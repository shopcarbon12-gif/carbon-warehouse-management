import http from "node:http";
import { log } from "./log.js";

/**
 * HTTP bridge: receives tag-read payloads from the legacy cdm process and
 * hands them off to a callback for forwarding to the WMS.
 *
 * cdm's `additional_endpoint_url` is configured to POST here. The payload
 * shape is whatever the legacy orchestrator emits — a single JSON object
 * per read OR a JSON array of reads per batch. Both are accepted.
 *
 * Each parsed read is normalized into Carbon CDM's own schema before being
 * passed to the consumer:
 *   { epcHex, antennaNumber?, rssi?, readAt? }
 */

export type IncomingTagRead = {
  epcHex: string;
  antennaNumber?: number;
  rssi?: number;
  readAt?: string;
  /** Original antenna_id string from the cdm payload (for debug routing). */
  antennaIdRaw?: string;
};

type ConsumeFn = (reads: IncomingTagRead[]) => void;

type LegacyReadObj = {
  EPC?: string;
  epc?: string;
  antenna_id?: string | number;
  antennaId?: string | number;
  RSSI?: number;
  rssi?: number;
  LastSeen?: string;
  FirstSeen?: string;
  last_seen?: string;
  read_at?: string;
};

function normalizeRead(obj: LegacyReadObj): IncomingTagRead | null {
  const epcRaw = (obj.EPC ?? obj.epc ?? "").toString().trim();
  if (!epcRaw) return null;
  const epcHex = epcRaw.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (epcHex.length === 0) return null;

  const antRaw = obj.antenna_id ?? obj.antennaId;
  const antennaIdRaw = antRaw !== undefined ? String(antRaw) : undefined;
  // Convention: legacy antenna_ids look like "101", "104", "201", etc.
  // The trailing digit (or last group) is typically the antenna number.
  // For safety we also accept plain "1".."32".
  let antennaNumber: number | undefined;
  if (antennaIdRaw !== undefined) {
    const n = Number(antennaIdRaw);
    if (Number.isFinite(n)) {
      if (n >= 1 && n <= 32) antennaNumber = Math.trunc(n);
      else {
        const last = Number(String(Math.trunc(n)).slice(-1));
        if (last >= 1 && last <= 9) antennaNumber = last;
      }
    }
  }

  const rssi =
    typeof obj.RSSI === "number" ? obj.RSSI :
    typeof obj.rssi === "number" ? obj.rssi : undefined;

  const readAt =
    obj.LastSeen ?? obj.last_seen ?? obj.read_at ?? obj.FirstSeen;

  return {
    epcHex,
    ...(antennaNumber !== undefined ? { antennaNumber } : {}),
    ...(rssi !== undefined ? { rssi } : {}),
    ...(readAt ? { readAt } : {}),
    ...(antennaIdRaw ? { antennaIdRaw } : {}),
  };
}

function parsePayload(body: string): IncomingTagRead[] {
  if (!body.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const out: IncomingTagRead[] = [];
  const objs: LegacyReadObj[] = Array.isArray(parsed)
    ? (parsed as LegacyReadObj[])
    : (typeof parsed === "object" && parsed !== null ? [parsed as LegacyReadObj] : []);
  for (const o of objs) {
    const r = normalizeRead(o);
    if (r) out.push(r);
  }
  return out;
}

export type CdmBridgeOptions = {
  host?: string;
  port?: number;
  onReads: ConsumeFn;
};

export function startCdmBridge(opts: CdmBridgeOptions): { close: () => void } {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8765;

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"ok":true,"service":"carbon-cdm-bridge"}`);
      return;
    }
    if (req.method !== "POST" || (req.url !== "/ingest" && req.url !== "/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(`{"error":"not found"}`);
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > 4 * 1024 * 1024) {
        aborted = true;
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      const body = Buffer.concat(chunks).toString("utf8");
      const reads = parsePayload(body);
      if (reads.length > 0) {
        try {
          opts.onReads(reads);
        } catch (e) {
          log.warn("cdm-bridge consumer threw", {
            err: e instanceof Error ? e.message : String(e),
          });
        }
        log.debug("cdm-bridge accepted", { count: reads.length });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"ok":true,"accepted":${reads.length}}`);
    });
    req.on("error", () => {
      aborted = true;
    });
  });

  server.listen(port, host, () => {
    log.info("cdm bridge listening", { host, port });
  });

  return {
    close: () => server.close(),
  };
}
