import type { AgentEnv } from "./config.js";
import { AGENT_VERSION } from "./config.js";
import { log } from "./log.js";

export type AgentConfigAntenna = {
  id: string;
  name: string;
  antenna_number: number;
  transmit_power_dbm: number;
  enabled: boolean;
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
  zone_id: string | null;
  zone_name: string | null;
  antennas: AgentConfigAntenna[];
};

export type AgentConfigBundle = {
  agent: { id: string; name: string; location_id: string; location_code: string };
  readers: AgentConfigReader[];
  server_time: string;
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

export async function postHeartbeat(
  env: AgentEnv,
  payload: { agentVersion: string; hostname: string; status: HeartbeatStatus },
): Promise<void> {
  await request(env, "POST", "/api/cdm-agents/heartbeat", payload);
  log.debug("heartbeat ok", { status: payload.status });
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
