// Zone reports started with handheld 1.2.178 / the 2026-10-16 server; the
// owner's first STORE assignment (1,548 tags, handheld 0e59c1a08cbbcfa9,
// 2026-10-16 18:59:46Z) happened before, so it had no report. This rebuilds
// it from the zone_assign history rows — same CSV as writeZoneReport, dated
// at the original time. The tags that could NOT be assigned in that scan were
// never sent to the server, so the mode says the skipped list wasn't kept.
//
//   DATABASE_URL=… npx tsx --tsconfig tsconfig.json scripts/oneoffs/zone-report-backfill-2026-10-16.mts           # dry run
//   DATABASE_URL=… npx tsx --tsconfig tsconfig.json scripts/oneoffs/zone-report-backfill-2026-10-16.mts --write
import pg from "pg";
import type { ZoneReportLine } from "@/lib/server/assigned-zones";

const mod = <T,>(m: T): T => ((m as { default?: T }).default ?? m);
const { checkEpcsForZone, writeZoneReport } = mod(await import("@/lib/server/assigned-zones"));

const WRITE = process.argv.includes("--write");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 3 });

const hist = await pool.query<{ tenant_id: string; device_id: string; at: Date; epcs: string[]; zone: string }>(
  `SELECT tenant_id::text, device_id, min(created_at) AS at, array_agg(entity_reference ORDER BY entity_reference) AS epcs,
          min(new_value) AS zone
     FROM inventory_audit_logs
    WHERE reason = 'zone_assign' AND created_at < '2026-10-16T20:00:00Z'
    GROUP BY tenant_id, device_id, date_trunc('second', created_at)
    ORDER BY min(created_at)`,
);
console.log(hist.rows.map((h) => `${h.at.toISOString()} ${h.device_id} → ${h.zone}: ${h.epcs.length} tags`).join("\n"));
const already = await pool.query(`SELECT count(*)::int n FROM device_upload_logs WHERE workflow_mode LIKE 'Zone %'`);
if (already.rows[0].n > 0) {
  console.log(`zone reports already exist (${already.rows[0].n}) — nothing to do`);
  await pool.end();
  process.exit(0);
}
const loc = await pool.query<{ location_id: string }>(
  `SELECT z.location_id::text FROM assigned_zones z WHERE lower(z.name) = lower($1) AND z.archived_at IS NULL LIMIT 1`,
  [hist.rows[0]?.zone ?? ""],
);
const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const h of hist.rows) {
    const checked = await checkEpcsForZone(pool, h.tenant_id, loc.rows[0]!.location_id, h.epcs);
    const lines: ZoneReportLine[] = checked.map((c) => ({
      epc: c.epc,
      result: "assigned",
      reason: null,
      details: { ...c.details, zone: null },
      zoneAfter: h.zone,
    }));
    const id = await writeZoneReport(client, h.tenant_id, h.device_id, "assign", h.zone, lines);
    await client.query(
      `UPDATE device_upload_logs
          SET created_at = $2, workflow_mode = workflow_mode || ' (skipped list not kept — before reports)'
        WHERE id = $1`,
      [id, h.at],
    );
    console.log(`report ${id}: ${lines.length} lines`);
  }
  if (WRITE) {
    await client.query("COMMIT");
    console.log("written");
  } else {
    await client.query("ROLLBACK");
    console.log("DRY RUN — nothing changed");
  }
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  client.release();
  await pool.end();
}
