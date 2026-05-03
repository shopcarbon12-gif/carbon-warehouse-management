"use client";

import { useEffect, useState } from "react";
import { Clock, Plus, Trash2, X } from "lucide-react";

const US_TIMEZONES: { value: string; label: string }[] = [
  { value: "America/New_York", label: "Eastern (EST/EDT)" },
  { value: "America/Chicago", label: "Central (CST/CDT)" },
  { value: "America/Denver", label: "Mountain (MST/MDT)" },
  { value: "America/Phoenix", label: "Mountain (Arizona, no DST)" },
  { value: "America/Los_Angeles", label: "Pacific (PST/PDT)" },
  { value: "America/Anchorage", label: "Alaska (AKST/AKDT)" },
  { value: "Pacific/Honolulu", label: "Hawaii (HST, no DST)" },
];

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Window = {
  days: number[];
  from: string;
  to: string;
};

type Schedule = {
  timezone: string;
  windows: Window[];
};

const EMPTY_WINDOW: Window = {
  days: [0, 1, 2, 3, 4, 5, 6],
  from: "22:00",
  to: "06:00",
};

export function ReaderScheduleModal({
  open,
  readerId,
  readerName,
  initialSchedule,
  onClose,
  onSaved,
}: {
  open: boolean;
  readerId: string;
  readerName: string;
  initialSchedule: Schedule | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tz, setTz] = useState("America/New_York");
  const [windows, setWindows] = useState<Window[]>([EMPTY_WINDOW]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (initialSchedule) {
      setTz(initialSchedule.timezone || "America/New_York");
      setWindows(initialSchedule.windows && initialSchedule.windows.length > 0
        ? initialSchedule.windows
        : [EMPTY_WINDOW]);
    } else {
      setTz("America/New_York");
      setWindows([EMPTY_WINDOW]);
    }
    setErr(null);
  }, [open, initialSchedule]);

  if (!open) return null;

  const updateWindow = (i: number, patch: Partial<Window>) => {
    setWindows((prev) => prev.map((w, idx) => (idx === i ? { ...w, ...patch } : w)));
  };
  const toggleDay = (i: number, day: number) => {
    setWindows((prev) =>
      prev.map((w, idx) =>
        idx !== i
          ? w
          : { ...w, days: w.days.includes(day) ? w.days.filter((d) => d !== day) : [...w.days, day].sort((a, b) => a - b) },
      ),
    );
  };
  const addWindow = () => setWindows((p) => [...p, EMPTY_WINDOW]);
  const removeWindow = (i: number) => setWindows((p) => p.filter((_, idx) => idx !== i));

  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch(
        `/api/hardware-config/readers/${encodeURIComponent(readerId)}/schedule`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ schedule: { timezone: tz, windows } }),
        },
      );
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch(
        `/api/hardware-config/readers/${encodeURIComponent(readerId)}/schedule`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ schedule: null }),
        },
      );
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Clear failed");
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
      <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          className="w-full max-w-lg rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-5 shadow-2xl"
        >
          <div className="flex items-start justify-between gap-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--wms-fg)]">
              <Clock className="h-4 w-4 text-[var(--wms-accent)]" />
              Pause schedule — {readerName}
            </h2>
            <button
              type="button"
              onClick={() => !busy && onClose()}
              className="rounded p-1 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
              aria-label="Close"
              disabled={busy}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <p className="mt-2 font-mono text-[0.7rem] leading-relaxed text-[var(--wms-muted)]">
            Auto-pause this reader during the configured time windows. Cross-midnight is supported
            (set <span className="text-[var(--wms-fg)]">to</span> earlier than{" "}
            <span className="text-[var(--wms-fg)]">from</span>).
          </p>

          <label className="mt-4 block font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
            Timezone
          </label>
          <select
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
            disabled={busy}
          >
            {US_TIMEZONES.map((z) => (
              <option key={z.value} value={z.value}>{z.label}</option>
            ))}
          </select>

          <div className="mt-4 space-y-3">
            {windows.map((w, i) => (
              <div
                key={i}
                className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
                    Window {i + 1}
                  </span>
                  {windows.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => removeWindow(i)}
                      className="rounded border border-red-400/30 px-1.5 py-0.5 font-mono text-[0.6rem] text-red-400/80 hover:bg-red-400/10"
                      disabled={busy}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {DAY_LABELS.map((label, day) => {
                    const on = w.days.includes(day);
                    return (
                      <button
                        type="button"
                        key={day}
                        onClick={() => toggleDay(i, day)}
                        disabled={busy}
                        className={`rounded border px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wide ${
                          on
                            ? "border-[var(--wms-accent)] bg-[var(--wms-accent)]/15 text-[var(--wms-accent-fg)]"
                            : "border-[var(--wms-border)] text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1 font-mono text-[0.65rem] text-[var(--wms-muted)]">
                    From
                    <input
                      type="time"
                      value={w.from}
                      onChange={(e) => updateWindow(i, { from: e.target.value })}
                      className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface)] px-2 py-1 font-mono text-xs text-[var(--wms-fg)]"
                      disabled={busy}
                    />
                  </label>
                  <label className="flex items-center gap-1 font-mono text-[0.65rem] text-[var(--wms-muted)]">
                    To
                    <input
                      type="time"
                      value={w.to}
                      onChange={(e) => updateWindow(i, { to: e.target.value })}
                      className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface)] px-2 py-1 font-mono text-xs text-[var(--wms-fg)]"
                      disabled={busy}
                    />
                  </label>
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={addWindow}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.65rem] text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
            >
              <Plus className="h-3 w-3" /> Add window
            </button>
          </div>

          {err ? <p className="mt-3 font-mono text-xs text-red-400/90">{err}</p> : null}

          <div className="mt-5 flex gap-2">
            {initialSchedule ? (
              <button
                type="button"
                onClick={() => void clear()}
                disabled={busy}
                className="flex-1 rounded-lg border border-red-400/40 bg-red-950/30 py-2.5 font-mono text-sm text-red-200 hover:bg-red-900/40 disabled:opacity-50"
              >
                Remove schedule
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onClose()}
              disabled={busy}
              className="flex-1 rounded-lg border-2 border-[var(--wms-border)] bg-[var(--wms-surface)] py-2.5 font-mono text-sm font-medium text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="wms-btn-primary flex-1 font-mono disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

export type { Schedule as ReaderScheduleType };
