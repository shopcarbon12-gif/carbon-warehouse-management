import type { AgentEnv } from "./config.js";
import { AGENT_VERSION } from "./config.js";
import { log } from "./log.js";

export type AgentConfigAntenna = {
  id: string;
  name: string;
  antenna_number: number;
  transmit_power_dbm: number;
  enabled: boolean;
  /** ISO timestamp when an operator clicked TEST. null = no test pending. */
  test_pending_at: string | null;
  /** Operator-saved radio defaults from /antenna_test → "Save as default"; agent
   *  uses these for the normal-scan spawn path. transmit_power_dbm above is
   *  still the canonical source for the power dimension. */
  behaviour?: {
    read_time_ms: number;
    cycle_mode: "infinite" | "oscillating";
    tag_focus: boolean;
  };
};

export type AgentConfigReader = {
  id: string;
  name: string;
  device_type: string;
  network_address: string | null;
  model: string;
  monsoon_serial_port: number;
  stream_port: number;
  control_port: number;
  antenna_count: number;
  epc_prefix: string;
  /** Which Mojix binary the supervisor should drive for this reader.
   *  - "stream"  (default): legacy 2019 `MonsoonReader --stream` over TCP.
   *  - "console": 2024 `new_monsoonreader --console` over stdout. Continuous
   *               stream, CRC-filtered at the binary, no watchdog needed.
   *  Server omits the field on older bundles → treat missing as "stream". */
  monsoon_driver?: "stream" | "console";
  zone_id: string | null;
  zone_name: string | null;
  antennas: AgentConfigAntenna[];
  /** Per-reader pause flag computed server-side (manual pause OR
   *  schedule window). True → supervisor treats this reader as if it
   *  were absent from the bundle (kills child, no spawn). Older WMS
   *  bundles may omit; treat missing as false (not paused). */
  effective_paused?: boolean;
};

export type AgentConfigBundle = {
  agent: { id: string; name: string; location_id: string; location_code: string };
  readers: AgentConfigReader[];
  server_time: string;
  /** Master scan toggle. When false, the supervisor pauses ALL readers
   *  (kills children, stops spawning) regardless of any per-reader
   *  config. Driven by the dashboard's live-scan tile — set to true
   *  while a session is active for this tenant, false otherwise. Older
   *  WMS bundles may omit this; treat missing as `true` so we keep
   *  scanning the way the agent always did. */
  live_scan_active?: boolean;
};

export type HeartbeatStatus = "online" | "degraded";

function authHeaders(env: AgentEnv): Record<string, string> {
  return {
    authorization: `Bearer ${env.CARBON_CDM_TOKEN}`,
    "user-agent": `carbon-cdm/${AGENT_VERSION}`,
  };
}

async function request<T>(
  env: AgentEnv,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${env.CARBON_WMS_URL}${path}`;
  const headers: Record<string, string> = authHeaders(env);
  let serialized: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    serialized = JSON.stringify(body);
  }

  const res = await fetch(url, { method, headers, body: serialized });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep as text */
  }
  if (!res.ok) {
    const errMsg =
      parsed && typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : text || `HTTP ${res.status}`;
    throw new Error(`${method} ${path} failed: ${errMsg}`);
  }
  return parsed as T;
}

export type HeartbeatResponse = {
  ok: true;
  /** Server tells the agent to exit so systemd respawns it.
   *  Set when an admin clicks "Recover readers" in WMS. */
  restart_requested?: boolean;
};

export async function postHeartbeat(
  env: AgentEnv,
  payload: {
    agentVersion: string;
    hostname: string;
    status: HeartbeatStatus;
    bootTimeIso?: string;
  },
): Promise<HeartbeatResponse> {
  const r = await request<HeartbeatResponse>(
    env,
    "POST",
    "/api/cdm-agents/heartbeat",
    payload,
  );
  log.debug("heartbeat ok", { status: payload.status });
  return r;
}

export async function fetchAgentConfig(env: AgentEnv): Promise<AgentConfigBundle> {
  const bundle = await request<AgentConfigBundle>(env, "GET", "/api/cdm-agents/config");
  return bundle;
}

export type IngestReadsBody = {
  readerId: string;
  reads: { epcHex: string; antennaNumber?: number; rssi?: number; readAt?: string }[];
};

export async function postReads(
  env: AgentEnv,
  body: IngestReadsBody,
): Promise<{ inserted?: number }> {
  const r = await request<{ ok: boolean; inserted?: number }>(
    env,
    "POST",
    "/api/cdm-agents/reads",
    body,
  );
  return { inserted: r.inserted };
}

/**
 * Tell the WMS that a reader's supervisor has a healthy byte stream from
 * the chassis — used to flip `devices.status_online` true even when no
 * tags are currently in the antenna's coverage. See the WMS-side route
 * comment for the full rationale (chassis reachable != tags flowing).
 */
export async function postReaderOnline(env: AgentEnv, readerId: string): Promise<void> {
  await request(env, "POST", "/api/cdm-agents/reader-online", { readerId });
}

export type WiznetDiscoveryBody = {
  discoveries: {
    mac: string;
    ip: string;
    port: number;
    dhcp?: boolean;
    raw?: Record<string, unknown>;
  }[];
};

export type WiznetDiscoveryResponse = {
  ok: true;
  matched_known: number;
  ip_updated: number;
  new_discoveries: number;
  /**
   * Lowercased MACs the server is asking the agent to reset to
   * DHCP+SERVER+10002. Server emits these for static-unbound bridges
   * that have been stale across multiple sweeps — the equivalent of
   * "this NVRAM config is left over from somewhere else, normalize it."
   * Optional for forward-compat with older WMS deployments.
   */
  reset_recommended?: string[];
};

export async function postWiznetDiscoveries(
  env: AgentEnv,
  body: WiznetDiscoveryBody,
): Promise<WiznetDiscoveryResponse> {
  return await request<WiznetDiscoveryResponse>(
    env,
    "POST",
    "/api/cdm-agents/wiznet-discoveries",
    body,
  );
}

export type AntennaTestResult = {
  antennaId: string;
  foundAnyEpc: boolean;
  observedEpcCount: number;
  testStartedAt: string;
  testEndedAt: string;
};

export async function postAntennaTestResult(
  env: AgentEnv,
  body: AntennaTestResult,
): Promise<void> {
  await request(env, "POST", "/api/cdm-agents/antenna-test-result", body);
  log.info("antenna test result posted", {
    antennaId: body.antennaId,
    foundAnyEpc: body.foundAnyEpc,
    count: body.observedEpcCount,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Antenna-test live mode (Phase 1 /antenna-test page)
// ──────────────────────────────────────────────────────────────────────────

export type ActiveAntennaTestSession = {
  id: string;
  readerId: string;
  antennaId: string;
  antennaNumber: number;
  flags: {
    powerArg: number;
    readTimeMs: number;
    cycleMode: "infinite" | "oscillating";
    tagFocus: boolean;
  };
  sweep: {
    startPowerArg: number;
    endPowerArg: number;
    stepPowerArg: number;
    dwellMs: number;
  } | null;
  startedAt: string;
};

export async function fetchActiveAntennaTestSessions(
  env: AgentEnv,
): Promise<ActiveAntennaTestSession[]> {
  const r = await request<{ sessions: ActiveAntennaTestSession[] }>(
    env,
    "GET",
    "/api/cdm-agents/active-sessions",
  );
  return r.sessions ?? [];
}

export type AntennaTestIngestRead = {
  epcHex: string;
  rssiDbm: number;
  antennaNumber: number;
  observedAt?: string;
  powerArg?: number;
};

export async function postAntennaTestReads(
  env: AgentEnv,
  body: {
    sessionId: string;
    reads: AntennaTestIngestRead[];
    stats?: { uniqueEpcs: number; totalReads: number; droppedBadCrc: number };
    sweepProgress?: {
      currentPowerArg: number;
      stepIndex: number;
      totalSteps: number;
      stepEndsAtMs: number;
    };
  },
): Promise<void> {
  await request(env, "POST", "/api/antenna-test/ingest", body);
}
