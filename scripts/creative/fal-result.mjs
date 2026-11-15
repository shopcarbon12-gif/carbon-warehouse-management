#!/usr/bin/env node
/** node scripts/creative/fal-result.mjs <response_url> <out.mp4> — download a finished fal request's video (key never printed). */
import fs from "node:fs";
let key = (process.env.FAL_KEY || "").trim();
for (const f of [".env.agent-secrets", ".env.local"]) {
  if (key || !fs.existsSync(f)) continue;
  const m = fs.readFileSync(f, "utf8").match(/^FAL_KEY=(.*)$/m);
  key = (m?.[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
}
if (!key) { console.log("no FAL_KEY"); process.exit(1); }
const r = await fetch(process.argv[2], { headers: { Authorization: `Key ${key}` } });
const j = await r.json().catch(() => ({}));
const url = j.video?.url;
console.log(`HTTP ${r.status} · video: ${url ? "yes" : "no"} ${JSON.stringify(j.detail ?? "").slice(0, 120)}`);
if (url && process.argv[3]) { const v = await fetch(url); fs.writeFileSync(process.argv[3], Buffer.from(await v.arrayBuffer())); console.log(`saved ${process.argv[3]}`); }
