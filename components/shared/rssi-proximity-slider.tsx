"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * RSSI proximity slider — a pure client-side display filter on per-tag RSSI.
 *
 * Ported from the Carbon-POS RFID-Scan modal. It NEVER changes RF power; it
 * only hides rows whose strongest sighting is weaker (further) than the
 * threshold. Rows with no RSSI (null) are always shown. Used on the .70
 * register/encode reader, where the operator wants to see only the tag right
 * in front of the antenna and ignore shelf stock behind it.
 *
 * Range −90 (far / show everything) … −20 (near / closest only). Default −50
 * per operator (2026-06-01) — adjust once the real bench distance is dialed in.
 */
export const RSSI_MIN = -90;
export const RSSI_MAX = -20;
export const RSSI_DEFAULT = -50;

/** Clamp + validate an RSSI value to the slider's range. */
function clampRssi(n: number): number {
  if (!Number.isFinite(n)) return RSSI_DEFAULT;
  return Math.min(RSSI_MAX, Math.max(RSSI_MIN, Math.round(n)));
}

/**
 * State hook: holds the threshold and persists it to localStorage under
 * `storageKey` (per-page). Hydrates once on mount (no SSR mismatch — starts at
 * the default, then reads the stored value in an effect).
 */
export function useRssiThreshold(
  storageKey: string,
  initial: number = RSSI_DEFAULT,
): [number, (v: number) => void] {
  const [value, setValue] = useState<number>(initial);
  useEffect(() => {
    try {
      const s = localStorage.getItem(storageKey);
      // One-time hydration from localStorage. Effect (not lazy init) keeps the
      // SSR render === first client render (no hydration mismatch); the stored
      // value is applied on the next tick.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (s !== null) setValue(clampRssi(Number(s)));
    } catch {
      /* localStorage unavailable — keep default */
    }
  }, [storageKey]);
  const set = useCallback(
    (v: number) => {
      const n = clampRssi(v);
      setValue(n);
      try {
        localStorage.setItem(storageKey, String(n));
      } catch {
        /* ignore */
      }
    },
    [storageKey],
  );
  return [value, set];
}

/** Does this row pass the proximity filter? null RSSI always passes. */
export function passesRssi(rssi: number | null | undefined, threshold: number): boolean {
  return rssi == null || rssi >= threshold;
}

export function RssiProximitySlider({
  value,
  onChange,
  hint,
}: {
  value: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--wms-border)] bg-[linear-gradient(180deg,rgba(45,212,191,0.06),transparent)] px-4 py-2.5 max-md:flex-wrap max-md:gap-y-2">
      <span className="shrink-0 text-[11px] uppercase tracking-wider text-[var(--wms-muted)]">
        Proximity
      </span>
      <span className="text-[11px] text-[var(--wms-muted)]">far</span>
      <input
        type="range"
        min={RSSI_MIN}
        max={RSSI_MAX}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="RFID proximity filter (RSSI threshold in dBm)"
        className="h-1 flex-1 accent-[var(--wms-accent)] max-md:h-2 max-md:min-w-[10rem] max-md:basis-full max-md:order-last"
      />
      <span className="text-[11px] text-[var(--wms-muted)]">near</span>
      <span className="w-[74px] text-right font-mono text-sm tabular-nums text-[var(--wms-accent)]">
        {value} dBm
      </span>
      {hint ? (
        <span className="ml-1 shrink-0 border-l border-[var(--wms-border)] pl-3 text-[10px] text-[var(--wms-muted)]">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
