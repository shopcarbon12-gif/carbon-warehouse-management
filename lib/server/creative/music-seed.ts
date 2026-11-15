/**
 * CarbonWMS Creative — the starter music (owner, 2026-11-15: the Music tab was empty, so every video
 * came out silent). Tracks from the HeyGen music library live in public/creative-music (manifest.json,
 * filled by scripts/creative/fetch-heygen-music.mjs). Job `music_seed` loads each one not yet in the
 * library into the Music tab — beat-detected and mood-tagged like an upload.
 */
import type { JobHandler } from "./jobs";
import { addAudio, listAudio } from "./audio";
import { WMS_BASE } from "./storage";

type Entry = { id: string; file: string; name: string; moods: string[] };

export const musicSeed: JobHandler = async (pool, job, setProgress) => {
  const base = WMS_BASE.replace(/\/+$/, "");
  // During a deploy the old app may answer with a login redirect (HTML) or a 404: wait, don't fail — and give up
  // after ~1 hour rather than waiting forever.
  const tries = Number((job.payload as { tries?: number }).tries ?? 0);
  const m = await fetch(`${base}/creative-music/manifest.json`, { signal: AbortSignal.timeout(30_000), redirect: "manual" }).catch(() => null);
  const isJson = Boolean(m?.ok && /json/i.test(m.headers.get("content-type") ?? ""));
  if (!isJson) {
    if (tries >= 30) return { status: "done", progress: "The music list wasn't reachable — add tracks on the Music tab" };
    return { status: "waiting", afterSeconds: 120, payload: { ...job.payload, tries: tries + 1 }, progress: "Waiting for the new web app to serve the music" };
  }
  const { tracks } = (await m!.json()) as { tracks: Entry[] };
  const have = new Set((await listAudio(pool, job.tenant_id, "music")).map((t) => t.name));
  let added = 0;
  for (const [i, t] of tracks.entries()) {
    if (have.has(t.name)) continue;
    await setProgress(`Adding music ${i + 1} of ${tracks.length}: ${t.name.slice(0, 60)}`);
    const r = await fetch(`${base}/creative-music/${encodeURIComponent(t.file)}`, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`music ${t.file} HTTP ${r.status}`);
    await addAudio(pool, job.tenant_id, { kind: "music", name: t.name, bytes: Buffer.from(await r.arrayBuffer()), contentType: "audio/mpeg", moods: t.moods, license: "HeyGen music library" });
    added++;
  }
  return { status: "done", result: { added }, progress: `${added} tracks added to the Music tab` };
};
