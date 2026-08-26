"use client";

import { useEffect, useRef } from "react";

export type ReaderWakeKind =
  | "transfer-out"
  | "cycle-count"
  | "print-commission"
  | "encode-items"
  | "bulk-import"
  | "bulk-status"
  | "bulk-geiger"
  | "geiger"
  | "scan-epc";

/**
 * Keep a set of readers WARM while `active` is true, by pre-warming them on
 * the server (scan-sessions) and heart-beating every 15 s. When `active` goes
 * false or the component unmounts (operator leaves the page), the heartbeat
 * stops and the server janitor ends the session(s) ~30 s later → readers go
 * cold. That 30 s grace means a quick navigate-away-and-back keeps them warm.
 *
 * Targeting — pick ONE (omit all → ALL non-POS readers at the location):
 *   - networkAddresses: e.g. ["192.168.1.16"]
 *   - readerIds
 * `locationId` defaults to the caller's session location.
 *
 * IMPORTANT: this only WAKES (warms) readers. It does NOT start "capturing" —
 * each page decides separately when to count reads (its own Start button). The
 * POS reader (.34) is never pre-warmed (the server excludes is_pos_dedicated).
 */
export function useReaderWake(opts: {
  active: boolean;
  kind: ReaderWakeKind;
  networkAddresses?: string[];
  readerIds?: string[];
  locationId?: string;
}): void {
  const { active, kind, locationId } = opts;
  const ipsKey = (opts.networkAddresses ?? []).join(",");
  const idsKey = (opts.readerIds ?? []).join(",");
  const sessionIdsRef = useRef<string[]>([]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const body = JSON.stringify({
      kind,
      ...(opts.networkAddresses?.length
        ? { networkAddresses: opts.networkAddresses }
        : {}),
      ...(opts.readerIds?.length ? { readerIds: opts.readerIds } : {}),
      ...(locationId ? { locationId } : {}),
    });

    const prewarm = async () => {
      try {
        const r = await fetch("/api/scan-sessions/prewarm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        const j = (await r.json().catch(() => null)) as
          | { ok?: boolean; sessions?: Array<{ sessionId: string }> }
          | null;
        if (!cancelled && j?.ok && Array.isArray(j.sessions)) {
          sessionIdsRef.current = j.sessions.map((s) => s.sessionId);
        }
      } catch {
        /* transient — the next heartbeat retries */
      }
    };

    void prewarm(); // warm immediately on activate
    const hb = setInterval(() => void prewarm(), 15_000); // heartbeat + re-warm

    return () => {
      cancelled = true;
      clearInterval(hb);
      // Deliberately DO NOT end the session here. Stopping the heartbeat lets
      // the server janitor end it ~30 s later (the leave-grace), so briefly
      // navigating away and back doesn't cold the readers.
      sessionIdsRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, kind, ipsKey, idsKey, locationId]);
}
