/**
 * CarbonWMS Creative — the music + SFX library (spec §7.4 / §12.1). Royalty-free or owner-licensed
 * files only (never trending commercial songs in ads); each upload is tempo-tagged by beat
 * detection and mood-tagged by the owner. "No music" exports leave room for trending audio added
 * inside Instagram.
 */
import type { Pool } from "pg";
import { detectBeats } from "./media";
import { putFile } from "./storage";

export type Track = { id: string; kind: "music" | "sfx"; name: string; storage_path: string; duration_s: number | null; bpm: number | null; beats: { beats: number[]; drop: number | null } | null; moods: string[]; license: string };

export async function addAudio(pool: Pool, tenantId: string, v: { kind: "music" | "sfx"; name: string; bytes: Buffer; contentType: string; moods: string[]; license: string }): Promise<Track> {
  const ext = /wav/.test(v.contentType) ? "wav" : /mp4|m4a|aac/.test(v.contentType) ? "m4a" : "mp3";
  const safe = v.name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60);
  const path = await putFile(`creative/audio/${tenantId}/${v.kind}/${Date.now()}-${safe}.${ext}`, v.bytes, v.contentType || "audio/mpeg");
  let bpm: number | null = null, duration: number | null = null, beats: { beats: number[]; drop: number | null } | null = null;
  try {
    const b = await detectBeats(v.bytes);
    duration = b.duration;
    if (v.kind === "music") {
      bpm = b.bpm;
      beats = { beats: b.beats, drop: b.drop };
    }
  } catch {
    /* tagging failed — still usable, just not beat-synced */
  }
  const r = await pool.query<Track>(
    `INSERT INTO creative_audio (tenant_id, kind, name, storage_path, duration_s, bpm, beats, moods, license) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) RETURNING id::text, kind, name, storage_path, duration_s, bpm, beats, moods, license`,
    [tenantId, v.kind, v.name.slice(0, 120), path, duration, bpm, beats ? JSON.stringify(beats) : null, v.moods.map((m) => m.toLowerCase().trim()).filter(Boolean), v.license],
  );
  return r.rows[0];
}

export async function listAudio(pool: Pool, tenantId: string, kind?: "music" | "sfx"): Promise<Track[]> {
  const r = await pool.query<Track>(
    `SELECT id::text, kind, name, storage_path, duration_s, bpm, beats, moods, license FROM creative_audio WHERE tenant_id = $1::uuid AND ($2::text IS NULL OR kind = $2) ORDER BY created_at DESC`,
    [tenantId, kind ?? null],
  );
  return r.rows;
}

/** The track closest to the concept's mood + BPM; `avoid` = tracks used recently / rejected. */
export function pickTrack(tracks: Track[], want: { mood: string; bpm: number }, avoid: string[] = []): Track | null {
  const music = tracks.filter((t) => t.kind === "music" && (t.duration_s ?? 0) >= 8);
  if (!music.length) return null;
  const words = want.mood.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
  const score = (t: Track) =>
    (t.moods.some((m) => words.some((w) => m.includes(w))) ? 30 : 0) - Math.abs((t.bpm ?? want.bpm) - want.bpm) - (avoid.includes(t.id) ? 50 : 0) + (t.beats?.drop != null ? 3 : 0);
  return [...music].sort((a, b) => score(b) - score(a))[0];
}

/** SFX by name keyword: whoosh, rustle, shutter, bass … → track id. */
export function sfxIndex(tracks: Track[]): Record<string, Track> {
  const out: Record<string, Track> = {};
  for (const t of tracks.filter((x) => x.kind === "sfx")) {
    const n = t.name.toLowerCase();
    for (const key of ["whoosh", "rustle", "fabric", "shutter", "bass", "impact", "riser", "click", "pop", "glitch", "swoosh", "hit"]) if (n.includes(key) && !out[key]) out[key] = t;
  }
  if (out.fabric && !out.rustle) out.rustle = out.fabric;
  if (out.impact && !out.bass) out.bass = out.impact;
  if (out.swoosh && !out.whoosh) out.whoosh = out.swoosh;
  return out;
}

export function sfxFor(name: string, idx: Record<string, Track>): Track | null {
  const n = name.toLowerCase();
  for (const [k, t] of Object.entries(idx)) if (n.includes(k)) return t;
  return null;
}
