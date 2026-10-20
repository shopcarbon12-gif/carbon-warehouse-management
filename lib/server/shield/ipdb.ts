/**
 * Carbon Shield IP data: IPv4 → country, IPv4 → network (ASN + owner), and
 * the published IP ranges of crawlers we must never block (Google, Bing,
 * Apple) and of Google Cloud.
 *
 * Built by the worker once a day from free published lists — DB-IP Lite
 * (CC BY 4.0, https://db-ip.com), Google, Bing, Apple — packed into one gzip
 * blob in `shield_ipdb`, and read into memory by the check endpoint.
 * wms.shopcarbon.com has no IPv6 address, so browsers always reach the check
 * over IPv4 and IPv4 is all we need.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import type { Pool } from "pg";

// ── IPv4 helpers ────────────────────────────────────────────────────────────

/** "1.2.3.4" (or IPv4-mapped "::ffff:1.2.3.4") → unsigned 32-bit int; null otherwise. */
export function ipv4ToInt(raw: string | null | undefined): number | null {
  if (!raw) return null;
  let s = raw.trim();
  if (s.toLowerCase().startsWith("::ffff:")) s = s.slice(7);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = [m[1], m[2], m[3], m[4]].map(Number);
  if (p.some((n) => n > 255)) return null;
  return p[0] * 16777216 + p[1] * 65536 + p[2] * 256 + p[3];
}

/** "10.0.0.0/8" → [first, last] as ints; a bare IP is a /32. */
export function cidrToRange(cidr: string): [number, number] | null {
  const [ip, bitsRaw] = cidr.trim().split("/");
  const base = ipv4ToInt(ip);
  if (base === null) return null;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  const start = Math.floor(base / size) * size;
  return [start, start + size - 1];
}

/** Index of the range containing x (ranges sorted by start, not overlapping), or -1. */
function findRange(starts: Uint32Array, ends: Uint32Array, x: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= x) {
      hit = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return hit >= 0 && ends[hit] >= x ? hit : -1;
}

// ── In-memory shape ─────────────────────────────────────────────────────────

type Ranges = { starts: Uint32Array; ends: Uint32Array };
type LabeledRanges = Ranges & { label: Uint8Array; labels: string[] };

export type IpDb = {
  version: string;
  refreshedAt: string;
  country: Ranges & { idx: Uint8Array; codes: string[] };
  network: Ranges & { asn: Uint32Array; orgs: Map<number, string> };
  /** Verified crawler ranges (label = "Googlebot", "Bingbot", …). */
  goodBots: LabeledRanges;
  /** Cloud provider customer ranges that are not visible by ASN alone. */
  cloud: LabeledRanges;
  counts: { country: number; network: number; goodBots: number; cloud: number };
};

export type IpInfo = {
  country: string | null;
  asn: number | null;
  org: string | null;
  goodBot: string | null;
  cloud: string | null;
};

export function lookupIp(db: IpDb | null, ipInt: number | null): IpInfo {
  const out: IpInfo = { country: null, asn: null, org: null, goodBot: null, cloud: null };
  if (!db || ipInt === null) return out;
  const c = findRange(db.country.starts, db.country.ends, ipInt);
  if (c >= 0) {
    const code = db.country.codes[db.country.idx[c]] ?? null;
    out.country = code && code !== "ZZ" ? code : null;
  }
  const n = findRange(db.network.starts, db.network.ends, ipInt);
  if (n >= 0) {
    out.asn = db.network.asn[n] || null;
    out.org = out.asn ? db.network.orgs.get(out.asn) ?? null : null;
  }
  const g = findRange(db.goodBots.starts, db.goodBots.ends, ipInt);
  if (g >= 0) out.goodBot = db.goodBots.labels[db.goodBots.label[g]] ?? "crawler";
  const k = findRange(db.cloud.starts, db.cloud.ends, ipInt);
  if (k >= 0) out.cloud = db.cloud.labels[db.cloud.label[k]] ?? "cloud";
  return out;
}

// ── Building (worker / "Refresh now") ───────────────────────────────────────

const DBIP = "https://download.db-ip.com/free";
const GOOD_BOT_LISTS: [string, string][] = [
  ["Googlebot", "https://developers.google.com/static/search/apis/ipranges/googlebot.json"],
  ["Google special crawler", "https://developers.google.com/static/search/apis/ipranges/special-crawlers.json"],
  ["Google fetcher", "https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers.json"],
  ["Google fetcher", "https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers-google.json"],
  ["Bingbot", "https://www.bing.com/toolbox/bingbot.json"],
  ["Applebot", "https://search.developer.apple.com/applebot.json"],
];
const CLOUD_LISTS: [string, string][] = [["Google Cloud", "https://www.gstatic.com/ipranges/cloud.json"]];

async function fetchBuffer(url: string, timeoutMs = 120_000): Promise<Buffer> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function monthTag(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** DB-IP publishes one file a month; early in a month this month's may not exist yet. */
async function downloadDbIp(kind: "country" | "asn"): Promise<{ month: string; text: string }> {
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  let lastErr: unknown = null;
  for (const month of [monthTag(now), monthTag(prev)]) {
    try {
      const gz = await fetchBuffer(`${DBIP}/dbip-${kind}-lite-${month}.csv.gz`);
      return { month, text: gunzipSync(gz).toString("utf8") };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`DB-IP ${kind} download failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/** CSV field that may be quoted ("Cloudflare, Inc.") with "" escapes. */
function unquote(s: string): string {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t;
}

type Row = { s: number; e: number };

function packSorted<T extends Row>(rows: T[]): T[] {
  rows.sort((a, b) => a.s - b.s || a.e - b.e);
  // Drop overlaps (keep the first) so binary search stays exact.
  const out: T[] = [];
  let lastEnd = -1;
  for (const r of rows) {
    if (r.s <= lastEnd) continue;
    out.push(r);
    lastEnd = r.e;
  }
  return out;
}

async function rangesFromPrefixLists(lists: [string, string][]): Promise<LabeledRows> {
  const labels: string[] = [];
  const rows: (Row & { l: number })[] = [];
  for (const [label, url] of lists) {
    let json: { prefixes?: { ipv4Prefix?: string }[] };
    try {
      json = JSON.parse((await fetchBuffer(url, 60_000)).toString("utf8"));
    } catch (e) {
      // One list being down must not stop the rest (or the build).
      console.warn(`[shield] could not load ${url}:`, e instanceof Error ? e.message : e);
      continue;
    }
    let li = labels.indexOf(label);
    if (li < 0) {
      labels.push(label);
      li = labels.length - 1;
    }
    for (const p of json.prefixes ?? []) {
      const r = p.ipv4Prefix ? cidrToRange(p.ipv4Prefix) : null;
      if (r) rows.push({ s: r[0], e: r[1], l: li });
    }
  }
  return { rows: packSorted(rows), labels };
}

type Header = {
  version: string;
  refreshedAt: string;
  codes: string[];
  goodLabels: string[];
  cloudLabels: string[];
  orgs: Record<string, string>;
  counts: IpDb["counts"];
};

export type LabeledRows = { rows: (Row & { l: number })[]; labels: string[] };

/** Download every source and pack it. Takes ~10–30 s; run off the request path. */
export async function buildIpDb(): Promise<{ blob: Buffer; version: string; rowCount: number }> {
  const [country, asn, good, cloud] = await Promise.all([
    downloadDbIp("country"),
    downloadDbIp("asn"),
    rangesFromPrefixLists(GOOD_BOT_LISTS),
    rangesFromPrefixLists(CLOUD_LISTS),
  ]);
  return packIpDb({ countryCsv: country.text, asnCsv: asn.text, month: country.month, good, cloud, minRows: 100_000 });
}

/**
 * Pack DB-IP Lite CSV text (country: "start,end,CC"; asn: "start,end,ASN,Org")
 * plus labeled crawler / cloud ranges into the stored blob. Exported for tests.
 */
export function packIpDb(input: {
  countryCsv: string;
  asnCsv: string;
  month: string;
  good: LabeledRows;
  cloud: LabeledRows;
  minRows?: number;
}): { blob: Buffer; version: string; rowCount: number } {
  const { good, cloud } = input;
  const country = { text: input.countryCsv, month: input.month };
  const asn = { text: input.asnCsv };
  const codes: string[] = [];
  const codeIdx = new Map<string, number>();
  const cRows: (Row & { i: number })[] = [];
  for (const line of country.text.split("\n")) {
    if (!line || line.includes(":")) continue; // IPv6 rows
    const [a, b, cc] = line.split(",");
    const s = ipv4ToInt(a);
    const e = ipv4ToInt(b);
    if (s === null || e === null || !cc) continue;
    const code = cc.trim().toUpperCase();
    let i = codeIdx.get(code);
    if (i === undefined) {
      i = codes.length;
      codes.push(code);
      codeIdx.set(code, i);
    }
    cRows.push({ s, e, i });
  }

  const orgs: Record<string, string> = {};
  const nRows: (Row & { a: number })[] = [];
  for (const line of asn.text.split("\n")) {
    if (!line || line.includes(":")) continue;
    const m = /^([\d.]+),([\d.]+),(\d*),(.*)$/.exec(line.trim());
    if (!m) continue;
    const s = ipv4ToInt(m[1]);
    const e = ipv4ToInt(m[2]);
    const a = Number(m[3] || 0);
    if (s === null || e === null) continue;
    nRows.push({ s, e, a });
    if (a && !(a in orgs)) orgs[a] = unquote(m[4]).slice(0, 120);
  }

  if (codes.length > 255) throw new Error(`Too many country codes (${codes.length}) for the packed format`);
  const cPacked = packSorted(cRows);
  const nPacked = packSorted(nRows);
  const minRows = input.minRows ?? 0;
  if (cPacked.length < minRows || nPacked.length < minRows) {
    throw new Error(`IP data looks incomplete (${cPacked.length} country / ${nPacked.length} network ranges) — not saved`);
  }

  const header: Header = {
    version: `dbip ${country.month} · ${new Date().toISOString().slice(0, 10)}`,
    refreshedAt: new Date().toISOString(),
    codes,
    goodLabels: good.labels,
    cloudLabels: cloud.labels,
    orgs,
    counts: { country: cPacked.length, network: nPacked.length, goodBots: good.rows.length, cloud: cloud.rows.length },
  };
  const u32 = (vals: number[]) => Buffer.from(new Uint32Array(vals).buffer);
  const u8 = (vals: number[]) => {
    const b = Buffer.from(new Uint8Array(vals).buffer);
    const pad = (4 - (b.length % 4)) % 4; // keep every later Uint32 block 4-byte aligned
    return pad ? Buffer.concat([b, Buffer.alloc(pad)]) : b;
  };
  let headerBuf = Buffer.from(JSON.stringify(header), "utf8");
  const hpad = (4 - (headerBuf.length % 4)) % 4;
  if (hpad) headerBuf = Buffer.concat([headerBuf, Buffer.alloc(hpad, 0x20)]);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(headerBuf.length, 0);
  const raw = Buffer.concat([
    lenBuf,
    headerBuf,
    u32(cPacked.map((r) => r.s)),
    u32(cPacked.map((r) => r.e)),
    u8(cPacked.map((r) => r.i)),
    u32(nPacked.map((r) => r.s)),
    u32(nPacked.map((r) => r.e)),
    u32(nPacked.map((r) => r.a)),
    u32(good.rows.map((r) => r.s)),
    u32(good.rows.map((r) => r.e)),
    u8(good.rows.map((r) => r.l)),
    u32(cloud.rows.map((r) => r.s)),
    u32(cloud.rows.map((r) => r.e)),
    u8(cloud.rows.map((r) => r.l)),
  ]);
  return { blob: gzipSync(raw, { level: 6 }), version: header.version, rowCount: cPacked.length + nPacked.length };
}

export function unpackIpDb(blob: Buffer): IpDb {
  const raw = gunzipSync(blob);
  // Copy into a fresh, 0-offset ArrayBuffer so every typed-array view is aligned.
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const view = new DataView(ab);
  const headerLen = view.getUint32(0, true);
  const header = JSON.parse(Buffer.from(ab, 4, headerLen).toString("utf8")) as Header;
  let off = 4 + headerLen;
  const takeU32 = (n: number) => {
    const a = new Uint32Array(ab.slice(off, off + n * 4));
    off += n * 4;
    return a;
  };
  const takeU8 = (n: number) => {
    const a = new Uint8Array(ab.slice(off, off + n));
    off += n + ((4 - (n % 4)) % 4);
    return a;
  };
  const { counts } = header;
  const cStarts = takeU32(counts.country);
  const cEnds = takeU32(counts.country);
  const cIdx = takeU8(counts.country);
  const nStarts = takeU32(counts.network);
  const nEnds = takeU32(counts.network);
  const nAsn = takeU32(counts.network);
  const gStarts = takeU32(counts.goodBots);
  const gEnds = takeU32(counts.goodBots);
  const gLabel = takeU8(counts.goodBots);
  const kStarts = takeU32(counts.cloud);
  const kEnds = takeU32(counts.cloud);
  const kLabel = takeU8(counts.cloud);
  const orgs = new Map<number, string>();
  for (const [k, v] of Object.entries(header.orgs)) orgs.set(Number(k), v);
  return {
    version: header.version,
    refreshedAt: header.refreshedAt,
    country: { starts: cStarts, ends: cEnds, idx: cIdx, codes: header.codes },
    network: { starts: nStarts, ends: nEnds, asn: nAsn, orgs },
    goodBots: { starts: gStarts, ends: gEnds, label: gLabel, labels: header.goodLabels },
    cloud: { starts: kStarts, ends: kEnds, label: kLabel, labels: header.cloudLabels },
    counts,
  };
}

/** Build and store a fresh copy. Returns the new version. */
export async function refreshIpDb(pool: Pool): Promise<{ version: string; rowCount: number; bytes: number }> {
  const { blob, version, rowCount } = await buildIpDb();
  await pool.query(
    `INSERT INTO shield_ipdb (kind, version, row_count, data, refreshed_at)
     VALUES ('v4', $1, $2, $3, now())
     ON CONFLICT (kind) DO UPDATE SET version = EXCLUDED.version, row_count = EXCLUDED.row_count,
       data = EXCLUDED.data, refreshed_at = now()`,
    [version, rowCount, blob],
  );
  cache = null; // next lookup reloads
  return { version, rowCount, bytes: blob.length };
}

/** Refresh when the stored copy is missing or older than `maxAgeHours`. */
export async function refreshIpDbIfStale(pool: Pool, maxAgeHours = 24): Promise<boolean> {
  const r = await pool.query<{ fresh: boolean }>(
    `SELECT refreshed_at > now() - ($1::int * interval '1 hour') AS fresh FROM shield_ipdb WHERE kind = 'v4'`,
    [maxAgeHours],
  );
  if (r.rows[0]?.fresh) return false;
  await refreshIpDb(pool);
  return true;
}

// ── Loading (check endpoint) ────────────────────────────────────────────────

let cache: { db: IpDb | null; version: string | null; checkedAt: number } | null = null;
let loading: Promise<IpDb | null> | null = null;
const RECHECK_MS = 10 * 60_000;

/**
 * The in-memory copy, reloaded when the stored version changes (checked at
 * most every 10 minutes). Never throws: without data the check simply knows
 * no country / network and allows.
 */
export async function getIpDb(pool: Pool): Promise<IpDb | null> {
  const now = Date.now();
  if (cache && now - cache.checkedAt < RECHECK_MS) return cache.db;
  if (loading) return loading;
  loading = (async () => {
    try {
      const v = await pool.query<{ version: string }>(`SELECT version FROM shield_ipdb WHERE kind = 'v4'`);
      const version = v.rows[0]?.version ?? null;
      if (cache && cache.version === version) {
        cache.checkedAt = now;
        return cache.db;
      }
      if (!version) {
        cache = { db: null, version: null, checkedAt: now };
        return null;
      }
      const d = await pool.query<{ data: Buffer }>(`SELECT data FROM shield_ipdb WHERE kind = 'v4'`);
      const db = d.rows[0]?.data ? unpackIpDb(d.rows[0].data) : null;
      cache = { db, version, checkedAt: now };
      return db;
    } catch (e) {
      console.warn("[shield] IP data load failed:", e instanceof Error ? e.message : e);
      cache = { db: cache?.db ?? null, version: cache?.version ?? null, checkedAt: now };
      return cache.db;
    } finally {
      loading = null;
    }
  })();
  return loading;
}
