"use client";

/**
 * Scan-out: hold the items being sent to a customer at the .87 antenna, check
 * the ones going out, and scan them out — their tags become SOLD.
 *
 * Used on its own page (Tags & Labels → Scan-out) and inside a Shopify order
 * (Shopify → Sales), where it is told the order, so every scan-out is logged
 * against it and the order's items are marked in the list.
 *
 * Every action — reader started or stopped, each tag scanned out or refused —
 * is recorded with the user, the time and the full item (Reports → Scan-out log).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { CheckCircle2, Eraser, Play, Radio, Square, Truck, XCircle } from "lucide-react";
import { RssiProximitySlider, passesRssi } from "@/components/shared/rssi-proximity-slider";
import { useReaderWake } from "@/components/shared/use-reader-wake";
import { ReaderForceStopButton } from "@/components/shared/reader-force-stop-button";

/** The Scan-out station's reader. */
const READER_IP = "192.168.1.87";
/** Close enough that only the item in the operator's hand reads — set fresh on every page load. */
const DEFAULT_PROXIMITY_DBM = -40;

type HcReader = { id: string; network_address: string | null };
type HcTree = { locations?: { zones?: { readers?: HcReader[] }[]; unzoned_readers?: HcReader[] }[] };
const hcFetcher = async (u: string): Promise<HcTree> => {
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error("hardware-config fetch failed");
  return r.json() as Promise<HcTree>;
};

export type ScanOutItem = {
  epc: string;
  status: string | null;
  serial: string | null;
  customSkuId: string | null;
  sku: string | null;
  upc: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
  bin: string | null;
};
type Seen = { epc: string; rssi: number | null };
type Done = ScanOutItem & { at: number; ok: boolean; error?: string; oldStatus: string | null };

const STATUS_LABEL: Record<string, string> = {
  "in-stock": "LIVE",
  unknown: "UNKNOWN",
  sold: "SOLD",
  return: "RETURN",
  damaged: "DAMAGED",
  stolen: "STOLEN",
  tag_killed: "TAG KILLED",
  "in-transit": "IN TRANSIT",
  pending_visibility: "PENDING VISIBILITY",
  pending_transaction: "PENDING TRANSACTION",
};
export const statusLabel = (s: string | null) => (s ? STATUS_LABEL[s] ?? s.toUpperCase() : "NOT IN WMS");
export function statusClass(s: string | null): string {
  switch (s) {
    case "in-stock":
      return "border-emerald-500/40 bg-emerald-500/15 text-emerald-500 dark:text-emerald-300";
    case "unknown":
      return "border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-300";
    case "sold":
      return "border-sky-500/40 bg-sky-500/15 text-sky-600 dark:text-sky-300";
    case null:
      return "border-red-500/40 bg-red-500/15 text-red-600 dark:text-red-300";
    default:
      return "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-muted)]";
  }
}
const canScanOut = (s: string | null) => s === "in-stock" || s === "unknown";

export function ShipScanOutWorkspace({
  order,
  onScannedOut,
}: {
  /** When opened from a Shopify order: logged with every action, and its items are marked. */
  order?: { id: string; name: string; skus: string[] };
  onScannedOut?: () => void;
} = {}) {
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

  const [threshold, setThreshold] = useState(DEFAULT_PROXIMITY_DBM);
  const [seen, setSeen] = useState<Map<string, Seen>>(new Map());
  const [info, setInfo] = useState<Map<string, ScanOutItem>>(new Map());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Done[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const orderSkus = useMemo(() => new Set(order?.skus.filter(Boolean) ?? []), [order]);

  const logReader = useCallback(
    (action: "start" | "stop") => {
      void fetch("/api/rfid/ship-scan-out/reader", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reader: READER_IP, orderId: order?.id, orderName: order?.name }),
      }).catch(() => {});
    },
    [order],
  );

  // SSE: stream EPCs from the Scan-out reader.
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

  /* Item details for every tag seen, fetched once per tag in small batches —
     the operator reads the item and its status, not a 24-digit number. */
  const asked = useRef<Set<string>>(new Set());
  useEffect(() => {
    const missing = [...seen.keys()].filter((e) => !asked.current.has(e));
    if (!missing.length) return;
    const t = window.setTimeout(() => {
      missing.forEach((e) => asked.current.add(e));
      void fetch("/api/rfid/ship-scan-out/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epcs: missing }),
      })
        .then((r) => r.json())
        .then((j: { items?: ScanOutItem[] }) => {
          setInfo((prev) => {
            const next = new Map(prev);
            for (const it of j.items ?? []) next.set(it.epc, it);
            return next;
          });
        })
        .catch(() => missing.forEach((e) => asked.current.delete(e)));
    }, 300);
    return () => window.clearTimeout(t);
  }, [seen]);

  const visible = useMemo(
    () =>
      Array.from(seen.values())
        .filter((s) => passesRssi(s.rssi, threshold))
        .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999)),
    [seen, threshold],
  );
  // "Check all" means the rows on screen that can go out — never every tag the reader ever saw.
  const selectable = useMemo(() => visible.filter((s) => canScanOut(info.get(s.epc)?.status ?? null)).map((s) => s.epc), [visible, info]);
  const checkedVisible = useMemo(() => selectable.filter((e) => checked.has(e)), [selectable, checked]);
  const allChecked = selectable.length > 0 && checkedVisible.length === selectable.length;

  const toggle = (epc: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(epc)) next.delete(epc);
      else next.add(epc);
      return next;
    });
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(selectable));

  const scanOutChecked = useCallback(async () => {
    const epcs = checkedVisible;
    if (!epcs.length) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const rssi: Record<string, number> = {};
      for (const e of epcs) {
        const r = seen.get(e)?.rssi;
        if (typeof r === "number") rssi[e] = r;
      }
      const r = await fetch("/api/rfid/ship-scan-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epcs, orderId: order?.id, orderName: order?.name, reader: READER_IP, rssi }),
      });
      const j = (await r.json().catch(() => ({}))) as { results?: Array<ScanOutItem & { ok: boolean; error?: string; oldStatus: string | null }>; error?: string };
      if (!j.results) {
        setErr(j.error ?? "Could not scan out.");
        return;
      }
      const at = Date.now();
      setDone((prev) => [...j.results!.map((x) => ({ ...x, at })), ...prev].slice(0, 200));
      setInfo((prev) => {
        const next = new Map(prev);
        for (const x of j.results!) if (x.ok) next.set(x.epc, { ...(next.get(x.epc) ?? x), status: "sold" });
        return next;
      });
      setChecked((prev) => {
        const next = new Set(prev);
        for (const x of j.results!) next.delete(x.epc);
        return next;
      });
      const ok = j.results.filter((x) => x.ok).length;
      const bad = j.results.length - ok;
      if (ok) setMsg(`Scanned out ${ok} item${ok === 1 ? "" : "s"} — now SOLD.`);
      if (bad) setErr(`${bad} could not be scanned out — see the list.`);
      if (ok) onScannedOut?.();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Network error");
    } finally {
      setBusy(false);
    }
  }, [checkedVisible, seen, order, onScannedOut]);

  const stopReader = () => {
    setReaderOn(false);
    logReader("stop");
  };
  const clearList = () => {
    setSeen(new Map());
    setChecked(new Set());
  };

  const fmtTime = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

  return (
    <div className="space-y-4">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            if (readerOn) stopReader();
            else {
              setReaderOn(true);
              logReader("start");
            }
          }}
          className={
            "inline-flex items-center gap-2 rounded-md border px-4 py-1.5 text-sm font-semibold max-md:min-h-11 " +
            (readerOn ? "border-red-400/50 bg-red-500/12 text-red-500 hover:bg-red-500/20 dark:text-red-300" : "border-emerald-400/50 bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25 dark:text-emerald-300")
          }
        >
          {readerOn ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {readerOn ? "Stop reader" : "Start reader"}
        </button>
        <span
          className={
            "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold " +
            (sessionActive ? "border-emerald-400/40 bg-emerald-500/12 text-emerald-600 dark:text-emerald-300" : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-muted)]")
          }
        >
          <Radio className="h-3.5 w-3.5" />
          Scan-out reader .87 · {!readerOn ? "off" : sessionActive ? "on" : readerId ? "starting…" : "not found"}
        </span>
        <ReaderForceStopButton networkAddresses={[READER_IP]} onStopped={() => setReaderOn(false)} />
        <div className="min-w-[300px] flex-1 max-md:min-w-full">
          <RssiProximitySlider value={threshold} onChange={setThreshold} hint="hold the item at the antenna" />
        </div>
      </div>

      {err ? <p className="font-mono text-xs text-red-500 dark:text-red-300">{err}</p> : null}
      {msg ? <p className="font-mono text-xs text-emerald-600 dark:text-emerald-300">{msg}</p> : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[3fr_2fr]">
        {/* Tags at the antenna */}
        <div className="min-w-0 rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-2 text-sm font-medium text-[var(--wms-fg)] max-md:min-h-11">
              <input
                id="scan-out-check-all"
                type="checkbox"
                className="h-4 w-4 accent-[var(--wms-accent)]"
                checked={allChecked}
                disabled={!selectable.length}
                onChange={toggleAll}
              />
              Check all ({selectable.length})
            </label>
            <span className="text-xs text-[var(--wms-muted)]">
              {visible.length} at the antenna{seen.size > visible.length ? ` · ${seen.size - visible.length} further away hidden` : ""}
            </span>
            <div className="ml-auto flex flex-wrap gap-2">
              <button
                type="button"
                onClick={clearList}
                disabled={!seen.size}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] px-3 py-1.5 text-xs font-semibold text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40 max-md:min-h-11"
              >
                <Eraser className="h-3.5 w-3.5" /> Clear list
              </button>
              <button
                type="button"
                disabled={busy || !checkedVisible.length}
                onClick={() => void scanOutChecked()}
                className="inline-flex items-center gap-2 rounded-md border border-[var(--wms-accent)] bg-[var(--wms-accent)] px-4 py-1.5 text-sm font-semibold text-[var(--wms-accent-fg)] hover:brightness-110 disabled:opacity-40 max-md:min-h-11"
              >
                <Truck className="h-4 w-4" /> {busy ? "Scanning out…" : `Scan out (${checkedVisible.length})`}
              </button>
            </div>
          </div>

          {!seen.size ? (
            <p className="py-6 text-center font-mono text-xs text-[var(--wms-muted)]">
              {readerOn ? "Listening… bring the item's tag to the antenna." : "Press Start reader, then hold the item at the antenna."}
            </p>
          ) : visible.length === 0 ? (
            <p className="py-6 text-center font-mono text-xs text-[var(--wms-muted)]">
              Nothing close enough — bring the item nearer, or move the proximity slider toward &ldquo;far&rdquo;.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-[var(--wms-border)]">
              {visible.map((s) => {
                const it = info.get(s.epc);
                const status = it ? it.status : undefined;
                const ok = canScanOut(status ?? null);
                const onOrder = !!it?.sku && orderSkus.has(it.sku);
                return (
                  <label
                    key={s.epc}
                    htmlFor={`so-${s.epc}`}
                    className={`flex cursor-pointer items-start gap-3 border-b border-[var(--wms-border)]/50 px-3 py-2.5 last:border-b-0 ${
                      checked.has(s.epc) ? "bg-[color-mix(in_srgb,var(--wms-accent)_8%,transparent)]" : ""
                    }`}
                  >
                    <input
                      id={`so-${s.epc}`}
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0 accent-[var(--wms-accent)]"
                      checked={checked.has(s.epc)}
                      disabled={!ok}
                      onChange={() => toggle(s.epc)}
                    />
                    <div className="min-w-0 flex-1">
                      {it ? (
                        <>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-base font-semibold text-[var(--wms-fg)]">{it.name ?? "Unknown item"}</span>
                            {onOrder ? (
                              <span className="rounded-full bg-[var(--wms-accent)]/15 px-2 py-0.5 text-[0.65rem] font-semibold text-[var(--wms-accent)]">
                                ON THIS ORDER
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-[var(--wms-fg)]/85">
                            {it.color ? <span>{it.color}</span> : null}
                            {it.size ? <span>Size {it.size}</span> : null}
                            {it.sku ? <span className="font-mono">SKU {it.sku}</span> : null}
                            {it.upc ? <span className="font-mono">UPC {it.upc}</span> : null}
                            <span className="font-mono">Bin {it.bin ?? "—"}</span>
                          </div>
                        </>
                      ) : (
                        <div className="text-sm text-[var(--wms-muted)]">Looking up…</div>
                      )}
                      <div className="mt-0.5 font-mono text-xs text-[var(--wms-muted)]">{s.epc}</div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {status !== undefined ? (
                        <span className={`rounded-md border px-2 py-0.5 font-mono text-[0.65rem] font-semibold ${statusClass(status)}`}>
                          {statusLabel(status)}
                        </span>
                      ) : null}
                      <span className="font-mono text-xs text-[var(--wms-muted)]">{s.rssi == null ? "—" : `${s.rssi} dBm`}</span>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Scanned out this session */}
        <div className="min-w-0 rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-4">
          <h2 className="mb-2 text-[11px] uppercase tracking-wider text-[var(--wms-muted)]">
            Scanned out this session ({done.filter((d) => d.ok).length})
          </h2>
          {done.length === 0 ? (
            <p className="py-6 text-center font-mono text-xs text-[var(--wms-muted)]">Nothing scanned out yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {done.map((d) => (
                <li
                  key={d.epc + d.at}
                  className={`rounded border px-3 py-2 text-sm ${d.ok ? "border-emerald-400/30 bg-emerald-500/8" : "border-red-400/30 bg-red-500/8"}`}
                >
                  <div className="flex items-start gap-2">
                    {d.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />}
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-[var(--wms-fg)]">
                        {[d.name, d.color, d.size].filter(Boolean).join(" · ") || "Unknown item"}
                      </div>
                      <div className="font-mono text-xs text-[var(--wms-muted)]">
                        {[d.sku && `SKU ${d.sku}`, d.epc].filter(Boolean).join(" · ")}
                      </div>
                      <div className="text-xs text-[var(--wms-muted)]">
                        {d.ok ? `${statusLabel(d.oldStatus)} → SOLD` : d.error}
                      </div>
                    </div>
                    <span className="shrink-0 font-mono text-xs text-[var(--wms-muted)]">{fmtTime(d.at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <p className="flex items-center gap-2 font-mono text-[0.65rem] text-[var(--wms-muted)]">
        <XCircle className="h-3 w-3" /> Only LIVE or UNKNOWN tags can be scanned out. Scanning out makes the tag SOLD — the EPC
        value is never changed. Every action is recorded in Reports → Scan-out log.
      </p>
    </div>
  );
}
