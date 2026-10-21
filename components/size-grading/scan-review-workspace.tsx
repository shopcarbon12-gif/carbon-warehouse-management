"use client";

/**
 * Scan review — every photo CarbonGradingAI saved, and the owner's verdict on it.
 *
 * A scan is saved the moment the operator presses Save on the phone, and its
 * numbers go straight onto the items (every colour of the size, every product
 * of its cut group). Review is the check afterwards, not a gate before: the
 * server flags what looks wrong — L/R that disagree, a size that does not sit
 * between its neighbours, a test phone — and those land here under "Needs
 * check" by default.
 *
 *   Approve  the reading stands.
 *   Redo     the reading is taken back: every measurement row the scan wrote is
 *            deleted (including copies made inside its cut group), so the size
 *            shows as not measured and comes back on the phone's list.
 *   Flag     back to "Needs check".
 *
 * The photo is the squared-up picture the phone measured on, and each line is
 * drawn exactly where the operator left it, coloured by where it came from —
 * the outline, the AI, or a hand that moved it. That is what makes a wrong
 * number findable: a sleeve line ending short of the cuff is obvious on the
 * picture and invisible in a table.
 *
 * The open scan is bound to ?scan= and the filter to ?status= (plus the
 * optional ?cutGroupId= / ?matrixId= the cut-group page links with), so a
 * refresh lands on the same screen. The note being typed stays in React state.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Check, ExternalLink, Flag, ImageIcon, Loader2, Move, RefreshCw, RotateCcw, Save, X } from "lucide-react";

import { withPairAverages, type GradingPoint, type GradingProfile } from "@/lib/size-grading/grading-app-profiles";
import { LineEditor, polyLen, type EditLine } from "@/components/size-grading/line-editor";
import { useUrlParam } from "@/lib/use-url-param";
import { STORE_TZ } from "@/lib/orlando-time";
import { staffLabel } from "@/lib/staff-name";

type ScanStatus = "flagged" | "saved" | "approved" | "redo";

type ScanRow = {
  id: string;
  matrix_id: string;
  name: string | null;
  upc: string | null;
  size: string | null;
  color: string | null;
  profile: string;
  status: ScanStatus | string;
  flags: string[] | null;
  points_cm: Record<string, number> | null;
  applied_to: number;
  created_at: string;
  ai_model: string | null;
  /** numeric — arrives as a string from Postgres. */
  ai_cost_usd: number | string | null;
  dropbox_path: string | null;
  dropbox_error: string | null;
  review_note: string | null;
  cut_group: string | null;
  has_photo: boolean;
  by_email: string | null;
};

type Line = { pts: [number, number][]; source: "outline" | "ai" | "manual"; moved?: boolean };

type ScanDetail = Omit<ScanRow, "has_photo" | "by_email"> & {
  has_photo?: boolean;
  by_email?: string | null;
  photo_key?: string | null;
  lines: Record<string, Line> | null;
  px_per_cm: number | string | null;
  photo_w: number | null;
  photo_h: number | null;
  depth: Record<string, unknown> | null;
  device: Record<string, unknown> | null;
  app_version?: string | null;
  sku?: string | null;
  view?: string | null;
  cut_group_id?: string | null;
  reviewed_at?: string | null;
  adjusted_at?: string | null;
  crotch?: { pxPerCm: number; photoW?: number; photoH?: number; lines: Record<string, Line>; depth?: Record<string, unknown> | null } | null;
  crotch_photo_key?: string | null;
  profileDef: { id: string; label: string; family: string; points: GradingPoint[] } | null;
};

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error ?? "Failed to load");
  return j;
};

const FILTERS = [
  { id: "flagged", label: "Needs check" },
  { id: "all", label: "All" },
  { id: "approved", label: "Approved" },
  { id: "redo", label: "Redo" },
] as const;

const STATUS: Record<string, { label: string; cls: string }> = {
  flagged: {
    label: "Needs check",
    cls: "border-[var(--wms-status-warning-fg)]/50 bg-[var(--wms-status-warning-fg)]/10 text-[var(--wms-status-warning-fg)]",
  },
  saved: { label: "Saved", cls: "border-[var(--wms-border)] text-[var(--wms-muted)]" },
  approved: {
    label: "Approved",
    cls: "border-[var(--wms-status-success-fg)]/40 bg-[var(--wms-status-success-fg)]/10 text-[var(--wms-status-success-fg)]",
  },
  redo: {
    label: "Redo",
    cls: "border-[var(--wms-status-danger-fg)]/40 bg-[var(--wms-status-danger-fg)]/10 text-[var(--wms-status-danger-fg)]",
  },
};
const statusOf = (s: string) => STATUS[s] ?? { label: s, cls: STATUS.saved.cls };

/* Line colours on the photo. Fixed, not theme tokens: they are drawn on a
   photograph, which looks the same in light and dark, and each sits on a dark
   halo so it reads on a white tee and on black denim alike. */
const SOURCE_COLOR = { outline: "#22d3ee", ai: "#fbbf24", manual: "#f472b6" } as const;
const SOURCE_LABEL = { outline: "Found from the outline", ai: "Placed by the AI", manual: "Moved by hand" } as const;
type SourceKind = keyof typeof SOURCE_COLOR;
const sourceKind = (l: Line | undefined): SourceKind | null =>
  !l ? null : l.source === "manual" || l.moved ? "manual" : l.source === "ai" ? "ai" : "outline";
const SOURCE_SHORT: Record<SourceKind, string> = { outline: "Outline", ai: "AI", manual: "Moved by hand" };

const WHEN = new Intl.DateTimeFormat("en-US", {
  timeZone: STORE_TZ,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const when = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : WHEN.format(d);
};
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const money = (v: unknown) => {
  const n = num(v);
  return n === null ? null : `$${n.toFixed(n < 0.01 ? 4 : 3)}`;
};
const cm1 = (v: number | null | undefined) => (typeof v === "number" ? v.toFixed(1) : "—");
const in1 = (v: number | null | undefined) => (typeof v === "number" ? (v / 2.54).toFixed(1) : "—");
const photoUrl = (id: string, which: "main" | "crotch" = "main") =>
  `/api/grading-app/scans/${id}/photo${which === "crotch" ? "?which=crotch" : ""}`;

const plainBtn =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] px-3 py-1.5 text-sm text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40 max-md:min-h-11";

export function ScanReviewWorkspace() {
  const [statusParam, setStatusParam] = useUrlParam("status");
  const [cutGroupId, setCutGroupId] = useUrlParam("cutGroupId");
  const [matrixId, setMatrixId] = useUrlParam("matrixId");
  const [scanId, setScanId] = useUrlParam("scan");
  const status = FILTERS.some((f) => f.id === statusParam) ? (statusParam as string) : "flagged";
  const [limit, setLimit] = useState(50);
  /** Which row's Dropbox error is spelled out (a tap target on phones, where there is no hover). */
  const [dropboxOpen, setDropboxOpen] = useState<string | null>(null);

  const key = useMemo(() => {
    const p = new URLSearchParams({ status, limit: String(limit) });
    if (cutGroupId) p.set("cutGroupId", cutGroupId);
    if (matrixId) p.set("matrixId", matrixId);
    return `/api/grading-app/scans?${p.toString()}`;
  }, [status, limit, cutGroupId, matrixId]);
  /* New scans arrive from the phone while this is open, so it keeps itself
     current rather than waiting for a refresh. */
  const { data, error, isLoading, isValidating, mutate } = useSWR<{ scans: ScanRow[] }>(key, fetcher, {
    refreshInterval: 30_000,
  });
  const scans = useMemo(() => data?.scans ?? [], [data]);
  const openRow = useMemo(() => scans.find((s) => s.id === scanId) ?? null, [scans, scanId]);

  const close = useCallback(() => setScanId(null), [setScanId]);
  const refreshList = useCallback(async () => {
    await mutate();
  }, [mutate]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Which scans">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={status === f.id}
              onClick={() => {
                setStatusParam(f.id === "flagged" ? null : f.id);
                setLimit(50);
              }}
              className={`rounded-full border px-3 py-1 text-sm max-md:min-h-11 max-md:px-4 ${
                status === f.id
                  ? "border-[var(--wms-accent)] bg-[var(--wms-accent)] font-semibold text-[var(--wms-accent-fg)]"
                  : "border-[var(--wms-border)] text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        {cutGroupId ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-0.5 pl-3 pr-1 text-sm text-[var(--wms-fg)]">
            Cut group: {scans.find((s) => s.cut_group)?.cut_group ?? "the chosen group"}
            <button
              type="button"
              onClick={() => setCutGroupId(null)}
              className="rounded-full p-1 text-[var(--wms-muted)] hover:text-[var(--wms-fg)] max-md:min-h-11 max-md:min-w-11 max-md:flex max-md:items-center max-md:justify-center"
              aria-label="Show every cut group"
              title="Show every cut group"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : null}
        {matrixId ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-0.5 pl-3 pr-1 text-sm text-[var(--wms-fg)]">
            Product: {scans[0]?.name ?? "the chosen product"}
            <button
              type="button"
              onClick={() => setMatrixId(null)}
              className="rounded-full p-1 text-[var(--wms-muted)] hover:text-[var(--wms-fg)] max-md:min-h-11 max-md:min-w-11 max-md:flex max-md:items-center max-md:justify-center"
              aria-label="Show every product"
              title="Show every product"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : null}
        <button type="button" className={`${plainBtn} ml-auto`} onClick={() => void mutate()} disabled={isValidating}>
          <RefreshCw className={`h-4 w-4 ${isValidating ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {error ? (
        <p className="text-sm text-[var(--wms-status-danger-fg)]">
          Could not load the scans — {error instanceof Error ? error.message : String(error)}
        </p>
      ) : null}

      <div className="min-w-0 overflow-hidden rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)]">
        {isLoading ? (
          <p className="flex items-center gap-2 p-3 text-sm text-[var(--wms-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading scans…
          </p>
        ) : !scans.length ? (
          <p className="p-3 text-sm text-[var(--wms-muted)]">
            {status === "flagged"
              ? "Nothing needs checking — every scan saved without a warning, or has been reviewed."
              : "No scans here yet."}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--wms-border)]">
            {scans.map((s) => {
              const st = statusOf(s.status);
              const cost = money(s.ai_cost_usd);
              const who = staffLabel(null, null, s.by_email);
              const flags = s.flags ?? [];
              return (
                <li key={s.id} className="flex flex-wrap items-start gap-3 p-3 hover:bg-[var(--wms-surface-elevated)]/50">
                  <button
                    type="button"
                    onClick={() => setScanId(s.id)}
                    className="flex min-w-0 flex-1 items-start gap-3 text-left"
                    title="Open this scan"
                  >
                    {s.has_photo ? (
                      // The scan's own photo, served from R2 behind the session.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={photoUrl(s.id)}
                        alt=""
                        loading="lazy"
                        className="h-16 w-16 shrink-0 rounded border border-[var(--wms-border)]/60 bg-[var(--wms-surface-elevated)] object-cover"
                      />
                    ) : (
                      <span
                        className="flex h-16 w-16 shrink-0 items-center justify-center rounded border border-[var(--wms-border)]/60 text-[var(--wms-border)]"
                        aria-hidden
                      >
                        <ImageIcon className="h-6 w-6" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-[var(--wms-fg)]">{s.name ?? "Unnamed product"}</span>
                      <span className="block font-mono text-xs text-[var(--wms-muted)]">
                        Size {s.size ?? "—"}
                        {s.color ? ` · ${s.color}` : ""}
                        {s.upc ? ` · UPC ${s.upc}` : ""}
                      </span>
                      {s.cut_group ? (
                        <span className="block text-xs text-[var(--wms-muted)]">Cut group: {s.cut_group}</span>
                      ) : null}
                      {flags.length ? (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {flags.map((f, i) => (
                            <span
                              key={`${i}-${f}`}
                              className="rounded border border-[var(--wms-status-warning-fg)]/50 bg-[var(--wms-status-warning-fg)]/10 px-1.5 py-0.5 font-mono text-[0.68rem] text-[var(--wms-status-warning-fg)]"
                            >
                              {f}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  <div className="flex shrink-0 flex-col items-end gap-0.5 text-right text-xs text-[var(--wms-muted)] max-md:w-full max-md:items-start max-md:text-left">
                    <span className={`rounded border px-1.5 py-0.5 font-mono text-[0.68rem] ${st.cls}`}>{st.label}</span>
                    <span>
                      {when(s.created_at)}
                      {who ? ` · ${who}` : ""}
                    </span>
                    {s.ai_model || cost ? (
                      <span className="font-mono">
                        AI: {s.ai_model ?? "—"}
                        {cost ? ` · ${cost}` : ""}
                      </span>
                    ) : null}
                    {s.dropbox_path ? (
                      <span className="text-[var(--wms-status-success-fg)]" title={s.dropbox_path}>
                        Dropbox: saved
                      </span>
                    ) : s.dropbox_error ? (
                      <>
                        <button
                          type="button"
                          title={s.dropbox_error}
                          onClick={() => setDropboxOpen((cur) => (cur === s.id ? null : s.id))}
                          className="text-[var(--wms-status-danger-fg)] underline decoration-dotted max-md:py-2"
                        >
                          Dropbox: failed
                        </button>
                        {dropboxOpen === s.id ? (
                          <span className="max-w-xs break-words text-[var(--wms-status-danger-fg)]">{s.dropbox_error}</span>
                        ) : null}
                      </>
                    ) : s.has_photo ? (
                      <span>Dropbox: not copied yet</span>
                    ) : (
                      <span>No photo saved</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {scans.length >= limit && limit < 200 ? (
        <button type="button" className={`${plainBtn} self-start`} onClick={() => setLimit(200)}>
          Showing the latest {limit} — show up to 200
        </button>
      ) : null}

      {scanId ? <ScanWindow key={scanId} id={scanId} row={openRow} onClose={close} onChanged={refreshList} /> : null}
    </div>
  );
}

/* ───────────────────────────── scan window ───────────────────────────── */

function ScanWindow({
  id,
  row,
  onClose,
  onChanged,
}: {
  id: string;
  /** The same scan's list row, when it is in the list — carries who saved it. */
  row: ScanRow | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { data, error, isLoading, mutate } = useSWR<{ scan: ScanDetail }>(`/api/grading-app/scans/${id}`, fetcher, {
    revalidateOnFocus: false,
  });
  const scan = data?.scan ?? null;
  /** The point picked in the table — its line is drawn thicker on the photo. */
  const [selected, setSelected] = useState<string | null>(null);
  /* Adjust lines: a copy of both photos' lines being dragged; null when not editing. */
  const [draft, setDraft] = useState<{ main: Record<string, Line>; crotch: Record<string, Line> | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [editMsg, setEditMsg] = useState<string | null>(null);

  const changed = useCallback(async () => {
    await Promise.all([mutate(), onChanged()]);
  }, [mutate, onChanged]);

  const canEdit = Boolean(scan && scan.status !== "redo" && Object.keys(scan.lines ?? {}).length);
  /* Lines can be dragged straight away — the first drag starts the edit (no
     mode to find first; owner, 2026-10-20). */
  const moveEnd = (which: "main" | "crotch") => (key: string, index: number, to: [number, number]) =>
    setDraft((cur) => {
      type Draft = { main: Record<string, Line>; crotch: Record<string, Line> | null };
      const d: Draft | null =
        cur ??
        (scan
          ? { main: JSON.parse(JSON.stringify(scan.lines ?? {})), crotch: scan.crotch?.lines ? JSON.parse(JSON.stringify(scan.crotch.lines)) : null }
          : null);
      if (!d) return d;
      const set = which === "main" ? d.main : d.crotch;
      const l = set?.[key];
      if (!set || !l) return d;
      const next = { ...set, [key]: { ...l, pts: l.pts.map((p, i) => (i === index ? to : p)), source: "manual" as const, moved: true } };
      return which === "main" ? { ...d, main: next } : { ...d, crotch: next };
    });
  /* The numbers while dragging, worked out as the phone and the server do. */
  const liveCm = useMemo(() => {
    if (!draft || !scan?.profileDef) return null;
    const known = new Set<string>(scan.profileDef.points.map((p) => p.key));
    const cm: Record<string, number> = {};
    const ppc = num(scan.px_per_cm) ?? 0;
    if (ppc > 0) for (const [k, l] of Object.entries(draft.main)) if (known.has(k)) cm[k] = polyLen(l.pts) / ppc;
    const cppc = num(scan.crotch?.pxPerCm) ?? 0;
    if (draft.crotch && cppc > 0) for (const [k, l] of Object.entries(draft.crotch)) if (known.has(k)) cm[k] = polyLen(l.pts) / cppc;
    return withPairAverages(scan.profileDef as unknown as GradingProfile, cm);
  }, [draft, scan]);
  const saveEdit = async () => {
    if (!draft || !scan) return;
    setSaving(true);
    setEditErr(null);
    try {
      const res = await fetch(`/api/grading-app/scans/${scan.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "adjust", lines: draft.main, crotchLines: draft.crotch }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; updated?: number };
      if (!res.ok) throw new Error(j.error ?? "Could not save");
      setDraft(null);
      setEditMsg(`Saved — the new numbers are on ${j.updated ?? 0} item${j.updated === 1 ? "" : "s"}.`);
      await changed();
    } catch (e) {
      setEditErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const who = staffLabel(null, null, scan?.by_email ?? row?.by_email ?? null);

  return (
    <>
      <button type="button" aria-label="Close" className="fixed inset-0 z-[60] bg-black/70" onClick={onClose} />
      <div className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center p-4 max-md:items-stretch max-md:p-0">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Scan"
          className="pointer-events-auto flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl max-md:h-full max-md:max-h-none max-md:max-w-none max-md:rounded-none max-md:border-0"
        >
          <div className="flex items-start justify-between gap-2 border-b border-[var(--wms-border)] px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-[var(--wms-fg)]">
                {scan ? `${scan.name ?? "Unnamed product"} — size ${scan.size ?? "—"}` : "Scan"}
              </h2>
              {scan ? (
                <p className="font-mono text-xs text-[var(--wms-muted)]">
                  {[
                    scan.color,
                    scan.sku ? `SKU ${scan.sku}` : null,
                    scan.upc ? `UPC ${scan.upc}` : null,
                    scan.profileDef?.label ?? scan.profile,
                    scan.view === "back" ? "back" : null,
                    scan.cut_group ? `cut group ${scan.cut_group}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : null}
              {scan ? (
                <p className="text-xs text-[var(--wms-muted)]">
                  Saved {when(scan.created_at)}
                  {who ? ` by ${who}` : ""}
                  {scan.ai_model ? ` · AI ${scan.ai_model}` : ""}
                  {money(scan.ai_cost_usd) ? ` · ${money(scan.ai_cost_usd)}` : ""}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] max-md:-my-1.5 max-md:inline-flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4 max-md:overscroll-contain max-md:pb-[max(1rem,env(safe-area-inset-bottom))]">
            {isLoading ? (
              <p className="flex items-center gap-2 text-sm text-[var(--wms-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading the scan…
              </p>
            ) : error || !scan ? (
              <p className="text-sm text-[var(--wms-status-danger-fg)]">
                {error instanceof Error && error.message !== "Not found"
                  ? `Could not load this scan — ${error.message}`
                  : "This scan no longer exists."}
              </p>
            ) : (
              <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <div className="flex min-w-0 flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {draft ? (
                      <>
                        <button type="button" className={plainBtn} onClick={() => void saveEdit()} disabled={saving}>
                          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save the new lines
                        </button>
                        <button type="button" className={plainBtn} onClick={() => setDraft(null)} disabled={saving}>
                          <X className="h-4 w-4" /> Undo my changes
                        </button>
                      </>
                    ) : null}
                    {canEdit ? (
                      <span className="inline-flex items-center gap-1 text-xs text-[var(--wms-muted)]">
                        <Move className="h-3.5 w-3.5" /> Drag any line end to move it — the numbers update as you go.
                      </span>
                    ) : scan.status === "redo" ? (
                      <span className="text-xs text-[var(--wms-status-warning-fg)]">
                        This scan was redone, so its lines can&apos;t be moved — open the newer scan of this size.
                      </span>
                    ) : null}
                    {scan.adjusted_at && !draft ? (
                      <span className="text-xs text-[var(--wms-muted)]">Lines adjusted on the WMS {when(scan.adjusted_at)}</span>
                    ) : null}
                  </div>
                  {editErr ? <p className="text-sm text-[var(--wms-status-danger-fg)]">{editErr}</p> : null}
                  {editMsg ? <p className="text-sm text-[var(--wms-status-success-fg)]">{editMsg}</p> : null}
                  <ScanPhoto
                    scan={scan}
                    which="main"
                    lines={draft?.main ?? scan.lines ?? {}}
                    selected={selected}
                    onSelect={setSelected}
                    editing={canEdit}
                    onMove={moveEnd("main")}
                  />
                  {scan.crotch ? (
                    <>
                      <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Crotch photo (legs spread) — front rise and inseam</h3>
                      <ScanPhoto
                        scan={scan}
                        which="crotch"
                        lines={draft?.crotch ?? scan.crotch.lines ?? {}}
                        selected={selected}
                        onSelect={setSelected}
                        editing={canEdit}
                        onMove={moveEnd("crotch")}
                      />
                    </>
                  ) : null}
                </div>
                <div className="flex min-w-0 flex-col gap-4">
                  <ReviewBox scan={scan} onChanged={changed} />
                  <PointsTable
                    scan={scan}
                    cmOverride={liveCm}
                    linesOverride={draft ? { ...draft.main, ...(draft.crotch ?? {}) } : { ...(scan.lines ?? {}), ...(scan.crotch?.lines ?? {}) }}
                    selected={selected}
                    onSelect={setSelected}
                  />
                  <FlagsList flags={scan.flags ?? []} />
                  <DepthFacts scan={scan} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* ───────────────────────────── photo + lines ───────────────────────────── */

/** For each L/R point, the plain key it is the half of — so picking "Sleeve" lights both. */
function pairIndex(scan: ScanDetail): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of scan.profileDef?.points ?? []) if (p.pairOf) out[p.key] = p.pairOf;
  return out;
}

function ScanPhoto({
  scan,
  which,
  lines: lineMap,
  selected,
  onSelect,
  editing,
  onMove,
}: {
  scan: ScanDetail;
  which: "main" | "crotch";
  lines: Record<string, Line>;
  selected: string | null;
  onSelect: (key: string | null) => void;
  editing: boolean;
  onMove: (key: string, index: number, to: [number, number]) => void;
}) {
  const hasPhoto = which === "crotch" ? Boolean(scan.crotch_photo_key) : (scan.has_photo ?? Boolean(scan.photo_key));
  const [failed, setFailed] = useState(false);
  const lines = useMemo(() => Object.entries(lineMap).filter(([, l]) => Array.isArray(l?.pts) && l.pts.length >= 2), [lineMap]);
  const { letters, labels } = useMemo(() => {
    const letters: Record<string, string> = {};
    const labels: Record<string, string> = {};
    for (const p of scan.profileDef?.points ?? []) {
      letters[p.key] = p.letter;
      labels[p.key] = p.label;
    }
    return { letters, labels };
  }, [scan.profileDef]);
  const pairOf = useMemo(() => pairIndex(scan), [scan]);
  /* No photo and no size on record: frame the lines themselves. */
  const fromLines = useMemo(() => {
    let w = 0;
    let h = 0;
    for (const [, l] of lines) for (const [x, y] of l.pts) {
      w = Math.max(w, x);
      h = Math.max(h, y);
    }
    return w && h ? { w: Math.ceil(w * 1.05), h: Math.ceil(h * 1.05) } : null;
  }, [lines]);
  const W = (which === "crotch" ? num(scan.crotch?.photoW) : num(scan.photo_w)) ?? fromLines?.w ?? 0;
  const H = (which === "crotch" ? num(scan.crotch?.photoH) : num(scan.photo_h)) ?? fromLines?.h ?? 0;
  const present = new Set(lines.map(([, l]) => sourceKind(l)));
  const src = photoUrl(scan.id, which);

  const editLines: Record<string, EditLine> = {};
  for (const [key, l] of lines) {
    const kind = sourceKind(l) ?? "outline";
    editLines[key] = { pts: l.pts, color: SOURCE_COLOR[kind], letter: letters[key] ?? key.charAt(0).toUpperCase(), title: `${labels[key] ?? key} — ${SOURCE_LABEL[kind].toLowerCase()}` };
  }
  /* Picking "Sleeve" in the table lights both halves. */
  const sel = selected === null ? null : (lines.find(([k]) => k === selected || pairOf[k] === selected)?.[0] ?? selected);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="min-w-0 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-1">
        {W && H ? (
          <>
            {hasPhoto && !failed ? (
              // Preload to notice a missing photo; the editor draws the same picture.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={src} alt="" className="hidden" onError={() => setFailed(true)} />
            ) : (
              <p className="px-2 pt-1 text-xs text-[var(--wms-muted)]">
                {failed ? "The photo could not be loaded — lines only." : "No photo was saved with this scan — lines only."}
              </p>
            )}
            <LineEditor
              src={hasPhoto && !failed ? src : null}
              alt={`Photo of ${scan.name ?? "the garment"}, size ${scan.size ?? ""}`}
              width={W}
              height={H}
              lines={editLines}
              selected={sel}
              onSelect={(k) => onSelect(k === null ? null : (pairOf[k] ?? k))}
              editing={editing}
              onMove={onMove}
            />
          </>
        ) : (
          <p className="p-6 text-center text-sm text-[var(--wms-muted)]">No photo and no lines were saved with this scan.</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--wms-muted)]">
        {(Object.keys(SOURCE_COLOR) as SourceKind[]).map((k) => (
          <span key={k} className={`inline-flex items-center gap-1.5 ${present.has(k) ? "" : "opacity-50"}`}>
            <span aria-hidden className="inline-block h-1 w-5 rounded" style={{ background: SOURCE_COLOR[k] }} />
            {SOURCE_LABEL[k]}
          </span>
        ))}
        {hasPhoto ? (
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-[var(--wms-accent)] hover:underline max-md:min-h-11"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Full-size photo
          </a>
        ) : null}
      </div>
      {which === "main" ? (
        <p className="text-xs text-[var(--wms-muted)]">
          The letter sits at the start of each line. Tap a line, or a row in the table, to pick it out.
        </p>
      ) : null}
    </div>
  );
}

/* ───────────────────────────── points table ───────────────────────────── */

type TableRow =
  | { kind: "single"; key: string; letter: string; label: string }
  | { kind: "pair"; key: string; letter: string; label: string; L?: GradingPoint; R?: GradingPoint };

function PointsTable({
  scan,
  cmOverride,
  linesOverride,
  selected,
  onSelect,
}: {
  scan: ScanDetail;
  /** The numbers while lines are being adjusted. */
  cmOverride?: Record<string, number> | null;
  linesOverride?: Record<string, Line>;
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const cm = useMemo(() => cmOverride ?? scan.points_cm ?? {}, [cmOverride, scan.points_cm]);
  const lines = useMemo(() => linesOverride ?? scan.lines ?? {}, [linesOverride, scan.lines]);

  /* The garment type's own order, which is the order of the letters on the
     guide picture. L/R points share one row so the two sides sit next to each
     other — they should agree, and when they do not it is the first thing to
     look at. Anything saved that the type does not list is still shown. */
  const rows = useMemo(() => {
    const out: TableRow[] = [];
    const pairs = new Map<string, Extract<TableRow, { kind: "pair" }>>();
    for (const p of scan.profileDef?.points ?? []) {
      if (p.pairOf) {
        let row = pairs.get(p.pairOf);
        if (!row) {
          row = { kind: "pair", key: p.pairOf, letter: p.letter, label: p.label.replace(/ [LR]$/, "") };
          pairs.set(p.pairOf, row);
          out.push(row);
        }
        if (p.side === "R") row.R = p;
        else row.L = p;
      } else {
        out.push({ kind: "single", key: p.key, letter: p.letter, label: p.label });
      }
    }
    const covered = new Set<string>();
    for (const r of out) {
      covered.add(r.key);
      if (r.kind === "pair") {
        if (r.L) covered.add(r.L.key);
        if (r.R) covered.add(r.R.key);
      }
    }
    for (const k of Object.keys(cm)) {
      if (covered.has(k)) continue;
      out.push({ kind: "single", key: k, letter: "", label: k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()) });
    }
    return out;
  }, [scan.profileDef, cm]);

  const sourceText = (key: string) => {
    const k = sourceKind(lines[key]);
    return k ? SOURCE_SHORT[k] : "—";
  };
  const sourceDot = (k: string) => {
    const kind = sourceKind(lines[k]);
    return kind ? (
      <span aria-hidden className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: SOURCE_COLOR[kind] }} />
    ) : null;
  };

  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Measurements</h3>
      <div className="overflow-x-auto rounded-md border border-[var(--wms-border)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">
              <th className="px-2 py-1.5 font-medium" />
              <th className="px-2 py-1.5 font-medium">Point</th>
              <th className="px-2 py-1.5 text-right font-medium">cm</th>
              <th className="px-2 py-1.5 text-right font-medium">in</th>
              <th className="px-2 py-1.5 font-medium">Placed by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const on = selected === r.key;
              const pick = () => onSelect(on ? null : r.key);
              const rowCls = `cursor-pointer border-t border-[var(--wms-border)] ${on ? "bg-[var(--wms-surface-elevated)]" : "hover:bg-[var(--wms-surface-elevated)]/60"}`;
              if (r.kind === "single") {
                return (
                  <tr key={r.key} onClick={pick} className={rowCls}>
                    <td className="px-2 py-1.5 font-mono text-xs font-bold text-[var(--wms-muted)]">{r.letter}</td>
                    <td className="px-2 py-1.5 text-[var(--wms-fg)]">{r.label}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-[var(--wms-fg)]">{cm1(num(cm[r.key]))}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-[var(--wms-muted)]">{in1(num(cm[r.key]))}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-xs text-[var(--wms-muted)]">
                      {sourceDot(r.key)}
                      {sourceText(r.key)}
                    </td>
                  </tr>
                );
              }
              const l = r.L ? num(cm[r.L.key]) : null;
              const rr = r.R ? num(cm[r.R.key]) : null;
              const avg = num(cm[r.key]) ?? (l !== null && rr !== null ? (l + rr) / 2 : null);
              const diff = l !== null && rr !== null ? Math.abs(l - rr) : null;
              return (
                <tr key={r.key} onClick={pick} className={rowCls}>
                  <td className="px-2 py-1.5 align-top font-mono text-xs font-bold text-[var(--wms-muted)]">{r.letter}</td>
                  <td className="px-2 py-1.5 align-top text-[var(--wms-fg)]">
                    {r.label}
                    {avg !== null ? (
                      <span className="block text-xs text-[var(--wms-muted)]">
                        average {cm1(avg)} cm / {in1(avg)}&quot; — used in the size chart
                      </span>
                    ) : null}
                    {diff !== null && diff > 1 ? (
                      <span className="mt-0.5 block text-xs text-[var(--wms-status-warning-fg)]">
                        Left and right differ by {diff.toFixed(1)} cm — one side may not have been laid straight.
                      </span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right align-top font-mono text-[var(--wms-fg)]">
                    <span className="block">L {cm1(l)}</span>
                    <span className="block">R {cm1(rr)}</span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right align-top font-mono text-[var(--wms-muted)]">
                    <span className="block">L {in1(l)}</span>
                    <span className="block">R {in1(rr)}</span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 align-top text-xs text-[var(--wms-muted)]">
                    <span className="block">
                      {r.L ? sourceDot(r.L.key) : null}L: {r.L ? sourceText(r.L.key) : "—"}
                    </span>
                    <span className="block">
                      {r.R ? sourceDot(r.R.key) : null}R: {r.R ? sourceText(r.R.key) : "—"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-[var(--wms-muted)]">
        Flat measurements, taken across the garment as it lies — not doubled.
        {num(scan.px_per_cm) ? ` Scale: ${num(scan.px_per_cm)!.toFixed(1)} pixels per cm.` : ""}
      </p>
    </section>
  );
}

/* ───────────────────────────── flags / depth ───────────────────────────── */

function FlagsList({ flags }: { flags: string[] }) {
  if (!flags.length) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Warnings</h3>
      <ul className="flex flex-col gap-1">
        {flags.map((f, i) => (
          <li
            key={`${i}-${f}`}
            className="rounded border border-[var(--wms-status-warning-fg)]/50 bg-[var(--wms-status-warning-fg)]/10 px-2 py-1 text-sm text-[var(--wms-status-warning-fg)]"
          >
            {f}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DepthFacts({ scan }: { scan: ScanDetail }) {
  const d = scan.depth ?? {};
  const dev = scan.device ?? {};
  const distance = num(d.distanceCm);
  const tilt = num(d.tiltDeg);
  const height = num(d.garmentHeightCm);
  const calibration = num(d.calibration);
  const testPhone = d.tof === false || (scan.flags ?? []).some((f) => f.startsWith("test phone"));
  const deviceName = [dev.manufacturer, dev.model].filter((v) => typeof v === "string" && v).join(" ");

  const facts: [string, string][] = [];
  if (d.tof === true) facts.push(["Scale from", "Depth sensor"]);
  else if (testPhone)
    facts.push(["Scale from", "Test phone (no depth sensor) — the scale is a guess, so nothing was written to the items"]);
  if (distance !== null) facts.push(["Camera distance", `${distance.toFixed(1)} cm (${(distance / 2.54).toFixed(1)}")`]);
  if (tilt !== null) facts.push(["Tilt", `${tilt.toFixed(1)}°`]);
  if (height !== null) facts.push(["Garment height above the table", `${height.toFixed(1)} cm`]);
  const age = num(d.depthAgeMs);
  const highConf = num(d.highConfPct);
  const rms = num(d.planeRmsMm);
  const inliers = num(d.inlierCount);
  const inlierPct = num(d.inlierPct) ?? (num(d.inlierFrac) !== null ? num(d.inlierFrac)! * 100 : null);
  // Older scans (before 1.0.6) saved -1 for "not measured".
  if (age !== null && age >= 0) facts.push(["Depth age", `${age.toFixed(1)} ms older than the photo`]);
  if (highConf !== null && highConf >= 0) facts.push(["Confident depth", `${highConf.toFixed(1)}% of the depth image`]);
  if (rms !== null) facts.push(["Table flatness (RMS)", `${rms.toFixed(1)} mm`]);
  if (inlierPct !== null)
    facts.push(["Table points", `${inliers !== null && inliers > 0 ? `${Math.round(inliers).toLocaleString()} · ` : ""}${inlierPct.toFixed(1)}%`]);
  if (calibration !== null) facts.push(["Calibration", `× ${calibration.toFixed(3)}`]);
  else if (d.calibration && typeof d.calibration === "object") facts.push(["Calibration", JSON.stringify(d.calibration)]);
  if (deviceName) facts.push(["Phone", deviceName]);
  else if (typeof d.deviceModel === "string" && d.deviceModel) facts.push(["Phone", d.deviceModel]);
  if (scan.app_version) facts.push(["App version", scan.app_version]);

  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold text-[var(--wms-fg)]">How it was shot</h3>
      {facts.length ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-[var(--wms-muted)]">{k}</dt>
              <dd className={`break-words ${k === "Scale from" && testPhone ? "text-[var(--wms-status-warning-fg)]" : "text-[var(--wms-fg)]"}`}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-[var(--wms-muted)]">No depth reading was saved with this scan.</p>
      )}
    </section>
  );
}

/* ───────────────────────────── review ───────────────────────────── */

function ReviewBox({ scan, onChanged }: { scan: ScanDetail; onChanged: () => Promise<void> }) {
  /** Null until typed in, so the saved note shows and a refetch never wipes a draft. */
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "redo" | "flag" | null>(null);
  const [confirmRedo, setConfirmRedo] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const note = noteDraft ?? scan.review_note ?? "";
  const st = statusOf(scan.status);
  const size = scan.size ?? "this size";
  const isRedo = scan.status === "redo";

  const act = async (action: "approve" | "redo" | "flag") => {
    setBusy(action);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/grading-app/scans/${scan.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(noteDraft !== null ? { note: noteDraft.trim() } : {}) }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; removed?: number };
      if (!res.ok || !j.ok) throw new Error(j.error ?? `Could not save (${res.status})`);
      await onChanged();
      setNoteDraft(null);
      setConfirmRedo(false);
      const removed = Number(j.removed ?? 0);
      setMsg(
        action === "approve"
          ? "Approved — the measurement stands."
          : action === "flag"
            ? "Flagged — it is back under Needs check."
            : `Taken back — ${removed} measurement${removed === 1 ? "" : "s"} removed from the items.`,
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(null);
    }
  };

  const applied =
    scan.applied_to > 0
      ? `Saved onto ${scan.applied_to} item size${scan.applied_to === 1 ? "" : "s"}: every colour of size ${size}${
          scan.cut_group ? `, and size ${size} of every product in the cut group "${scan.cut_group}"` : ""
        }.`
      : "Not written onto any item.";

  return (
    <section className="flex flex-col gap-2 rounded-md border border-[var(--wms-border)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[0.68rem] ${st.cls}`}>{st.label}</span>
        {scan.reviewed_at ? <span className="text-xs text-[var(--wms-muted)]">reviewed {when(scan.reviewed_at)}</span> : null}
      </div>
      <p className="text-sm text-[var(--wms-fg)]">{isRedo ? "This measurement was taken back." : applied}</p>
      {isRedo ? (
        <p className="text-sm text-[var(--wms-muted)]">
          Measure size {size} again with the phone app — the new scan will show up here.
        </p>
      ) : null}

      <label className="flex flex-col gap-1">
        <span className="font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">Note</span>
        <textarea
          value={note}
          maxLength={500}
          rows={2}
          onChange={(e) => setNoteDraft(e.target.value)}
          placeholder="Optional — e.g. sleeve was folded under, measure again."
          className="resize-y rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 text-sm text-[var(--wms-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--wms-accent)]/40 max-md:text-base"
        />
      </label>

      {!isRedo ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="wms-btn-success-solid max-md:flex-1"
            disabled={busy !== null || scan.status === "approved"}
            onClick={() => void act("approve")}
          >
            {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Approve
          </button>
          <button
            type="button"
            className="wms-btn-danger max-md:flex-1"
            disabled={busy !== null || confirmRedo}
            onClick={() => setConfirmRedo(true)}
          >
            <RotateCcw className="h-4 w-4" /> Redo
          </button>
          <button
            type="button"
            className="wms-btn-accent-soft inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm disabled:opacity-40 max-md:min-h-11 max-md:flex-1"
            disabled={busy !== null || scan.status === "flagged"}
            onClick={() => void act("flag")}
          >
            {busy === "flag" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Flag className="h-4 w-4" />}
            Flag for checking
          </button>
        </div>
      ) : null}

      {confirmRedo && !isRedo ? (
        <div className="rounded-md border border-[var(--wms-status-danger-fg)]/50 bg-[var(--wms-status-danger-fg)]/10 p-3">
          <p className="text-sm font-medium text-[var(--wms-fg)]">Redo this scan?</p>
          <p className="mt-1 text-sm text-[var(--wms-muted)]">
            The measurement this scan saved is deleted from every item it went onto
            {scan.applied_to > 0
              ? ` — ${scan.applied_to} item size${scan.applied_to === 1 ? "" : "s"} (every colour of size ${size}${
                  scan.cut_group ? ` and the same size of every product in "${scan.cut_group}"` : ""
                })`
              : ""}
            , including any copies made inside its cut group. Size {size} then shows as not measured, so it goes back on
            the phone&apos;s measuring list. The photo and this record stay here.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="wms-btn-danger wms-btn-sm max-md:min-h-11"
              disabled={busy !== null}
              onClick={() => void act("redo")}
            >
              {busy === "redo" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Yes, take it back
            </button>
            <button type="button" className={plainBtn} disabled={busy !== null} onClick={() => setConfirmRedo(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : null}

      {msg ? <p className="text-sm text-[var(--wms-status-success-fg)]">{msg}</p> : null}
      {err ? <p className="text-sm text-[var(--wms-status-danger-fg)]">{err}</p> : null}
      {scan.cut_group_id ? (
        <Link
          href={`/inventory/size-grading/cut-groups?group=${scan.cut_group_id}`}
          className="self-start text-xs text-[var(--wms-accent)] hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center"
        >
          Open the cut group &quot;{scan.cut_group}&quot;
        </Link>
      ) : null}
    </section>
  );
}
