import "dotenv/config";
import { hostname } from "node:os";
import { z } from "zod";

const envSchema = z.object({
  CARBON_WMS_URL: z
    .string()
    .url()
    .transform((v) => v.replace(/\/$/, "")),
  CARBON_CDM_TOKEN: z.string().min(8).startsWith("cdm_"),
  CARBON_HEARTBEAT_INTERVAL_SEC: z.coerce.number().int().min(5).max(600).default(30),
  /**
   * How often the agent fetches the WMS config bundle. Lowered from 60 s
   * to 3 s to give the dashboard live-scan tile near-real-time pause/
   * resume propagation (≤3 s worst case). The bundle is small (a few
   * hundred bytes) and the query is fully indexed; load on the WMS at
   * 3 s polling for one agent is ~0.3 req/s, negligible. Override with
   * `CARBON_CONFIG_POLL_INTERVAL_SEC` env var if needed.
   */
  CARBON_CONFIG_POLL_INTERVAL_SEC: z.coerce.number().int().min(2).max(600).default(3),
  CARBON_MONSOON_BINARY: z.string().default("/opt/carbon-cdm/MonsoonReader"),
  CARBON_LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),
  CARBON_AGENT_HOSTNAME: z.string().optional(),
});

export type AgentEnv = z.infer<typeof envSchema>;

let cached: AgentEnv | null = null;

export function loadConfig(): AgentEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(
      `Invalid Carbon CDM environment. Check .env:\n${lines.join("\n")}`,
    );
  }
  cached = parsed.data;
  return cached;
}

export function effectiveHostname(env: AgentEnv): string {
  return env.CARBON_AGENT_HOSTNAME?.trim() || hostname();
}

export const AGENT_VERSION = "0.1.0";
