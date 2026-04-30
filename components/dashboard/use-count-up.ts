"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Animates an integer counter from its current displayed value to `target`.
 * Defaults: 800ms total, ease-out timing. New target mid-flight kicks off a
 * fresh animation from wherever we are.
 *
 * Use for KPI tiles that should "climb up" on first paint.
 */
export function useCountUp(target: number, durationMs = 800): number {
  const [display, setDisplay] = useState(0);
  const startRef = useRef<number | null>(null);
  const fromRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      setDisplay(target);
      return;
    }
    if (target === display) return;
    fromRef.current = display;
    startRef.current = null;

    const tick = (now: number) => {
      if (startRef.current == null) startRef.current = now;
      const elapsed = now - startRef.current;
      const t = Math.min(1, elapsed / durationMs);
      // ease-out cubic — fast at first, settling at the end.
      const eased = 1 - Math.pow(1 - t, 3);
      const next = Math.round(fromRef.current + (target - fromRef.current) * eased);
      setDisplay(next);
      if (t < 1) {
        rafRef.current = window.requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs]);

  return display;
}
