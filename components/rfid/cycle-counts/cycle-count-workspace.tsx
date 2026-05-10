"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type LocationRow = { id: string; code: string; name: string };
type BinRow = { id: string; code: string; in_stock_count: number };

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
};

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
  misplaced: "Misplaced",
  unrecognized: "Unrecognized",
} as const;

export function CycleCountWorkspace({ isAdmin = false }: { isAdmin?: boolean }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  return (
    <div className="space-y-6">
      {activeId ? (
        <ActiveSessionView
          sessionId={activeId}
          onLeave={() => setActiveId(null)}
          isAdmin={isAdmin}
        />
      ) : (
        <SessionLanding
          onOpen={(id) => setActiveId(id)}
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
  const { data: openData, mutate: mutateOpen } = useSWR<{ sessions: SessionRow[] }>(
    "/api/rfid/cycle-counts/sessions?status=open",
    fetcher,
    { refreshInterval: 5_000 },
  );
  const { data: closedData } = useSWR<{ sessions: SessionRow[] }>(
    showHistory ? "/api/rfid/cycle-counts/sessions?status=closed" : null,
    fetcher,
  );

  return (
    <>
      <NewSessionForm onCreated={(id) => onOpen(id)} onMutate={mutateOpen} />

      <Section title="Open counts" hint="Active or paused sessions you can resume.">
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
        <Section title="History" hint="Committed and canceled sessions.">
          {closedData && closedData.sessions.length > 0 ? (
            <SessionTable sessions={closedData.sessions} onOpen={onOpen} variant="history" />
          ) : (
            <Empty>No closed sessions yet.</Empty>
          )}
        </Section>
      ) : null}
    </>
  );
}

function NewSessionForm({
  onCreated,
  onMutate,
}: {
  onCreated: (id: string) => void;
  onMutate: () => void;
}) {
  const { data: locData } = useSWR<{ id: string; code: string; name: string }[]>(
    "/api/locations",
    fetcher,
  );
  const locations: LocationRow[] = locData ?? [];

  const [locationId, setLocationId] = useState("");
  const [binId, setBinId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
          name: name.trim() || undefined,
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
    <Section title="Start a new count" hint="Pick a location (and optionally a bin) to scope what should be counted. The expected list is frozen at start.">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Location">
          <select
            value={locationId}
            onChange={(e) => {
              setLocationId(e.target.value);
              setBinId("");
            }}
            className={inputCls}
          >
            <option value="">— Select —</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.code} — {l.name}
              </option>
            ))}
          </select>
        </Field>
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
        <Field label="Name (optional)">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="auto-named with location + time"
            className={inputCls}
          />
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
          {busy ? "Starting…" : "Start count"}
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
  // History view drops the Bin column (operators reference closed counts
  // by # + who ran them, not by bin scope), replaces leading "Name" with
  // a per-tenant "#" session number, and adds a trailing "Name" column
  // showing the email of the user who opened it. Open-counts view keeps
  // the operator's chosen Name as the leading column for picking up an
  // in-progress count.
  const isHistory = variant === "history";
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80">
      <table className="w-full border-collapse text-left">
        <thead className="bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
          <tr>
            {isHistory ? (
              <th className="px-3 py-2 w-12 text-right">#</th>
            ) : (
              <th className="px-3 py-2">Name</th>
            )}
            <th className="px-3 py-2">Location</th>
            {isHistory ? null : <th className="px-3 py-2">Bin</th>}
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2 text-right">Expected</th>
            <th className="px-3 py-2 text-right">Scanned</th>
            <th className="px-3 py-2">Started</th>
            {isHistory ? <th className="px-3 py-2">Name</th> : null}
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-xs text-[var(--wms-fg)]">
          {sessions.map((s) => (
            <tr key={s.id} className="hover:bg-[var(--wms-surface-elevated)]/40">
              {isHistory ? (
                <td className="px-3 py-2 text-right tabular-nums text-[var(--wms-accent)]">
                  {s.session_number ?? "—"}
                </td>
              ) : (
                <td className="px-3 py-2 truncate max-w-[18rem] text-[var(--wms-accent)]">
                  {s.name}
                </td>
              )}
              <td className="px-3 py-2">{s.location_code}</td>
              {isHistory ? null : (
                <td className="px-3 py-2 text-[var(--wms-muted)]">{s.bin_code ?? "(all)"}</td>
              )}
              <td className="px-3 py-2">
                <StatusPill status={s.status} />
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{s.expected_count}</td>
              <td className="px-3 py-2 text-right tabular-nums">{s.scanned_count}</td>
              <td className="px-3 py-2 text-[var(--wms-muted)]">
                {new Date(s.started_at).toLocaleString()}
              </td>
              {isHistory ? (
                <td
                  className="px-3 py-2 truncate max-w-[16rem] text-[var(--wms-muted)]"
                  title={s.started_by_email ?? ""}
                >
                  {s.started_by_email ?? "—"}
                </td>
              ) : null}
              <td className="px-3 py-2 text-right">
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
    </div>
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

const cycleStreamContexts = new Set(["CYCLE_COUNT"]);

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
    misplaced: [],
    unrecognized: [],
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
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Hydrate local scanned set from server on first load + when session changes.
  useEffect(() => {
    if (!detail) return;
    setLocalScanned(new Set(detail.scanned_epcs.map((e) => e.toUpperCase())));
  }, [detail?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const ctx = (p.scanContext ?? "").toUpperCase();
      if (!cycleStreamContexts.has(ctx)) return;
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
    };
    return () => es.close();
  }, [detail?.id, detail?.status]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Server-sync — push local scanned set on a 3s debounce while active.
  useEffect(() => {
    if (!detail) return;
    if (detail.status !== "active") return;
    const t = setInterval(() => {
      const arr = [...localScanned];
      // Only PATCH if the server's count differs.
      if (arr.length === detail.scanned_count) return;
      void fetch(`/api/rfid/cycle-counts/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scannedEpcs: arr }),
      }).then(() => mutate());
    }, 3000);
    return () => clearInterval(t);
  }, [detail?.id, detail?.status, detail?.scanned_count, localScanned, sessionId, mutate]);

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

  // Stop the workflow that currently owns a specific reader, then claim it.
  const takeoverReader = useCallback(
    async (readerId: string) => {
      const c = conflicts.get(readerId);
      if (!c) return;
      try {
        await fetch("/api/scan-sessions/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: c.sessionId }),
        }).catch(() => {});
      } finally {
        setConflicts((prev) => {
          const next = new Map(prev);
          next.delete(readerId);
          return next;
        });
      }
      await new Promise((r) => setTimeout(r, 300));
      void startScanSessionsForSelectedReaders();
    },
    [conflicts, startScanSessionsForSelectedReaders],
  );

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

  // When the count goes active, wake selected readers. When it goes
  // paused/canceled (or committed elsewhere), release them.
  useEffect(() => {
    if (!detail) return;
    if (detail.status === "active") {
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
      // Push any pending scans first (so the server snapshot is current).
      await fetch(`/api/rfid/cycle-counts/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scannedEpcs: [...localScanned], status: next }),
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
    acceptMisplaced: string[];
    acceptUnrecognized: string[];
    notes: string;
  }) => {
    // Make sure latest scans are persisted before committing.
    await fetch(`/api/rfid/cycle-counts/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scannedEpcs: [...localScanned] }),
    });
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
              {detail.name}
            </h2>
            <p className="mt-1 font-mono text-[0.65rem] text-[var(--wms-muted)]">
              {detail.location_code} · {detail.bin_code ?? "all bins"} ·{" "}
              <StatusPill status={detail.status} /> ·{" "}
              started {new Date(detail.started_at).toLocaleString()}
            </p>
          </div>
          <a
            href={`/api/rfid/cycle-counts/sessions/${sessionId}/export`}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-surface)]"
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </a>
        </div>
      </div>

      {/* KPI strip with coverage + read rate */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile big label="Coverage" value={`${coverage}%`} cls={coverage === 100 ? "wms-status-success" : coverage >= 80 ? "text-amber-400" : "text-red-400"} />
        <KpiTile label="Matched" value={`${variance.matched.length} / ${expectedCount}`} cls="wms-status-success" />
        <KpiTile label="Missing" value={String(variance.missing.length)} cls="text-amber-400" />
        <KpiTile label="Misplaced" value={String(variance.misplaced.length)} cls="text-orange-400" />
        <KpiTile label="Unrecognized" value={String(variance.unrecognized.length)} cls="text-[var(--wms-muted)]" />
        <KpiTile
          label="Read rate"
          value={`${readsPerMin}/min`}
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
            <Play className="h-4 w-4" /> Resume
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
            {[...conflicts.entries()].map(([rid, c]) => (
              <button
                key={rid}
                type="button"
                onClick={() => void takeoverReader(rid)}
                title={`Reader ${rid.slice(0, 8)}… is busy with a ${c.kind} workflow. Click to stop it and take this reader.`}
                className="inline-flex items-center gap-2 rounded-lg border border-amber-500/60 bg-amber-950/40 px-3 py-2 font-mono text-xs font-semibold text-amber-100 hover:bg-amber-900/40"
              >
                <Radio className="h-3.5 w-3.5 text-amber-300" />
                Stop other & take {rid.slice(0, 6)}
              </button>
            ))}
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
              onClick={() => setCommitOpen(true)}
              className="wms-btn-primary px-6 font-mono disabled:opacity-50"
            >
              Review &amp; commit
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
                      : s === "misplaced"
                        ? variance.misplaced.length
                        : variance.unrecognized.length;
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
          Committed: {detail.variance_summary.matched} matched · {detail.variance_summary.missing} missing
          · {detail.variance_summary.misplaced} misplaced · {detail.variance_summary.unrecognized} unrecognized.
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
