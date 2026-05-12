"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useCountUp } from "@/components/dashboard/use-count-up";
import { CycleCountCommitModal } from "./cycle-count-commit-modal";
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
  scan_periods: ScanPeriod[];
};

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
  };
  const cols: ColCfg[] = isHistory
    ? [
        { label: "#" },
        { label: "Status" },
        { label: "Expected", align: "right" },
        { label: "Scanned", align: "right" },
        { label: "Started" },
        { label: "By" },
        { label: "", noResize: true },
      ]
    : [
        { label: "#" },
        { label: "Bin" },
        { label: "Status" },
        { label: "Expected", align: "right" },
        { label: "Scanned", align: "right" },
        { label: "Started" },
        { label: "", noResize: true },
      ];

  return (
    <DataTableContainer maxHeight="min(60vh, 560px)">
      <table
        ref={tableRef}
        className="w-full min-w-[800px] border-collapse text-left"
        style={{ tableLayout: pickTableLayout(colWidths) }}
      >
        <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
          <tr>
            {cols.map((c, i) => {
              const w = colWidths[i];
              return (
                <th
                  key={c.label || `col-${i}`}
                  style={w !== null ? { width: w, minWidth: w } : undefined}
                  className={`relative overflow-hidden px-3 py-2 ${
                    c.align === "right"
                      ? "text-right"
                      : c.align === "center"
                        ? "text-center"
                        : ""
                  }`}
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
              <td className={`${cellTruncate} px-3 py-2 tabular-nums text-[var(--wms-accent)]`} title={s.name}>
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
              <td className="overflow-hidden px-3 py-2 text-right tabular-nums">{s.expected_count}</td>
              <td className="overflow-hidden px-3 py-2 text-right tabular-nums">{s.scanned_count}</td>
              <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`}>
                {new Date(s.started_at).toLocaleString()}
              </td>
              {isHistory ? (
                <td
                  className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`}
                  title={s.started_by_email ?? ""}
                >
                  {s.started_by_email ?? "—"}
                </td>
              ) : null}
              <td className="overflow-hidden px-3 py-2 text-right">
                <button
                  type="button"
                  onClick={() => onOpen(s.id)}
                  className="rounded-md border border-[var(--wms-border)] px-3 py-1 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
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
    refreshInterval: 5_000,
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

  const [tab, setTab] = useState<"all" | "by_sku" | "by_bin">("all");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [search, setSearch] = useState("");
  const [commitOpen, setCommitOpen] = useState(false);
  // "Finish" popup: replaces the old "Review & commit" closer. The fixed-
  // reader cycle count cannot close itself anymore (2026-05-12 policy) —
  // operators must hand off to the mobile handheld add-on count, which is
  // the only path that closes the session + runs reconcile + flips
  // truly-missing tags to tag_killed.
  const [finishOpen, setFinishOpen] = useState(false);
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
      setLastReadAt(now);
      readsThisMinuteRef.current.push(now);
      // prune > 60s
      const cutoff = now - 60_000;
      while (readsThisMinuteRef.current[0] !== undefined && readsThisMinuteRef.current[0] < cutoff) {
        readsThisMinuteRef.current.shift();
      }
      setReadsPerMin(readsThisMinuteRef.current.length);
      setLocalScanned((prev) => {
        const next = new Set(prev);
        for (const epc of list) next.add(epc);
        return next;
      });
      for (const epc of list) pendingScanRef.current.add(epc);
      // Fire immediately — flushingRef gates pile-up. Drain loop in the
      // flusher keeps draining as events arrive during the in-flight POST.
      void flushPendingScans();
    };
    return () => es.close();
  }, [detail?.id, detail?.status, flushPendingScans]); // eslint-disable-line react-hooks/exhaustive-deps

  // Read-rate refresher even when no new reads arrive (decay to 0).
  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - 60_000;
      while (readsThisMinuteRef.current[0] !== undefined && readsThisMinuteRef.current[0] < cutoff) {
        readsThisMinuteRef.current.shift();
      }
      setReadsPerMin(readsThisMinuteRef.current.length);
    }, 1500);
    return () => clearInterval(t);
  }, []);

  // Safety-net interval — picks up anything that piled up while a flush was
  // already running. Short cadence so the UI stays current even if the
  // SSE-triggered flush is gated.
  useEffect(() => {
    if (!detail) return;
    if (detail.status !== "active") return;
    const t = setInterval(() => {
      void flushPendingScans();
    }, 750);
    return () => clearInterval(t);
  }, [detail?.id, detail?.status, flushPendingScans]);

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

  // Track scan-session ids per reader so we can release them on status flip.
  // Keyed by reader id since cycle counts may use multiple readers and the
  // scan-session API is per-reader.
  const scanSessionIdsRef = useRef<Map<string, string>>(new Map());

  // Reader-busy conflicts (409 from /api/scan-sessions/start). Maps
  // readerId → conflicting session id (the OTHER workflow's session). The
  // operator can take any of them over via the busy banner. The map
  // updates whenever a multi-reader pickup encounters a busy reader.
  const [conflicts, setConflicts] = useState<Map<string, { sessionId: string; kind: string }>>(
    () => new Map(),
  );

  const startScanSessionsForSelectedReaders = useCallback(async () => {
    const readerIds = [...selectedReadersRef.current];
    if (readerIds.length === 0) return;
    for (const rid of readerIds) {
      if (scanSessionIdsRef.current.has(rid)) continue;
      try {
        const r = await fetch("/api/scan-sessions/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ readerId: rid, kind: "cycle-count" }),
        });
        const j = (await r.json()) as {
          ok?: boolean;
          sessionId?: string;
          reason?: string;
          existing?: { id: string; kind: string };
        };
        if (r.ok && j.ok && j.sessionId) {
          scanSessionIdsRef.current.set(rid, j.sessionId);
          setConflicts((prev) => {
            if (!prev.has(rid)) return prev;
            const next = new Map(prev);
            next.delete(rid);
            return next;
          });
        } else if (j.reason === "reader_busy" && j.existing?.id) {
          setConflicts((prev) => {
            const next = new Map(prev);
            next.set(rid, { sessionId: j.existing!.id, kind: j.existing!.kind });
            return next;
          });
        }
      } catch {
        /* server-side idle expiry will release within 60s */
      }
    }
  }, []);

  // Stop every workflow that currently owns any of the selected readers, then
  // claim them all in one shot. Operators don't want to see which reader is
  // busy — one button takes them all over.
  const takeoverAllReaders = useCallback(async () => {
    const entries = [...conflicts.entries()];
    if (entries.length === 0) return;
    await Promise.all(
      entries.map(([, c]) =>
        fetch("/api/scan-sessions/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: c.sessionId }),
        }).catch(() => {}),
      ),
    );
    setConflicts(new Map());
    await new Promise((r) => setTimeout(r, 300));
    void startScanSessionsForSelectedReaders();
  }, [conflicts, startScanSessionsForSelectedReaders]);

  const endAllScanSessions = useCallback(async () => {
    const entries = [...scanSessionIdsRef.current.entries()];
    scanSessionIdsRef.current.clear();
    for (const [, sid] of entries) {
      try {
        await fetch("/api/scan-sessions/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sid }),
        });
      } catch {
        /* network blip — operator can re-pause from Hardware Config if needed */
      }
    }
  }, []);

  // On unmount: end all sessions so readers return to paused state when the
  // operator navigates away. There is NO server-side idle expiry — sessions
  // only end on explicit click or this unmount keepalive.
  useEffect(() => {
    return () => {
      for (const [, sid] of scanSessionIdsRef.current.entries()) {
        void fetch("/api/scan-sessions/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sid }),
          keepalive: true,
        }).catch(() => {});
      }
      scanSessionIdsRef.current.clear();
    };
  }, []);

  // When the count goes active, wake selected readers and remember that
  // we've been scanning. When it goes paused/canceled (or committed
  // elsewhere), release them.
  useEffect(() => {
    if (!detail) return;
    if (detail.status === "active") {
      setWasEverActive(true);
      void startScanSessionsForSelectedReaders();
    } else {
      void endAllScanSessions();
    }
  }, [detail?.status, startScanSessionsForSelectedReaders, endAllScanSessions]);

  // If the operator changes selected readers mid-count, re-sync sessions.
  useEffect(() => {
    if (!detail || detail.status !== "active") return;
    const wantIds = selectedReaders;
    // Release any session for a reader no longer selected.
    for (const [rid, sid] of [...scanSessionIdsRef.current.entries()]) {
      if (!wantIds.has(rid)) {
        scanSessionIdsRef.current.delete(rid);
        void fetch("/api/scan-sessions/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sid }),
        }).catch(() => {});
      }
    }
    // Wake any newly-selected readers.
    void startScanSessionsForSelectedReaders();
  }, [selectedReaders, detail?.status, startScanSessionsForSelectedReaders]);

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
  const liveMatchedCount = useMemo(() => {
    let n = 0;
    for (const epc of localScanned) if (expectedEpcSet.has(epc)) n += 1;
    return Math.max(n, variance.matched.length);
  }, [localScanned, expectedEpcSet, variance.matched.length]);
  const liveMissingCount = Math.max(0, liveExpectedCount - liveMatchedCount);
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
  const animCoverage = useCountUp(liveCoverage);
  const animMatched = useCountUp(liveMatchedCount);
  const animMissing = useCountUp(liveMissingCount);
  const animAdded = useCountUp(variance.added_here.length);
  const animDefective = useCountUp(variance.defective.length);
  const animLocked = useCountUp(variance.locked.length);
  const animReadsPerMin = useCountUp(readsPerMin);

  // Live-ticking scan time. When the session is active, the open period's
  // contribution grows in real time, so tick every second.
  const [scanClockTick, setScanClockTick] = useState(0);
  useEffect(() => {
    if (detail?.status !== "active") return;
    const t = setInterval(() => setScanClockTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [detail?.status]);
  const scanMs = detail
    ? totalScanMs(detail.scan_periods, Date.now())
    : 0;
  void scanClockTick;

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
      // Release readers immediately on pause/cancel — don't wait for
      // the next reconcile tick. (active path handled by useEffect above.)
      if (next !== "active") {
        await endAllScanSessions();
      }
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
    // Release all readers immediately on commit — antennas off the moment
    // the action is done, per the spec.
    await endAllScanSessions();
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
        <KpiTile big label="Coverage" value={`${animCoverage}%`} cls={coverage === 100 ? "wms-status-success" : coverage >= 80 ? "text-amber-400" : "text-red-400"} />
        <KpiTile label="Matched" value={`${animMatched} / ${expectedCount}`} cls="wms-status-success" />
        <KpiTile label="Missing" value={String(animMissing)} cls="text-amber-400" />
        <KpiTile label="Added here" value={String(animAdded)} cls="text-sky-300" />
        <KpiTile label="Defective" value={String(animDefective)} cls="text-red-400" />
        <KpiTile label="Locked" value={String(animLocked)} cls="text-fuchsia-300" />
        <KpiTile
          label="Scan time"
          value={formatHms(scanMs)}
          sub={`${detail.scan_periods.length} period${detail.scan_periods.length === 1 ? "" : "s"}`}
          cls={detail.status === "active" ? "text-emerald-300" : "text-[var(--wms-muted)]"}
        />
        <KpiTile
          label="Read rate"
          value={`${animReadsPerMin}/min`}
          sub={`last read ${lastReadStr}`}
          cls={readsPerMin > 0 ? "text-emerald-300" : "text-[var(--wms-muted)]"}
        />
      </div>

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
            {conflicts.size > 0 ? (
              <button
                type="button"
                onClick={() => void takeoverAllReaders()}
                title="Some selected readers are busy on another screen. Stop them there and take them all here in one click."
                className="inline-flex items-center gap-2 rounded-lg border border-amber-500/60 bg-amber-950/40 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-amber-100 hover:bg-amber-900/40"
              >
                <Radio className="h-3.5 w-3.5 text-amber-300" />
                Take all readers here ({conflicts.size})
              </button>
            ) : null}
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
            <button
              type="button"
              disabled={localScanned.size === 0}
              onClick={() => setFinishOpen(true)}
              className="wms-btn-primary px-6 font-mono disabled:opacity-50"
            >
              Finish
            </button>
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
              className={`px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide ${
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
                  className={`rounded-full border px-2.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wide ${
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
        <AllEpcsTable rows={flatRows} search={search} stateFilter={stateFilter} />
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
