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
// Resource packages (free call, QPS <= 1): which packages are live and what's left (Kling notes a 12 h delay on "remaining").
const now = Date.now();
const c = await fetch(`https://api-singapore.klingai.com/account/costs?start_time=${now - 365 * 86400000}&end_time=${now + 86400000}`, { headers: { Authorization: `Bearer ${key}` } });
const cj = await c.json().catch(() => ({}));
for (const p of cj.data?.resource_pack_subscribe_infos ?? [])
  console.log(`package: ${p.resource_pack_name} · tier ${p.resource_pack_tier} · ${p.status} · ${p.remaining_quantity}/${p.total_quantity} units · ${p.resource_pack_applicable_models ?? ""} · expires ${new Date(p.invalid_time).toISOString().slice(0, 10)}`);
if (!(cj.data?.resource_pack_subscribe_infos ?? []).length) console.log(`packages: none (${cj.code} ${cj.message ?? ""})`);
// node scripts/creative/kling-check.mjs <taskId> — that task's status (no key printed).
if (process.argv[2]) {
  const t = await fetch(`https://api-singapore.klingai.com/tasks?task_ids=${encodeURIComponent(process.argv[2])}`, { headers: { Authorization: `Bearer ${key}` } });
  const tj = await t.json().catch(() => ({}));
  const x = tj.data?.[0];
  console.log(`task ${process.argv[2]}: ${x?.status ?? tj.message} ${x?.message ?? ""} · video: ${x?.outputs?.some((o) => o.type === "video") ? "yes" : "no"} · billed ${x?.usage?.output_duration ?? "-"} s`);
}
// node scripts/creative/kling-check.mjs <taskId> --url — also print the video's download link (Kling keeps it 30 days).
if (process.argv[2] && process.argv.includes("--url")) {
  const t = await fetch(`https://api-singapore.klingai.com/tasks?task_ids=${encodeURIComponent(process.argv[2])}`, { headers: { Authorization: `Bearer ${key}` } });
  const tj = await t.json().catch(() => ({}));
  console.log(`url: ${tj.data?.[0]?.outputs?.find((o) => o.type === "video")?.url ?? "-"}`);
}
// node scripts/creative/kling-check.mjs --voices — how many voice-actor library voices, and a few names.
if (process.argv.includes("--voices")) {
  const v = await fetch("https://api-singapore.klingai.com/v1/general/presets-voices?pageNum=1&pageSize=200", { headers: { Authorization: `Bearer ${key}` } });
  const vj = await v.json().catch(() => ({}));
  const all = (vj.data ?? []).flatMap((t) => t.task_result?.voices ?? []);
  console.log(`library voices: ${all.length} (with a sample: ${all.filter((x) => x.trial_url).length}) · e.g. ${all.slice(0, 12).map((x) => x.voice_name).join(", ")}`);
}
