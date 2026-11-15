#!/usr/bin/env node
/** Is KLING_API_KEY (from .env.agent-secrets or the env) accepted by Kling? Prints Kling's answer only, never the key. */
import fs from "node:fs";
let key = (process.env.KLING_API_KEY || "").trim();
if (!key && fs.existsSync(".env.agent-secrets")) {
  const m = fs.readFileSync(".env.agent-secrets", "utf8").match(/^KLING_API_KEY=(.*)$/m);
  key = (m?.[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
}
if (!key) { console.log("KLING_API_KEY is empty"); process.exit(1); }
const r = await fetch("https://api-singapore.klingai.com/v1/general/presets-voices?pageNum=1&pageSize=3", { headers: { Authorization: `Bearer ${key}` } });
const j = await r.json().catch(() => ({}));
console.log(`HTTP ${r.status} · code ${j.code} · ${j.message ?? ""} · preset voices returned: ${Array.isArray(j.data) ? j.data.length : "-"}`);
