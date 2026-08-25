"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar as CalIcon } from "lucide-react";

/**
 * Lightspeed-style date-range picker: a "FROM to TO" trigger that opens a
 * navigable month grid with click-to-select range + quick presets
 * (Today / Yesterday / Last week / Last three weeks). Values are ISO
 * `YYYY-MM-DD` strings. Self-contained — no calendar lib.
 */

export type DateRange = { from: string; to: string };

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}
function parse(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function DateRangePicker({
  value,
  onChange,
}: {
  value: DateRange;
  onChange: (r: DateRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Date>(() => parse(value.from) ?? new Date(2026, 4, 1));
  // While picking: first click sets `pickStart`, second completes the range.
  const [pickStart, setPickStart] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // pointerdown (not mousedown) so taps dismiss the popover on touch too.
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [open]);

  const grid = useMemo(() => {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const startPad = first.getDay();
    const days: (Date | null)[] = [];
    for (let i = 0; i < startPad; i += 1) days.push(null);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= last; d += 1) days.push(new Date(anchor.getFullYear(), anchor.getMonth(), d));
    return days;
  }, [anchor]);

  const inRange = (d: Date): boolean => {
    const s = parse(value.from);
    const e = parse(value.to);
    if (!s || !e) return false;
    return d >= s && d <= e;
  };

  const clickDay = (d: Date) => {
    const ds = iso(d);
    if (!pickStart) {
      setPickStart(ds);
      onChange({ from: ds, to: ds });
      return;
    }
    // Second click completes the range (order-independent).
    const a = pickStart;
    const lo = a <= ds ? a : ds;
    const hi = a <= ds ? ds : a;
    onChange({ from: lo, to: hi });
    setPickStart(null);
    setOpen(false);
  };

  const applyPreset = (from: Date, to: Date) => {
    onChange({ from: iso(from), to: iso(to) });
    setPickStart(null);
    setOpen(false);
  };
  const today = () => new Date();

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)] hover:border-[var(--wms-accent)]/40"
      >
        <span>
          {value.from} to {value.to}
        </span>
        <CalIcon className="h-3.5 w-3.5 text-[var(--wms-muted)]" />
      </button>

      {open ? (
        <div className="absolute z-30 mt-1 w-[18rem] rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3 shadow-2xl max-md:fixed max-md:inset-x-3 max-md:top-24 max-md:z-50 max-md:w-auto max-md:max-h-[70dvh] max-md:overflow-y-auto max-md:overscroll-contain">
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setAnchor((a) => new Date(a.getFullYear(), a.getMonth() - 1, 1))}
              className="rounded px-2 py-1 font-mono text-xs text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
            >
              ‹
            </button>
            <span className="font-mono text-xs font-semibold text-[var(--wms-accent)]">
              {MONTHS[anchor.getMonth()]} {anchor.getFullYear()}
            </span>
            <button
              type="button"
              onClick={() => setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + 1, 1))}
              className="rounded px-2 py-1 font-mono text-xs text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
            >
              ›
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center font-mono text-[0.6rem]">
            {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
              <span key={i} className="py-1 text-[var(--wms-muted)]">
                {d}
              </span>
            ))}
            {grid.map((d, i) =>
              d === null ? (
                <span key={`e${i}`} />
              ) : (
                <button
                  key={iso(d)}
                  type="button"
                  onClick={() => clickDay(d)}
                  className={`rounded py-1 text-xs max-md:py-2 active:bg-[var(--wms-accent)]/20 ${
                    inRange(d)
                      ? "bg-[var(--wms-accent)]/30 text-[var(--wms-fg)]"
                      : "text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
                  }`}
                >
                  {d.getDate()}
                </button>
              ),
            )}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[0.65rem]">
            <input
              type="date"
              value={value.from}
              onChange={(e) => onChange({ ...value, from: e.target.value })}
              className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 text-[var(--wms-fg)] max-md:py-2 max-md:text-base"
            />
            <input
              type="date"
              value={value.to}
              onChange={(e) => onChange({ ...value, to: e.target.value })}
              className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 text-[var(--wms-fg)] max-md:py-2 max-md:text-base"
            />
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[0.6rem]">
            <Preset label="Today" onClick={() => applyPreset(today(), today())} />
            <Preset label="Yesterday" onClick={() => applyPreset(addDays(today(), -1), addDays(today(), -1))} />
            <Preset label="Last week" onClick={() => applyPreset(addDays(today(), -7), today())} />
            <Preset label="Last three weeks" onClick={() => applyPreset(addDays(today(), -21), today())} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Preset({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 text-[var(--wms-accent)] hover:bg-[var(--wms-accent)]/10 max-md:px-3 max-md:py-2 active:bg-[var(--wms-accent)]/15"
    >
      {label}
    </button>
  );
}
