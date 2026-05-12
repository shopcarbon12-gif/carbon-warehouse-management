"use client";

import { useEffect, useState } from "react";
import { X, ArrowRight, HelpCircle } from "lucide-react";
import type { ExpectedRow, LiveScanRow, Variance } from "./cycle-count-results-views";

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
  onCommit: (opts: {
    acceptMissing: string[];
    notes: string;
  }) => Promise<void>;
};

/**
 * Pre-commit preview.
 *
 * With live cycle-count ingestion, added_here / defective / locked rows are
 * already settled in inventory before this modal opens — they're shown here
 * read-only so the operator sees what landed. The only thing left for commit
 * is Missing → tag_killed, where the operator can opt-out specific rows.
 */
export function CycleCountCommitModal({
  open,
  onClose,
  variance,
  onCommit,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setAccepted(new Set(variance.missing.map((m) => m.epc)));
    setErr(null);
    setNotes("");
  }, [open, variance.missing]);

  if (!open) return null;

  const toggle = (epc: string) => {
    setAccepted((cur) => {
      const next = new Set(cur);
      if (next.has(epc)) next.delete(epc);
      else next.add(epc);
      return next;
    });
  };

  const toggleAll = () => {
    setAccepted((cur) => {
      const all = variance.missing.map((m) => m.epc);
      if (cur.size === all.length) return new Set();
      return new Set(all);
    });
  };

  const run = async () => {
    setErr(null);
    setBusy(true);
    try {
      await onCommit({
        acceptMissing: [...accepted],
        notes: notes.trim(),
      });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Commit failed");
    } finally {
      setBusy(false);
    }
  };

  const liveTotal =
    variance.added_here.length + variance.defective.length + variance.locked.length;

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
                Added / Defective / Locked rows already settled live during the scan.
                The only thing left to apply is Missing → tag_killed; uncheck any row
                you don&apos;t want flipped.
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

          <SummaryStrip
            matched={variance.matched.length}
            missingAccepted={accepted.size}
            addedHere={variance.added_here.length}
            defective={variance.defective.length}
            locked={variance.locked.length}
          />

          {variance.missing.length > 0 ? (
            <MissingBucket
              rows={variance.missing}
              accepted={accepted}
              onToggle={toggle}
              onToggleAll={toggleAll}
            />
          ) : (
            <p className="mt-4 font-mono text-xs text-[var(--wms-muted)]">
              No missing rows — nothing to flip on commit.
            </p>
          )}

          {liveTotal > 0 ? (
            <LiveSummary
              addedHere={variance.added_here}
              defective={variance.defective}
              locked={variance.locked}
            />
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
              placeholder="e.g. Counted by J. with 3 SA-2000 readers, 2 missing confirmed shrink"
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
              disabled={busy}
              onClick={() => void run()}
              className="wms-btn-primary px-6 font-mono disabled:opacity-50"
            >
              {busy
                ? "Committing…"
                : `Apply ${accepted.size} missing → tag_killed`}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function SummaryStrip({
  matched,
  missingAccepted,
  addedHere,
  defective,
  locked,
}: {
  matched: number;
  missingAccepted: number;
  addedHere: number;
  defective: number;
  locked: number;
}) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
      <Tile label="Matched" n={matched} cls="wms-status-success" />
      <Tile label="Missing →" n={missingAccepted} cls="text-amber-400" />
      <Tile label="Added live" n={addedHere} cls="text-sky-300" />
      <Tile label="Defective" n={defective} cls="text-red-400" />
      <Tile label="Locked" n={locked} cls="text-fuchsia-300" />
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

function MissingBucket({
  rows,
  accepted,
  onToggle,
  onToggleAll,
}: {
  rows: ExpectedRow[];
  accepted: Set<string>;
  onToggle: (epc: string) => void;
  onToggleAll: () => void;
}) {
  return (
    <section className="mt-4 overflow-hidden rounded-lg border border-[var(--wms-border)]">
      <header className="flex flex-wrap items-center justify-between gap-2 bg-[var(--wms-surface-elevated)] px-3 py-2">
        <div>
          <h3 className="font-mono text-xs font-semibold uppercase tracking-wide text-amber-400">
            Missing — will be marked tag_killed ({rows.length})
          </h3>
          <p className="mt-0.5 flex items-start gap-1.5 font-mono text-[0.6rem] text-[var(--wms-muted)]">
            <HelpCircle className="mt-0.5 h-3 w-3 shrink-0" /> Tag was expected but
            never scanned. Status will move from in-stock → tag_killed (counts as
            shrink). Uncheck rows you know are physically here but didn&apos;t read.
          </p>
        </div>
        <button
          type="button"
          onClick={onToggleAll}
          className="rounded border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
        >
          {accepted.size === rows.length ? "Uncheck all" : "Check all"}
        </button>
      </header>
      <ul className="max-h-64 overflow-auto divide-y divide-[var(--wms-border)]/60 font-mono text-xs">
        {rows.map((r) => {
          const checked = accepted.has(r.epc);
          return (
            <li
              key={r.epc}
              className={`flex items-center gap-2 px-3 py-1.5 ${checked ? "" : "opacity-50"}`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(r.epc)}
                aria-label="apply this change"
              />
              <span className="truncate text-[var(--wms-accent)]">{r.epc}</span>
              <span className="text-[var(--wms-fg)]">{r.sku}</span>
              <span className="hidden truncate text-[var(--wms-muted)] md:inline">
                {r.description ?? ""}
              </span>
              <span className="ml-auto inline-flex items-center gap-1 text-[var(--wms-muted)]">
                {r.bin_code ?? "—"} <ArrowRight className="h-3 w-3" /> tag_killed
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function LiveSummary({
  addedHere,
  defective,
  locked,
}: {
  addedHere: LiveScanRow[];
  defective: LiveScanRow[];
  locked: LiveScanRow[];
}) {
  return (
    <section className="mt-4 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 px-3 py-2">
      <h3 className="font-mono text-xs font-semibold uppercase tracking-wide text-[var(--wms-muted)]">
        Settled live during the scan
      </h3>
      <ul className="mt-1 grid gap-1 font-mono text-[0.65rem] sm:grid-cols-3">
        <li className="text-sky-300">
          {addedHere.length} added / moved here (in-stock at this location)
        </li>
        <li className="text-red-400">
          {defective.length} defective → tag_killed
        </li>
        <li className="text-fuchsia-300">
          {locked.length} locked (Super Admin status — unchanged)
        </li>
      </ul>
    </section>
  );
}
