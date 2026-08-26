"use client";

/**
 * Per-page reader filter — dropdown next to "Start scan". Lists every
 * reader on this tenant grouped by zone (with location header), checkbox
 * per reader, and an "ALL" toggle that selects/clears everything.
 *
 * The picker doesn't talk to the SSE stream itself; it just exposes a
 * `selected: Set<string>` of reader IDs that the parent component uses
 * to filter incoming scans. When ALL is checked, the parent should treat
 * any read as "selected" (we still hand back the full set so callers can
 * use `selected.has(deviceId)` uniformly).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { ChevronDown, Radio } from "lucide-react";
import type {
  HardwareConfigTree,
  HardwareReaderRow,
} from "@/lib/server/hardware-config";

const fetcher = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("fetch failed");
  return r.json();
};

type Props = {
  /** Currently-selected reader IDs. Empty set = nothing matches. */
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /** Optional label override (default: "Readers"). */
  label?: string;
  /** Render as disabled (e.g. while page is in some lock state). */
  disabled?: boolean;
  /**
   * Pre-select every reader whose name matches this string (case-insensitive,
   * exact match). Applied once on first data load only — never overrides a
   * user's later manual change.
   */
  defaultReaderName?: string;
  /**
   * Drop readers flagged `is_pos_dedicated=true` from the list. Used by
   * surfaces where POS-dedicated readers don't belong (Operations dashboard,
   * Bulk Status, Transfer In). Cycle Counts and Hardware Config pickers
   * keep them visible.
   */
  hidePosDedicated?: boolean;
};

type FlatReader = HardwareReaderRow & { _zoneName: string; _locationCode: string };

export function ReaderPicker({
  selected,
  onChange,
  label = "Readers",
  disabled = false,
  defaultReaderName,
  hidePosDedicated = false,
}: Props) {
  const { data } = useSWR<HardwareConfigTree>("/api/hardware-config", fetcher, {
    revalidateOnFocus: false,
  });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const defaultAppliedRef = useRef(false);

  // Flatten the tree into a list with zone+location metadata for grouping.
  const flat: FlatReader[] = useMemo(() => {
    if (!data?.locations) return [];
    const out: FlatReader[] = [];
    for (const loc of data.locations) {
      for (const z of loc.zones ?? []) {
        for (const r of z.readers ?? []) {
          if (hidePosDedicated && r.is_pos_dedicated) continue;
          out.push({ ...r, _zoneName: z.name, _locationCode: loc.code });
        }
      }
      // include unzoned readers so operators can still pick them
      for (const r of loc.unzonedReaders ?? []) {
        if (hidePosDedicated && r.is_pos_dedicated) continue;
        out.push({ ...r, _zoneName: "(no zone)", _locationCode: loc.code });
      }
    }
    return out;
  }, [data, hidePosDedicated]);

  const allIds = useMemo(() => flat.map((r) => r.id), [flat]);
  const allChecked = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someChecked = allIds.some((id) => selected.has(id));

  // Group by location → zone for rendering.
  const grouped = useMemo(() => {
    const m = new Map<string, FlatReader[]>();
    for (const r of flat) {
      const k = `${r._locationCode} · ${r._zoneName}`;
      const arr = m.get(k) ?? [];
      arr.push(r);
      m.set(k, arr);
    }
    return Array.from(m.entries()).map(([k, v]) => ({ key: k, readers: v }));
  }, [flat]);

  // Apply defaultReaderName once on first data load. Skipped if the parent
  // already has a non-empty selection — that means somebody (the user, or a
  // previous mount) already populated the picker.
  useEffect(() => {
    if (defaultAppliedRef.current) return;
    if (!defaultReaderName || flat.length === 0) return;
    if (selected.size > 0) {
      defaultAppliedRef.current = true;
      return;
    }
    const target = defaultReaderName.trim().toLowerCase();
    if (target.length === 0) {
      defaultAppliedRef.current = true;
      return;
    }
    const matches = flat
      .filter((r) => r.name.trim().toLowerCase() === target)
      .map((r) => r.id);
    if (matches.length > 0) {
      onChange(new Set(matches));
    }
    defaultAppliedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat, defaultReaderName]);

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    // pointerdown (not mousedown) so taps dismiss the popover on touch too.
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  const toggleAll = () => {
    if (allChecked) onChange(new Set());
    else onChange(new Set(allIds));
  };

  // Summary label when closed.
  const summary = (() => {
    if (allIds.length === 0) return "No readers";
    if (allChecked) return `All (${allIds.length})`;
    if (selected.size === 0) return "None";
    if (selected.size === 1) {
      const r = flat.find((x) => selected.has(x.id));
      return r?.name ?? "1 reader";
    }
    return `${selected.size} of ${allIds.length}`;
  })();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled || allIds.length === 0}
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-2 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2.5 font-mono text-xs text-[var(--wms-fg)] hover:border-teal-500/40 disabled:cursor-not-allowed disabled:opacity-40 max-md:min-h-11 ${
          open ? "border-teal-500/50" : ""
        }`}
        title="Filter scanned EPCs to specific readers"
      >
        <Radio className="h-3.5 w-3.5 text-[var(--wms-muted)]" />
        <span className="text-[var(--wms-muted)] uppercase tracking-wider text-[0.6rem]">
          {label}:
        </span>
        <span className="font-semibold text-[var(--wms-fg)]">{summary}</span>
        <ChevronDown className={`h-3.5 w-3.5 opacity-70 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div
          className="absolute left-0 top-full z-30 mt-1 w-72 max-h-96 overflow-auto rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-1 shadow-xl max-md:fixed max-md:inset-x-3 max-md:top-24 max-md:z-50 max-md:w-auto max-md:max-h-[70dvh] max-md:overscroll-contain"
          role="listbox"
          aria-multiselectable="true"
        >
          {/* ALL toggle — sticky at the top */}
          <label className="sticky top-0 z-10 flex cursor-pointer items-center gap-2 border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-surface)] max-md:py-2.5 active:bg-[var(--wms-surface)]">
            <input
              type="checkbox"
              checked={allChecked}
              ref={(el) => {
                if (el) el.indeterminate = !allChecked && someChecked;
              }}
              onChange={toggleAll}
              className="h-3.5 w-3.5 cursor-pointer accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
            />
            <span className="font-semibold">All</span>
            <span className="ml-auto text-[var(--wms-muted)]">{allIds.length}</span>
          </label>

          {grouped.length === 0 ? (
            <p className="px-3 py-3 font-mono text-xs text-[var(--wms-muted)]">
              No readers configured.
            </p>
          ) : (
            grouped.map((g) => (
              <div key={g.key} className="py-1">
                <div className="px-3 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-[var(--wms-muted)]">
                  {g.key}
                </div>
                {g.readers.map((r) => {
                  const checked = selected.has(r.id);
                  return (
                    <label
                      key={r.id}
                      className="flex cursor-pointer items-center gap-2 px-3 py-1.5 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface)] max-md:py-2.5 active:bg-[var(--wms-surface)]"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOne(r.id)}
                        className="h-3.5 w-3.5 cursor-pointer accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
                      />
                      <span className={r.status_online ? "text-[var(--wms-fg)]" : "text-[var(--wms-muted)]"}>
                        {r.name}
                      </span>
                      {r.network_address ? (
                        <span className="text-[var(--wms-muted)] text-[0.6rem]">{r.network_address}</span>
                      ) : null}
                      <span
                        className={`ml-auto inline-block rounded px-1.5 py-0.5 text-[0.55rem] uppercase tracking-wider ${
                          r.status_online
                            ? "bg-emerald-400/15 text-emerald-300"
                            : "bg-zinc-500/15 text-zinc-400"
                        }`}
                      >
                        {r.status_online ? "Online" : "Offline"}
                      </span>
                    </label>
                  );
                })}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
