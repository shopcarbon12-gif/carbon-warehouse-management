#!/usr/bin/env node
/**
 * CarbonWMS Creative — fill the Music tab from the HeyGen music library (owner, 2026-11-15: the Reels'
 * music came from HeyGen; CarbonWMS never had any). Runs on a PC where the `heygen` CLI is signed in
 * (`heygen auth login --oauth`). Searches the catalog per mood, downloads the top tracks, converts them to
 * mp3 into public/creative-music/ and writes manifest.json. Commit + deploy; the `music_seed` job then
 * loads every track into the Music tab (beat-detected, mood-tagged).
 *
 *   node scripts/creative/fetch-heygen-music.mjs [perMood=4]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const PER = Number(process.argv[2] || 4);
const OUT = path.resolve("public/creative-music");
const MOODS = [
  { moods: ["deep house"], query: "deep house, elegant groove, warm bass, fashion, no vocals" },
  { moods: ["tech house"], query: "tech house, driving bass, confident, runway, no vocals" },
  { moods: ["dark afro house", "afro house"], query: "dark afro house, tribal percussion, deep, night, no vocals" },
  { moods: ["lo-fi house", "lo-fi", "chill"], query: "lo-fi house, relaxed, warm, chill beat, no vocals" },
  { moods: ["chill", "ugc", "vlog"], query: "light chill background beat for a vlog, relaxed, positive, no vocals" },
  { moods: ["upbeat", "pop", "ugc"], query: "upbeat fashion try-on beat, fun, bright, no vocals" },
  { moods: ["luxury", "ambient", "minimal"], query: "luxury minimal electronic, slow, elegant, cinematic, no vocals" },
  { moods: ["hip hop", "street"], query: "street hip hop beat, confident, boom bap, no vocals" },
];

mkdirSync(OUT, { recursive: true });
const manifestPath = path.join(OUT, "manifest.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { tracks: [] };
const have = new Set(manifest.tracks.map((t) => t.id));

for (const m of MOODS) {
  const res = JSON.parse(execFileSync("heygen", ["audio", "sounds", "list", "--query", m.query, "--type", "music", "--limit", String(PER * 3)], { encoding: "utf8" }));
  let got = 0;
  for (const t of res.data ?? []) {
    if (got >= PER) break;
    if (have.has(t.id) || (t.duration ?? 0) < 20) continue;
    const file = `${m.moods[0].replace(/[^a-z0-9]+/g, "-")}-${t.id.slice(0, 8)}.mp3`;
    const tmp = path.join(OUT, `.${t.id}.src`);
    execFileSync("curl", ["-sSfL", "-o", tmp, t.audio_url]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", tmp, "-ac", "2", "-ar", "44100", "-b:a", "160k", path.join(OUT, file)]);
    execFileSync("rm", ["-f", tmp]);
    manifest.tracks.push({ id: t.id, file, name: `${m.moods[0]} — ${(t.description ?? "").slice(0, 70)}`, moods: m.moods, duration: t.duration, source: "HeyGen music library" });
    have.add(t.id);
    got++;
    console.log(`${m.moods[0]}: ${file} (${t.duration}s) ${t.description ?? ""}`);
  }
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`${manifest.tracks.length} tracks in ${manifestPath}`);
