"use client";

/**
 * Shopify → Returns. Approve the request in Shopify; everything after happens
 * here: scan the returned pieces in (they become LIVE), scan the exchange
 * pieces out (they become SOLD), then "Complete in Shopify" — the scanned-in
 * pieces are restocked there and the exchange items released for shipping.
 * See lib/server/shopify-return-desk.ts.
 */
import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import { CheckCircle2, ExternalLink, Loader2, PackageCheck, RefreshCw, ScanLine, Truck, X } from "lucide-react";
import { useUrlParam } from "@/lib/use-url-param";
import { RfidTagsModal } from "@/components/inventory/catalog/rfid-tags-modal";
import {
  ShipScanOutWorkspace,
  statusClass,
  statusLabel,
  type ScanOutItem,
} from "@/components/rfid/ship-scan-out/ship-scan-out-workspace";

type Row = {
  id: string;
  name: string;
  createdAt: string;
  orderId: string;
  orderName: string;
  customer: string | null;
  returning: number;
  exchanging: number;
  scannedIn: number;
};
type Wms = { customSkuId: string | null; sku: string | null; upc: string | null; bin: string | null; name: string | null; color: string | null; size: string | null };
type Line = Wms & {
  id: string;
  title: string;
  variant: string | null;
  image: string | null;
  quantity: number;
  processed: number;
  processable: number;
  reason: string | null;
  note: string | null;
  scannedIn: ScanOutItem[];
  inTransit: ScanOutItem[];
};
type Exchange = Wms & {
  id: string;
  title: string;
  variant: string | null;
  image: string | null;
  quantity: number;
  processed: number;
  processable: number;
  scannedOut: ScanOutItem[];
};
type Detail = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  orderId: string;
  orderName: string;
  customer: string | null;
  adminUrl: string;
  lines: Line[];
  exchanges: Exchange[];
};

const fetcher = async (u: string) => {
  const r = await fetch(u, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error ?? `Request failed (${r.status})`);
  return j;
};

const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function ReturnsWorkspace() {
  const { data, error, isLoading, mutate } = useSWR<{ rows: Row[] }>("/api/shopify/returns", fetcher, { refreshInterval: 60_000 });
  const [openId, setOpenId] = useUrlParam("return");
  const rows = data?.rows ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--wms-fg)]">Returns</h1>
          <p className="mt-0.5 max-w-2xl text-sm text-[var(--wms-muted)]">
            Approve a return in Shopify; then receive it here — scan the returned pieces in, scan the exchange pieces out,
            and complete it in Shopify from this screen.
          </p>
        </div>
        <button type="button" className="wms-btn inline-flex items-center gap-1.5 max-md:min-h-11" onClick={() => void mutate()}>
          <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {error ? <p className="text-sm text-[var(--wms-status-danger-fg)]">{String(error.message ?? error)}</p> : null}

      <div className="overflow-x-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]">
        <table className="w-full min-w-[760px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--wms-border)] text-xs font-medium text-[var(--wms-muted)]">
              <th className="px-3 py-2">Return</th>
              <th className="px-3 py-2">Order</th>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Opened</th>
              <th className="px-3 py-2">Coming back</th>
              <th className="px-3 py-2">Exchange</th>
              <th className="px-3 py-2">Scanned in</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => setOpenId(r.id)} className="cursor-pointer border-b border-[var(--wms-border)]/60 hover:bg-[var(--wms-surface-elevated)]/60">
                <td className="px-3 py-2.5 font-semibold text-[var(--wms-fg)]">{r.name}</td>
                <td className="px-3 py-2.5 text-[var(--wms-fg)]">{r.orderName}</td>
                <td className="px-3 py-2.5 text-[var(--wms-fg)]">{r.customer ?? "—"}</td>
                <td className="whitespace-nowrap px-3 py-2.5 text-[var(--wms-fg)]/85">{when(r.createdAt)}</td>
                <td className="px-3 py-2.5 text-[var(--wms-fg)]/85">
                  {r.returning} {r.returning === 1 ? "item" : "items"}
                </td>
                <td className="px-3 py-2.5 text-[var(--wms-fg)]/85">{r.exchanging ? `${r.exchanging} ${r.exchanging === 1 ? "item" : "items"}` : "—"}</td>
                <td className="px-3 py-2.5">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${r.returning > 0 && r.scannedIn >= r.returning ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" : "bg-yellow-400/20 text-yellow-700 dark:text-yellow-300"}`}>
                    {r.scannedIn} / {r.returning}
                  </span>
                </td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-[var(--wms-muted)]">
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading returns from Shopify…
                    </>
                  ) : (
                    "No returns in progress. Approve a return request in Shopify and it appears here."
                  )}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {openId ? <ReturnPanel key={openId} id={openId} onClose={() => setOpenId(null)} onChanged={() => void mutate()} /> : null}
    </div>
  );
}

function TagRow({ tags, onOpen }: { tags: ScanOutItem[]; onOpen: (t: ScanOutItem) => void }) {
  return (
    <ul className="mt-1 flex flex-col gap-1">
      {tags.map((t) => (
        <li key={t.epc} className="flex flex-wrap items-center gap-2">
          <button type="button" className="font-mono text-sm font-semibold text-[var(--wms-accent)] underline-offset-2 hover:underline max-md:min-h-11" onClick={() => onOpen(t)}>
            {t.epc}
          </button>
          <span className={`rounded-md border px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold ${statusClass(t.status)}`}>{statusLabel(t.status)}</span>
        </li>
      ))}
    </ul>
  );
}

function ItemHead({ image, title, w, variant }: { image: string | null; title: string; w: Wms; variant: string | null }) {
  return (
    <div className="flex items-start gap-3">
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt="" className="h-16 w-16 shrink-0 rounded-md border border-[var(--wms-border)] object-cover" />
      ) : (
        <div className="h-16 w-16 shrink-0 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-base font-semibold leading-snug text-[var(--wms-fg)]">{w.name ?? title}</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {(w.color ?? variant?.split(" / ")[0]) ? (
            <span className="rounded-md bg-[var(--wms-accent)]/15 px-2 py-0.5 text-sm font-semibold text-[var(--wms-accent)]">{w.color ?? variant?.split(" / ")[0]}</span>
          ) : null}
          {(w.size ?? variant?.split(" / ")[1]) ? (
            <span className="rounded-md bg-sky-500/15 px-2 py-0.5 text-sm font-semibold text-sky-600 dark:text-sky-300">Size {w.size ?? variant?.split(" / ")[1]}</span>
          ) : null}
        </div>
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-sm">
          <dt className="text-[var(--wms-muted)]">SKU</dt>
          <dd className="font-semibold text-[var(--wms-fg)]">{w.sku ?? "—"}</dd>
          <dt className="text-[var(--wms-muted)]">UPC</dt>
          <dd className="font-semibold text-[var(--wms-fg)]">{w.upc ?? "—"}</dd>
          <dt className="text-[var(--wms-muted)]">Bin</dt>
          <dd className="font-semibold text-amber-600 dark:text-amber-300">{w.bin ?? "none"}</dd>
        </dl>
      </div>
    </div>
  );
}

function ReturnPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data: d, error, mutate } = useSWR<Detail>(`/api/shopify/returns/${id}`, fetcher, { revalidateOnFocus: true });
  const [scan, setScan] = useState<"in" | "out" | null>(null);
  const [tagsFor, setTagsFor] = useState<{ custom_sku_id: string; name: string; sku: string } | null>(null);
  const [completing, setCompleting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(() => {
    void mutate();
    onChanged();
  }, [mutate, onChanged]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || tagsFor) return;
      if (scan) setScan(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, scan, tagsFor]);

  const openTags = (t: ScanOutItem, w: Wms) => {
    const cs = t.customSkuId ?? w.customSkuId;
    if (cs) setTagsFor({ custom_sku_id: cs, name: t.name ?? w.name ?? "", sku: t.sku ?? w.sku ?? "" });
  };

  const expected = d?.lines.reduce((t, l) => t + l.processable, 0) ?? 0;
  const freshIn = d?.lines.reduce((t, l) => t + Math.min(l.processable, Math.max(0, l.scannedIn.length - l.processed)), 0) ?? 0;
  const toRelease = d?.exchanges.reduce((t, x) => t + x.processable, 0) ?? 0;
  const unscannedOut = d?.exchanges.reduce((t, x) => t + Math.max(0, x.processable - x.scannedOut.length), 0) ?? 0;

  const complete = async () => {
    if (!d) return;
    const parts = [
      freshIn ? `restock ${freshIn} scanned-in piece${freshIn === 1 ? "" : "s"}` : null,
      toRelease ? `release ${toRelease} exchange item${toRelease === 1 ? "" : "s"} for shipping` : null,
    ].filter(Boolean);
    const warn = [
      expected > freshIn ? `${expected - freshIn} returned piece${expected - freshIn === 1 ? " is" : "s are"} not scanned in and will stay open on the return.` : null,
      unscannedOut ? `${unscannedOut} exchange piece${unscannedOut === 1 ? " is" : "s are"} not scanned out yet — one LIVE tag each will be held as UNKNOWN until shipped.` : null,
    ].filter(Boolean);
    if (!window.confirm(`Complete ${d.name} in Shopify: ${parts.join(" and ")}?${warn.length ? "\n\n" + warn.join("\n") : ""}`)) return;
    setCompleting(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch(`/api/shopify/returns/${d.id}/complete`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error ?? "Could not complete the return.");
      setMsg(
        `Done in Shopify — ${j.restocked} restocked, ${j.released} exchange item${j.released === 1 ? "" : "s"} released.` +
          (j.released ? " Ship them from Shopify → Orders (Create shipping label)." : ""),
      );
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCompleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside className="flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-[var(--wms-bg)] shadow-xl" onClick={(e) => e.stopPropagation()} aria-label="Return details">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-[var(--wms-border)] bg-[var(--wms-bg)] px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-[var(--wms-fg)]">
              {d ? `${d.name} · ${d.orderName}` : "Return"}
            </h2>
            {d ? (
              <p className="text-xs text-[var(--wms-muted)]">
                {d.customer ?? "No customer"} · opened {when(d.createdAt)} · {d.status === "OPEN" ? "in progress" : d.status.toLowerCase()}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {d ? (
              <a className="wms-btn inline-flex items-center gap-1.5 max-md:min-h-11" href={d.adminUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" /> Shopify
              </a>
            ) : null}
            <button type="button" aria-label="Close" className="wms-btn inline-flex items-center max-md:min-h-11" onClick={onClose}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {error ? <p className="p-4 text-sm text-[var(--wms-status-danger-fg)]">{String(error.message ?? error)}</p> : null}
        {!d && !error ? (
          <p className="p-4 text-sm text-[var(--wms-muted)]">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading the return…
          </p>
        ) : null}

        {d ? (
          <div className="flex flex-col gap-3 p-4">
            {/* 1. Coming back */}
            <section className="rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--wms-border)] px-4 py-2">
                <h3 className="text-sm font-semibold text-[var(--wms-fg)]">1 · Coming back</h3>
                <button
                  type="button"
                  className="wms-btn-primary inline-flex items-center gap-1.5 max-md:min-h-11"
                  disabled={!d.lines.some((l) => l.processable > Math.max(0, l.scannedIn.length - l.processed))}
                  onClick={() => setScan("in")}
                >
                  <ScanLine className="h-4 w-4" /> Scan in
                </button>
              </div>
              <ul>
                {d.lines.map((l) => {
                  const got = Math.max(0, l.scannedIn.length - l.processed);
                  const full = l.processable > 0 && got >= l.processable;
                  return (
                    <li key={l.id} className="border-b border-[var(--wms-border)]/60 px-4 py-3 last:border-0">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <ItemHead image={l.image} title={l.title} w={l} variant={l.variant} />
                        </div>
                        <div className="shrink-0 text-right">
                          <div className={`text-sm font-semibold ${full ? "text-emerald-600 dark:text-emerald-300" : "text-[var(--wms-fg)]"}`}>
                            {full ? <CheckCircle2 className="mr-1 inline h-4 w-4" /> : null}
                            {got} / {l.processable} scanned in
                          </div>
                          {l.processed ? <div className="text-xs text-[var(--wms-muted)]">{l.processed} already completed</div> : null}
                        </div>
                      </div>
                      {l.reason || l.note ? (
                        <p className="mt-1 text-xs text-[var(--wms-muted)]">
                          {[l.reason && `Reason: ${l.reason}`, l.note && `Customer note: ${l.note}`].filter(Boolean).join(" · ")}
                        </p>
                      ) : null}
                      {l.inTransit.some((t) => t.status === "in-transit") ? (
                        <div className="mt-2 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/50 px-3 py-2">
                          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--wms-muted)]">In transit — on the way back</div>
                          <TagRow tags={l.inTransit.filter((t) => t.status === "in-transit")} onOpen={(t) => openTags(t, l)} />
                        </div>
                      ) : null}
                      <div className="mt-2 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/50 px-3 py-2">
                        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--wms-muted)]">Tags scanned in</div>
                        {l.scannedIn.length ? <TagRow tags={l.scannedIn} onOpen={(t) => openTags(t, l)} /> : <p className="mt-1 text-xs text-[var(--wms-muted)]">None yet.</p>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>

            {/* 2. Exchange */}
            {d.exchanges.length ? (
              <section className="rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--wms-border)] px-4 py-2">
                  <h3 className="text-sm font-semibold text-[var(--wms-fg)]">2 · Exchange — sending out</h3>
                  <button type="button" className="wms-btn-primary inline-flex items-center gap-1.5 max-md:min-h-11" onClick={() => setScan("out")}>
                    <Truck className="h-4 w-4" /> Scan out
                  </button>
                </div>
                <ul>
                  {d.exchanges.map((x) => (
                    <li key={x.id} className="border-b border-[var(--wms-border)]/60 px-4 py-3 last:border-0">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <ItemHead image={x.image} title={x.title} w={x} variant={x.variant} />
                        </div>
                        <div className="shrink-0 text-right text-sm font-semibold text-[var(--wms-fg)]">
                          {Math.min(x.scannedOut.length, x.quantity)} / {x.quantity} scanned out
                          {x.processed ? <div className="text-xs font-normal text-[var(--wms-muted)]">released in Shopify</div> : null}
                        </div>
                      </div>
                      <div className="mt-2 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/50 px-3 py-2">
                        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--wms-muted)]">Tags scanned out</div>
                        {x.scannedOut.length ? <TagRow tags={x.scannedOut} onOpen={(t) => openTags(t, x)} /> : <p className="mt-1 text-xs text-[var(--wms-muted)]">None yet.</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {/* 3. Complete */}
            <section className="rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--wms-fg)]">{d.exchanges.length ? "3" : "2"} · Complete in Shopify</h3>
                  <p className="text-xs text-[var(--wms-muted)]">
                    Restocks the {freshIn} scanned-in piece{freshIn === 1 ? "" : "s"}
                    {toRelease ? ` and releases ${toRelease} exchange item${toRelease === 1 ? "" : "s"} for shipping` : ""}. Nothing to do in Shopify.
                  </p>
                </div>
                <button
                  type="button"
                  className="wms-btn-primary inline-flex items-center gap-1.5 max-md:min-h-11"
                  disabled={completing || (!freshIn && !toRelease)}
                  onClick={() => void complete()}
                >
                  {completing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />} Complete in Shopify
                </button>
              </div>
              {err ? <p className="mt-2 text-sm text-[var(--wms-status-danger-fg)]">{err}</p> : null}
              {msg ? <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-300">{msg}</p> : null}
            </section>
          </div>
        ) : null}
      </aside>

      {tagsFor ? (
        <div onClick={(e) => e.stopPropagation()}>
          <RfidTagsModal modalSku={tagsFor} onClose={() => setTagsFor(null)} onMutated={refresh} showAllInitially />
        </div>
      ) : null}

      {scan && d ? (
        <div
          className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/60 p-4 max-md:p-0"
          onClick={(e) => {
            e.stopPropagation();
            setScan(null);
          }}
        >
          <div
            role="dialog"
            aria-label={scan === "in" ? "Scan-in" : "Scan-out"}
            className="w-full max-w-6xl rounded-xl border border-[var(--wms-border)] bg-[var(--wms-bg)] p-4 shadow-2xl max-md:min-h-full max-md:rounded-none"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-[var(--wms-fg)]">
                  {scan === "in" ? `Scan-in · ${d.name}` : `Scan-out · ${d.orderName} exchange`}
                </h2>
                <p className="text-xs text-[var(--wms-muted)]">
                  {scan === "in"
                    ? "Hold each returned piece at the antenna. Only this return's items can be checked; scanning in makes them LIVE."
                    : "Hold each exchange piece at the antenna. Items on this exchange are marked; scanning out makes them SOLD."}
                </p>
              </div>
              <button type="button" aria-label="Close" className="wms-btn inline-flex items-center max-md:min-h-11" onClick={() => setScan(null)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            {scan === "in" ? (
              <ShipScanOutWorkspace
                scanIn={{ returnId: d.id, returnName: d.name, customSkuIds: d.lines.map((l) => l.customSkuId).filter((x): x is string => !!x) }}
                onScannedOut={refresh}
              />
            ) : (
              <ShipScanOutWorkspace
                order={{ id: d.orderId, name: d.orderName, skus: d.exchanges.map((x) => x.sku ?? "").filter(Boolean) }}
                onScannedOut={refresh}
              />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
