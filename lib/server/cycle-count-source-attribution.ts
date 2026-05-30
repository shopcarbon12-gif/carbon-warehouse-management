import type { Pool, PoolClient } from "pg";

/**
 * Source attribution for cycle_count_sessions.scanned_epc_sources.
 *
 * Every path that appends to scanned_epcs (live SSE merge from cdm_reads,
 * direct POST /scan, mobile add-on close) calls into here so the source
 * map stays in lockstep with the EPC list. Schema:
 *
 *   { EPC_24_HEX: { kind: 'mobile' | 'reader', name: string, ts: ISO } }
 *
 * The map is "first-sighting wins" — if two paths see the same EPC, the
 * earlier-timestamped source stays. This matches how operators reason
 * about it: "who saw the tag first" is more useful than "who saw it
 * last," because the rest of the system already dedupes EPCs.
 */

export type EpcSourceKind = "mobile" | "reader";

export type EpcSourceEntry = {
  kind: EpcSourceKind;
  name: string;
  ts: string;
};

export type EpcSourceMap = Record<string, EpcSourceEntry>;

/** Coerce whatever the database returned into a typed source map. */
export function parseSourceMap(raw: unknown): EpcSourceMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: EpcSourceMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const kind = o.kind === "mobile" || o.kind === "reader" ? o.kind : null;
    const name = typeof o.name === "string" ? o.name : "";
    const ts = typeof o.ts === "string" ? o.ts : "";
    if (!kind || !ts) continue;
    out[k.toUpperCase()] = { kind, name, ts };
  }
  return out;
}

/**
 * Merge a batch of source-tagged EPCs into the existing map. Earlier
 * sightings win — if the EPC already has an entry, the incoming one is
 * discarded. Caller is expected to pass timestamps it controls (e.g.
 * `read.ts` from cdm_reads or `entry.first_seen_iso` from add-on).
 */
export function mergeSourceMap(
  existing: EpcSourceMap,
  incoming: ReadonlyArray<{ epc: string; kind: EpcSourceKind; name: string; ts: string }>,
): EpcSourceMap {
  const out: EpcSourceMap = { ...existing };
  for (const it of incoming) {
    const epc = it.epc.replace(/\s/g, "").toUpperCase();
    if (!epc) continue;
    if (out[epc]) continue; // first-sighting wins
    out[epc] = { kind: it.kind, name: it.name, ts: it.ts };
  }
  return out;
}

/**
 * Persist the merged source map back to a single session row. Caller
 * passes a transaction client when the source update needs to be in the
 * same txn as the scanned_epcs append (most callers do).
 */
export async function writeSourceMap(
  client: Pool | PoolClient,
  sessionId: string,
  map: EpcSourceMap,
): Promise<void> {
  await client.query(
    `UPDATE cycle_count_sessions
        SET scanned_epc_sources = $2::jsonb
      WHERE id = $1::uuid`,
    [sessionId, JSON.stringify(map)],
  );
}

/**
 * Convenience for callers that want to read + merge + write in one
 * round-trip — they pass in the new sightings and we handle the JSON
 * shuffle. Returns the post-merge map so the caller can re-emit it on
 * an SSE channel etc.
 */
export async function appendSourceSightings(
  client: Pool | PoolClient,
  sessionId: string,
  sightings: ReadonlyArray<{ epc: string; kind: EpcSourceKind; name: string; ts: string }>,
): Promise<EpcSourceMap> {
  const cur = await client.query<{ scanned_epc_sources: unknown }>(
    `SELECT scanned_epc_sources FROM cycle_count_sessions WHERE id = $1::uuid`,
    [sessionId],
  );
  const existing = parseSourceMap(cur.rows[0]?.scanned_epc_sources);
  const merged = mergeSourceMap(existing, sightings);
  if (Object.keys(merged).length === Object.keys(existing).length) {
    return existing; // nothing new — skip the write
  }
  await writeSourceMap(client, sessionId, merged);
  return merged;
}

/**
 * Extract the distinct reader / mobile names from a source map. Used by
 * the workspace filter dropdown.
 */
export function distinctSourceNames(map: EpcSourceMap): {
  mobiles: string[];
  readers: string[];
} {
  const mobiles = new Set<string>();
  const readers = new Set<string>();
  for (const v of Object.values(map)) {
    if (!v?.name) continue;
    if (v.kind === "mobile") mobiles.add(v.name);
    else if (v.kind === "reader") readers.add(v.name);
  }
  return {
    mobiles: [...mobiles].sort((a, b) => a.localeCompare(b)),
    readers: [...readers].sort((a, b) => a.localeCompare(b)),
  };
}
