import { spawn } from "node:child_process";
import { log } from "./log.js";
import type { AgentEnv } from "./config.js";
import { postWiznetDiscoveries } from "./wms-client.js";

/**
 * Periodically discovers every WIZnet bridge on the local LAN via
 * `wiznet-cli -d` and reports the result to the WMS so it can:
 *   1. Auto-track IP changes for KNOWN readers (matched by MAC).
 *   2. Surface NEW readers in the hardware-config UI for adoption.
 *
 * `wiznet-cli` requires sudo to do its UDP discovery broadcast, so we
 * shell out to `sudo -n` (the agent runs as `shopcarbon`, which has
 * passwordless sudo on the CarbonCDM VM by design).
 *
 * Sample output (one device per line, repeated up to 4× per UDP probe):
 *   1. 0008DC1E1980  192.168.1.22  255.255.255.0  192.168.1.1  10002  N  115200 8N1  SERVER(2)  20  N
 *
 * We dedupe by MAC and keep the most recent IP for each.
 */

const DEFAULT_INTERVAL_MS = 60_000;
const WIZNET_CLI = "/opt/legacy-rfid/wiznet-cli";
const SCAN_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 30_000;
const RESET_TIMEOUT_MS = 30_000;
/**
 * Carbon network's expected gateway. Bridges with a different gateway in
 * NVRAM came from a previous network/install and need their config wiped.
 */
const EXPECTED_GATEWAY = "192.168.1.1";
/**
 * Standard WIZnet inactivity timeout (seconds). 0 = disabled (bridge never
 * auto-drops a client). Was 20s before 2026-05-12 — that turned out to be
 * the FLEET-WIDE wedge source: any chip that goes silent for >20 s (which
 * is normal during inventory startup, multi-second tagFocus pauses, or a
 * brief PLL relock) causes the bridge to FIN-close its TCP client. The
 * new_monsoonreader binary then sits in CLOSE-WAIT forever — TCP looks
 * "ESTAB" to it, `recvfrom() = 0` (EOF) ignored — and the chip stops
 * receiving reader commands. Symptom: reader reads briefly post-spawn
 * then goes permanently dark. Verified 2026-05-12 against .18 / .225:
 * setting `inactivity=0` made both recover to top-tier read rates and
 * sustain. The earlier 2026-05-09 .69 misdiagnosis (562 reads / 1 unique
 * after antenna test) was actually a separate test-mode loop bug that
 * had nothing to do with the bridge's idle timer; the supervisor's
 * antenna-test cleanup path was incorrectly blamed.
 */
const EXPECTED_INACTIVITY = 0;
/** Carbon network's expected control port for MonsoonReader. */
const EXPECTED_PORT = 10002;
/**
 * MACs we've already attempted to lock in this agent process. Prevents
 * re-issuing wiznet-cli against a bridge whose first lock attempt failed
 * for a non-recoverable reason (e.g. the bridge isn't responding to UDP
 * config commands). The set resets on agent restart, so a transient
 * failure can recover after a systemd respawn.
 */
const LOCK_ATTEMPTED = new Set<string>();
/**
 * MACs we've issued a "reset to fresh DHCP+SERVER+10002" command to in
 * this process. Same one-shot semantics as LOCK_ATTEMPTED. After a
 * successful reset the bridge reboots and reappears with new config —
 * the next tick re-evaluates it (most likely DHCP=Y and the auto-lock
 * pins it). Retried on failure (deleted from set on non-zero exit).
 */
const RESET_ATTEMPTED = new Set<string>();

/**
 * MACs we've issued an inactivity normalization to (Inactivity != 20 →
 * Inactivity = 20) in this agent process. One-shot per MAC; on failure
 * the entry is removed so the next sweep retries.
 */
const INACTIVITY_NORMALIZED = new Set<string>();

type WiznetRecord = {
  mac: string;
  ip: string;
  port: number;
  dhcp: boolean;
  /** Operating mode reported by wiznet-cli: "SERVER", "MIXED", "CLIENT". */
  mode: string;
  /** Inactivity timeout in seconds, 0 = disabled. */
  inactivity: number;
  raw: Record<string, string>;
};

function parseWiznetCliOutput(text: string): WiznetRecord[] {
  const out = new Map<string, WiznetRecord>();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    // Match a row like (full layout: index, MAC, IP, netmask, gateway,
    // port, DHCP, baud, framing, mode, inactivity, hasclient):
    //   "  1. 0008DC1E1980  192.168.1.22  255.255.255.0  192.168.1.1  10002  N  115200  8N1  SERVER(2)  20  N"
    const m = line.trim().match(
      /^\d+\.\s+([0-9A-Fa-f]{12})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s+([YN])\s+\d+\s+\S+\s+(\w+)(?:\([^)]*\))?\s+(\d+)\b/,
    );
    if (!m || m.length < 9) continue;
    const macUpper = m[1]!.toUpperCase();
    out.set(macUpper, {
      mac: macUpper,
      ip: m[2]!,
      port: Number(m[5]),
      dhcp: m[6] === "Y",
      // Strip the trailing "(N)" parenthetical so callers can compare
      // against the bare keyword: "SERVER", "MIXED", "CLIENT".
      mode: m[7]!,
      inactivity: Number(m[8]),
      raw: {
        netmask: m[3]!,
        gateway: m[4]!,
      },
    });
  }
  return [...out.values()];
}

async function runWiznetDiscovery(): Promise<WiznetRecord[]> {
  return await new Promise((resolve) => {
    const child = spawn("sudo", ["-n", WIZNET_CLI, "-d"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (records: WiznetRecord[]) => {
      if (done) return;
      done = true;
      resolve(records);
    };
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    child.on("error", (e) => {
      log.warn("wiznet-discovery: spawn failed", { err: e.message });
      finish([]);
    });
    child.on("exit", () => {
      if (stderr.trim()) log.debug("wiznet-discovery stderr", { stderr: stderr.slice(0, 200) });
      finish(parseWiznetCliOutput(stdout));
    });
    setTimeout(() => {
      if (done) return;
      log.warn("wiznet-discovery: timed out, killing child");
      child.kill("SIGTERM");
      finish([]);
    }, SCAN_TIMEOUT_MS);
  });
}

/**
 * Decide whether a bridge's NVRAM config is incompatible with this
 * Carbon network and needs to be wiped back to a clean DHCP+SERVER+10002
 * baseline before we let the rest of the pipeline see it.
 *
 * Four triggers:
 *
 *   1. **IP collision** — two static bridges advertising the same IP.
 *      Whichever wins ARP at any given moment is non-deterministic, so
 *      MonsoonReader can't reliably reach the right device. Reset both;
 *      after they reboot, DHCP gives each a unique address.
 *
 *   2. **Wrong gateway** — bridge's gateway in NVRAM isn't this LAN's
 *      gateway. That's the calling-card of a unit pre-flashed for a
 *      different installation site or factory test bench. Whatever IP
 *      it claims is meaningless to us.
 *
 *   3. **Wrong mode** — bridge isn't in SERVER mode. MonsoonReader
 *      expects the bridge to push serial bytes over TCP on connect;
 *      MIXED/CLIENT modes don't, which is why the binary appears to
 *      "connect cleanly" then exit with zero records.
 *
 *   4. **Wrong port** — bridge's NVRAM TCP port isn't 10002. Some
 *      pre-flashed spares come back from a previous install with
 *      port 1461 (WIZnet factory default) or other site-specific
 *      values. The supervisor can fall back to 1461 in its candidate
 *      list, but operationally we want every Carbon bridge speaking
 *      10002 so config is uniform across the fleet.
 *
 * Returns the trigger reason for logging, or null if the bridge is fine.
 */
function bridgeNeedsReset(r: WiznetRecord, allRecords: WiznetRecord[]): string | null {
  if (!r.dhcp) {
    const conflicting = allRecords.find(
      (o) => o.ip === r.ip && o.mac !== r.mac && !o.dhcp,
    );
    if (conflicting) return `ip_collision_with_${conflicting.mac}`;
  }
  const gw = r.raw.gateway;
  if (gw && gw !== EXPECTED_GATEWAY) return `wrong_gateway_${gw}`;
  if (r.mode && r.mode !== "SERVER") return `wrong_mode_${r.mode}`;
  if (r.port && r.port !== EXPECTED_PORT) return `wrong_port_${r.port}`;
  return null;
}

/**
 * Wipe a bridge's NVRAM back to a clean Carbon baseline:
 *   --dhcp           (release the static IP)
 *   --mode-server    (force SERVER mode for MonsoonReader)
 *   --port 10002     (the canonical Carbon control port)
 *
 * Bridge reboots on config write. When it comes back ~10 s later it'll
 * be on DHCP — the next discovery tick will see it again and the
 * existing lockBridgeStatic() pins whatever fresh address it received.
 *
 * Symptom we're treating: a unit pre-configured by a previous installer
 * (different gateway, MIXED mode, hardcoded to .248 from a prior site)
 * stomps on the LAN. Operator plugs it in expecting normal behavior;
 * gets ARP races and silent reader failures instead. Auto-resetting
 * means the operator can take any spare bridge from the shelf, plug it
 * in, and the agent will normalize it within one sweep cycle.
 */
async function resetBridgeBadConfig(record: WiznetRecord): Promise<boolean> {
  return resetBridgeBadConfigImpl(record.mac, record.ip);
}

/**
 * Public API for callers that have only a MAC (no full WiznetRecord) and
 * want to wipe a bridge's NVRAM back to DHCP + SERVER mode + port 10002.
 * Used by the supervisor's reader-deletion path so the bridge is ready
 * for re-deployment without manual operator intervention.
 *
 * Tolerant of failure (returns false). Caller should not assume the
 * bridge is reachable — it may already be unplugged or hardware-failed,
 * in which case the wipe is a best-effort no-op.
 */
export async function wipeBridgeToDhcp(mac: string, ipForLogs: string): Promise<boolean> {
  return resetBridgeBadConfigImpl(mac, ipForLogs);
}

/**
 * Run wiznet-cli -d, return every discovered bridge that is currently on
 * a STATIC IP whose MAC is not in `knownMacs`. These are orphans: a
 * bridge that was previously adopted (so it was set static at adoption
 * time) but is no longer in WMS. Caller can wipe them so the bridge
 * goes back to DHCP and either disappears or re-appears for adoption.
 *
 * Healthy adoption flow is unaffected — freshly-plugged bridges arrive
 * with DHCP=Y and are skipped by this filter.
 */
export async function findOrphanStaticBridges(
  knownMacs: ReadonlySet<string>,
): Promise<{ mac: string; ip: string }[]> {
  const records = await runWiznetDiscovery();
  const normalized = new Set<string>();
  for (const m of knownMacs) {
    const u = m.replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
    if (u.length === 12) normalized.add(u);
  }
  const out: { mac: string; ip: string }[] = [];
  for (const r of records) {
    if (r.dhcp) continue;
    if (normalized.has(r.mac)) continue;
    out.push({ mac: r.mac, ip: r.ip });
  }
  return out;
}

async function resetBridgeBadConfigImpl(mac: string, ip: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const args = [
      "-n",
      WIZNET_CLI,
      "--ipconfig",
      mac,
      "--dhcp",
      "--mode-server",
      "--port",
      String(EXPECTED_PORT),
      // Normalize inactivity at the same time we reset other config —
      // saves a second wiznet-cli invocation per fresh bridge.
      "--inactivity",
      String(EXPECTED_INACTIVITY),
    ];
    // detached:true puts sudo + wiznet-cli in their own process group so
    // we can SIGKILL the whole group on timeout. Without this, killing
    // sudo leaves wiznet-cli orphaned (sudo doesn't reliably forward
    // SIGTERM/SIGKILL to its child for non-interactive sessions, and
    // wiznet-cli's UDP retry loop ignores SIGTERM anyway). Live evidence
    // 2026-05-07: orphaned wiznet-cli processes survived 4+ days with
    // 72% CPU each, blocking subsequent bridge config attempts.
    const child = spawn("sudo", args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stderr = "";
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const groupKill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    child.on("error", (e) => {
      log.warn("wiznet-discovery: reset spawn failed", { mac, err: e.message });
      finish(false);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        log.warn("wiznet-discovery: reset returned non-zero", {
          mac,
          ip,
          code,
          stderr: stderr.trim().slice(0, 200),
        });
      }
      finish(code === 0);
    });
    setTimeout(() => {
      if (done) return;
      log.warn("wiznet-discovery: reset timed out, group-killing", { mac });
      groupKill();
      finish(false);
    }, RESET_TIMEOUT_MS);
  });
}

/**
 * Issue `wiznet-cli --ipconfig MAC --static-ip IP --static-gateway GW
 * --port PORT` to flip a DHCP-enabled bridge to a static lease at its
 * current IP. The bridge keeps the same address it already has — we're
 * not assigning a new one, just removing it from the DHCP pool so the
 * router can't move it later.
 *
 * Bridge accepts the config over UDP, writes NVRAM, and reboots its TCP
 * listener (clients reconnect ~5-10 s later). The agent's existing
 * watchdog handles the brief disconnect with no operator intervention.
 *
 * Tolerant of failure — the next discovery tick will see the bridge
 * still on DHCP and try again. The LOCK_ATTEMPTED set prevents tight
 * retry loops within a single agent process.
 */
/**
 * Issue `wiznet-cli --ipconfig MAC --inactivity 20` on a bridge whose
 * current Inactivity field isn't the expected value. Standalone path
 * for bridges that don't go through reset/lock (already DHCP-locked at
 * the right IP, just inherited a non-default inactivity from a prior
 * install or factory flash). Bridge accepts the config over UDP, writes
 * NVRAM, and reboots its TCP listener; existing reader connections are
 * dropped briefly. Tolerant of failure — the next sweep tick retries.
 */
async function normalizeInactivity(record: WiznetRecord): Promise<boolean> {
  return await new Promise((resolve) => {
    const args = [
      "-n",
      WIZNET_CLI,
      "--ipconfig",
      record.mac,
      "--inactivity",
      String(EXPECTED_INACTIVITY),
    ];
    // Same detached + group-kill rationale as resetBridgeBadConfig.
    const child = spawn("sudo", args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stderr = "";
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const groupKill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    child.on("error", (e) => {
      log.warn("wiznet-discovery: inactivity-normalize spawn failed", { mac: record.mac, err: e.message });
      finish(false);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        log.warn("wiznet-discovery: inactivity-normalize returned non-zero", {
          mac: record.mac,
          ip: record.ip,
          code,
          stderr: stderr.trim().slice(0, 200),
        });
      }
      finish(code === 0);
    });
    setTimeout(() => {
      if (done) return;
      log.warn("wiznet-discovery: inactivity-normalize timed out, group-killing", { mac: record.mac });
      groupKill();
      finish(false);
    }, RESET_TIMEOUT_MS);
  });
}

async function lockBridgeStatic(record: WiznetRecord): Promise<boolean> {
  return await new Promise((resolve) => {
    const args = [
      "-n",
      WIZNET_CLI,
      "--ipconfig",
      record.mac,
      "--static-ip",
      record.ip,
      "--static-gateway",
      record.raw.gateway ?? "192.168.1.1",
      "--static-netmask",
      record.raw.netmask ?? "255.255.255.0",
      "--port",
      String(record.port),
      // Pin inactivity at the same time we pin the static IP — one
      // bridge-reboot for all our standardization.
      "--inactivity",
      String(EXPECTED_INACTIVITY),
    ];
    // See resetBridgeBadConfig for why we need detached + group-kill: sudo
    // doesn't forward SIGTERM to wiznet-cli, so a stuck UDP retry loop
    // turns into a multi-day orphan that holds the bridge in mid-config
    // mode and blocks reader connections.
    const child = spawn("sudo", args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stderr = "";
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const groupKill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    child.on("error", (e) => {
      log.warn("wiznet-discovery: lock spawn failed", { mac: record.mac, err: e.message });
      finish(false);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        log.warn("wiznet-discovery: lock returned non-zero", {
          mac: record.mac,
          ip: record.ip,
          code,
          stderr: stderr.trim().slice(0, 200),
        });
      }
      finish(code === 0);
    });
    setTimeout(() => {
      if (done) return;
      log.warn("wiznet-discovery: lock timed out, group-killing", { mac: record.mac });
      groupKill();
      finish(false);
    }, LOCK_TIMEOUT_MS);
  });
}

/**
 * Starts a periodic WIZnet-discovery loop. Returns a stop() that cancels it.
 */
export function startWiznetDiscovery(env: AgentEnv): () => void {
  let stopped = false;
  const intervalMs = DEFAULT_INTERVAL_MS;

  const tick = async () => {
    if (stopped) return;
    try {
      const records = await runWiznetDiscovery();
      if (records.length === 0) {
        log.debug("wiznet-discovery: no devices found");
        return;
      }
      log.info("wiznet-discovery", { count: records.length });

      // Pass 1: bad-config reset.
      // Detect bridges whose NVRAM is incompatible with this Carbon LAN
      // (IP collision with another bridge, gateway from a previous network,
      // or non-SERVER mode that breaks MonsoonReader). Wipe them back to
      // DHCP+SERVER+10002 so the router can hand them a fresh address and
      // the next sweep brings them up cleanly.
      const toReset = new Set<string>();
      for (const r of records) {
        if (RESET_ATTEMPTED.has(r.mac)) continue;
        const reason = bridgeNeedsReset(r, records);
        if (reason) {
          RESET_ATTEMPTED.add(r.mac);
          toReset.add(r.mac);
          log.info("wiznet-discovery: bridge config invalid, resetting to DHCP+SERVER", {
            mac: r.mac,
            ip: r.ip,
            mode: r.mode,
            gateway: r.raw.gateway,
            reason,
          });
          const ok = await resetBridgeBadConfig(r);
          if (!ok) {
            // Reset failed — drop from RESET_ATTEMPTED so the next tick
            // can retry. Don't proceed with auto-lock for this bridge in
            // this tick; it's still in a bad state.
            RESET_ATTEMPTED.delete(r.mac);
          } else {
            // Reset succeeded — bridge is rebooting. When it reappears
            // (next tick) it'll be on DHCP and the auto-lock pass below
            // will pin its fresh IP. Clear LOCK_ATTEMPTED so we DO try
            // to re-lock the new state, even if a previous lock attempt
            // had already added this MAC.
            LOCK_ATTEMPTED.delete(r.mac);
          }
        }
      }

      // Pass 2: auto-lock any DHCP-enabled bridge to its current IP. Every
      // Carbon reader should be on a static lease so a router reboot or
      // DHCP pool recycle can't move it out from under us. Skip bridges
      // we just reset in pass 1 — they're rebooting and will reappear in
      // the next tick. One-shot per MAC per agent process; retried on the
      // next tick if the lock didn't take.
      const dhcpBridges = records.filter(
        (r) => r.dhcp && !LOCK_ATTEMPTED.has(r.mac) && !toReset.has(r.mac),
      );
      for (const r of dhcpBridges) {
        LOCK_ATTEMPTED.add(r.mac);
        log.info("wiznet-discovery: auto-locking bridge to static", {
          mac: r.mac,
          ip: r.ip,
          gateway: r.raw.gateway,
        });
        const ok = await lockBridgeStatic(r);
        if (!ok) {
          // Lock failed — drop from set so a future tick can retry once
          // the bridge is reachable again.
          LOCK_ATTEMPTED.delete(r.mac);
        }
      }

      // Pass 2.5: normalize Inactivity to EXPECTED_INACTIVITY (20s) for
      // bridges where it differs. Inactivity=0 was observed live on .69
      // (2026-05-09): when the supervisor SIGKILLs a runner, the resulting
      // TCP RST is silently dropped by the bridge with Inactivity=0, so
      // the slot stays pinned and the chassis MCU is stuck waiting for
      // an R2000 reply that never arrives. The 20s default lets the
      // bridge auto-evict dead clients within one watchdog window.
      // Skip MACs we just reset/locked (their NVRAM is already being
      // written; double-write would race the reboot).
      for (const r of records) {
        if (r.inactivity === EXPECTED_INACTIVITY) continue;
        if (INACTIVITY_NORMALIZED.has(r.mac)) continue;
        if (toReset.has(r.mac)) continue;
        if (dhcpBridges.some((d) => d.mac === r.mac)) continue;
        INACTIVITY_NORMALIZED.add(r.mac);
        log.info("wiznet-discovery: normalizing Inactivity", {
          mac: r.mac,
          ip: r.ip,
          fromInactivity: r.inactivity,
          toInactivity: EXPECTED_INACTIVITY,
        });
        const ok = await normalizeInactivity(r);
        if (!ok) {
          INACTIVITY_NORMALIZED.delete(r.mac);
        }
      }

      const result = await postWiznetDiscoveries(env, {
        discoveries: records.map((r) => ({
          mac: r.mac,
          ip: r.ip,
          port: r.port,
          dhcp: r.dhcp,
          raw: r.raw,
        })),
      });
      if (result.ip_updated > 0 || result.new_discoveries > 0) {
        log.info("wiznet-discovery: server response", result);
      }

      // Pass 3: server-recommended resets. Server flags bridges that
      // have been static-unbound across sweeps — pre-flashed NVRAM
      // from a prior install that local rules can't catch (the config
      // is structurally valid, just operationally stale). Issue the
      // same DHCP+SERVER+10002 reset we use for locally-detected bad
      // config; the bridge reboots, comes back DHCP, and the next
      // sweep's auto-lock pins it at a clean address.
      const recommended = result.reset_recommended ?? [];
      for (const macLower of recommended) {
        const macUpper = macLower.toUpperCase();
        if (RESET_ATTEMPTED.has(macUpper)) continue;
        const r = records.find((x) => x.mac === macUpper);
        if (!r) continue;
        RESET_ATTEMPTED.add(macUpper);
        log.info("wiznet-discovery: server-recommended reset (stale unbound)", {
          mac: r.mac,
          ip: r.ip,
        });
        const ok = await resetBridgeBadConfig(r);
        if (!ok) {
          RESET_ATTEMPTED.delete(macUpper);
        } else {
          LOCK_ATTEMPTED.delete(macUpper);
        }
      }
    } catch (e) {
      log.warn("wiznet-discovery: tick failed", {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // First tick after a short delay so the agent is fully reconciled before
  // we start poking at the LAN with sudo.
  setTimeout(() => void tick(), 30_000);
  const handle = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
