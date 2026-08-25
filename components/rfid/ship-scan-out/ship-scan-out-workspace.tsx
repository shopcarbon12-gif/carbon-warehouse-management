"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { CheckCircle2, Play, Radio, Square, Truck, XCircle } from "lucide-react";
import { RssiProximitySlider, useRssiThreshold, passesRssi } from "@/components/shared/rssi-proximity-slider";
import { useReaderWake } from "@/components/shared/use-reader-wake";

/** Ship station reader (Office-POS / register area). */
const READER_IP = "192.168.1.87";

type HcReader = { id: string; network_address: string | null };
type HcTree = { locations?: { zones?: { readers?: HcReader[] }[]; unzoned_readers?: HcReader[] }[] };
const hcFetcher = async (u: string): Promise<HcTree> => {
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error("hardware-config fetch failed");
  return r.json() as Promise<HcTree>;
};

type Seen = { epc: string; rssi: number | null };
type Shipped = { epc: string; sku: string | null; name: string | null; at: number };

export function ShipScanOutWorkspace() {
  const { data: hc } = useSWR<HcTree>("/api/hardware-config", hcFetcher, { revalidateOnFocus: false });
  const readerId = useMemo(() => {
    for (const loc of hc?.locations ?? []) {
      for (const z of loc.zones ?? []) for (const r of z.readers ?? []) if (r.network_address === READER_IP) return r.id;
      for (const r of loc.unzoned_readers ?? []) if (r.network_address === READER_IP) return r.id;
    }
    return null;
  }, [hc]);

  const [readerOn, setReaderOn] = useState(false);
  useReaderWake({ active: readerOn, kind: "scan-epc", networkAddresses: [READER_IP] });
  const sessionActive = readerOn && readerId !== null;

  const [threshold, setThreshold] = useRssiThreshold("wms.ship-scan-out.rssi");
  const [seen, setSeen] = useState<Map<string, Seen>>(new Map());
  const [shipped, setShipped] = useState<Shipped[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [manual, setManual] = useState("");

  // SSE: stream EPCs from the ship reader.
  useEffect(() => {
    if (!sessionActive || !readerId) return;
    const es = new EventSource("/api/edge/stream");
    es.onmessage = (ev) => {
      if (!ev.data?.trim() || ev.data.startsWith(":")) return;
      let p: { epcs?: string[]; deviceId?: string; epcRssiMap?: Record<string, number> };
      try {
        p = JSON.parse(ev.data) as typeof p;
      } catch {
        return;
      }
      if (p.deviceId && p.deviceId !== readerId) return;
      const list = (p.epcs ?? []).map((e) => e.replace(/\s/g, "").toUpperCase()).filter((e) => /^[0-9A-F]{24}$/.test(e));
      if (!list.length) return;
      const rssiMap = p.epcRssiMap ?? {};
      setSeen((prev) => {
        const next = new Map(prev);
        let changed = false;
        for (const epc of list) {
          const rssi = typeof rssiMap[epc] === "number" ? rssiMap[epc] : null;
          const cur = next.get(epc);
          if (!cur) {
            next.set(epc, { epc, rssi });
            changed = true;
          } else if (rssi != null && (cur.rssi == null || rssi > cur.rssi)) {
            next.set(epc, { epc, rssi });
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    return () => es.close();
  }, [sessionActive, readerId]);

  const visible = useMemo(
    () =>
      Array.from(seen.values())
        .filter((s) => passesRssi(s.rssi, threshold))
        .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999)),
    [seen, threshold],
  );

  const shipOne = useCallback(async (epc: string) => {
    const e = epc.replace(/\s/g, "").toUpperCase();
    if (!/^[0-9A-F]{24}$/.test(e)) {
      setErr("Invalid EPC.");
      return;
    }
    setBusy(e);
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch("/api/rfid/ship-scan-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epc: e }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        sku?: string | null;
        name?: string | null;
        color?: string | null;
        size?: string | null;
        error?: string;
      };
      if (!j.ok) {
        setErr(j.error ?? "Could not ship this tag.");
        return;
      }
      setShipped((prev) => [{ epc: e, sku: j.sku ?? null, name: j.name ?? null, at: Date.now() }, ...prev].slice(0, 50));
      setSeen((prev) => {
        const next = new Map(prev);
        next.delete(e);
        return next;
      });
      setMsg(`Shipped ✓ — ${j.name ?? ""} ${j.sku ?? ""}`.trim());
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Network error");
    } finally {
      setBusy(null);
    }
  }, []);

  const fmtTime = (t: number) => {
    const d = new Date(t);
    let h = d.getHours();
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${String(h).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} ${ap}`;
  };

  return (
    <div className="space-y-4">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => { if (readerOn) { setReaderOn(false); setSeen(new Map()); } else setReaderOn(true); }}
          className={
            "inline-flex items-center gap-2 rounded-md border px-4 py-1.5 text-xs font-semibold " +
            (readerOn ? "border-red-400/50 bg-red-500/12 text-red-300 hover:bg-red-500/20" : "border-emerald-400/50 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25")
          }
        >
          {readerOn ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {readerOn ? "Stop reader" : "Start reader"}
        </button>
        <span
          className={
            "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold " +
            (sessionActive ? "border-emerald-400/40 bg-emerald-500/12 text-emerald-300" : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-muted)]")
          }
        >
          <Radio className="h-3.5 w-3.5" />
          Ship reader .87 · {!readerOn ? "off" : sessionActive ? "on" : readerId ? "starting…" : "not found"}
        </span>
        <div className="min-w-[300px] flex-1">
          <RssiProximitySlider value={threshold} onChange={setThreshold} hint="hold the item at the ship antenna" />
        </div>
      </div>

      {/* Manual EPC entry */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && manual.trim()) { void shipOne(manual.trim()); setManual(""); } }}
          placeholder="Scan or type an EPC, then Enter"
          className="min-w-[280px] flex-1 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)] focus:border-[var(--wms-accent)] focus:outline-none"
          autoComplete="off"
        />
        <button
          type="button"
          disabled={busy !== null || !manual.trim()}
          onClick={() => { void shipOne(manual.trim()); setManual(""); }}
          className="inline-flex items-center gap-2 rounded-md border border-[var(--wms-accent)] bg-[var(--wms-accent)] px-4 py-2 text-sm font-semibold text-[var(--wms-accent-fg)] hover:brightness-110 disabled:opacity-40"
        >
          <Truck className="h-4 w-4" /> Ship (sold)
        </button>
      </div>
      {err ? <p className="font-mono text-xs text-red-300">{err}</p> : msg ? <p className="font-mono text-xs text-emerald-300">{msg}</p> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Tags at the antenna */}
        <div className="rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-4">
          <h2 className="mb-2 text-[11px] uppercase tracking-wider text-[var(--wms-muted)]">Tags at the ship antenna</h2>
          {!readerOn ? (
            <p className="py-6 text-center font-mono text-xs text-[var(--wms-muted)]">Press Start reader, then hold the item at the antenna.</p>
          ) : visible.length === 0 ? (
            <p className="py-6 text-center font-mono text-xs text-[var(--wms-muted)]">Listening… bring the item&apos;s tag closer.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-[var(--wms-border)]">
              {visible.map((s) => (
                <div key={s.epc} className="flex items-center gap-3 border-b border-[var(--wms-border)]/50 px-3 py-2 last:border-b-0">
                  <span className="font-mono text-xs font-semibold text-teal-300 max-md:min-w-0 max-md:truncate" title={s.epc}>{s.epc}</span>
                  <span className="ml-auto font-mono text-xs text-[var(--wms-muted)] max-md:shrink-0">{s.rssi == null ? "—" : `${s.rssi} dBm`}</span>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void shipOne(s.epc)}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--wms-accent)] bg-[var(--wms-accent)] px-2.5 py-1 text-[0.65rem] font-semibold text-[var(--wms-accent-fg)] hover:brightness-110 disabled:opacity-40 max-md:shrink-0 max-md:px-3 max-md:py-2"
                  >
                    {busy === s.epc ? "…" : <><Truck className="h-3 w-3" /> Ship</>}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Shipped today */}
        <div className="rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-4">
          <h2 className="mb-2 text-[11px] uppercase tracking-wider text-[var(--wms-muted)]">Shipped this session ({shipped.length})</h2>
          {shipped.length === 0 ? (
            <p className="py-6 text-center font-mono text-xs text-[var(--wms-muted)]">Nothing shipped yet.</p>
          ) : (
            <ul className="space-y-1.5 font-mono">
              {shipped.map((s) => (
                <li key={s.epc + s.at} className="flex items-center gap-2 rounded border border-emerald-400/30 bg-emerald-500/8 px-3 py-1.5 text-xs">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  <span className="truncate text-[var(--wms-fg)]">{[s.name, s.sku].filter(Boolean).join(" · ") || s.epc}</span>
                  <span className="ml-auto shrink-0 text-[var(--wms-muted)]">{fmtTime(s.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <p className="flex items-center gap-2 font-mono text-[0.65rem] text-[var(--wms-muted)]">
        <XCircle className="h-3 w-3" /> Only in-stock or unknown tags can be shipped. Shipping flips the tag to
        <span className="text-[var(--wms-fg)]">sold</span> — the EPC value is never changed.
      </p>
    </div>
  );
}
