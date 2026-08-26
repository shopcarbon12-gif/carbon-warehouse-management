"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import {
  Radio,
  ScanLine,
  Pause,
  Play,
  X as XIcon,
  Download,
  ArrowLeft,
  Search,
  History,
  Clock,
  CheckCircle2,
  CircleSlash,
} from "lucide-react";
import { ReaderPicker } from "@/components/shared/reader-picker";
import { useReaderWake } from "@/components/shared/use-reader-wake";
import { useCountUp } from "@/components/dashboard/use-count-up";
import { CycleCountCommitModal } from "./cycle-count-commit-modal";
import { CycleCountManualItemsModal } from "./cycle-count-manual-items-modal";
import { ZeroOutRfidButton } from "./zero-out-rfid-button";
import {
  AllEpcsTable,
  buildFlatRows,
  ByBinTable,
  BySkuTable,
  type ExpectedRow,
  type StateFilter,
  type Variance,
} from "./cycle-count-results-views";
import {
  cellTruncate,
  DataTableContainer,
  pickTableLayout,
  ResizeHandle,
  useColResize,
} from "@/components/shared/data-table";
import { shortName } from "@/lib/format-name";
import { useUrlFlag } from "@/lib/use-url-param";

type LocationRow = { id: string; code: string; name: string };
type BinRow = { id: string; code: string; in_stock_count: number };

type ScanPeriod = { started_at: string; ended_at: string | null };

type SessionDetail = {
  id: string;
  session_number: number;
  location_id: string;
  location_code: string;
  location_name: string;
  bin_id: string | null;
  bin_code: string | null;
  name: string;
  status: "active" | "paused" | "committed" | "canceled";
  started_by: string | null;
  started_by_email: string | null;
  started_by_first: string | null;
  started_by_last: string | null;
  started_at: string;
  completed_at: string | null;
  scanned_count: number;
  expected_count: number;
  reader_filter: string[];
  notes: string | null;
  variance_summary: { matched: number; missing: number; misplaced: number; unrecognized: number } | null;
  audit_log_id: string | null;
  expected: ExpectedRow[];
  scanned_epcs: string[];
  /**
   * Per-EPC source attribution from the server. Empty `{}` on legacy
   * sessions before the backfill migration runs. Drives the filter
   * dropdown + the "Source" column in the EPC table.
   */
  scanned_epc_sources: Record<
    string,
    { kind: "mobile" | "reader"; name: string; ts: string }
  >;
  scan_periods: ScanPeriod[];
};

/** Workspace-level filter for the EPC table + KPI scoping. */
type SourceFilter =
  | { kind: "all" }
  | { kind: "mobile"; name: string | null }
  | { kind: "reader"; name: string | null };

function epcMatchesFilter(
  epc: string,
  sources: SessionDetail["scanned_epc_sources"],
  f: SourceFilter,
): boolean {
  if (f.kind === "all") return true;
  const src = sources[epc.toUpperCase()];
  if (!src) return false;
  if (src.kind !== f.kind) return false;
  if (f.name == null) return true;
  return src.name === f.name;
}

function distinctSourceNames(
  sources: SessionDetail["scanned_epc_sources"],
): { mobiles: string[]; readers: string[] } {
  const mobiles = new Set<string>();
  const readers = new Set<string>();
  for (const v of Object.values(sources)) {
    if (!v?.name) continue;
    if (v.kind === "mobile") mobiles.add(v.name);
    else if (v.kind === "reader") readers.add(v.name);
  }
  return {
    mobiles: [...mobiles].sort((a, b) => a.localeCompare(b)),
    readers: [...readers].sort((a, b) => a.localeCompare(b)),
  };
}

function totalScanMs(periods: ScanPeriod[], now: number): number {
  let ms = 0;
  for (const p of periods) {
    const s = Date.parse(p.started_at);
    if (Number.isNaN(s)) continue;
    const e = p.ended_at ? Date.parse(p.ended_at) : now;
    if (Number.isNaN(e)) continue;
    ms += Math.max(0, e - s);
  }
  return ms;
}

function formatHms(totalMs: number): string {
  const s = Math.floor(totalMs / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

type SessionRow = Omit<SessionDetail, "expected" | "scanned_epcs">;

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

const STATE_LABELS = {
  all: "All",
  matched: "Matched",
  missing: "Missing",
  added_here: "Added here",
  defective: "Defective",
  locked: "Locked",
} as const;

export function CycleCountWorkspace({ isAdmin = false }: { isAdmin?: boolean }) {
  // Keep the active-session id in the URL (?session=<uuid>) so the browser
  // Back button navigates back to the landing view instead of jumping to the
  // previous page (e.g. dashboard).
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeId = searchParams.get("session");
  const [showHistory, setShowHistory] = useState(false);

  const openSession = useCallback(
    (id: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("session", id);
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams],
  );

  const leaveSession = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("session");
    // Session-scoped popup params (manual-items modal, EPC history) must not
    // leak into the next session the operator opens.
    params.delete("manual");
    params.delete("epc");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }, [router, pathname, searchParams]);

  return (
    <div className="space-y-6">
      {activeId ? (
        <ActiveSessionView
          sessionId={activeId}
          onLeave={leaveSession}
          isAdmin={isAdmin}
        />
      ) : (
        <SessionLanding
          onOpen={openSession}
          showHistory={showHistory}
          onToggleHistory={() => setShowHistory((v) => !v)}
        />
      )}
    </div>
  );
}

/* ──────────── Landing: start new + open existing + history ──────────── */
function SessionLanding({
  onOpen,
  showHistory,
  onToggleHistory,
}: {
  onOpen: (id: string) => void;
  showHistory: boolean;
  onToggleHistory: () => void;
}) {
  const { data: locData } = useSWR<{ id: string; code: string; name: string }[]>(
    "/api/locations",
    fetcher,
  );
  const locations: LocationRow[] = useMemo(() => locData ?? [], [locData]);
  const [selectedLocationId, setSelectedLocationId] = useState("");
  // Each location keeps its own count history — operators don't want Orlando's
  // history showing up at Florida Mall and vice versa. Pin the filter to the
  // first available location until the operator picks another. We derive this
  // during render (rather than seeding state in an effect) so there is no
  // visible flash of the empty state.
  const locationId =
    selectedLocationId && locations.some((l) => l.id === selectedLocationId)
      ? selectedLocationId
      : (locations[0]?.id ?? "");

  const openUrl = locationId
    ? `/api/rfid/cycle-counts/sessions?status=open&locationId=${encodeURIComponent(locationId)}`
    : null;
  const closedUrl = showHistory && locationId
    ? `/api/rfid/cycle-counts/sessions?status=closed&locationId=${encodeURIComponent(locationId)}`
    : null;

  const { data: openData, mutate: mutateOpen } = useSWR<{ sessions: SessionRow[] }>(
    openUrl,
    fetcher,
    { refreshInterval: 5_000 },
  );
  const { data: closedData } = useSWR<{ sessions: SessionRow[] }>(
    closedUrl,
    fetcher,
  );

  const selectedLoc = locations.find((l) => l.id === locationId);
  const locLabel = selectedLoc ? `${selectedLoc.code} — ${selectedLoc.name}` : "—";

  return (
    <>
      <Section
        title="Location"
        hint="Counts are kept separate per location. Each location numbers its counts 001, 002, 003… independently."
      >
        <select
          value={locationId}
          onChange={(e) => setSelectedLocationId(e.target.value)}
          className={inputCls}
          disabled={locations.length === 0}
        >
          {locations.length === 0 ? <option value="">Loading…</option> : null}
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.code} — {l.name}
            </option>
          ))}
        </select>
      </Section>

      <NewSessionForm
        locationId={locationId}
        onCreated={(id) => onOpen(id)}
        onMutate={mutateOpen}
      />

      <Section title={`Open counts at ${locLabel}`} hint="Active or paused sessions you can resume.">
        {openData && openData.sessions.length > 0 ? (
          <SessionTable sessions={openData.sessions} onOpen={onOpen} />
        ) : (
          <Empty>No open counts. Start one above.</Empty>
        )}
      </Section>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onToggleHistory}
          className="inline-flex items-center gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)]/60 px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
        >
          <History className="h-3.5 w-3.5" />
          {showHistory ? "Hide history" : "Show history"}
        </button>
      </div>

      {showHistory ? (
        <Section title={`History at ${locLabel}`} hint="Committed and canceled sessions at this location.">
          {closedData && closedData.sessions.length > 0 ? (
            <SessionTable sessions={closedData.sessions} onOpen={onOpen} variant="history" />
          ) : (
            <Empty>No closed sessions at this location yet.</Empty>
          )}
        </Section>
      ) : null}
    </>
  );
}

function NewSessionForm({
  locationId,
  onCreated,
  onMutate,
}: {
  locationId: string;
  onCreated: (id: string) => void;
  onMutate: () => void;
}) {
  const [binId, setBinId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset bin whenever the page-level location changes so we don't carry a
  // bin from the previous location.
  useEffect(() => {
    setBinId("");
  }, [locationId]);

  const binsUrl = locationId
    ? `/api/locations/bins?locationId=${encodeURIComponent(locationId)}`
    : null;
  const { data: binRows } = useSWR<BinRow[]>(binsUrl, fetcher);

  const create = async () => {
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch("/api/rfid/cycle-counts/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationId,
          binId: binId || null,
        }),
      });
      const j = (await res.json()) as { error?: string; session?: { id: string } };
      if (!res.ok || !j.session) throw new Error(j.error ?? "Create failed");
      onMutate();
      onCreated(j.session.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Start a new count"
      hint="The next number for this location is assigned automatically (001, 002, 003…). Optionally scope to a single bin; otherwise the count covers the whole location. The expected list is frozen at start. Scanning stays off until you press Start."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Bin (optional)">
          <select
            value={binId}
            disabled={!locationId}
            onChange={(e) => setBinId(e.target.value)}
            className={inputCls}
          >
            <option value="">All bins at location</option>
            {(binRows ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} ({b.in_stock_count} in-stock)
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="mt-3 flex items-center justify-between">
        {err ? (
          <p className="font-mono text-xs text-red-400/90">{err}</p>
        ) : (
          <span />
        )}
        <button
          type="button"
          disabled={!locationId || busy}
          onClick={create}
          className="wms-btn-primary px-6 font-mono disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create count"}
        </button>
      </div>
    </Section>
  );
}

function SessionTable({
  sessions,
  onOpen,
  variant,
}: {
  sessions: SessionRow[];
  onOpen: (id: string) => void;
  variant?: "history";
}) {
  // Lists are already filtered to a single location at the workspace level,
  // so we drop the Location column. The auto-assigned per-location number
  // is the canonical identifier and lives in the "#" column. History adds a
  // trailing "By" column with the operator's email.
  const isHistory = variant === "history";
  const tableRef = useRef<HTMLTableElement>(null);
  // Open: 7 cols (#, Bin, Status, Expected, Scanned, Started, action)
  // Hist: 7 cols (#,      Status, Expected, Scanned, Started, By, action)
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 7);

  type ColCfg = {
    label: string;
    align?: "right" | "center";
    noResize?: boolean;
    hideMobile?: boolean;
  };
  const cols: ColCfg[] = isHistory
    ? [
        { label: "#" },
        { label: "Status" },
        { label: "Expected", align: "right", hideMobile: true },
        { label: "Scanned", align: "right" },
        { label: "Started", hideMobile: true },
        { label: "By", hideMobile: true },
        { label: "", noResize: true },
      ]
    : [
        { label: "#" },
        { label: "Bin" },
        { label: "Status" },
        { label: "Expected", align: "right", hideMobile: true },
        { label: "Scanned", align: "right" },
        { label: "Started", hideMobile: true },
        { label: "", noResize: true },
      ];

  return (
    <DataTableContainer maxHeight="min(60vh, 560px)">
      <table
        ref={tableRef}
        className="w-full min-w-[800px] border-collapse text-left max-md:min-w-0"
        style={{ tableLayout: pickTableLayout(colWidths) }}
      >
        <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)] max-md:text-xs">
          <tr>
            {cols.map((c, i) => {
              const w = colWidths[i];
              return (
                <th
                  key={c.label || `col-${i}`}
                  style={
                    w !== null
                      ? { width: w, minWidth: w }
                      : c.label === "#"
                        ? { width: "1%", whiteSpace: "nowrap" }
                        : undefined
                  }
                  className={`relative overflow-hidden px-3 py-2 ${
                    c.align === "right"
                      ? "text-right"
                      : c.align === "center"
                        ? "text-center"
                        : ""
                  }${c.hideMobile ? " max-md:hidden" : ""}`}
                >
                  <span>{c.label}</span>
                  {c.noResize ? null : (
                    <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-xs text-[var(--wms-fg)]">
          {sessions.map((s) => (
            <tr key={s.id} className="hover:bg-[var(--wms-surface-elevated)]/40">
              <td
                className={`${cellTruncate} px-3 py-2 tabular-nums text-[var(--wms-accent)]`}
                style={{ width: "1%", whiteSpace: "nowrap" }}
                title={s.name}
              >
                {s.name}
              </td>
              {isHistory ? null : (
                <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`} title={s.bin_code ?? ""}>
                  {s.bin_code ?? "(all)"}
                </td>
              )}
              <td className="overflow-hidden px-3 py-2">
                <StatusPill status={s.status} />
              </td>
              <td className="overflow-hidden px-3 py-2 text-right tabular-nums max-md:hidden">{s.expected_count}</td>
              <td className="overflow-hidden px-3 py-2 text-right tabular-nums">{s.scanned_count}</td>
              <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)] max-md:hidden`}>
                {new Date(s.started_at).toLocaleString()}
              </td>
              {isHistory ? (
                <td
                  className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)] max-md:hidden`}
                  title={s.started_by_email ?? ""}
                >
                  {shortName(s.started_by_first, s.started_by_last, s.started_by_email)}
                </td>
              ) : null}
              <td className="overflow-hidden px-3 py-2 text-right">
                <button
                  type="button"
                  onClick={() => onOpen(s.id)}
                  className="rounded-md border border-[var(--wms-border)] px-3 py-1 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] max-md:py-2 max-md:text-[0.7rem]"
                >
                  {isHistory ? "View" : "Open"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </DataTableContainer>
  );
}

function StatusPill({ status }: { status: SessionRow["status"] }) {
  const cls =
    status === "active"
      ? "border-emerald-500/40 bg-emerald-950/40 text-emerald-300"
      : status === "paused"
        ? "border-amber-500/40 bg-amber-950/40 text-amber-300"
        : status === "committed"
          ? "border-teal-500/40 bg-teal-950/40 text-teal-300"
          : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-muted)]";
  const Icon =
    status === "active" ? Radio : status === "paused" ? Pause : status === "committed" ? CheckCircle2 : CircleSlash;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-wide ${cls}`}
    >
      <Icon className="h-3 w-3" /> {status}
    </span>
  );
}

/* ──────────── Active session view ──────────── */

function ActiveSessionView({
  sessionId,
  onLeave,
  isAdmin,
}: {
  sessionId: string;
  onLeave: () => void;
  isAdmin: boolean;
}) {
  const { data, mutate, error } = useSWR<{
    session: SessionDetail;
    variance: Variance;
  }>(`/api/rfid/cycle-counts/sessions/${sessionId}`, fetcher, {
    /* Slowed from 5s → 10s. The GET handler reconciles SSE-dropped reads
       from cdm_reads every poll, which is the heavy part. 10s plus the
       server-side 20s backfill throttle keeps the session view responsive
       without hammering the DB. */
    refreshInterval: 10_000,
    /* The GET response is a freshly-parsed object every poll. Default SWR
       compare uses === on the whole payload — that always says "different",
       which busts every downstream useMemo and reconciles the 5K-row table
       on every 10 s tick even when nothing changed.

       This compare is a cheap structural fingerprint: same status + same
       counts in every bucket + same scan-period count + same latest period
       endpoint ⇒ same content. When equal, SWR keeps the OLD reference, so
       `detail` and `variance` identities are stable and downstream memos
       (flatRows, expectedEpcSet) hold their cache.

       Writes via mutate() with genuinely new data still update the cache
       normally — the compare is consulted, sees a delta (e.g. a new EPC
       grew variance.matched.length), and SWR adopts the new object. */
    compare: (a, b) => {
      if (a === b) return true;
      if (!a || !b) return false;
      const sa = a.session;
      const sb = b.session;
      if (sa === sb && a.variance === b.variance) return true;
      const va = a.variance;
      const vb = b.variance;
      const lastA = sa.scan_periods[sa.scan_periods.length - 1];
      const lastB = sb.scan_periods[sb.scan_periods.length - 1];
      return (
        sa.id === sb.id &&
        sa.status === sb.status &&
        sa.completed_at === sb.completed_at &&
        sa.scanned_count === sb.scanned_count &&
        sa.expected_count === sb.expected_count &&
        sa.expected.length === sb.expected.length &&
        sa.scanned_epcs.length === sb.scanned_epcs.length &&
        sa.scan_periods.length === sb.scan_periods.length &&
        (lastA?.started_at ?? null) === (lastB?.started_at ?? null) &&
        (lastA?.ended_at ?? null) === (lastB?.ended_at ?? null) &&
        va.matched.length === vb.matched.length &&
        va.missing.length === vb.missing.length &&
        va.added_here.length === vb.added_here.length &&
        va.defective.length === vb.defective.length &&
        va.locked.length === vb.locked.length
      );
    },
  });

  const detail = data?.session;
  const variance: Variance = data?.variance ?? {
    matched: [],
    missing: [],
    added_here: [],
    defective: [],
    locked: [],
  };

  // Local scanned set — driven by SSE stream when status === active.
  // We sync to server in batched PATCH (every ~3s) and after status flips.
  const [localScanned, setLocalScanned] = useState<Set<string>>(new Set());
  const lastReadAtRef = useRef<number | null>(null);
  const [lastReadAt, setLastReadAt] = useState<number | null>(null);
  const readsThisMinuteRef = useRef<number[]>([]);
  const [readsPerMin, setReadsPerMin] = useState(0);
  const [selectedReaders, setSelectedReaders] = useState<Set<string>>(() => new Set());
  const selectedReadersRef = useRef(selectedReaders);
  useEffect(() => {
    selectedReadersRef.current = selectedReaders;
  }, [selectedReaders]);

  // Warm ALL non-POS readers at the location ONLY while this count is active.
  // Omitting networkAddresses/readerIds tells the shared hook to pre-warm every
  // non-POS reader; they go cold ~30 s after `active` turns false. The
  // ReaderPicker below stays a live-display filter only and no longer wakes
  // readers.
  useReaderWake({ active: detail?.status === "active", kind: "cycle-count" });

  const [tab, setTab] = useState<"all" | "by_sku" | "by_bin">("all");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>({ kind: "all" });
  const [search, setSearch] = useState("");
  const [commitOpen, setCommitOpen] = useState(false);
  // "Finish" popup: replaces the old "Review & commit" closer. The fixed-
  // reader cycle count cannot close itself anymore (2026-05-12 policy) —
  // operators must hand off to the mobile handheld add-on count, which is
  // the only path that closes the session + runs reconcile + flips
  // truly-missing tags to tag_killed.
  const [finishOpen, setFinishOpen] = useState(false);
  // ?manual=1 — survives a browser refresh (see lib/use-url-param.ts).
  const [manualItemsOpen, setManualItemsOpen] = useUrlFlag("manual");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Tracks whether scanning has been started at least once in this mount.
  // Used to flip the primary button label from "Start scanning" → "Resume"
  // after the operator pauses mid-scan. Combined with scanned_count below
  // so the label is also "Resume" when re-opening a session that already
  // has reads.
  const [wasEverActive, setWasEverActive] = useState(false);

  // Hydrate local scanned set from server on first load + when session changes.
  useEffect(() => {
    if (!detail) return;
    setLocalScanned(new Set(detail.scanned_epcs.map((e) => e.toUpperCase())));
  }, [detail?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pending EPCs buffer — SSE events kick an immediate flush (gated against
  // pile-up by flushingRef). The /scan endpoint runs the catalog formula,
  // mutates `items`, writes audit_log rows, AND returns the refreshed session
  // + variance so the workspace can render new rows the instant the POST
  // returns. A 750ms interval acts as a safety net for events that arrived
  // while a flush was already in flight.
  const pendingScanRef = useRef<Set<string>>(new Set());
  const flushingRef = useRef(false);

  const flushPendingScans = useCallback(async () => {
    if (flushingRef.current) return;
    if (pendingScanRef.current.size === 0) return;
    flushingRef.current = true;
    try {
      // Drain in a loop so events that arrive during the POST are picked up
      // immediately on the next iteration instead of waiting for an interval.
      while (pendingScanRef.current.size > 0) {
        const batch = [...pendingScanRef.current];
        pendingScanRef.current.clear();
        try {
          const r = await fetch(
            `/api/rfid/cycle-counts/sessions/${sessionId}/scan`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ epcs: batch }),
            },
          );
          const j = (await r.json().catch(() => null)) as
            | { ok?: boolean; session?: SessionDetail; variance?: Variance }
            | null;
          if (j?.ok && j.session && j.variance) {
            await mutate(
              { session: j.session, variance: j.variance },
              { revalidate: false },
            );
          } else {
            await mutate();
          }
        } catch {
          for (const e of batch) pendingScanRef.current.add(e);
          break;
        }
      }
    } finally {
      flushingRef.current = false;
    }
  }, [sessionId, mutate]);

  // SSE feed — only acts when status is "active". When paused, ignore reads.
  //
  // HOT-PATH POLICY: the SSE handler MUST NOT call setState. It only writes
  // to refs (pendingScanRef, lastReadAtRef, readsThisMinuteRef). A separate
  // 200 ms ticker (effect below) drains those refs into React state exactly
  // ONCE per tick — meaning at most ~5 renders/sec regardless of SSE rate.
  //
  // Why: the previous handler did 4 setStates + a Set-rebuild + a flush
  // (which mutate()'d the entire SessionDetail) on EVERY SSE event. During
  // a fast scan that's 8+ renders/sec with payloads that grow linearly
  // with session size — eventually the React render queue backlogs (page
  // freeze), then the cumulative session-detail payloads blow memory
  // (tab crash). The freeze + crash + counts-stuck triad reported by
  // the operator matches this exact pattern.
  useEffect(() => {
    if (!detail) return;
    if (detail.status !== "active") return;
    const es = new EventSource("/api/edge/stream");
    es.onmessage = (ev) => {
      if (!ev.data?.trim() || ev.data.startsWith(":")) return;
      let p: { scanContext?: string; epcs?: string[]; deviceId?: string };
      try {
        p = JSON.parse(ev.data) as { scanContext?: string; epcs?: string[]; deviceId?: string };
      } catch {
        return;
      }
      // No scanContext gate: agent reads are tagged "TRANSFER" regardless
      // of the workflow that woke the reader, so filtering on "CYCLE_COUNT"
      // dropped every read. Reader-picker selection is the relevance signal
      // (same pattern as Transfer Out's workspace) — empty picker accepts
      // all reads, otherwise only matching device IDs.
      const sel = selectedReadersRef.current;
      if (sel.size > 0 && p.deviceId && !sel.has(p.deviceId)) return;
      const list = (p.epcs ?? [])
        .map((e) => e.replace(/\s/g, "").toUpperCase())
        .filter((e) => /^[0-9A-F]{24}$/.test(e));
      if (list.length === 0) return;
      const now = Date.now();
      lastReadAtRef.current = now;
      readsThisMinuteRef.current.push(now);
      // prune > 60 s, with a hard cap as a safety net in case prune misses
      // bursts (e.g. system clock jump). 6000 = 100 reads/sec for 60s ceiling.
      const cutoff = now - 60_000;
      while (readsThisMinuteRef.current[0] !== undefined && readsThisMinuteRef.current[0] < cutoff) {
        readsThisMinuteRef.current.shift();
      }
      if (readsThisMinuteRef.current.length > 6000) {
        readsThisMinuteRef.current.splice(0, readsThisMinuteRef.current.length - 6000);
      }
      for (const epc of list) pendingScanRef.current.add(epc);
      // NO setState here — the 200 ms ticker drains everything as one batch.
    };
    return () => es.close();
  }, [detail?.id, detail?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unified 200 ms tick: drains pendingScanRef into localScanned + UI rate
  // counters + kicks the network flush. Replaces the old per-SSE-event
  // setStates and the separate 750 ms safety net (this tick is faster than
  // that net so it subsumes the role). 5 renders/sec is the UI ceiling.
  // Always runs (not gated on status) so the UI continues to "decay to 0"
  // for read-rate even when paused.
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      // Decay rate even if no new SSE events arrived.
      const cutoff = now - 60_000;
      while (readsThisMinuteRef.current[0] !== undefined && readsThisMinuteRef.current[0] < cutoff) {
        readsThisMinuteRef.current.shift();
      }
      setReadsPerMin((prev) => {
        const next = readsThisMinuteRef.current.length;
        return next === prev ? prev : next;
      });
      const lastRead = lastReadAtRef.current;
      if (lastRead !== null) {
        setLastReadAt((prev) => (prev === lastRead ? prev : lastRead));
      }
      // Drain pending EPCs into localScanned IF the session is active AND
      // there's anything new to add.
      if (
        detail?.status === "active" &&
        pendingScanRef.current.size > 0
      ) {
        // Snapshot the batch BUT don't clear pendingScanRef yet — the
        // network flush needs them too. flushPendingScans clears its own
        // copy on successful POST.
        const batch = [...pendingScanRef.current];
        setLocalScanned((prev) => {
          // Only allocate a new Set if at least one EPC is genuinely new.
          let added = false;
          for (const epc of batch) {
            if (!prev.has(epc)) {
              added = true;
              break;
            }
          }
          if (!added) return prev;
          const next = new Set(prev);
          for (const epc of batch) next.add(epc);
          return next;
        });
        void flushPendingScans();
      }
    }, 200);
    return () => clearInterval(t);
  }, [detail?.status, flushPendingScans]);

  const flatRows = useMemo(
    () => (detail ? buildFlatRows(detail.expected, variance) : []),
    [detail, variance],
  );

  // ALL hooks must run on every render — these used to live below the
  // `if (!detail) return …` guard, which made the hook count differ
  // between the loading render and the data-arrived render. React then
  // crashed the page with "Rendered more hooks than during the previous
  // render". That's the intermittent "Open count" white-screen the
  // operator hit on 2026-05-10. Hooks now run unconditionally; runtime
  // safety lives inside each effect via `if (!detail) return;`.

  // When the count goes active, remember that we've been scanning so the
  // primary button label flips to "Resume" after a pause. Reader waking is
  // handled by the shared useReaderWake hook above.
  useEffect(() => {
    if (detail?.status === "active") setWasEverActive(true);
  }, [detail?.status]);

  // KPI counters: for Matched / Missing / Coverage we compute LOCALLY from
  // localScanned ∩ expected, identical to how the dashboard's Live Scan tile
  // ticks from its own SSE-driven Set. That makes the count climb the
  // instant a read lands in the browser, instead of waiting for the POST
  // round-trip (~300-500ms per batch) to return the server-side variance.
  // Categorical buckets (added_here, defective, locked) still come from
  // the server because they need items-table joins; the live local matched
  // count never undercounts those (added/defective are EXTRAS, not part of
  // expected).
  //
  // Server variance.matched is used as a high-water reconciliation: if the
  // server has counted more matched than we have locally (e.g., on session
  // reload, or after a transient SSE gap), we take its number. Never moves
  // backwards.
  const liveExpectedCount = detail?.expected.length ?? 0;
  const expectedEpcSet = useMemo(
    () => new Set((detail?.expected ?? []).map((e) => e.epc.toUpperCase())),
    [detail?.expected],
  );

  /** Helper: does an EPC fall inside the current Source filter?
   * Returns true when filter is "all" OR the EPC's source map entry
   * matches the kind (+ optionally name). EPCs with no source entry
   * fail any non-"all" filter — same rule the EPC table uses. */
  const epcInSource = useCallback(
    (epc: string): boolean => {
      if (sourceFilter.kind === "all") return true;
      const src = detail?.scanned_epc_sources?.[epc.toUpperCase()];
      if (!src) return false;
      if (src.kind !== sourceFilter.kind) return false;
      if (sourceFilter.name != null && src.name !== sourceFilter.name) return false;
      return true;
    },
    [detail?.scanned_epc_sources, sourceFilter],
  );

  /** Filtered scanned set the KPI tiles use. When Source = All, this is
   *  identical to localScanned. When Source = (mobile | reader | name),
   *  only EPCs whose source entry matches survive — so Matched / Missing
   *  / Coverage all rescope to "what THIS source contributed." */
  const scopedScanned = useMemo(() => {
    if (sourceFilter.kind === "all") return localScanned;
    const out = new Set<string>();
    for (const e of localScanned) if (epcInSource(e)) out.add(e);
    return out;
  }, [localScanned, sourceFilter, epcInSource]);

  const liveMatchedCount = useMemo(() => {
    let n = 0;
    for (const epc of scopedScanned) if (expectedEpcSet.has(epc)) n += 1;
    // Server variance.matched is the global high-water; we only take it
    // when the Source filter is "all" so a narrower view doesn't get
    // inflated by the global reconciliation.
    return sourceFilter.kind === "all"
      ? Math.max(n, variance.matched.length)
      : n;
  }, [scopedScanned, expectedEpcSet, variance.matched.length, sourceFilter]);
  const liveMissingCount = Math.max(0, liveExpectedCount - liveMatchedCount);

  /** Per-source counts for the three extras buckets. When the filter is
   *  "all", these collapse to the server-reported totals. Otherwise we
   *  reduce against the source map so the tile under the filter matches
   *  the operator's selection. */
  const liveAddedHereCount = useMemo(
    () =>
      sourceFilter.kind === "all"
        ? variance.added_here.length
        : variance.added_here.filter((r) => epcInSource(r.epc)).length,
    [variance.added_here, sourceFilter, epcInSource],
  );
  const liveDefectiveCount = useMemo(
    () =>
      sourceFilter.kind === "all"
        ? variance.defective.length
        : variance.defective.filter((r) => epcInSource(r.epc)).length,
    [variance.defective, sourceFilter, epcInSource],
  );
  const liveLockedCount = useMemo(
    () =>
      sourceFilter.kind === "all"
        ? variance.locked.length
        : variance.locked.filter((r) => epcInSource(r.epc)).length,
    [variance.locked, sourceFilter, epcInSource],
  );

  // "By source" breakdown strip: one chip per (kind, name) contributor with
  // matched / added-here / defective counts so the operator sees what the
  // mobile add-on contributed without touching the Source dropdown first.
  // MUST be declared above the `if (!detail) return` early-returns so the
  // hook count stays stable across renders (React: "Rendered more hooks
  // than during the previous render"). detail can be undefined here on
  // the loading render — use optional chaining.
  const sourceBreakdown = useMemo<
    Array<{
      key: string;
      kind: "mobile" | "reader";
      name: string;
      matched: number;
      addedHere: number;
      defective: number;
    }>
  >(() => {
    const sources = detail?.scanned_epc_sources ?? {};
    if (Object.keys(sources).length === 0) return [];
    type Agg = {
      kind: "mobile" | "reader";
      name: string;
      matched: number;
      addedHere: number;
      defective: number;
    };
    const agg = new Map<string, Agg>();
    const matchedSet = new Set(variance.matched.map((r) => r.epc.toUpperCase()));
    const addedSet = new Set(variance.added_here.map((r) => r.epc.toUpperCase()));
    const defectiveSet = new Set(variance.defective.map((r) => r.epc.toUpperCase()));
    for (const [epc, src] of Object.entries(sources)) {
      const key = `${src.kind}:${src.name}`;
      const existing = agg.get(key) ?? {
        kind: src.kind,
        name: src.name,
        matched: 0,
        addedHere: 0,
        defective: 0,
      };
      if (matchedSet.has(epc)) existing.matched += 1;
      if (addedSet.has(epc)) existing.addedHere += 1;
      if (defectiveSet.has(epc)) existing.defective += 1;
      agg.set(key, existing);
    }
    // Fixed display order so tiles DON'T reshuffle as counts change. Aisle
    // readers first in natural aisle/reader/antenna order (Aisle 1-2/1, 1-2/2,
    // 1-2/3, 3-4/1 … 5/1 … 6/1, 6/2), then other zones (store / office / POS …)
    // alphabetically; mobile sources last. The antenna suffix ("· A2") sorts
    // within its reader. Zero-padded numeric segments keep 003 < 010.
    const orderKey = (name: string): string => {
      const m = name.match(/^Aisle\s+(\d+)(?:-\d+)?\/(\d+)/i);
      const am = name.match(/·\s*A(\d+)/i);
      const ant = String(am ? parseInt(am[1], 10) : 0).padStart(3, "0");
      if (m) {
        const aisle = String(parseInt(m[1], 10)).padStart(3, "0");
        const reader = String(parseInt(m[2], 10)).padStart(3, "0");
        return `0:${aisle}:${reader}:${ant}:${name.toLowerCase()}`;
      }
      return `1:${name.toLowerCase()}:${ant}`;
    };
    return Array.from(agg.entries())
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "reader" ? -1 : 1;
        return orderKey(a.name).localeCompare(orderKey(b.name));
      });
  }, [
    detail?.scanned_epc_sources,
    variance.matched,
    variance.added_here,
    variance.defective,
  ]);

  // Coverage % uses Math.floor so a count that's 99.91% complete shows as
  // 99%, not a misleading "100%". Only display 100 when ALL expected EPCs
  // are accounted for (matched == expected, missing == 0). Without this
  // rule, operators see "Coverage 100%" with "Missing 4" in the same row
  // and reasonably ask "how does that happen?" — observed 2026-05-12.
  const liveCoverage =
    liveExpectedCount === 0
      ? 0
      : liveMissingCount === 0
        ? 100
        : Math.min(99, Math.floor((liveMatchedCount / liveExpectedCount) * 100));
  /* Each KPI tile holds its own useCountUp internally (see AnimKpiTile) so
     the 7 RAF animations don't reconcile this whole subtree — including the
     5K-row results table — on every animation frame. ScanTimeTile holds its
     own 1 s ticker for the same reason. */

  if (error) {
    return (
      <Section title="Couldn’t load session" hint="">
        <p className="font-mono text-xs text-red-400/90">{(error as Error).message}</p>
        <button
          type="button"
          onClick={onLeave}
          className="mt-3 rounded-md border border-[var(--wms-border)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]"
        >
          Back to sessions
        </button>
      </Section>
    );
  }
  if (!detail) {
    return <Empty>Loading session…</Empty>;
  }

  const closed = detail.status === "committed" || detail.status === "canceled";

  const setStatus = async (next: "active" | "paused" | "canceled") => {
    if (next === "canceled" && !confirm("Cancel this count? No inventory changes will be applied.")) {
      return;
    }
    setBusyAction(next);
    try {
      // Flush any pending live scans first (server is the source of truth).
      await flushPendingScans();
      await fetch(`/api/rfid/cycle-counts/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      await mutate();
      // Readers go cold automatically ~30 s after status leaves "active"
      // (useReaderWake stops its heartbeat once active===false).
      setToast(`Session ${next}`);
    } finally {
      setBusyAction(null);
    }
  };

  const doCommit = async (opts: {
    acceptMissing: string[];
    notes: string;
  }) => {
    // Flush any pending live scans first so missing/matched include them.
    await flushPendingScans();
    const res = await fetch(
      `/api/rfid/cycle-counts/sessions/${sessionId}/commit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      },
    );
    const j = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(j.error ?? "Commit failed");
    // Readers go cold automatically once the session leaves "active"
    // (useReaderWake stops its heartbeat → server janitor ends the warm
    // session ~30 s later).
    await mutate();
    setToast("Cycle count committed");
  };

  const expectedCount = detail.expected.length;
  const matchedCount = variance.matched.length;
  const coverage = expectedCount === 0 ? 0 : Math.round((matchedCount / expectedCount) * 100);
  const lastReadStr = lastReadAt ? `${Math.max(1, Math.round((Date.now() - lastReadAt) / 1000))}s ago` : "—";

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <button
              type="button"
              onClick={onLeave}
              className="mb-2 inline-flex items-center gap-1 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
            >
              <ArrowLeft className="h-3 w-3" /> All sessions
            </button>
            <h2 className="truncate text-base font-semibold text-[var(--wms-fg)]">
              Count #{detail.name} — {detail.location_code}
            </h2>
            <p className="mt-1 font-mono text-[0.65rem] text-[var(--wms-muted)]">
              {detail.location_name} · {detail.bin_code ?? "all bins"} ·{" "}
              <StatusPill status={detail.status} /> ·{" "}
              started {new Date(detail.started_at).toLocaleString()}
            </p>
          </div>
          <a
            href={`/api/rfid/cycle-counts/sessions/${sessionId}/export`}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-surface)]"
          >
            <Download className="h-3.5 w-3.5" /> Export XLSX
          </a>
        </div>
      </div>

      {/* KPI strip with coverage + read rate */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-8">
        <AnimKpiTile
          big
          label="Coverage"
          target={liveCoverage}
          format={(n) => `${n}%`}
          cls={coverage === 100 ? "wms-status-success" : coverage >= 80 ? "text-amber-400" : "text-red-400"}
        />
        <AnimKpiTile
          label="Matched"
          target={liveMatchedCount}
          format={(n) => `${n} / ${expectedCount}`}
          cls="wms-status-success"
        />
        <AnimKpiTile label="Missing" target={liveMissingCount} cls="text-amber-400" />
        <AnimKpiTile label="Added here" target={liveAddedHereCount} cls="text-sky-300" />
        <AnimKpiTile label="Defective" target={liveDefectiveCount} cls="text-red-400" />
        <AnimKpiTile label="Locked" target={liveLockedCount} cls="text-fuchsia-300" />
        <ScanTimeTile scanPeriods={detail.scan_periods} status={detail.status} />
        <AnimKpiTile
          label="Read rate"
          target={readsPerMin}
          format={(n) => `${n}/min`}
          sub={`last read ${lastReadStr}`}
          cls={readsPerMin > 0 ? "text-emerald-300" : "text-[var(--wms-muted)]"}
        />
      </div>

      {/* By-source breakdown strip — answers "what did the mobile add-on
          contribute?" at a glance, without making the operator open the
          Source filter dropdown. Click any chip to apply that source
          as the table filter. Hidden when the session has no source
          attribution (legacy / never-scanned). */}
      {sourceBreakdown.length > 0 ? (
        <div className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-3">
          <div className="mb-2 flex items-center gap-2 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
            <span>By source</span>
            {sourceFilter.kind !== "all" ? (
              <button
                type="button"
                onClick={() => setSourceFilter({ kind: "all" })}
                className="ml-auto rounded border border-[var(--wms-border)] px-2 py-0.5 text-[var(--wms-muted)] hover:text-[var(--wms-fg)] max-md:px-3 max-md:py-1.5"
              >
                Clear filter
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {sourceBreakdown.map((row) => {
              const active =
                sourceFilter.kind === row.kind && sourceFilter.name === row.name;
              return (
                <button
                  key={row.key}
                  type="button"
                  onClick={() =>
                    active
                      ? setSourceFilter({ kind: "all" })
                      : setSourceFilter({ kind: row.kind, name: row.name })
                  }
                  className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-left font-mono text-[0.7rem] transition-colors ${
                    active
                      ? "border-[var(--wms-accent)] bg-[var(--wms-accent)]/15 text-[var(--wms-fg)]"
                      : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)] hover:border-[var(--wms-accent)]/50"
                  }`}
                >
                  <span className="text-base leading-none">
                    {row.kind === "mobile" ? "📱" : "📡"}
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-semibold uppercase tracking-wide">
                      {row.name}
                    </span>
                    <span className="font-mono text-[0.6rem] text-[var(--wms-muted)]">
                      <span className="wms-status-success">{row.matched} matched</span>
                      {" · "}
                      <span className="text-sky-300">{row.addedHere} added</span>
                      {" · "}
                      <span className="text-red-400">{row.defective} defective</span>
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-3">
        {detail.status === "active" ? (
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => setStatus("paused")}
            className="inline-flex min-h-[2.5rem] items-center gap-2 rounded-lg border border-amber-500/50 bg-amber-950/40 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-amber-100 hover:bg-amber-900/40 disabled:opacity-50"
          >
            <Pause className="h-4 w-4" /> Pause
          </button>
        ) : detail.status === "paused" ? (
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => setStatus("active")}
            className="inline-flex min-h-[2.5rem] items-center gap-2 rounded-lg border border-emerald-500/50 bg-emerald-950/40 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-emerald-100 hover:bg-emerald-900/40 disabled:opacity-50"
          >
            <Play className="h-4 w-4" />
            {wasEverActive || localScanned.size > 0 ? "Resume" : "Start scanning"}
          </button>
        ) : null}

        {!closed ? (
          <>
            <ReaderPicker selected={selectedReaders} onChange={setSelectedReaders} />
            <button
              type="button"
              disabled={busyAction !== null || localScanned.size === 0}
              onClick={() => {
                if (!confirm("Clear all scans for this session? (You can re-scan; this doesn't end the session.)")) return;
                setLocalScanned(new Set());
                void fetch(`/api/rfid/cycle-counts/sessions/${sessionId}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ scannedEpcs: [] }),
                }).then(() => mutate());
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--wms-border)] px-4 py-2 font-mono text-xs text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
            >
              <ScanLine className="h-4 w-4" /> Clear scans
            </button>
          </>
        ) : null}

        {!closed ? (
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => setStatus("canceled")}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--wms-border)] px-4 py-2 font-mono text-xs text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
          >
            <XIcon className="h-4 w-4" /> Cancel session
          </button>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {!closed ? (
            <>
              <button
                type="button"
                disabled={localScanned.size === 0}
                onClick={() => setFinishOpen(true)}
                className="wms-btn-primary px-6 font-mono disabled:opacity-50"
              >
                Finish
              </button>
              <button
                type="button"
                onClick={() => setManualItemsOpen(true)}
                className="rounded-md border px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wider hover:opacity-90"
                style={{
                  borderColor: "color-mix(in srgb, oklch(82.8% 0.111 230.318) 45%, transparent)",
                  backgroundColor: "color-mix(in srgb, oklch(82.8% 0.111 230.318) 18%, var(--wms-surface-elevated))",
                  color: "oklch(82.8% 0.111 230.318)",
                }}
                title="Count non-RFID SKUs at this location"
              >
                Manual Items
              </button>
            </>
          ) : (
            <span className="font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
              <Clock className="mr-1 inline h-3 w-3" />
              Closed {detail.completed_at ? new Date(detail.completed_at).toLocaleString() : ""}
            </span>
          )}
          {isAdmin && !closed ? <ZeroOutRfidButton onZeroed={() => mutate()} /> : null}
        </div>
      </div>

      {/* Filters + tabs */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)]/60">
          {(["all", "by_sku", "by_bin"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide max-md:py-2.5 max-md:text-[0.7rem] ${
                tab === t
                  ? "bg-[var(--wms-accent)] text-[var(--wms-accent-fg)]"
                  : "text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
              }`}
            >
              {t === "all" ? "All EPCs" : t === "by_sku" ? "By SKU" : "By Bin"}
            </button>
          ))}
        </div>

        {tab === "all" ? (
          <div className="inline-flex flex-wrap gap-1">
            {(Object.keys(STATE_LABELS) as StateFilter[]).map((s) => {
              const n =
                s === "all"
                  ? flatRows.length
                  : s === "matched"
                    ? variance.matched.length
                    : s === "missing"
                      ? variance.missing.length
                      : s === "added_here"
                        ? variance.added_here.length
                        : s === "defective"
                          ? variance.defective.length
                          : variance.locked.length;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStateFilter(s)}
                  className={`rounded-full border px-2.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wide max-md:px-3 max-md:py-1.5 max-md:text-[0.7rem] ${
                    stateFilter === s
                      ? "border-[var(--wms-accent)] bg-[var(--wms-accent)]/15 text-[var(--wms-fg)]"
                      : "border-[var(--wms-border)] text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
                  }`}
                >
                  {STATE_LABELS[s]} ({n})
                </button>
              );
            })}
          </div>
        ) : null}

        {/* Source filter — only rendered when at least one source is
            known on the session. Pre-migration / never-scanned sessions
            have an empty map; showing a dropdown with one item ("All")
            is noise. */}
        {(() => {
          const { mobiles, readers } = distinctSourceNames(detail.scanned_epc_sources);
          if (mobiles.length === 0 && readers.length === 0) return null;
          // Serialise the active filter to a single string for the
          // <select>; parse on change. Format: "kind:name" or "all".
          const current =
            sourceFilter.kind === "all"
              ? "all"
              : `${sourceFilter.kind}:${sourceFilter.name ?? ""}`;
          return (
            <div className="inline-flex items-center gap-1 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)]/60 px-2 py-1">
              <span className="font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
                Source
              </span>
              <select
                value={current}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "all") {
                    setSourceFilter({ kind: "all" });
                  } else if (v === "mobile:") {
                    setSourceFilter({ kind: "mobile", name: null });
                  } else if (v === "reader:") {
                    setSourceFilter({ kind: "reader", name: null });
                  } else if (v.startsWith("mobile:")) {
                    setSourceFilter({ kind: "mobile", name: v.slice(7) });
                  } else if (v.startsWith("reader:")) {
                    setSourceFilter({ kind: "reader", name: v.slice(7) });
                  }
                }}
                className="bg-transparent font-mono text-xs text-[var(--wms-fg)] outline-none"
              >
                <option value="all">All</option>
                {mobiles.length > 0 && (
                  <optgroup label="📱 Mobile">
                    <option value="mobile:">Any mobile</option>
                    {mobiles.map((n) => (
                      <option key={`m:${n}`} value={`mobile:${n}`}>
                        {n}
                      </option>
                    ))}
                  </optgroup>
                )}
                {readers.length > 0 && (
                  <optgroup label="📡 Readers">
                    <option value="reader:">Any reader</option>
                    {readers.map((n) => (
                      <option key={`r:${n}`} value={`reader:${n}`}>
                        {n}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
          );
        })()}

        <div className="ml-auto inline-flex items-center gap-1 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)]/60 px-2 py-1">
          <Search className="h-3.5 w-3.5 text-[var(--wms-muted)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search EPC / SKU / bin"
            className="bg-transparent font-mono text-xs text-[var(--wms-fg)] outline-none placeholder:text-[var(--wms-muted)]"
          />
        </div>
      </div>

      {/* Tab body */}
      {tab === "all" ? (
        <AllEpcsTable
          rows={flatRows}
          search={search}
          stateFilter={stateFilter}
          sources={detail.scanned_epc_sources}
          sourceFilter={sourceFilter}
        />
      ) : tab === "by_sku" ? (
        <BySkuTable expected={detail.expected} variance={variance} search={search} />
      ) : (
        <ByBinTable expected={detail.expected} variance={variance} />
      )}

      {detail.status === "committed" && detail.variance_summary ? (
        <p className="font-mono text-xs text-[var(--wms-muted)]">
          Committed: {detail.variance_summary.matched} matched · {detail.variance_summary.missing} missing → tag_killed
          · {detail.variance_summary.unrecognized} settled live (added / defective / locked).
          Audit log: {detail.audit_log_id ?? "—"}.
        </p>
      ) : null}

      {toast ? (
        <p className="font-mono text-xs text-[var(--wms-muted)]">{toast}</p>
      ) : null}

      <CycleCountCommitModal
        open={commitOpen}
        onClose={() => setCommitOpen(false)}
        expected={detail.expected}
        variance={variance}
        binCodeForCommit={detail.bin_code}
        onCommit={doCommit}
      />

      {manualItemsOpen ? (
        <CycleCountManualItemsModal
          sessionId={detail.id}
          sessionName={detail.name}
          onClose={() => setManualItemsOpen(false)}
          onCommitted={() => void mutate()}
        />
      ) : null}

      {finishOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setFinishOpen(false)}
        >
          <div
            className="max-w-md rounded-xl border border-amber-400/60 bg-[var(--wms-surface)] p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center gap-2">
              <Clock className="h-5 w-5 text-amber-400" />
              <h2 className="font-mono text-base font-semibold uppercase tracking-wide text-amber-300">
                Almost there — finish on mobile
              </h2>
            </div>
            <p className="mb-4 font-mono text-sm text-[var(--wms-fg)]">
              This cycle count is recorded but <strong>not closed yet</strong>.
              Fixed readers can&apos;t see everything in coverage — to finalize
              this count and update inventory, you must complete the add-on
              pass on the mobile handheld:
            </p>
            <p className="mb-4 font-mono text-sm font-semibold text-[var(--wms-fg)]">
              📱 Carbon WMS mobile → <span className="text-[var(--wms-accent)]">Inventory → Add-On Count</span>
            </p>
            <p className="mb-5 font-mono text-xs text-[var(--wms-muted)]">
              When the handheld finishes and uploads, the system reconciles:
              tags the handheld picks up flip to <strong>live</strong>; tags
              missed by BOTH passes flip to <strong>tag_killed</strong>;
              defective EPCs are surfaced in <em>Catalog → Defective EPCs</em>.
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setFinishOpen(false)}
                className="wms-btn-primary px-6 font-mono"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ──────────── Tiny UI primitives ──────────── */

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
          {title}
        </h2>
        {hint ? (
          <p className="font-mono text-[0.6rem] text-[var(--wms-muted)]/80">{hint}</p>
        ) : null}
      </div>
      <div className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-4">
        {children}
      </div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-[var(--wms-border)] p-4 text-center font-mono text-xs text-[var(--wms-muted)]">
      {children}
    </p>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}

/* AnimKpiTile + ScanTimeTile are deliberately defined as memo()'d standalone
   components. The reason is the cycle-count workspace renders a results table
   with potentially thousands of rows. If we hold useCountUp / setInterval in
   the parent (ActiveSessionView), every animation frame and every clock tick
   re-renders the whole subtree, including that table — which is the root
   cause of the "barely moving / computer stuck" symptom on big sessions.
   Pushing the animation state into these small memoized children keeps each
   tile's re-renders local to itself. */

const AnimKpiTile = memo(function AnimKpiTile({
  label,
  target,
  cls,
  big,
  sub,
  format,
}: {
  label: string;
  target: number;
  cls: string;
  big?: boolean;
  sub?: string;
  format?: (n: number) => string;
}) {
  const v = useCountUp(target);
  return (
    <KpiTile
      label={label}
      value={format ? format(v) : String(v)}
      cls={cls}
      big={big}
      sub={sub}
    />
  );
});

const ScanTimeTile = memo(function ScanTimeTile({
  scanPeriods,
  status,
}: {
  scanPeriods: ScanPeriod[];
  status: SessionDetail["status"];
}) {
  /* Local 1 s ticker — runs only when the session is active. Decoupled from
     the parent so the per-second re-render never reaches the results table. */
  const [, setTick] = useState(0);
  useEffect(() => {
    if (status !== "active") return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [status]);
  const ms = totalScanMs(scanPeriods, Date.now());
  return (
    <KpiTile
      label="Scan time"
      value={formatHms(ms)}
      sub={`${scanPeriods.length} period${scanPeriods.length === 1 ? "" : "s"}`}
      cls={status === "active" ? "text-emerald-300" : "text-[var(--wms-muted)]"}
    />
  );
});

function KpiTile({
  label,
  value,
  cls,
  big,
  sub,
}: {
  label: string;
  value: string;
  cls: string;
  big?: boolean;
  sub?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 px-3 py-2 text-center ${big ? "lg:col-span-1" : ""}`}
    >
      <div className="font-mono text-[0.55rem] uppercase tracking-wide text-[var(--wms-muted)]">
        {label}
      </div>
      <div className={`mt-0.5 font-mono ${big ? "text-3xl" : "text-xl"} tabular-nums ${cls}`}>
        {value}
      </div>
      {sub ? (
        <div className="mt-0.5 font-mono text-[0.5rem] text-[var(--wms-muted)]">{sub}</div>
      ) : null}
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)]";
