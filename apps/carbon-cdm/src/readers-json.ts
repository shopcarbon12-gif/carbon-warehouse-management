import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentConfigBundle, AgentConfigReader } from "./wms-client.js";
import { log } from "./log.js";

/**
 * Renders the legacy orchestrator's `readers.json` from the WMS agent
 * config bundle. The file is written atomically (write to .tmp, rename).
 *
 * Returns true if the file changed (caller should restart the orchestrator).
 *
 * Reader-type mapping:
 *   "fixed_reader"          → SA-2000 (MonsoonReader-driven)
 *   "transaction_reader"    → SA-2000 (same driver, different scan policy)
 *   "door_reader"           → SA-2000 (same)
 *   later: a "zebra_reader" config field could pick the rfidapi driver
 */

type LegacyReadersFile = LegacyReaderEntry[];

type LegacyReaderEntry = {
  deviceId: number;
  name: string;
  ip_address: string;
  reader_type: number;
  antennas: string;
  command: string;
  test_command: string;
  cache_interval: number;
  encode_power: number;
  endpoint_url: string;
  epc_pattern: string;
  epc_prefix: string;
  extract_endbit: number;
  extract_startbit: number;
  rssi_filter: number;
  upload_interval: number;
  location_id: string;
  tenant_code: string;
  session_key: string;
  theft_ping_epc: string;
  // action: 1 means "should be running" — cdm checks this on every cycle
  // and (re)starts the reader if it's not active. Without it, cdm comes
  // up idle and only scans on a /api/pull/start HTTP trigger.
  action: number;
};

function legacyDeviceId(uuid: string, fallback: number): number {
  // Stable numeric id derived from the first 6 hex chars of the UUID, kept
  // small enough that legacy code (which uses numeric ids) handles it.
  const hex = uuid.replace(/[^0-9a-f]/gi, "").slice(0, 6);
  const n = parseInt(hex, 16);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // Compress to 4-digit range so antenna_ids like {readerId}{antNum} fit too.
  return 1000 + (n % 9000);
}

function buildMonsoonCommand(spec: AgentConfigReader): string {
  const enabled = spec.antennas.filter((a) => a.enabled);
  const avgPower = enabled.length
    ? enabled.reduce((s, a) => s + a.transmit_power_dbm, 0) / enabled.length
    : 30;
  const powerArg = Math.round(avgPower * 10);
  const parts = [
    "MonsoonReader",
    "--num", "1",
    "--cstream",
    "--stream", String(spec.stream_port),
    "--control", String(spec.control_port),
    "--read_time_ms", "1000",
    "--power", String(powerArg),
    "--serial_host", String(spec.network_address ?? ""),
    "--serial_port", String(spec.monsoon_serial_port),
    "--fastid",
    "--nocache",
  ];
  return parts.join(" ");
}

function buildZebraCommand(spec: AgentConfigReader): string {
  // Zebra FX9600 driven through the bundled rfidapi tool. Power is in tenths
  // of dBm. Default to all 4 antenna ports unless we have a specific list.
  const enabled = spec.antennas.filter((a) => a.enabled);
  const ants = enabled.length ? enabled.map((a) => a.antenna_number).join(",") : "1,2,3,4";
  const avgPower = enabled.length
    ? enabled.reduce((s, a) => s + a.transmit_power_dbm, 0) / enabled.length
    : 25;
  const powerArg = Math.round(avgPower * 10);
  return [
    "./zebra/app/rfidapi",
    String(spec.network_address ?? ""),
    "--infinite",
    "--power", String(powerArg),
    "--ant", ants,
  ].join(" ");
}

function buildEntry(
  spec: AgentConfigReader,
  idx: number,
  locationCode: string,
  tenantCode: string,
): LegacyReaderEntry {
  const isZebra = (spec.model ?? "").toLowerCase().includes("zebra")
                 || (spec.model ?? "").toLowerCase().includes("fx96");
  const command = isZebra ? buildZebraCommand(spec) : buildMonsoonCommand(spec);
  const deviceId = legacyDeviceId(spec.id, 100 + idx);
  const ants = spec.antennas
    .filter((a) => a.enabled)
    .map((a) => a.antenna_number)
    .sort((a, b) => a - b)
    .join(",") || "1";
  // cdm's ReaderType enum (from binary inspection):
  //   0=FIXED, 1=DOOR, 2=TRANSACTION, 3=AUTOMOTIVE, 4=MOCK, 5=THEFT, 6=FIXED_1SEC
  // FIXED is the always-on continuous scan mode appropriate for our
  // SA-2000 + MonsoonReader setup. TRANSACTION is for handheld-style
  // burst scans triggered per-transaction (which leaves MonsoonReader
  // idle waiting for commands and exiting after 25s).
  // For Zebra FX9600, DOOR (1) is the standard continuous-scan mode.
  const readerTypeInt = isZebra ? 1 : 0;
  return {
    deviceId,
    name: spec.name,
    ip_address: String(spec.network_address ?? ""),
    reader_type: readerTypeInt,
    antennas: ants,
    command,
    test_command: command,
    cache_interval: 1,
    encode_power: 250,
    // Even though disable_sending_data_to_endpoint_api is true in cdm.json,
    // the legacy code still uses this field for some routing decisions.
    // Point at our local bridge so any rogue posts go to /dev/null on us.
    endpoint_url: "http://127.0.0.1:8765/ingest",
    epc_pattern: spec.epc_prefix ? `${spec.epc_prefix}.*` : ".*",
    epc_prefix: spec.epc_prefix ?? "",
    extract_endbit: 40,
    extract_startbit: 20,
    rssi_filter: -200,
    upload_interval: 1,
    location_id: locationCode,
    tenant_code: tenantCode,
    session_key: "",
    theft_ping_epc: "",
    // action=1 → cdm's auto-start reconciliation will (re)launch the
    // reader subprocess on every `Checking reader auto-start` pass.
    action: 1,
  };
}

export function renderReadersJson(bundle: AgentConfigBundle): LegacyReadersFile {
  // tenant_code isn't a separate field on the bundle; we reuse the agent name
  // as a stable identifier — cdm only uses it for log lines.
  const tenantCode = bundle.agent.name;
  const locationCode = bundle.agent.location_code;
  return bundle.readers.map((r, i) => buildEntry(r, i, locationCode, tenantCode));
}

/**
 * Write the readers.json atomically. Returns true if the file content
 * changed (caller can use this to decide whether to restart the
 * orchestrator).
 */
export async function writeReadersJsonIfChanged(
  filePath: string,
  bundle: AgentConfigBundle,
): Promise<boolean> {
  const next = JSON.stringify(renderReadersJson(bundle));
  let current = "";
  try {
    current = (await fs.readFile(filePath, "utf8")).trim();
  } catch {
    current = "";
  }
  if (current === next) return false;
  const tmp = filePath + ".tmp";
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmp, next, "utf8");
  await fs.rename(tmp, filePath);
  log.info("readers.json updated", {
    path: filePath,
    readers: bundle.readers.length,
  });
  return true;
}
