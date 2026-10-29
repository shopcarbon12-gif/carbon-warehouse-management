/**
 * Stills from across a Social video, for the AI (owner, 2026-10-29: the AI
 * wrote a Reel's caption and tags from its cover alone, and the cover showed a
 * look that is not in the video). ffmpeg/ffprobe come from the container
 * (apk add ffmpeg in Dockerfile and Dockerfile.worker); without them this
 * returns no frames and callers fall back to the cover.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** `count` JPEG frames (base64), evenly spread from start to end, 640 px wide. */
export async function videoFrames(url: string, count = 8): Promise<string[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "social-frames-"));
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const file = path.join(dir, "video");
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    const duration = Number(probe.stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) return [];
    const frames: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const at = (duration * (i + 0.5)) / count;
      const out = await run(
        "ffmpeg",
        ["-v", "error", "-ss", at.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
        { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
      );
      if (out.stdout.length) frames.push(Buffer.from(out.stdout).toString("base64"));
    }
    return frames;
  } catch (e) {
    console.error("[video-frames]", e instanceof Error ? e.message : e);
    return [];
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
