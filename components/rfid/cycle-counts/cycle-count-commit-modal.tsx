"use client";

import { useEffect, useMemo, useState } from "react";
import { X, AlertTriangle, ArrowRight, HelpCircle } from "lucide-react";
import type { ExpectedRow, Variance } from "./cycle-count-results-views";

export type VarianceSummary = {
  matched: number;
  missing: number;
  misplaced: number;
  unrecognized: number;
};

type Props = {
  open: boolean;
  onClose: () => void;
  expected: ExpectedRow[];
  variance: Variance;
  binCodeForCommit: string | null;
  /** Submit. The caller decides whether to include each accept-list. */
  onCommit: (opts: {
    acceptMissing: string[];
    acceptMisplaced: string[];
    acceptUnrecognized: string[];
    notes: string;
  }) => Promise<void>;
};

/**
 * Pre-commit preview. Shows every row that's about to mutate inventory,
 * grouped by what will happen. Each row has a checkbox so the operator
 * can opt-out lines they don't trust (e.g. a "missing" item they know is
 * physically there but didn't read).
 *
 * The commit body sends accept-lists, which the server intersects with
 * its own variance computation. Anything unchecked is silently skipped
 * (the item row is not mutated).
 */
export function CycleCountCommitModal({
  open,
  onClose,
  expected,
  variance,
  binCodeForCommit,
  onCommit,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<{
    missing: Set<string>;
    misplaced: Set<string>;
    unrecognized: Set<string>;
  }>({ missing: new Set(), misplaced: new Set(), unrecognized: new Set() });
  const [notes, setNotes] = useState("");

  // Re-init accept-everything every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setAccepted({
      missing: new Set(variance.missing),
      misplaced: new Set(variance.misplaced),
      unrecognized: new Set(variance.unrecognized),
    });
    setErr(null);
    setNotes("");
  }, [open, variance.missing, variance.misplaced, variance.unrecognized]);

  const expByEpc = useMemo(
    () => new Map(expected.map((e) => [e.epc, e])),
    [expected],
  );

  if (!open) return null;

  const counts = {
    matched: variance.matched.length,
    missing: accepted.missing.size,
    misplaced: accepted.misplaced.size,
    unrecognized: accepted.unrecognized.size,
  };

  const toggle = (
    bucket: "missing" | "misplaced" | "unrecognized",
    epc: string,
  ) => {
    setAccepted((cur) => {
      const next = new Set(cur[bucket]);
      if (next.has(epc)) next.delete(epc);
      else next.add(epc);
      return { ...cur, [bucket]: next };
    });
  };

  const toggleAll = (
    bucket: "missing" | "misplaced" | "unrecognized",
    epcs: string[],
  ) => {
    setAccepted((cur) => {
      if (cur[bucket].size === epcs.length) {
        return { ...cur, [bucket]: new Set() };
      }
      return { ...cur, [bucket]: new Set(epcs) };
    });
  };

  const run = async () => {
    setErr(null);
    setBusy(true);
    try {
      await onCommit({
        acceptMissing: [...accepted.missing],
        acceptMisplaced: [...accepted.misplaced],
        acceptUnrecognized: [...accepted.unrecognized],
        notes: notes.trim(),
      });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Commit failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-[80] bg-black/70"
        onClick={() => !busy && onClose()}
      />
      <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-4">
        <div
          className="my-8 w-full max-w-3xl rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-5 shadow-2xl"
          role="dialog"
          aria-modal="true"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-[var(--wms-fg)]">
                Review &amp; commit cycle count
              </h2>
              <p className="mt-1 font-mono text-[0.65rem] text-[var(--wms-muted)]">
                Each line below shows what will change in inventory. Uncheck any
                line you don&apos;t want applied.
              </p>
            </div>
            <button
              type="button"
              onClick={() => !busy && onClose()}
              className="rounded p-1 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <SummaryStrip counts={counts} matched={variance.matched.length} />

          {variance.missing.length > 0 ? (
            <Bucket
              title="Missing — will be marked tag_killed"
              hint="Tag was expected at this scope but didn’t read. Status will move from in-stock → tag_killed (counts as shrink)."
              tone="amber"
              epcs={variance.missing}
              accepted={accepted.missing}
              onToggle={(e) => toggle("missing", e)}
              onToggleAll={() => toggleAll("missing", variance.missing)}
              describe={(epc) => {
                const r = expByEpc.get(epc);
                return {
                  sku: r?.sku ?? "—",
                  description: r?.description ?? "",
                  fromBin: r?.bin_code ?? "—",
                  arrowText: "tag_killed",
                };
              }}
            />
          ) : null}

          {variance.misplaced.length > 0 ? (
            <Bucket
              title={
                binCodeForCommit
                  ? `Misplaced — will be moved to bin ${binCodeForCommit}`
                  : "Misplaced — bin required to commit"
              }
              hint="Tag is in-stock somewhere else but you scanned it here. The item will be relocated to the count’s bin."
              tone="orange"
              epcs={variance.misplaced}
              accepted={accepted.misplaced}
              onToggle={(e) => toggle("misplaced", e)}
              onToggleAll={() => toggleAll("misplaced", variance.misplaced)}
              describe={(epc) => {
                const r = expByEpc.get(epc);
                return {
                  sku: r?.sku ?? "—",
                  description: r?.description ?? "",
                  fromBin: "(elsewhere)",
                  arrowText: binCodeForCommit ?? "bin?",
                };
              }}
              warning={!binCodeForCommit ? "Pick a bin in the workspace before committing misplaced rows." : null}
            />
          ) : null}

          {variance.unrecognized.length > 0 ? (
            <Bucket
              title="Unrecognized — routed through ingest"
              hint="EPC isn’t in your catalog or doesn’t decode. Decodable EPCs that match catalog become in-stock here; the rest land as tag_killed (visible in Defective EPCs)."
              tone="muted"
              epcs={variance.unrecognized}
              accepted={accepted.unrecognized}
              onToggle={(e) => toggle("unrecognized", e)}
              onToggleAll={() => toggleAll("unrecognized", variance.unrecognized)}
              describe={() => ({
                sku: "—",
                description: "",
                fromBin: "(unknown)",
                arrowText: "ingest",
              })}
            />
          ) : null}

          {variance.matched.length > 0 ? (
            <p className="mt-3 font-mono text-[0.65rem] text-[var(--wms-muted)]">
              <span className="wms-status-success">{variance.matched.length} matched</span>{" "}
              tags need no action — they were expected and seen.
            </p>
          ) : null}

          <div className="mt-4">
            <label className="block font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
              Notes (optional — saved on the audit row)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="e.g. Counted by J. with 3 SA-2000 readers, 2 missing items confirmed shrink"
              className="mt-1 w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)]"
            />
          </div>

          {err ? (
            <p className="mt-3 font-mono text-xs text-red-400/90">{err}</p>
          ) : null}

          <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onClose()}
              className="rounded-lg border-2 border-[var(--wms-border)] bg-[var(--wms-surface)] px-5 py-2.5 font-mono text-sm font-medium text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={
                busy ||
                (variance.misplaced.length > 0 &&
                  !binCodeForCommit &&
                  accepted.misplaced.size > 0)
              }
              onClick={() => void run()}
              className="wms-btn-primary px-6 font-mono disabled:opacity-50"
            >
              {busy
                ? "Committing…"
                : `Apply ${counts.missing + counts.misplaced + counts.unrecognized} change${
                    counts.missing + counts.misplaced + counts.unrecognized === 1 ? "" : "s"
                  }`}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function SummaryStrip({
  counts,
  matched,
}: {
  counts: { missing: number; misplaced: number; unrecognized: number };
  matched: number;
}) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Tile label="Matched" n={matched} cls="wms-status-success" />
      <Tile label="Missing" n={counts.missing} cls="text-amber-400" />
      <Tile label="Misplaced" n={counts.misplaced} cls="text-orange-400" />
      <Tile label="Unrecognized" n={counts.unrecognized} cls="text-[var(--wms-muted)]" />
    </div>
  );
}

function Tile({ label, n, cls }: { label: string; n: number; cls: string }) {
  return (
    <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-center">
      <div className="font-mono text-[0.55rem] uppercase tracking-wide text-[var(--wms-muted)]">
        {label}
      </div>
      <div className={`mt-0.5 font-mono text-lg tabular-nums ${cls}`}>{n}</div>
    </div>
  );
}

function Bucket({
  title,
  hint,
  tone,
  epcs,
  accepted,
  onToggle,
  onToggleAll,
  describe,
  warning,
}: {
  title: string;
  hint: string;
  tone: "amber" | "orange" | "muted";
  epcs: string[];
  accepted: Set<string>;
  onToggle: (epc: string) => void;
  onToggleAll: () => void;
  describe: (epc: string) => {
    sku: string;
    description: string;
    fromBin: string;
    arrowText: string;
  };
  warning?: string | null;
}) {
  const headerCls =
    tone === "amber"
      ? "text-amber-400"
      : tone === "orange"
        ? "text-orange-400"
        : "text-[var(--wms-muted)]";

  return (
    <section className="mt-4 overflow-hidden rounded-lg border border-[var(--wms-border)]">
      <header className="flex flex-wrap items-center justify-between gap-2 bg-[var(--wms-surface-elevated)] px-3 py-2">
        <div>
          <h3 className={`font-mono text-xs font-semibold uppercase tracking-wide ${headerCls}`}>
            {title} ({epcs.length})
          </h3>
          <p className="mt-0.5 flex items-start gap-1.5 font-mono text-[0.6rem] text-[var(--wms-muted)]">
            <HelpCircle className="mt-0.5 h-3 w-3 shrink-0" /> {hint}
          </p>
        </div>
        <button
          type="button"
          onClick={onToggleAll}
          className="rounded border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
        >
          {accepted.size === epcs.length ? "Uncheck all" : "Check all"}
        </button>
      </header>
      {warning ? (
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-950/30 px-3 py-1.5 font-mono text-[0.65rem] text-amber-200/80">
          <AlertTriangle className="h-3.5 w-3.5" /> {warning}
        </div>
      ) : null}
      <ul className="max-h-48 overflow-auto divide-y divide-[var(--wms-border)]/60 font-mono text-xs">
        {epcs.map((epc) => {
          const d = describe(epc);
          const checked = accepted.has(epc);
          return (
            <li
              key={epc}
              className={`flex items-center gap-2 px-3 py-1.5 ${checked ? "" : "opacity-50"}`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(epc)}
                aria-label="apply this change"
              />
              <span className="text-[var(--wms-accent)] truncate">{epc}</span>
              <span className="text-[var(--wms-fg)]">{d.sku}</span>
              <span className="text-[var(--wms-muted)] hidden md:inline truncate">{d.description}</span>
              <span className="ml-auto inline-flex items-center gap-1 text-[var(--wms-muted)]">
                {d.fromBin} <ArrowRight className="h-3 w-3" /> {d.arrowText}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
