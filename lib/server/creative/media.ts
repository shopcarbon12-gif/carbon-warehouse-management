/**
 * CarbonWMS Creative — media helpers: perceptual hashes (dedupe + originality check), video
 * keyframes / probe / audio beats with ffmpeg (on the web + worker images).
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

export const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

/* ------------------------------------------------------------------ pHash (DCT, 64 bit) */

const N = 32;
const COS: number[][] = Array.from({ length: N }, (_, u) => Array.from({ length: N }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N))));

export async function phash(image: Buffer): Promise<string> {
  const px = await sharp(image).rotate().greyscale().resize(N, N, { fit: "fill" }).raw().toBuffer();
  const f: number[][] = Array.from({ length: N }, (_, y) => Array.from({ length: N }, (_, x) => px[y * N + x]));
  const dct: number[] = [];
  for (let u = 0; u < 8; u++)
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) s += f[y][x] * COS[u][y] * COS[v][x];
      dct.push(s);
    }
  const vals = dct.slice(1); // drop DC
  const median = [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  let bits = "";
  for (const v of dct) bits += v > median ? "1" : "0";
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hamming(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}
/** Same picture (resized, recompressed, small crop) ≈ distance ≤ 10 of 64. */
export const SAME_IMAGE = 10;

/* ------------------------------------------------------------------ ffmpeg */

export function run(cmd: string, args: string[], timeoutMs = 10 * 60_000): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const t = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-8000)));
    p.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(-600)}`));
    });
  });
}

export async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "creative-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function probe(file: string): Promise<{ duration: number; width: number; height: number; hasAudio: boolean }> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], 60_000);
  const j = JSON.parse(stdout.toString());
  const v = (j.streams ?? []).find((s: { codec_type: string }) => s.codec_type === "video");
  return {
    duration: Number(j.format?.duration ?? v?.duration ?? 0),
    width: Number(v?.width ?? 0),
    height: Number(v?.height ?? 0),
    hasAudio: (j.streams ?? []).some((s: { codec_type: string }) => s.codec_type === "audio"),
  };
}

/** Keyframes of a video: `count` JPEGs spread over its length (for pHash, tagging and the critic). */
export async function keyframes(video: Buffer, count = 4, width = 512): Promise<{ frames: Buffer[]; duration: number; width: number; height: number }> {
  return withTmp(async (dir) => {
    const f = path.join(dir, "in.mp4");
    await writeFile(f, video);
    const meta = await probe(f);
    const frames: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      const t = Math.max(0, (meta.duration * (i + 0.5)) / count);
      const out = path.join(dir, `k${i}.jpg`);
      await run(FFMPEG, ["-y", "-ss", t.toFixed(2), "-i", f, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "4", out], 60_000).catch(() => null);
      const b = await readFile(out).catch(() => null);
      if (b) frames.push(b);
    }
    return { frames, ...meta };
  });
}

/** Scene cuts (seconds) — for the cut rate of a Radar video. */
export async function sceneCuts(video: Buffer): Promise<number[]> {
  return withTmp(async (dir) => {
    const f = path.join(dir, "in.mp4");
    await writeFile(f, video);
    const { stderr } = await run(FFMPEG, ["-i", f, "-vf", "select='gt(scene,0.32)',showinfo", "-f", "null", "-"], 120_000).catch((e) => ({ stderr: String(e) }));
    return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
  });
}

/**
 * Beat detection for music (spec §7.4): decode to 11 kHz mono PCM, spectral-flux onset envelope,
 * tempo by autocorrelation (80–170 BPM), then beat times by picking the strongest phase.
 */
export async function detectBeats(audio: Buffer): Promise<{ bpm: number; beats: number[]; duration: number; drop: number | null }> {
  return withTmp(async (dir) => {
    const f = path.join(dir, "in.audio");
    await writeFile(f, audio);
    const sr = 11025;
    const { stdout } = await run(FFMPEG, ["-i", f, "-ac", "1", "-ar", String(sr), "-f", "f32le", "-"], 120_000);
    const pcm = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
    return beatsFromPcm(pcm, sr);
  });
}

export function beatsFromPcm(pcm: Float32Array, sr: number): { bpm: number; beats: number[]; duration: number; drop: number | null } {
  const hop = 128;
  const win = 512;
  const frames = Math.max(0, Math.floor((pcm.length - win) / hop));
  const env = new Float32Array(frames);
  const energy = new Float32Array(frames);
  let prev = 0;
  for (let i = 0; i < frames; i++) {
    let e = 0;
    for (let j = 0; j < win; j++) {
      const s = pcm[i * hop + j];
      e += s * s;
    }
    e = Math.log1p(e * 100);
    energy[i] = e;
    env[i] = Math.max(0, e - prev);
    prev = e;
  }
  const fps = sr / hop;
  // Tempo: autocorrelation of the onset envelope at FRACTIONAL lags (linear interpolation), as a comb
  // over 1–4 beat multiples, so 120 and 124 BPM (both ≈ 40 frames apart) are told apart.
  const at = (x: number) => {
    const i = Math.floor(x);
    const f = x - i;
    return (env[i] ?? 0) * (1 - f) + (env[i + 1] ?? 0) * f;
  };
  let best = 120, bestScore = -1;
  for (let bpm = 80; bpm <= 170; bpm += 0.25) {
    const lag = (60 / bpm) * fps;
    let s = 0;
    for (let k = 1; k <= 4; k++) {
      const L = lag * k;
      let acc = 0, n = 0;
      for (let i = 0; i + L < frames; i++) {
        acc += env[i] * at(i + L);
        n++;
      }
      if (n) s += acc / n;
    }
    if (s > bestScore) {
      bestScore = s;
      best = bpm;
    }
  }
  // Prefer the house range (≈ 118–130) when a half/double tempo fits as well.
  if (best < 95 && best * 2 <= 170) best *= 2;
  const period = (60 / best) * fps;
  let bestPhase = 0, phaseScore = -1;
  for (let ph = 0; ph < period; ph += 0.5) {
    let s = 0;
    for (let t = ph; t < frames; t += period) s += Math.max(env[Math.floor(t)] ?? 0, env[Math.ceil(t)] ?? 0);
    if (s > phaseScore) {
      phaseScore = s;
      bestPhase = ph;
    }
  }
  const beats: number[] = [];
  // A frame's energy jumps when its window first reaches the hit: the hit is `win` samples after the frame start.
  const lead = win / sr;
  for (let t = bestPhase; t < frames; t += period) beats.push(Math.round((t / fps + lead) * 1000) / 1000);
  // The drop: the biggest rise in 2-second average energy, after the first 4 s.
  let drop: number | null = null, rise = 0;
  const w = Math.round(2 * fps);
  for (let i = Math.round(4 * fps); i + w < frames; i += Math.round(fps / 4)) {
    let a = 0, b = 0;
    for (let k = 0; k < w; k++) {
      a += energy[i - w + k] ?? 0;
      b += energy[i + k];
    }
    if (b - a > rise) {
      rise = b - a;
      drop = i / fps + lead;
    }
  }
  if (drop != null && beats.length) drop = beats.reduce((p, c) => (Math.abs(c - drop!) < Math.abs(p - drop!) ? c : p), beats[0]);
  return { bpm: Math.round(best * 10) / 10, beats, duration: pcm.length / sr, drop };
}

export async function listDir(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}
