/**
 * Encode jobs worker — actually programs the chip on an already-stuck
 * tag. Polls /api/cdm-agents/encode-jobs every POLL_INTERVAL_MS, picks
 * up pending rows for this agent's readers, borrows the bridge slot
 * via the supervisor, runs MonsoonReader --target_tag <old>
 * --write_tag <new> against the bridge, and reports the result back
 * via POST /api/cdm-agents/encode-jobs/[id]/result.
 *
 * The Encode Items page is the only producer today (operator clicks
 * Encode after picking a reader). Handhelds bypass this — they write
 * the chip directly via the C72E SDK.
 *
 * Failure modes the worker explicitly handles:
 *   • Reader not currently managed by this supervisor → "reader_unmanaged"
 *   • Reader has an active antenna-test session → "reader_in_test_mode"
 *   • MonsoonReader binary exited non-zero → "binary_exit_<code>"
 *   • MonsoonReader exceeded WRITE_TIMEOUT_MS → "write_timeout"
 *   • TCP connect failed (bridge unreachable) → "bridge_unreachable"
 *   • Tag not in field / write rejected → parsed from binary stderr
 */

import { spawn } from "node:child_process";
import { log } from "./log.js";
import type { MonsoonSupervisor } from "./monsoon-supervisor.js";
import type { AgentEnv } from "./config.js";
import {
  fetchPendingEncodeJobs,
  postEncodeJobResult,
  type PendingEncodeJob,
} from "./wms-client.js";

const POLL_INTERVAL_MS = 3_000;
const WRITE_TIMEOUT_MS = 25_000;
/**
 * Default write binary — Senitron MonsoonReader (2019 build). Handles
 * F0A0B-prefix Carbon Gen2 SGTIN-96 EPCs cleanly.
 */
const MONSOON_BINARY = "/opt/legacy-rfid/MonsoonReader";
/**
 * Alternate write binary — Senitron MonsoonReader2 (Feb 2020 build). Used
 * only when the *target* EPC starts with C1/C2 (the Senitron-era custom
 * non-SGTIN pool). The 2019 binary segfaults parsing those targets
 * (live evidence 2026-05-26: SIGSEGV before banner output on .70 with
 * target_tag=C1...). The 2020 binary's parser was rewritten and accepts
 * non-SGTIN targets — confirmed end-to-end with TAG_ACCESS write_bytes=12
 * against the same chip. Same protocol, same wire format, just a fixed
 * argument-parse path. Kept as a separate constant so the F0A0B happy
 * path is untouched (operator preference: don't migrate working tags). */
const MONSOON_BINARY_C_PREFIX = "/opt/legacy-rfid/MonsoonReader2";

/**
 * Pick which binary to spawn based on the target_tag (the EPC currently
 * burned into the chip). The new write EPC is always F0A0B-prefix, so
 * `--write_tag` doesn't influence binary selection — only the target
 * matters for the parser-crash decision.
 */
function pickWriteBinary(targetEpc: string): string {
  return /^[Cc][12]/.test(targetEpc) ? MONSOON_BINARY_C_PREFIX : MONSOON_BINARY;
}

export type EncodeJobsWorkerHandle = { stop: () => void };

export function startEncodeJobsWorker(
  env: AgentEnv,
  supervisor: MonsoonSupervisor,
): EncodeJobsWorkerHandle {
  let stopped = false;
  let tickInFlight = false;

  const tick = async (): Promise<void> => {
    if (stopped || tickInFlight) return;
    tickInFlight = true;
    try {
      const jobs = await fetchPendingEncodeJobs(env, 5);
      if (jobs.length === 0) return;
      log.info("encode-jobs: claimed pending jobs", { count: jobs.length });
      // Serially: bridge slots are SERVER(2) single-client, and we
      // currently only have one POS reader anyway. Parallel writes on
      // the SAME reader would fight; serializing keeps the simple
      // correctness story.
      for (const job of jobs) {
        await runOne(env, supervisor, job);
      }
    } catch (e) {
      log.warn("encode-jobs: poll cycle threw", {
        err: e instanceof Error ? e.message : String(e),
      });
    } finally {
      tickInFlight = false;
    }
  };

  // Initial tick on startup so a queued job that landed during a
  // restart isn't stuck for the first interval.
  void tick();
  const handle = setInterval(() => void tick(), POLL_INTERVAL_MS);

  return {
    stop(): void {
      stopped = true;
      clearInterval(handle);
    },
  };
}

async function runOne(
  env: AgentEnv,
  supervisor: MonsoonSupervisor,
  job: PendingEncodeJob,
): Promise<void> {
  const jobLogCtx = {
    jobId: job.id,
    readerId: job.reader_id,
    oldEpc: job.old_epc,
    newEpc: job.new_epc,
    attempts: job.attempts,
  };
  log.info("encode-jobs: starting write", jobLogCtx);

  // Step 1: borrow the bridge slot from the supervisor.
  let slot: { host: string; serialPort: number } | null;
  try {
    slot = await supervisor.acquireBridgeForExternalOp(job.reader_id);
  } catch (e) {
    await reportFailure(env, job, "acquire_threw", {
      err: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  if (!slot) {
    await reportFailure(env, job, "reader_unmanaged_or_in_test", {});
    return;
  }
  log.info("encode-jobs: acquired bridge slot", { ...jobLogCtx, ...slot });

  try {
    const outcome = await runWriteTag(slot.host, slot.serialPort, job.old_epc, job.new_epc);
    if (outcome.ok) {
      log.info("encode-jobs: write success", { ...jobLogCtx, ...outcome });
      await postEncodeJobResult(env, job.id, {
        status: "done",
        meta: outcome.meta,
      });
    } else {
      log.warn("encode-jobs: write failed", { ...jobLogCtx, ...outcome });
      await postEncodeJobResult(env, job.id, {
        status: "failed",
        error_msg: outcome.error_msg,
        meta: outcome.meta,
      });
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    log.warn("encode-jobs: runWriteTag threw", { ...jobLogCtx, err: errMsg });
    try {
      await postEncodeJobResult(env, job.id, {
        status: "failed",
        error_msg: `worker_threw: ${errMsg}`,
      });
    } catch {
      /* WMS unreachable — job stays 'running' and will be cleaned up
       * by a future reconciler / manual retry. Don't fail the loop. */
    }
  } finally {
    supervisor.releaseBridgeForExternalOp(job.reader_id);
  }
}

type WriteOutcome =
  | { ok: true; meta: Record<string, unknown> }
  | { ok: false; error_msg: string; meta: Record<string, unknown> };

/**
 * Spawn MonsoonReader against the bridge and wait for it to write the
 * new EPC onto the chip whose current EPC is `oldEpc`. The binary needs
 * the tag to be physically in the antenna's field; if it isn't, the
 * write returns a non-zero exit and we report failure so the operator
 * can retry with the tag presented to the antenna.
 *
 * Flag summary (from `MonsoonReader --help`):
 *   --serial_host / --serial_port → WIZnet bridge endpoint
 *   --target_tag  → EPC of the chip we want to write
 *   --write_tag   → New EPC to program
 *   -p / --power  → Tx power in tenths-dBm (300 = 30 dBm)
 *   --num 1       → Reader index (single reader)
 */
function runWriteTag(
  host: string,
  serialPort: number,
  oldEpc: string,
  newEpc: string,
): Promise<WriteOutcome> {
  return new Promise<WriteOutcome>((resolve) => {
    const args = [
      "--serial_host", host,
      "--serial_port", String(serialPort),
      "--num", "1",
      "-p", "300",
      "--target_tag", oldEpc.toUpperCase(),
      "--write_tag", newEpc.toUpperCase(),
    ];
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    const binary = pickWriteBinary(oldEpc);
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // detached so we can SIGKILL the whole process group on timeout
      detached: true,
    });
    const killTimer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      if (!pid || child.exitCode !== null) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
      }
    }, WRITE_TIMEOUT_MS);
    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    child.on("error", (e) => {
      clearTimeout(killTimer);
      resolve({
        ok: false,
        error_msg: `spawn_error: ${e.message}`,
        meta: { stage: "spawn" },
      });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(killTimer);
      const meta: Record<string, unknown> = {
        binary,
        exit_code: code,
        signal,
        stdout_tail: stdout.slice(-400),
        stderr_tail: stderr.slice(-400),
      };
      if (timedOut) {
        resolve({ ok: false, error_msg: "write_timeout", meta });
        return;
      }
      // Success requires POSITIVE evidence: at least one
      // `TAG_ACCESS : cmd = WRITE, write_bytes = ...` line from the
      // binary. The 2016 MR1 binary emits this exactly once per
      // 12-byte word actually written to the chip; absent the line,
      // no Gen2 ACCESS write hit the air, regardless of exit code.
      //
      // Live evidence 2026-05-26: MR2 routinely exits 0 with output
      // like "Failed to connect to remote serial host / No radios
      // found in enumeration" — exit-code-based heuristic logged
      // those as success and the UI showed "Wrote ✓" while chips
      // stayed C-prefix. New heuristic refuses any outcome that
      // can't produce a TAG_ACCESS WRITE line.
      const lc = (stderr + stdout).toLowerCase();
      const sawWrite = /tag_access\s*:\s*cmd\s*=\s*write/i.test(stdout);
      if (code === 0 && sawWrite) {
        resolve({ ok: true, meta });
        return;
      }
      let errSummary = "binary_exit_" + String(code);
      if (/radio_not_present|radio not present/i.test(lc)) errSummary = "radio_not_present";
      else if (/no radios found/i.test(lc)) errSummary = "no_radios_found";
      else if (/failed to connect/i.test(lc)) errSummary = "bridge_unreachable";
      else if (/unable to connect/i.test(lc)) errSummary = "bridge_unreachable";
      else if (/tag not found/i.test(lc)) errSummary = "tag_not_in_field";
      else if (/write fail/i.test(lc)) errSummary = "write_rejected_by_chip";
      else if (code === 0 && !sawWrite) errSummary = "no_tag_access_write_line";
      resolve({ ok: false, error_msg: errSummary, meta });
    });
  });
}

async function reportFailure(
  env: AgentEnv,
  job: PendingEncodeJob,
  reason: string,
  meta: Record<string, unknown>,
): Promise<void> {
  try {
    await postEncodeJobResult(env, job.id, {
      status: "failed",
      error_msg: reason,
      meta,
    });
  } catch (e) {
    log.warn("encode-jobs: failed to POST failure report", {
      jobId: job.id,
      reason,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}
