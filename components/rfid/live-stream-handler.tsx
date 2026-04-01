"use client";

import { useEffect, useRef, useState } from "react";

type EdgePayload = {
  deviceId?: string;
  scanContext?: string;
  epcs?: string[];
  rowsAffected?: number;
  timestamp?: string;
};

function parseData(raw: string): EdgePayload | null {
  try {
    return JSON.parse(raw) as EdgePayload;
  } catch {
    return null;
  }
}

/**
 * Subscribes to `/api/edge/stream` (location-filtered SSE) and surfaces floor activity on the dashboard.
 */
export function LiveStreamHandler({
  onLiveScanCount,
}: {
  onLiveScanCount?: (delta: number, last?: EdgePayload) => void;
}) {
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countCb = useRef(onLiveScanCount);

  useEffect(() => {
    countCb.current = onLiveScanCount;
  }, [onLiveScanCount]);

  useEffect(() => {
    const es = new EventSource("/api/edge/stream");

    const showToast = (msg: string) => {
      setToast(msg);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 4500);
    };

    es.onmessage = (ev) => {
      if (!ev.data || ev.data.startsWith(":")) return;
      const p = parseData(ev.data);
      if (!p) return;
      if (!p.epcs?.length && (p.rowsAffected ?? 0) === 0 && !p.scanContext) return;
      const n = p.epcs?.length ?? 0;
      const ctx = p.scanContext ?? "scan";
      const rows = p.rowsAffected ?? 0;
      showToast(
        rows > 0
          ? `${ctx}: ${n} tag(s) · ${rows} row(s) updated`
          : `${ctx}: ${n} tag(s) on the floor`,
      );
      countCb.current?.(n, p);
    };

    es.onerror = () => {
      /* EventSource auto-reconnects; keep UI quiet */
    };

    return () => {
      es.close();
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  if (!toast) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-6 right-6 z-50 max-w-sm rounded-lg border border-emerald-500/35 bg-[var(--wms-surface)]/95 px-4 py-3 font-mono text-xs text-emerald-100 shadow-lg shadow-emerald-900/20"
      role="status"
    >
      <div className="text-[0.6rem] uppercase tracking-wider text-emerald-500/90">Live edge</div>
      <div className="mt-1 leading-snug text-[var(--wms-fg)]">{toast}</div>
    </div>
  );
}
