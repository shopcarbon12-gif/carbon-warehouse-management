/**
 * CarbonWMS Creative — the render worker (spec §12.1). Runs inside the WMS worker (Coolify, the
 * owner's own server, free): picks queued renders, writes the edit plan as a HyperFrames project,
 * renders HTML → MP4 with the system Chromium + ffmpeg, runs the finishing pass, and hands the
 * file back to the web app (which owns storage). `RenderEngine` is the swap point (Remotion …).
 */
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { assetFile, composeHyperFrames, finishingArgs, type EditPlan } from "./editor";
import { FFMPEG, probe, run, withTmp } from "./media";

export interface RenderEngine {
  name: string;
  render(plan: EditPlan, dir: string, html?: string | null): Promise<string>; // returns the raw MP4 path
}

export const HyperFramesEngine: RenderEngine = {
  name: "hyperframes",
  async render(plan, dir, html) {
    await writeFile(path.join(dir, "index.html"), html || composeHyperFrames(plan));
    await writeFile(path.join(dir, "hyperframes.json"), JSON.stringify({ paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, media: { autoProxy: false } }));
    const chrome = [process.env.CHROMIUM_PATH, "/usr/bin/chromium-browser", "/usr/bin/chromium"].find((p) => p && existsSync(p));
    const env = {
      ...process.env,
      ...(chrome ? { PRODUCER_HEADLESS_SHELL_PATH: chrome } : {}),
      // Must be an absolute path (a bare "ffmpeg" makes HyperFrames fail at start); else let it find its own.
      ...(ffmpegAbs() ? { HYPERFRAMES_FFMPEG_PATH: ffmpegAbs()! } : {}),
      HYPERFRAMES_NO_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
      PRODUCER_LOW_MEMORY_MODE: process.env.PRODUCER_LOW_MEMORY_MODE ?? "1",
    };
    const bin = process.env.HYPERFRAMES_BIN || "hyperframes";
    const out = path.join(dir, "raw.mp4");
    const args = ["render", "--quality", "delivery", "--output", out];
    await new Promise<void>((resolve, reject) => {
      const p = spawn(bin, args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
      let log = "";
      p.stdout.on("data", (d) => (log = (log + d).slice(-6000)));
      p.stderr.on("data", (d) => (log = (log + d).slice(-6000)));
      const t = setTimeout(() => p.kill("SIGKILL"), 25 * 60_000);
      p.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
      p.on("close", (code) => {
        clearTimeout(t);
        if (code === 0 && existsSync(out)) resolve();
        else reject(new Error(`hyperframes render failed (${code}): ${log.slice(-800)}`));
      });
    });
    return out;
  },
};

function ffmpegAbs(): string | null {
  const c = [process.env.HYPERFRAMES_FFMPEG_PATH, FFMPEG, "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((p) => p && p.startsWith("/") && existsSync(p));
  return c ?? null;
}

const ENGINES: Record<string, RenderEngine> = { hyperframes: HyperFramesEngine };

export function uploadSig(genId: string, secret = process.env.CREATIVE_LINK_SECRET || process.env.SESSION_SECRET || ""): string {
  return crypto.createHmac("sha256", secret).update(`render:${genId}`).digest("hex").slice(0, 40);
}

async function download(url: string, file: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`asset download HTTP ${r.status}`);
  await writeFile(file, Buffer.from(await r.arrayBuffer()));
}

/** One queued render, if any. Returns true when it did work. */
export async function runOneRender(pool: Pool): Promise<boolean> {
  const c = await pool.query<{ id: string; inputs: { plan: EditPlan; engine?: string; upscale4k?: boolean; interpolate?: boolean; html?: string | null } }>(
    `UPDATE creative_generations SET status = 'running', updated_at = now()
      WHERE id = (SELECT id FROM creative_generations WHERE kind = 'render' AND status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id::text, inputs`,
  );
  const g = c.rows[0];
  if (!g) return false;
  const base = (process.env.WMS_APP_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  try {
    const plan = g.inputs.plan;
    const engine = ENGINES[g.inputs.engine ?? "hyperframes"] ?? HyperFramesEngine;
    await withTmp(async (dir) => {
      await mkdir(path.join(dir, "assets"), { recursive: true });
      for (const [key, url] of Object.entries(plan.assets)) await download(url, path.join(dir, assetFile(key)));
      const raw = await engine.render(plan, dir, g.inputs.html);
      const meta = await probe(raw);
      const final = path.join(dir, "final.mp4");
      await run(FFMPEG, finishingArgs(plan, raw, final, { upscale4k: g.inputs.upscale4k, interpolate: g.inputs.interpolate, hasAudio: meta.hasAudio }), 20 * 60_000);
      const poster = path.join(dir, "poster.jpg");
      await run(FFMPEG, ["-y", "-ss", "0.4", "-i", final, "-frames:v", "1", "-q:v", "3", poster], 60_000);
      const fmeta = await probe(final);
      for (const [kind, file, type] of [["video", final, "video/mp4"], ["poster", poster, "image/jpeg"]] as const) {
        const r = await fetch(`${base}/api/creative/render/upload?gen=${g.id}&kind=${kind}&sig=${uploadSig(g.id)}&duration=${fmeta.duration.toFixed(2)}`, {
          method: "POST",
          headers: { "Content-Type": type },
          body: new Uint8Array(await readFile(file)),
          signal: AbortSignal.timeout(300_000),
        });
        if (!r.ok) throw new Error(`upload ${kind} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      }
    });
  } catch (e) {
    console.error("[creative render]", e);
    await pool.query(`UPDATE creative_generations SET status = 'failed', error = $2, updated_at = now() WHERE id = $1::uuid`, [g.id, (e as Error).message.slice(0, 1500)]);
  }
  return true;
}
