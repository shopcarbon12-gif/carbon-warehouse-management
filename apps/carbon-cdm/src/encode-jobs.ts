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
import {
  startEncodeWriteProxy,
  PLACEHOLDER_TARGET_EPC,
} from "./encode-write-proxy.js";

const POLL_INTERVAL_MS = 3_000;
const WRITE_TIMEOUT_MS = 25_000;
/**
 * The only Senitron binary in the entire archive that produces real
 * `TAG_ACCESS : cmd = WRITE` traffic against the SA-2000 family. MR2
 * (2020) was tried for C-prefix targets but its RFID_RadioOpen fails
 * with `-9983 RADIO_NOT_PRESENT` on .30 and .34 in every state (cold
 * / warm / reset / reboot), so MR2 is dead end. MR1 is what we use,
 * with the encode-write-proxy stripping the C-prefix segfault out
 * of the loop for C1/C2 targets.
 */
const MONSOON_BINARY = "/opt/legacy-rfid/MonsoonReader";

function isCPrefixTarget(epc: string): boolean {
  return /^[Cc][12]/.test(epc);
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
/**
 * Run a single MR1 `--reset` against the bridge before the actual write.
 * RFID_MacReset clears any leftover chip state from the supervisor's
 * just-killed `new_monsoonreader --console` child. Without it, MR1's
 * stream-mode enumerate returns zero radios because the chip is still
 * in console mode from the previous binary (live evidence 2026-05-26
 * on .30: every encode failed `no_radios_found in enumeration`).
 *
 * ~1 s wall-clock; we don't care about the exit code, only that it
 * sends the chip-MAC reset opcode and exits cleanly. Returns the
 * captured stdout for the meta block in case operators need to debug.
 */
async function preFlightChipReset(
  host: string,
  serialPort: number,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let stdout = "";
    const child = spawn(
      MONSOON_BINARY,
      ["--serial_host", host, "--serial_port", String(serialPort), "--reset"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, 5_000);
    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.on("close", () => {
      clearTimeout(killTimer);
      resolve(stdout.slice(-200));
    });
    child.on("error", () => {
      clearTimeout(killTimer);
      resolve("");
    });
  });
}

async function runWriteTag(
  host: string,
  serialPort: number,
  oldEpc: string,
  newEpc: string,
): Promise<WriteOutcome> {
  // Pre-flight: RFID_MacReset to clear chip mode from the supervisor's
  // console-driver child. See preFlightChipReset comment.
  const resetOut = await preFlightChipReset(host, serialPort);
  // Brief settle so the chip MAC layer comes back up.
  await new Promise<void>((r) => setTimeout(r, 500));

  // For C-prefix targets we route MR1 through a local TCP proxy that
  // substitutes the SELECT-mask register bytes mid-flight. MR1 thinks
  // it's targeting a parser-safe F0A0B placeholder; the bridge sees
  // the real C-prefix EPC. See `encode-write-proxy.ts` for the wire
  // protocol breakdown.
  const cPrefix = isCPrefixTarget(oldEpc);
  let proxyHandle: Awaited<ReturnType<typeof startEncodeWriteProxy>> | null = null;
  let effectiveHost = host;
  let effectivePort = serialPort;
  let targetForBinary = oldEpc.toUpperCase();
  if (cPrefix) {
    try {
      proxyHandle = await startEncodeWriteProxy(host, serialPort, oldEpc.toUpperCase());
    } catch (e) {
      return {
        ok: false,
        error_msg: "proxy_start_failed",
        meta: { stage: "proxy_start", err: e instanceof Error ? e.message : String(e) },
      };
    }
    effectiveHost = "127.0.0.1";
    effectivePort = proxyHandle.port;
    targetForBinary = PLACEHOLDER_TARGET_EPC;
  }

  return new Promise<WriteOutcome>((resolve) => {
    const args = [
      "--serial_host", effectiveHost,
      "--serial_port", String(effectivePort),
      "--num", "1",
      "-p", "300",
      "--target_tag", targetForBinary,
      "--write_tag", newEpc.toUpperCase(),
    ];
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    const binary = MONSOON_BINARY;
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
      if (proxyHandle) {
        void proxyHandle.shutdown().catch(() => { /* ignore */ });
      }
      resolve({
        ok: false,
        error_msg: `spawn_error: ${e.message}`,
        meta: { stage: "spawn", proxy_used: cPrefix },
      });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(killTimer);
      const proxyStats = proxyHandle?.stats();
      // Tear the proxy down before resolving so the localhost port is
      // released cleanly even on fast follow-up jobs.
      if (proxyHandle) {
        void proxyHandle.shutdown().catch(() => {
          /* ignore — best-effort cleanup */
        });
      }
      const meta: Record<string, unknown> = {
        binary,
        exit_code: code,
        signal,
        stdout_tail: stdout.slice(-400),
        stderr_tail: stderr.slice(-400),
        proxy_used: cPrefix,
        preflight_reset_tail: resetOut,
        ...(proxyStats ? { proxy_stats: proxyStats } : {}),
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
