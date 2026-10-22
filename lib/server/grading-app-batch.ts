import type { Pool } from "pg";
import OpenAI, { toFile } from "openai";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { downloadStorageObject } from "@/lib/storageProvider";
import { PROFILE_BY_ID, hardKeys, type GradingProfile, type GradingProfileId } from "@/lib/size-grading/grading-app-profiles";
import {
  NeedRound, gradingAppAgentConfig, measureWithAgent, openAiFullRequest, openAiRequest, replayTurns, usageCost, type AgentResult,
} from "@/lib/server/size-grading-agent";
import { allowedKeys, areaOf, getAiSettings, logAiCall, modelForKeys } from "@/lib/server/grading-app-ai";
import { adjustScan, type CrotchMeta, type ScanLine } from "@/lib/server/grading-app";

/**
 * CarbonGradingAI's AI through OpenAI's Batch API (half price), sent the
 * moment a scan is saved (owner, 2026-10-22: "any ai through the grading app
 * is going through batch and not in 1 am but at the moment we ready to send").
 *
 * The phone saves the outline's points straight away. Here every photo of the
 * scan gets a job; each of the agent's rounds (overview, then close-ups) is one
 * batch request, and a job is replayed with the answers it has to build the
 * next. When a scan's jobs are done, the AI's points replace the outline's —
 * never a line moved by hand — and the item's numbers are worked out again.
 */

export { gradingAiBatchOn } from "@/lib/server/grading-app-ai";

const MAX_TRIES = 3;
/** A second photo's two runs further apart than this get a third. */
const SPREAD_CM = 1.5;

type XY = { x: number; y: number };
type Lines = Record<string, { a: XY; b: XY }>;

/** Two placements of the same points: averaged ends, and how far apart the two runs put each point (cm). */
export function mergeRuns(a: Lines, b: Lines, pxPerCm: number): { lines: Lines; spreadCm: Record<string, number> } {
  const lines: Lines = {};
  const spreadCm: Record<string, number> = {};
  const d = (p: XY, q: XY) => Math.hypot(p.x - q.x, p.y - q.y);
  const mid = (p: XY, q: XY) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  for (const [k, la] of Object.entries(a)) {
    const lb = b[k];
    if (!lb) { lines[k] = la; continue; }
    // The second run may have drawn the line the other way round.
    const flip = d(la.a, lb.b) + d(la.b, lb.a) < d(la.a, lb.a) + d(la.b, lb.b);
    const ob = flip ? { a: lb.b, b: lb.a } : lb;
    spreadCm[k] = Math.round((Math.max(d(la.a, ob.a), d(la.b, ob.b)) / pxPerCm) * 10) / 10;
    lines[k] = { a: mid(la.a, ob.a), b: mid(la.b, ob.b) };
  }
  for (const [k, lb] of Object.entries(b)) if (!lines[k]) lines[k] = lb;
  return { lines, spreadCm };
}

type ScanRow = {
  id: string; profile: string; px_per_cm: string; lines: Record<string, ScanLine> | null; crotch: CrotchMeta | null;
  photo_key: string | null; crotch_photo_key: string | null; status: string;
};

/**
 * A scan was saved: one job per photo for the points the AI switch allows
 * (main photo: the seam points and, with "everything else" on, the rest; the
 * sleeves-up / crotch photo: its own points, two runs). Returns how many jobs.
 */
export async function enqueueScanAi(pool: Pool, tenantId: string | null | undefined, scanId: string, userId: string | null): Promise<number> {
  const cfg = gradingAppAgentConfig();
  if (!cfg) return 0;
  const r = await pool.query<ScanRow>(
    `SELECT id::text, profile, px_per_cm, lines, crotch, photo_key, crotch_photo_key, status FROM size_grading_scans WHERE id = $1::uuid`, [scanId],
  );
  const s = r.rows[0];
  const profile = s && (PROFILE_BY_ID[s.profile as GradingProfileId] as GradingProfile | undefined);
  if (!s || !profile || s.status === "redo") return 0;
  const exists = await pool.query(`SELECT 1 FROM grading_ai_jobs WHERE scan_id = $1::uuid LIMIT 1`, [scanId]);
  if (exists.rowCount) return 0; // a save retried from the phone's offline queue
  const allowed = new Set(allowedKeys(profile, await getAiSettings(pool, tenantId)));
  const hard = new Set<string>(hardKeys(profile));
  const second = new Set<string>(profile.secondPhoto?.keys ?? profile.crotchPhoto?.keys ?? []);
  const hasSecond = !!(s.crotch && s.crotch_photo_key);
  const free = (l: ScanLine | undefined) => !!l && !l.moved;
  const jobs: { photo: "main" | "second"; run: number; keys: string[]; pxPerCm: number }[] = [];
  if (s.photo_key) {
    const keys = profile.points.map((p) => p.key as string).filter((k) =>
      allowed.has(k) && (hard.has(k) || areaOf(profile, k) === "other") && !(hasSecond && second.has(k)) && free(s.lines?.[k]));
    if (keys.length) jobs.push({ photo: "main", run: 0, keys, pxPerCm: Number(s.px_per_cm) });
  }
  if (hasSecond) {
    const keys = [...second].filter((k) => allowed.has(k) && free(s.crotch!.lines?.[k]));
    if (keys.length) for (const run of [0, 1]) jobs.push({ photo: "second", run, keys, pxPerCm: Number(s.crotch!.pxPerCm) });
  }
  for (const j of jobs) {
    await pool.query(
      `INSERT INTO grading_ai_jobs (tenant_id, scan_id, photo, run, profile, keys, px_per_cm, model, created_by)
       VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9)`,
      [tenantId ?? null, scanId, j.photo, j.run, profile.id, j.keys, j.pxPerCm, modelForKeys(profile, j.keys, cfg.model), userId],
    );
  }
  if (jobs.length) await pool.query(`UPDATE size_grading_scans SET ai_status = 'pending' WHERE id = $1::uuid`, [scanId]);
  return jobs.length;
}

type JobRow = {
  id: string; tenant_id: string | null; scan_id: string; photo: "main" | "second"; run: number; profile: string; keys: string[];
  px_per_cm: string; model: string; status: string; answers: string[]; response_ids: string[]; full_history: boolean;
  openai_batch_id: string | null; tries: number; usage: AgentResult["usage"]; created_by: string | null;
};

const photoCache = new Map<string, Buffer>();
async function photoOf(scanId: string, photo: "main" | "second", pool: Pool): Promise<Buffer> {
  const ck = `${scanId}:${photo}`;
  const hit = photoCache.get(ck);
  if (hit) return hit;
  const r = await pool.query<{ photo_key: string | null; crotch_photo_key: string | null }>(
    `SELECT photo_key, crotch_photo_key FROM size_grading_scans WHERE id = $1::uuid`, [scanId],
  );
  const key = photo === "main" ? r.rows[0]?.photo_key : r.rows[0]?.crotch_photo_key;
  if (!key) throw new Error("The scan's photo is missing");
  const buf = Buffer.from((await downloadStorageObject(key)).body);
  if (photoCache.size > 20) photoCache.clear();
  photoCache.set(ck, buf);
  return buf;
}

/** Replay a job with its answers: its next request, or its final placement. */
async function advance(pool: Pool, j: JobRow): Promise<{ need: NeedRound } | { final: AgentResult }> {
  const profile = PROFILE_BY_ID[j.profile as GradingProfileId];
  const cfg = gradingAppAgentConfig();
  const points = profile.points.filter((p) => j.keys.includes(p.key)).map((p) => ({ key: p.key, label: p.label, rule: p.rule }));
  try {
    const final = await measureWithAgent(
      { image: await photoOf(j.scan_id, j.photo, pool), pxPerCm: Number(j.px_per_cm), type: profile.family, view: "front", keys: [], points, scale: "depth" },
      { provider: "openai", model: j.model, maxRounds: cfg?.maxRounds ?? 5, effort: cfg?.effort ?? "low", turns: replayTurns(j.answers) },
    );
    return { final };
  } catch (e) {
    if (e instanceof NeedRound) return { need: e };
    throw e;
  }
}

/** The reply text of a Responses API body (raw JSON has no output_text helper). */
function replyText(body: Record<string, unknown>): string {
  if (typeof body.output_text === "string") return body.output_text;
  const out = Array.isArray(body.output) ? (body.output as { type?: string; content?: { type?: string; text?: string }[] }[]) : [];
  return out.filter((o) => o.type === "message").flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
}

async function readJsonl(openai: OpenAI, fileId: string): Promise<Record<string, unknown>[]> {
  const text = await (await openai.files.content(fileId)).text();
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } });
}

/** Ask OpenAI about the batches out; store each answer on its job. */
/** @internal exported for tests */
export async function pollSent(pool: Pool, openai: OpenAI, log: (m: string) => void): Promise<number> {
  const open = await pool.query<{ openai_batch_id: string }>(
    `SELECT DISTINCT openai_batch_id FROM grading_ai_jobs WHERE status = 'sent' AND openai_batch_id IS NOT NULL`,
  );
  let answered = 0;
  for (const { openai_batch_id: bid } of open.rows) {
    const b = await openai.batches.retrieve(bid);
    if (!["completed", "failed", "expired", "cancelled"].includes(b.status)) continue;
    const rows = [
      ...(b.output_file_id ? await readJsonl(openai, b.output_file_id) : []),
      ...(b.error_file_id ? await readJsonl(openai, b.error_file_id) : []),
    ];
    const seen = new Set<string>();
    for (const row of rows) {
      const cid = String(row.custom_id ?? "");
      const jobId = cid.split(":")[0];
      if (!jobId) continue;
      seen.add(jobId);
      const resp = row.response as { status_code?: number; body?: Record<string, unknown> } | undefined;
      const body = resp?.body ?? {};
      const err = (row.error as { message?: string } | null)?.message ?? (resp?.status_code !== 200 ? String((body.error as { message?: string } | undefined)?.message ?? `HTTP ${resp?.status_code}`) : null);
      if (err) {
        // A round that could not point at the last answer goes again with the whole conversation.
        const chain = /previous[_ ]response/i.test(err);
        await pool.query(
          `UPDATE grading_ai_jobs SET status = CASE WHEN $3 OR tries + 1 < $4 THEN 'waiting' ELSE 'failed' END,
                  full_history = full_history OR $3, tries = tries + CASE WHEN $3 THEN 0 ELSE 1 END, error = $2, updated_at = now()
            WHERE id = $1::uuid AND status = 'sent'`,
          [jobId, err.slice(0, 500), chain, MAX_TRIES],
        );
        continue;
      }
      const u = (body.usage ?? {}) as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
      const cached = u.input_tokens_details?.cached_tokens ?? 0;
      await pool.query(
        `UPDATE grading_ai_jobs
            SET status = 'waiting', answers = answers || to_jsonb($2::text), response_ids = response_ids || to_jsonb($3::text),
                usage = jsonb_build_object('input', (usage->>'input')::numeric + $4, 'output', (usage->>'output')::numeric + $5,
                                           'cacheRead', (usage->>'cacheRead')::numeric + $6, 'cacheWrite', 0),
                error = NULL, updated_at = now()
          WHERE id = $1::uuid AND status = 'sent'`,
        [jobId, replyText(body), String(body.id ?? ""), (u.input_tokens ?? 0) - cached, u.output_tokens ?? 0, cached],
      );
      answered++;
    }
    // A request OpenAI never answered (expired or cancelled batch) goes again.
    await pool.query(
      `UPDATE grading_ai_jobs SET status = CASE WHEN tries + 1 < $3 THEN 'waiting' ELSE 'failed' END, tries = tries + 1,
              error = $4, updated_at = now()
        WHERE openai_batch_id = $1 AND status = 'sent' AND NOT (id::text = ANY($2::text[]))`,
      [bid, [...seen], MAX_TRIES, `OpenAI batch ${b.status} without an answer`],
    );
    for (const id of [b.input_file_id, b.output_file_id, b.error_file_id]) if (id) await openai.files.delete(id).catch(() => {});
    log(`batch ${bid} ${b.status}: ${rows.length} answer(s)`);
  }
  return answered;
}

/** Build the next round of every waiting job, finish the ones that have their answer, and send the rest in one batch per model. */
/** @internal exported for tests */
export async function sendWaiting(pool: Pool, openai: OpenAI, log: (m: string) => void): Promise<{ sent: number; finished: number }> {
  const waiting = await pool.query<JobRow>(
    `SELECT id::text, tenant_id::text, scan_id::text, photo, run, profile, keys, px_per_cm, model, status, answers, response_ids,
            full_history, openai_batch_id, tries, usage, created_by::text
       FROM grading_ai_jobs WHERE status = 'waiting' ORDER BY created_at LIMIT 200`,
  );
  const cfg = gradingAppAgentConfig();
  const byModel = new Map<string, { job: JobRow; line: string }[]>();
  let finished = 0;
  for (const j of waiting.rows) {
    try {
      const step = await advance(pool, j);
      if ("final" in step) {
        const r = step.final;
        await pool.query(
          `UPDATE grading_ai_jobs SET status = 'done', result = $2::jsonb, cost_usd = $3, done_at = now(), updated_at = now() WHERE id = $1::uuid`,
          [j.id, JSON.stringify({ lines: r.lines, skipped: r.skipped, remarks: r.remarks, rounds: r.rounds, zooms: r.zooms }), finiteOrNull(usageCost(j.model, j.usage, true))],
        );
        finished++;
        continue;
      }
      const n = step.need;
      const prev = j.response_ids[n.round - 1];
      const body = j.full_history || !prev
        ? (n.round === 0 ? openAiRequest(j.model, cfg?.effort ?? "low", n.parts) : openAiFullRequest(j.model, cfg?.effort ?? "low", n.parts, n.history))
        : openAiRequest(j.model, cfg?.effort ?? "low", n.parts, prev);
      const line = JSON.stringify({ custom_id: `${j.id}:${n.round}`, method: "POST", url: "/v1/responses", body });
      const list = byModel.get(j.model) ?? [];
      list.push({ job: j, line });
      byModel.set(j.model, list);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await pool.query(
        `UPDATE grading_ai_jobs SET status = CASE WHEN tries + 1 < $3 THEN 'waiting' ELSE 'failed' END, tries = tries + 1, error = $2, updated_at = now() WHERE id = $1::uuid`,
        [j.id, msg.slice(0, 500), MAX_TRIES],
      );
    }
  }
  let sent = 0;
  // OpenAI takes one model per batch file.
  for (const [model, list] of byModel) {
    const input = await openai.files.create({
      file: await toFile(Buffer.from(list.map((l) => l.line).join("\n") + "\n"), `grading-ai-${Date.now()}.jsonl`, { type: "application/jsonl" }),
      purpose: "batch",
    });
    const batch = await openai.batches.create({ input_file_id: input.id, endpoint: "/v1/responses", completion_window: "24h", metadata: { app: "carbongradingai" } });
    await pool.query(
      `UPDATE grading_ai_jobs SET status = 'sent', openai_batch_id = $2, custom_id = NULL, sent_at = now(), updated_at = now() WHERE id = ANY($1::uuid[])`,
      [list.map((l) => l.job.id), batch.id],
    );
    sent += list.length;
    log(`sent ${list.length} round(s) on ${model} → OpenAI batch ${batch.id}`);
  }
  return { sent, finished };
}

function finiteOrNull(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

/**
 * Scans whose jobs have all ended: a second photo's two runs are merged (a
 * third run when they disagree), then the AI's points go on the scan — lines
 * moved by hand stay — and the item's numbers are worked out again.
 */
/** @internal exported for tests */
export async function applyFinished(pool: Pool, log: (m: string) => void): Promise<number> {
  // Scans waiting on the AI whose jobs have all ended.
  const ready = await pool.query<{ scan_id: string }>(
    `SELECT s.id::text AS scan_id FROM size_grading_scans s
      WHERE s.ai_status = 'pending'
        AND EXISTS (SELECT 1 FROM grading_ai_jobs j WHERE j.scan_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM grading_ai_jobs j WHERE j.scan_id = s.id AND j.status IN ('waiting', 'sent'))`,
  );
  let applied = 0;
  for (const { scan_id } of ready.rows) {
    const scan = await pool.query<ScanRow & { ai_status: string | null }>(
      `SELECT id::text, profile, px_per_cm, lines, crotch, photo_key, crotch_photo_key, status, ai_status FROM size_grading_scans WHERE id = $1::uuid`, [scan_id],
    );
    const s = scan.rows[0];
    if (!s || s.ai_status !== "pending") continue;
    const jobs = (await pool.query<JobRow & { result: { lines: Lines; remarks?: string } | null; cost_usd: string | null; error: string | null }>(
      `SELECT id::text, photo, run, keys, model, status, result, cost_usd, error, tenant_id::text, created_by::text, profile, px_per_cm
         FROM grading_ai_jobs WHERE scan_id = $1::uuid ORDER BY photo, run`, [scan_id],
    )).rows;
    const profile = PROFILE_BY_ID[s.profile as GradingProfileId];
    const done = (photo: string) => jobs.filter((j) => j.photo === photo && j.status === "done" && j.result);
    // The second photo: two runs agree → averaged; apart → a third run breaks the tie.
    let secondLines: Lines | null = null;
    let spread = 0;
    const sec = done("second");
    if (sec.length >= 2) {
      const ppc = Number(s.crotch?.pxPerCm ?? 1);
      const pairs: [number, number][] = sec.length >= 3 ? [[0, 1], [0, 2], [1, 2]] : [[0, 1]];
      const merged = pairs.map(([a, b]) => mergeRuns(sec[a].result!.lines, sec[b].result!.lines, ppc));
      const worst = (m: ReturnType<typeof mergeRuns>) => Math.max(0, ...Object.values(m.spreadCm));
      const best = merged.reduce((x, m) => (worst(m) < worst(x) ? m : x));
      if (worst(best) > SPREAD_CM && sec.length === 2 && !jobs.some((j) => j.photo === "second" && j.run === 2)) {
        const j0 = sec[0];
        await pool.query(
          `INSERT INTO grading_ai_jobs (tenant_id, scan_id, photo, run, profile, keys, px_per_cm, model, created_by)
           VALUES ($1, $2::uuid, 'second', 2, $3, $4, $5, $6, $7)`,
          [j0.tenant_id, scan_id, j0.profile, j0.keys, j0.px_per_cm, j0.model, j0.created_by],
        );
        log(`scan ${scan_id}: second photo's runs ${worst(best)} cm apart — a third run`);
        continue;
      }
      secondLines = best.lines;
      spread = worst(best);
    } else if (sec.length === 1) {
      secondLines = sec[0].result!.lines;
    }
    const mainLines = done("main")[0]?.result?.lines ?? null;
    const toLine = (k: string, l: { a: XY; b: XY }): ScanLine => {
      const bend = profile.points.find((p) => p.key === k)?.bend;
      const a: [number, number] = [l.a.x, l.a.y], b: [number, number] = [l.b.x, l.b.y];
      return { pts: bend ? [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], b] : [a, b], source: "ai" };
    };
    // Only lines nobody moved by hand take the AI's placement.
    const put = (cur: Record<string, ScanLine> | null | undefined, ai: Lines | null) => {
      const out: Record<string, ScanLine> = { ...(cur ?? {}) };
      let n = 0;
      for (const [k, l] of Object.entries(ai ?? {})) if (out[k] && !out[k].moved) { out[k] = toLine(k, l); n++; }
      return { out, n };
    };
    const m = put(s.lines, mainLines);
    const c = s.crotch ? put(s.crotch.lines, secondLines) : { out: null, n: 0 };
    const cost = jobs.reduce((t, j) => t + (j.cost_usd == null ? 0 : Number(j.cost_usd)), 0);
    const models = [...new Set(jobs.filter((j) => j.status === "done").map((j) => j.model))].join(" + ");
    const failed = jobs.filter((j) => j.status === "failed");
    if (m.n + c.n > 0) {
      const res = await adjustScan(pool, scan_id, m.out, c.out, null, `AI placed ${m.n + c.n} point${m.n + c.n === 1 ? "" : "s"} (batch, ${models})`);
      if (res && "refused" in res) {
        await pool.query(`UPDATE grading_ai_jobs SET status = 'cancelled' WHERE scan_id = $1::uuid AND status IN ('waiting', 'sent')`, [scan_id]);
      }
    }
    const extraFlags: string[] = [];
    if (spread > SPREAD_CM) extraFlags.push(`AI unsure on the ${profile.secondPhoto?.title ?? "second"} photo: its placements differ by ${spread} cm`);
    if (failed.length) extraFlags.push(`AI could not place ${[...new Set(failed.flatMap((j) => j.keys))].join(", ")}: ${failed[0].error ?? "no answer"}`);
    await pool.query(
      `UPDATE size_grading_scans
          SET ai_status = $2, ai_model = $3, ai_cost_usd = $4,
              ai_lines = COALESCE($5::jsonb, ai_lines),
              crotch = CASE WHEN crotch IS NULL OR $6::jsonb IS NULL THEN crotch ELSE jsonb_set(crotch, '{aiLines}', $6::jsonb) END,
              flags = COALESCE((SELECT to_jsonb(array_agg(DISTINCT f)) FROM jsonb_array_elements_text(COALESCE(flags, '[]'::jsonb) || $7::jsonb) f), '[]'::jsonb)
        WHERE id = $1::uuid`,
      [scan_id, failed.length && !(m.n + c.n) ? "failed" : "done", models || null, cost || null,
        mainLines ? JSON.stringify(Object.fromEntries(Object.entries(mainLines).map(([k, l]) => [k, toLine(k, l)]))) : null,
        secondLines ? JSON.stringify(Object.fromEntries(Object.entries(secondLines).map(([k, l]) => [k, toLine(k, l)]))) : null,
        JSON.stringify(extraFlags)],
    );
    // Each photo's cost, for the AI switch's "cost per size".
    for (const photo of ["main", "second"] as const) {
      const pj = jobs.filter((j) => j.photo === photo && j.status === "done");
      if (!pj.length) continue;
      await logAiCall(pool, {
        tenantId: pj[0].tenant_id, model: pj[0].model, profile, keys: pj[0].keys, runs: pj.length,
        costUsd: pj.reduce((t, j) => t + (j.cost_usd == null ? 0 : Number(j.cost_usd)), 0) || null, ms: null,
      });
    }
    applied++;
    log(`scan ${scan_id}: AI placed ${m.n + c.n} point(s), ${(cost * 100).toFixed(1)}¢`);
  }
  return applied;
}

/**
 * One pass: store OpenAI's answers, advance and send what is waiting, put
 * finished placements on their scans. Safe to call often — one pass at a time
 * (advisory lock); the scan save calls it, and the worker every minute while
 * jobs are open.
 */
export async function gradingAiTick(pool: Pool, log: (m: string) => void = (m) => console.log(`[grading-ai] ${m}`)) {
  const apiKey = getOpenAiApiKey().trim();
  if (!apiKey) return { skipped: "no OpenAI key" };
  const client = await pool.connect();
  try {
    const got = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('grading_ai_tick')) AS ok`);
    if (!got.rows[0]?.ok) return { skipped: "busy" };
    try {
      const openai = new OpenAI({ apiKey });
      const answered = await pollSent(pool, openai, log);
      let applied = await applyFinished(pool, log);
      const r = await sendWaiting(pool, openai, log);
      // A job that finished just now (its last answer) is put on its scan in the same pass.
      if (r.finished) applied += await applyFinished(pool, log);
      return { answered, sent: r.sent, finished: r.finished, applied };
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('grading_ai_tick'))`).catch(() => {});
    }
  } finally {
    client.release();
  }
}

/** Jobs still open (the worker keeps ticking while there are any). */
export async function openGradingAiJobs(pool: Pool): Promise<number> {
  const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM grading_ai_jobs WHERE status IN ('waiting', 'sent')`);
  return r.rows[0]?.n ?? 0;
}
