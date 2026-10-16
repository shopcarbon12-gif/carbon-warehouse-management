import type { Pool } from "pg";
import { parseCsv } from "@/lib/server/count-review";

/**
 * Count reports (owner, 2026-10-16): at the end of every count — desktop Cycle
 * Count, mobile Inventory Count, Add-On Count, Add-On Catalog — a summary plus
 * every NEW Unknown tag the count found (a fresh number never recorded in the
 * WMS, items.fresh_found_at) with all its information, and the defective tags.
 * The owner checks the new ones with Cloud + Geiger and changes them to LIVE
 * when found. Built live from the data, so a later download shows each tag's
 * status now ("Live — verified …") while still listing it.
 *
 * Also the standing list of every new tag still waiting (Reports → New
 * Unknown tags). Both feed the same Excel / PDF exporters (count-report-export).
 */

export type ReportTagRow = {
  epc: string;
  product: string | null;
  color: string | null;
  size: string | null;
  sku: string | null;
  upc: string | null;
  price: string | null;
  serial: string | null;
  bin: string | null;
  /** This count's read (ISO) and what read it. */
  readAt: string | null;
  readBy: string | null;
  /** When / what first found it as a new tag. */
  firstFoundAt: string | null;
  firstFoundBy: string | null;
  /** True when this count is where it was first found. */
  foundHere: boolean;
  lastSeenAt: string | null;
  statusNow: string;
};

export type ReportDefectRow = {
  epc: string;
  reason: string;
  readAt: string | null;
  readBy: string | null;
};

export type CountReport = {
  kind: "cycle_count" | "phone" | "unverified";
  id: string;
  title: string;
  activity: string;
  location: string | null;
  startedAt: string | null;
  endedAt: string | null;
  by: string[];
  devices: string[];
  totals: {
    read: number;
    live: number;
    cameBack: number;
    newUnknown: number;
    earlierUnknown: number;
    defective: number;
    other: number;
  };
  unknown: ReportTagRow[];
  defective: ReportDefectRow[];
  generatedAt: string;
};

export class CountReportNotFound extends Error {}

/** A tag's read in this count. */
type Read = { epc: string; at: string | null; by: string | null };

const MARGIN_MS = 10 * 60_000;

const fullName = (f: string | null, l: string | null, e: string | null) =>
  [f, l].map((x) => (x ?? "").trim()).filter(Boolean).join(" ") || (e ? e.split("@")[0]! : "");

async function deviceNames(pool: Pool, tenantId: string): Promise<Map<string, string>> {
  const r = await pool.query<{ k: string; name: string }>(
    `SELECT lower(k) AS k, name FROM devices d,
            unnest(ARRAY[d.android_id, d.id::text, d.config->>'deviceId', d.config->>'edgeDeviceId']) AS k
      WHERE d.tenant_id = $1::uuid AND k IS NOT NULL AND trim(k) <> ''`,
    [tenantId],
  );
  return new Map(r.rows.map((x) => [x.k, x.name]));
}

const nameFor = (names: Map<string, string>, raw: string | null | undefined) =>
  raw ? (names.get(raw.trim().toLowerCase()) ?? raw) : null;

/** "Oct 16 2026 4:12 PM" in the warehouse's time zone. */
export function fmtET(iso: string | Date | null | undefined, withSeconds = false): string {
  if (!iso) return "";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  }).replace(",", "").replace(",", "");
}

const statusLabel = (status: string, verifiedAt: Date | null) => {
  if (status === "unknown") return "Unknown — not verified";
  const base = status === "in-stock" ? "Live" : status.replace(/_/g, " ");
  return verifiedAt ? `${base} — verified ${fmtET(verifiedAt)}` : base;
};

type ItemRow = {
  epc: string;
  status: string;
  custom_sku_id: string | null;
  fresh_found_at: Date | null;
  verified_at: Date | null;
  source_device_label: string | null;
  serial_number: string | null;
  last_seen_at: Date | null;
  bin: string | null;
  sku: string | null;
  upc: string | null;
  product: string | null;
  color: string | null;
  size: string | null;
  price: string | null;
};

async function loadItems(pool: Pool, tenantId: string, epcs: string[]): Promise<Map<string, ItemRow>> {
  if (epcs.length === 0) return new Map();
  const r = await pool.query<ItemRow>(
    `SELECT i.epc, i.status, i.custom_sku_id::text, i.fresh_found_at, i.verified_at,
            i.source_device_label, i.serial_number::text, i.last_seen_at,
            b.code AS bin, cs.sku, COALESCE(cs.upc, m.upc) AS upc, m.description AS product,
            cs.color_code AS color, cs.size, cs.retail_price::text AS price
       FROM items i
       JOIN locations l ON l.id = i.location_id AND l.tenant_id = $2::uuid
       LEFT JOIN custom_skus cs ON cs.id = i.custom_sku_id
       LEFT JOIN matrices m ON m.id = cs.matrix_id
       LEFT JOIN bins b ON b.id = i.bin_id AND b.archived_at IS NULL
      WHERE i.epc = ANY($1::text[])`,
    [epcs, tenantId],
  );
  return new Map(r.rows.map((x) => [x.epc.toUpperCase(), x]));
}

function tagRow(it: ItemRow, read: Read | null, names: Map<string, string>, foundHere: boolean, fallbackFinder: string | null): ReportTagRow {
  return {
    epc: it.epc,
    product: it.product,
    color: it.color,
    size: it.size,
    sku: it.sku,
    upc: it.upc,
    price: it.price,
    serial: it.serial_number,
    bin: it.bin,
    readAt: read?.at ?? null,
    readBy: read?.by ?? null,
    firstFoundAt: it.fresh_found_at ? it.fresh_found_at.toISOString() : null,
    firstFoundBy:
      it.source_device_label && it.source_device_label !== "cycle-count-live"
        ? nameFor(names, it.source_device_label)
        : fallbackFinder,
    foundHere,
    lastSeenAt: it.last_seen_at ? it.last_seen_at.toISOString() : null,
    statusNow: statusLabel(it.status, it.verified_at),
  };
}

/** Classifies a count's reads into the report. */
async function assemble(
  pool: Pool,
  tenantId: string,
  base: Omit<CountReport, "totals" | "unknown" | "defective" | "generatedAt">,
  reads: Read[],
  defectiveFromFile: ReportDefectRow[],
  names: Map<string, string>,
): Promise<CountReport> {
  const byEpc = new Map<string, Read>();
  for (const r of reads) {
    const k = r.epc.trim().toUpperCase();
    if (/^[0-9A-F]{24}$/.test(k) && !byEpc.has(k)) byEpc.set(k, { ...r, epc: k });
  }
  const epcs = [...byEpc.keys()];
  const items = await loadItems(pool, tenantId, epcs);
  const start = base.startedAt ? new Date(base.startedAt).getTime() - MARGIN_MS : -Infinity;
  const end = base.endedAt ? new Date(base.endedAt).getTime() + MARGIN_MS : Infinity;

  const cameBack = new Set(
    epcs.length === 0
      ? []
      : (
          await pool.query<{ epc: string }>(
            `SELECT DISTINCT upper(entity_reference) AS epc FROM inventory_audit_logs
              WHERE tenant_id = $1::uuid AND log_type = 'STATUS_CHANGE'
                AND old_value = 'unknown' AND new_value = 'in-stock'
                AND entity_reference = ANY($2::text[])
                AND created_at BETWEEN $3::timestamptz AND $4::timestamptz`,
            [
              tenantId,
              epcs,
              new Date(Number.isFinite(start) ? start : 0).toISOString(),
              new Date(Number.isFinite(end) ? end : Date.now() + MARGIN_MS).toISOString(),
            ],
          )
        ).rows.map((x) => x.epc),
  );

  const unknown: ReportTagRow[] = [];
  const defective = new Map<string, ReportDefectRow>(defectiveFromFile.map((d) => [d.epc.toUpperCase(), d]));
  let live = 0;
  let other = 0;
  for (const epc of epcs) {
    const it = items.get(epc);
    const read = byEpc.get(epc)!;
    // Listed when it was still waiting for a person when this count read it.
    const readT = read.at ? new Date(read.at).getTime() : end;
    if (it && it.fresh_found_at && (!it.verified_at || it.verified_at.getTime() > (Number.isFinite(readT) ? readT : end))) {
      const t = it.fresh_found_at.getTime();
      unknown.push(tagRow(it, read, names, t >= start && t <= end, read.by));
      continue;
    }
    if (defective.has(epc)) continue;
    if (it && it.status === "tag_killed" && !it.custom_sku_id) {
      defective.set(epc, { epc, reason: "Not a Carbon tag / no catalog match", readAt: read.at, readBy: read.by });
      continue;
    }
    if (it && it.status === "in-stock") live++;
    else other++;
  }
  unknown.sort((a, b) => Number(b.foundHere) - Number(a.foundHere) || (a.product ?? "").localeCompare(b.product ?? "") || a.epc.localeCompare(b.epc));
  const defectRows = [...defective.values()].sort((a, b) => a.epc.localeCompare(b.epc));
  return {
    ...base,
    totals: {
      read: epcs.length,
      live,
      cameBack: [...cameBack].filter((e) => byEpc.has(e)).length,
      newUnknown: unknown.filter((u) => u.foundHere).length,
      earlierUnknown: unknown.filter((u) => !u.foundHere).length,
      defective: defectRows.length,
      other,
    },
    unknown,
    defective: defectRows,
    generatedAt: new Date().toISOString(),
  };
}

/** Desktop Cycle Count session (cycle_count_sessions). */
export async function buildCycleCountReport(pool: Pool, tenantId: string, sessionId: string): Promise<CountReport> {
  const r = await pool.query<{
    id: string;
    session_number: number | null;
    name: string | null;
    status: string;
    started_at: Date | null;
    created_at: Date;
    completed_at: Date | null;
    loc: string | null;
    scanned_epcs: unknown;
    scanned_epc_sources: Record<string, { ts?: string; kind?: string; name?: string }> | null;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  }>(
    `SELECT c.id::text, c.session_number, c.name, c.status, c.started_at, c.created_at, c.completed_at,
            l.code || ' — ' || l.name AS loc, c.scanned_epcs, c.scanned_epc_sources,
            u.first_name, u.last_name, u.email
       FROM cycle_count_sessions c
       LEFT JOIN locations l ON l.id = c.location_id
       LEFT JOIN users u ON u.id = c.started_by
      WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid`,
    [sessionId, tenantId],
  );
  const s = r.rows[0];
  if (!s) throw new CountReportNotFound("Count not found");
  const names = await deviceNames(pool, tenantId);
  const sources = s.scanned_epc_sources ?? {};
  const reads: Read[] = [];
  const devices = new Set<string>();
  for (const [epc, v] of Object.entries(sources)) {
    const who = v?.name ? `${v.kind === "reader" ? "Fixed reader" : v.kind === "mobile" ? "Handheld" : "Reader"} ${v.name.replace(" · A1", "")}` : null;
    if (who) devices.add(who);
    reads.push({ epc, at: v?.ts ?? null, by: who });
  }
  if (Array.isArray(s.scanned_epcs)) {
    for (const e of s.scanned_epcs) if (typeof e === "string" && !(e in sources)) reads.push({ epc: e, at: null, by: null });
  }
  const startedBy = fullName(s.first_name, s.last_name, s.email);
  return assemble(
    pool,
    tenantId,
    {
      kind: "cycle_count",
      id: s.id,
      title: `Cycle count ${s.session_number != null ? `#${String(s.session_number).padStart(3, "0")}` : ""}${s.name ? ` — ${s.name}` : ""}`.trim(),
      activity: "CYCLE COUNT",
      location: s.loc,
      startedAt: (s.started_at ?? s.created_at).toISOString(),
      endedAt: s.completed_at ? s.completed_at.toISOString() : null,
      by: startedBy ? [startedBy] : [],
      devices: [...devices].sort(),
    },
    reads,
    [],
    names,
  );
}

/** A phone count upload (inventory_reports): Inventory Count, Add-On Count, Add-On Catalog. */
export async function buildPhoneCountReport(pool: Pool, tenantId: string, reportId: string): Promise<CountReport> {
  const r = await pool.query<{
    id: string;
    activity: string;
    uploaded_at: Date;
    uploaded_by: string | null;
    device_id: string | null;
    csv_content: string | null;
    defective_csv_blob: string | null;
    filename: string | null;
  }>(
    `SELECT id::text, activity, uploaded_at, uploaded_by, device_id, csv_content, defective_csv_blob, filename
       FROM inventory_reports WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [reportId, tenantId],
  );
  const rep = r.rows[0];
  if (!rep) throw new CountReportNotFound("Report not found");
  const names = await deviceNames(pool, tenantId);
  const deviceName = nameFor(names, rep.device_id);

  // Who: the uploader, plus every person on an Add-On session's ledger.
  const userIds = new Set<string>();
  if (rep.uploaded_by && /^[0-9a-f-]{36}$/i.test(rep.uploaded_by)) userIds.add(rep.uploaded_by);
  const ledgerReads = new Map<string, { at: string | null; d: string | null }>();
  const session = (
    await pool.query<{ epc_ledger: Record<string, { d?: string; u?: string; at?: string }> | null; started_at: Date | null; joined: string[] | null; owner: string | null }>(
      `SELECT epc_ledger, started_at, joined_user_ids::text[] AS joined, owner_user_id::text AS owner
         FROM add_on_sessions WHERE report_id = $1::uuid LIMIT 1`,
      [reportId],
    )
  ).rows[0];
  if (session?.owner) userIds.add(session.owner);
  if (session?.epc_ledger) {
    for (const [epc, v] of Object.entries(session.epc_ledger)) {
      ledgerReads.set(epc.toUpperCase(), { at: v?.at ?? null, d: v?.d ?? null });
      if (v?.u) userIds.add(v.u);
    }
  }
  for (const u of session?.joined ?? []) userIds.add(u);
  const people =
    userIds.size === 0
      ? []
      : (
          await pool.query<{ first_name: string | null; last_name: string | null; email: string | null }>(
            `SELECT first_name, last_name, email FROM users WHERE id = ANY($1::uuid[])`,
            [[...userIds]],
          )
        ).rows.map((u) => fullName(u.first_name, u.last_name, u.email)).filter(Boolean);

  // Reads: the audit CSV (epc, …, first_seen_iso); Add-On ledger device when known.
  const reads: Read[] = [];
  const devices = new Set<string>();
  if (deviceName) devices.add(deviceName);
  let earliest: number | null = null;
  const rows = parseCsv(rep.csv_content ?? "");
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const iEpc = head.indexOf("epc");
  const iFirst = head.indexOf("first_seen_iso");
  for (const row of rows.slice(1)) {
    const epc = (row[iEpc] ?? "").trim().toUpperCase();
    if (!epc) continue;
    const led = ledgerReads.get(epc);
    const at = led?.at ?? (iFirst >= 0 ? (row[iFirst] ?? "").trim() || null : null);
    const by = led?.d ? nameFor(names, led.d) : deviceName;
    if (by) devices.add(by);
    if (at) {
      const t = new Date(at).getTime();
      if (Number.isFinite(t)) earliest = earliest === null ? t : Math.min(earliest, t);
    }
    reads.push({ epc, at, by });
  }
  for (const [epc, v] of ledgerReads) {
    if (!reads.some((x) => x.epc === epc)) reads.push({ epc, at: v.at, by: v.d ? nameFor(names, v.d) : deviceName });
  }

  // Defective: the report's defective file (epc, scanned_at, decode_reason, …, device_id).
  const defective: ReportDefectRow[] = [];
  const drows = parseCsv(rep.defective_csv_blob ?? "");
  const dh = (drows[0] ?? []).map((h) => h.trim().toLowerCase());
  for (const row of drows.slice(1)) {
    const epc = (row[dh.indexOf("epc")] ?? "").trim().toUpperCase();
    if (!epc) continue;
    const reason = (row[dh.indexOf("decode_reason")] ?? "").trim();
    defective.push({
      epc,
      reason: reason ? reason.replace(/_/g, " ") : "Not a Carbon tag",
      readAt: (row[dh.indexOf("scanned_at")] ?? "").trim() || null,
      readBy: nameFor(names, (row[dh.indexOf("device_id")] ?? "").trim() || rep.device_id),
    });
  }

  const startedAt = session?.started_at?.getTime() ?? earliest ?? rep.uploaded_at.getTime();
  return assemble(
    pool,
    tenantId,
    {
      kind: "phone",
      id: rep.id,
      title: `${rep.activity}${rep.filename ? ` — ${rep.filename}` : ""}`,
      activity: rep.activity,
      location: null,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: rep.uploaded_at.toISOString(),
      by: [...new Set(people)].sort(),
      devices: [...devices].sort(),
    },
    reads,
    defective,
    names,
  );
}

/** Every new tag still waiting for a person (fresh, not verified). */
export async function buildUnverifiedReport(pool: Pool, tenantId: string): Promise<CountReport> {
  const r = await pool.query<{ epc: string }>(
    `SELECT i.epc FROM items i JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
      WHERE i.fresh_found_at IS NOT NULL AND i.verified_at IS NULL AND i.status = 'unknown'`,
    [tenantId],
  );
  const names = await deviceNames(pool, tenantId);
  const items = await loadItems(pool, tenantId, r.rows.map((x) => x.epc.toUpperCase()));
  const unknown = [...items.values()]
    .map((it) => tagRow(it, null, names, true, null))
    .sort((a, b) => (b.firstFoundAt ?? "").localeCompare(a.firstFoundAt ?? "") || a.epc.localeCompare(b.epc));
  return {
    kind: "unverified",
    id: "unverified",
    title: "New Unknown tags — not verified",
    activity: "NEW UNKNOWN TAGS",
    location: null,
    startedAt: null,
    endedAt: null,
    by: [],
    devices: [...new Set(unknown.map((u) => u.firstFoundBy).filter((x): x is string => !!x))].sort(),
    totals: { read: 0, live: 0, cameBack: 0, newUnknown: unknown.length, earlierUnknown: 0, defective: 0, other: 0 },
    unknown,
    defective: [],
    generatedAt: new Date().toISOString(),
  };
}
