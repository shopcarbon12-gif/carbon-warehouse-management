import { Pool } from "pg";
import { listActivity } from "@/lib/server/activity-feed";
const pool = new Pool({ connectionString: process.env.TEST_DB, ssl: false, max: 3 });
pool.on("connect", (c) => { void c.query("SET default_transaction_read_only = on"); });
async function main() {
const tid = (await pool.query("SELECT id::text FROM tenants LIMIT 1")).rows[0].id;
const show = (label: string, r: Awaited<ReturnType<typeof listActivity>>) => {
  console.log(`\n== ${label}: ${r.rows.length} rows, next=${r.nextCursor ? "yes" : "no"}`);
  for (const x of r.rows.slice(0, 6)) console.log(`${x.at} | ${x.actor} | ${x.module} | ${x.action} | ${x.summary ?? ""} | ${x.item ? [x.item.product, x.item.color, x.item.size, x.item.sku, x.item.epc].filter(Boolean).join(" ") : ""} | ${x.source} ${x.sourceDetail ?? ""} | ${x.outcome}`);
};
let t = Date.now();
const p1 = await listActivity(pool, tid, { limit: 50 });
show(`default (${Date.now() - t}ms)`, p1);
t = Date.now();
const p2 = await listActivity(pool, tid, { limit: 50, cursor: p1.nextCursor });
show(`page 2 (${Date.now() - t}ms)`, p2);
const overlap = p2.rows.filter((r) => p1.rows.some((o) => o.id === r.id)).length;
console.log("overlap between pages:", overlap);
t = Date.now();
show(`readers on (${Date.now() - t}ms)`, await listActivity(pool, tid, { limit: 20, readers: true }));
t = Date.now();
show(`q=Excuse (${Date.now() - t}ms)`, await listActivity(pool, tid, { limit: 20, q: "Excuse" }));
t = Date.now();
show(`module=Readers & hardware`, await listActivity(pool, tid, { limit: 10, module: "Readers & hardware" }));
t = Date.now();
show(`q=F0A0B30E4F9CAB2000070335 readers (${Date.now() - t}ms)`, await listActivity(pool, tid, { limit: 10, q: "F0A0B30E4F9CAB2000070335", readers: true }));
await pool.end();

}
main().catch((e) => { console.error(e); process.exit(1); });
