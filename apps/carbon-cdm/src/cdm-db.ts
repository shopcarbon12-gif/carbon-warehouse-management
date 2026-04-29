import { spawn } from "node:child_process";
import { log } from "./log.js";
import { renderReadersJson } from "./readers-json.js";
import type { AgentConfigBundle } from "./wms-client.js";

/**
 * Syncs the desired reader set into cdm's `readers` SQLite table inside
 * /opt/legacy-rfid/runtime/cdm.db.
 *
 * cdm's auto-start loop reads this table on every cycle: any row with
 * action=1 that isn't currently running gets a MonsoonReader/rfidapi
 * subprocess spawned for it. The legacy `readers.json` file is *not*
 * picked up by the auto-start path — it was originally a sidecar dumped
 * by Athena (Senitron Cloud) for human inspection. We keep writing it
 * for parity but the SQLite table is the source of truth at runtime.
 *
 * We shell out to the `sqlite3` CLI (already on the VM via apt) instead
 * of pulling in a native node binding. The set of rows we sync is small
 * (≤ ~10 readers in our largest planned deployment), so a few exec()s
 * per minute is fine.
 */

const DEFAULT_CDM_DB = "/opt/legacy-rfid/runtime/cdm.db";

function sqliteEscape(s: string): string {
  // Single quotes are SQL string delimiter; double them up.
  return s.replace(/'/g, "''");
}

function runSqlite(dbPath: string, sql: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("sqlite3", [dbPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", () => resolve({ ok: false, stdout: "", stderr: "spawn failed" }));
    child.on("exit", (code) => resolve({ ok: code === 0, stdout, stderr }));
    child.stdin.end(sql);
  });
}

/**
 * Replace the readers table contents with the rows derived from `bundle`.
 * Returns true if the table content changed (caller may want to restart
 * the orchestrator so cdm sees the new ip_address / command / etc.).
 *
 * The table is created lazily by cdm itself when it first opens cdm.db,
 * so this function is safe to call before cdm has ever run — the INSERTs
 * will simply fail silently and we'll sync on the next cycle.
 */
export async function syncReadersToCdmDb(
  bundle: AgentConfigBundle,
  dbPath: string = DEFAULT_CDM_DB,
): Promise<boolean> {
  const desired = renderReadersJson(bundle);

  // Snapshot the current rows so we can diff. A trailing | per column makes
  // the comparison unambiguous (sqlite3 default separator is the pipe).
  const cur = await runSqlite(
    dbPath,
    "SELECT deviceId, name, ip_address, antennas, command, location_id, action, encode_power, rssi_filter FROM readers ORDER BY deviceId;",
  );
  if (!cur.ok && !cur.stderr.includes("no such table")) {
    log.warn("cdm.db readers snapshot failed", { stderr: cur.stderr.slice(0, 200) });
    return false;
  }
  const desiredKey = desired
    .map((r) => [r.deviceId, r.name, r.ip_address, r.antennas, r.command, r.location_id, r.action, r.encode_power, r.rssi_filter].join("|"))
    .sort()
    .join("\n");
  const currentKey = (cur.stdout ?? "").trim().split("\n").sort().join("\n");
  if (desiredKey === currentKey) return false;

  // Build a single transaction: wipe the table, then re-insert all desired rows.
  // We don't try to be clever with upserts — full replace is simpler and the
  // row count is tiny.
  const inserts = desired.map((r) => {
    const cols = [
      "deviceId", "cache_interval", "upload_interval", "reader_type", "name",
      "command", "test_command", "ip_address", "tenant_code", "location_id",
      "endpoint_url", "antennas", "action", "epc_pattern", "epc_prefix",
      "rssi_filter", "session_key", "extract_startbit", "extract_endbit",
      "theft_ping_epc", "encode_power",
    ];
    const vals = [
      String(r.deviceId),
      String(r.cache_interval),
      String(r.upload_interval),
      String(r.reader_type),
      `'${sqliteEscape(r.name)}'`,
      `'${sqliteEscape(r.command)}'`,
      `'${sqliteEscape(r.test_command)}'`,
      `'${sqliteEscape(r.ip_address)}'`,
      `'${sqliteEscape(r.tenant_code)}'`,
      `'${sqliteEscape(r.location_id)}'`,
      `'${sqliteEscape(r.endpoint_url)}'`,
      `'${sqliteEscape(r.antennas)}'`,
      String(r.action),
      `'${sqliteEscape(r.epc_pattern)}'`,
      `'${sqliteEscape(r.epc_prefix)}'`,
      String(r.rssi_filter),
      `'${sqliteEscape(r.session_key)}'`,
      String(r.extract_startbit),
      String(r.extract_endbit),
      `'${sqliteEscape(r.theft_ping_epc)}'`,
      String(r.encode_power),
    ];
    return `INSERT INTO readers (${cols.join(",")}) VALUES (${vals.join(",")});`;
  }).join("\n");

  const sql = [
    "BEGIN;",
    "DELETE FROM readers;",
    inserts,
    "COMMIT;",
  ].join("\n");

  const res = await runSqlite(dbPath, sql);
  if (!res.ok) {
    if (res.stderr.includes("no such table")) {
      log.info("cdm.db readers table not yet created — cdm will create it on first start; will retry next cycle");
      return false;
    }
    log.warn("cdm.db readers sync failed", { stderr: res.stderr.slice(0, 400) });
    return false;
  }
  log.info("cdm.db readers synced", { count: desired.length });
  return true;
}
