"use client";

/**
 * Shopify → Sales. The store's Orders page, inside the WMS: the same tabs, the
 * same columns, the same status badges, read live from Shopify (see
 * lib/server/shopify-sales.ts) and refreshed every minute. Read-only — every
 * change is made in Shopify, and "Open in Shopify" is one click away.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, RefreshCw, Search, X } from "lucide-react";
import { useUrlParam } from "@/lib/use-url-param";

type Money = { amount: string; currencyCode: string };
type Row = {
  id: string;
  legacyId: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  closed: boolean;
  test: boolean;
  customer: string | null;
  channel: string | null;
  total: Money | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  returnStatus: string | null;
  items: number;
  deliveryStatus: string | null;
  deliveryMethod: string | null;
  tags: string[];
};
type Page = {
  rows: Row[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  count: number | null;
  countIsExact: boolean;
  adminBase: string;
};
type Today = { orders: number; items: number; returns: number; fulfilled: number; delivered: number };
type Detail = Row & {
  email: string | null;
  phone: string | null;
  note: string | null;
  customerOrders: string | null;
  shippingAddress: string[];
  billingAddress: string[];
  subtotal: Money | null;
  shipping: Money | null;
  tax: Money | null;
  discounts: Money | null;
  refunded: Money | null;
  lines: Array<{ title: string; variant: string | null; sku: string | null; quantity: number; unit: Money | null; total: Money | null; image: string | null }>;
  tracking: Array<{ company: string | null; number: string | null; url: string | null; status: string | null }>;
  adminUrl: string;
};

const TABS = [
  { id: "all", label: "All" },
  { id: "unfulfilled", label: "Unfulfilled" },
  { id: "unpaid", label: "Unpaid" },
  { id: "open", label: "Open" },
  { id: "archived", label: "Archived" },
] as const;

const REFRESH_MS = 60_000;

/* ─────────────────────────────── formatting ─────────────────────────────── */

function money(m: Money | null): string {
  if (!m) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: m.currencyCode }).format(Number(m.amount));
  } catch {
    return `${m.amount} ${m.currencyCode}`;
  }
}

/** Shopify's own date style: "Today at 7:41 pm", "Thursday at 3:02 pm", "Sep 30 at 4:38 pm". */
function shopifyDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return `Today at ${time}`;
  if (diff === 1) return `Yesterday at ${time}`;
  if (diff > 1 && diff < 7) return `${d.toLocaleDateString("en-US", { weekday: "long" })} at ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })} at ${time}`;
}

const title = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

type Tone = "neutral" | "attention" | "warning" | "critical" | "info" | "success";

const PAYMENT: Record<string, [string, Tone]> = {
  PAID: ["Paid", "neutral"],
  PENDING: ["Payment pending", "warning"],
  AUTHORIZED: ["Authorized", "attention"],
  PARTIALLY_PAID: ["Partially paid", "attention"],
  PARTIALLY_REFUNDED: ["Partially refunded", "neutral"],
  REFUNDED: ["Refunded", "neutral"],
  VOIDED: ["Voided", "neutral"],
  EXPIRED: ["Expired", "critical"],
};
const FULFILLMENT: Record<string, [string, Tone]> = {
  UNFULFILLED: ["Unfulfilled", "attention"],
  FULFILLED: ["Fulfilled", "neutral"],
  PARTIALLY_FULFILLED: ["Partially fulfilled", "attention"],
  IN_PROGRESS: ["In progress", "info"],
  ON_HOLD: ["On hold", "warning"],
  SCHEDULED: ["Scheduled", "info"],
  OPEN: ["Open", "attention"],
  PENDING_FULFILLMENT: ["Pending", "attention"],
  RESTOCKED: ["Restocked", "neutral"],
  REQUEST_DECLINED: ["Request declined", "critical"],
};
const DELIVERY_TONE: Record<string, Tone> = {
  DELIVERED: "success",
  IN_TRANSIT: "info",
  OUT_FOR_DELIVERY: "info",
  ATTEMPTED_DELIVERY: "warning",
  READY_FOR_PICKUP: "info",
  FAILURE: "critical",
  NOT_DELIVERED: "critical",
};

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)]/80",
  attention: "bg-yellow-400/20 text-yellow-700 dark:text-yellow-300",
  warning: "bg-orange-400/20 text-orange-700 dark:text-orange-300",
  critical: "bg-red-500/15 text-red-700 dark:text-red-300",
  info: "bg-sky-400/15 text-sky-700 dark:text-sky-300",
  success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};

/** Shopify's badge: a pill with a progress dot — full, half or empty. */
function Badge({ label, tone, fill }: { label: string; tone: Tone; fill?: "full" | "half" | "empty" }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}>
      {fill ? (
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full border border-current"
          style={{
            background:
              fill === "full" ? "currentColor" : fill === "half" ? "linear-gradient(90deg, currentColor 50%, transparent 50%)" : "transparent",
          }}
        />
      ) : null}
      {label}
    </span>
  );
}

function PaymentBadge({ s }: { s: string | null }) {
  if (!s) return null;
  const [label, tone] = PAYMENT[s] ?? [title(s), "neutral" as Tone];
  const fill = s === "PAID" || s === "REFUNDED" ? "full" : s.startsWith("PARTIALLY") ? "half" : "empty";
  return <Badge label={label} tone={tone} fill={fill} />;
}
function FulfillmentBadge({ s }: { s: string | null }) {
  if (!s) return null;
  const [label, tone] = FULFILLMENT[s] ?? [title(s), "neutral" as Tone];
  const fill = s === "FULFILLED" ? "full" : s.startsWith("PARTIALLY") || s === "IN_PROGRESS" ? "half" : "empty";
  return <Badge label={label} tone={tone} fill={fill} />;
}
function DeliveryBadge({ s }: { s: string | null }) {
  if (!s) return null;
  return <Badge label={title(s)} tone={DELIVERY_TONE[s] ?? "neutral"} />;
}

/* ─────────────────────────────── the page ─────────────────────────────── */

export function SalesWorkspace() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  /** The cursor this page was loaded from; null = first page. */
  const [cursor, setCursor] = useState<{ after?: string; before?: string } | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [today, setToday] = useState<Today | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [openId, setOpenId] = useUrlParam("order");
  const reqRef = useRef(0);

  const load = useCallback(async (quiet = false) => {
    const id = ++reqRef.current;
    if (!quiet) setLoading(true);
    const sp = new URLSearchParams({ tab });
    if (query) sp.set("q", query);
    if (cursor?.after) sp.set("after", cursor.after);
    if (cursor?.before) sp.set("before", cursor.before);
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const [r, t] = await Promise.all([
        fetch(`/api/shopify/sales?${sp}`, { cache: "no-store" }),
        fetch(`/api/shopify/sales?today=1&tz=${encodeURIComponent(tz)}`, { cache: "no-store" }),
      ]);
      const j = await r.json().catch(() => ({}));
      const tj = await t.json().catch(() => null);
      if (id !== reqRef.current) return;
      if (!r.ok) throw new Error(j?.error || `Shopify did not answer (${r.status})`);
      setPage(j as Page);
      if (t.ok && tj) setToday(tj as Today);
      setError(null);
      setUpdatedAt(new Date());
    } catch (e) {
      if (id === reqRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  }, [tab, query, cursor]);

  useEffect(() => {
    void load();
  }, [load]);

  // Kept in sync with Shopify: the page reloads itself every minute while it is open.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const changeTab = (t: typeof tab) => {
    setTab(t);
    setCursor(null);
    setPageIndex(0);
  };
  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setQuery(search.trim());
    setCursor(null);
    setPageIndex(0);
  };

  const first = pageIndex * 50 + 1;
  const last = pageIndex * 50 + (page?.rows.length ?? 0);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--wms-fg)]">Sales</h1>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-[var(--wms-muted)]">
            {updatedAt ? `Synced with Shopify ${updatedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : "Syncing…"}
          </span>
          <button type="button" className="wms-btn inline-flex items-center gap-1.5 max-md:min-h-11" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
          {page ? (
            <a className="wms-btn inline-flex items-center gap-1.5 max-md:min-h-11" href={`${page.adminBase}/orders`} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" /> Open in Shopify
            </a>
          ) : null}
        </div>
      </div>

      {/* Shopify's "Today" bar. */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-border)] sm:grid-cols-6">
        <div className="flex items-center bg-[var(--wms-surface)] px-4 py-3 text-sm font-semibold text-[var(--wms-fg)]">Today</div>
        {(
          [
            ["Orders", today?.orders],
            ["Items ordered", today?.items],
            ["Returns", today?.returns],
            ["Orders fulfilled", today?.fulfilled],
            ["Orders delivered", today?.delivered],
          ] as const
        ).map(([label, v]) => (
          <div key={label} className="bg-[var(--wms-surface)] px-4 py-3">
            <div className="text-xs text-[var(--wms-muted)]">{label}</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums text-[var(--wms-fg)]">{v ?? "—"}</div>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--wms-border)] px-2 py-2">
          <div className="flex flex-wrap gap-1" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => changeTab(t.id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium max-md:min-h-11 ${
                  tab === t.id
                    ? "bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)] ring-1 ring-[var(--wms-border)]"
                    : "text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <form onSubmit={submitSearch} className="flex min-w-0 items-center gap-1">
            <div className="relative min-w-0">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--wms-muted)]" />
              <input
                id="shopify-sales-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search all orders"
                className="w-56 max-w-full rounded-lg border border-[var(--wms-border)] bg-[var(--wms-bg)] py-1.5 pl-8 pr-7 text-sm text-[var(--wms-fg)] max-md:min-h-11"
              />
              {search ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--wms-muted)]"
                  onClick={() => {
                    setSearch("");
                    setQuery("");
                    setCursor(null);
                    setPageIndex(0);
                  }}
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          </form>
        </div>

        {error ? (
          <p className="px-4 py-6 text-sm text-[var(--wms-status-danger-fg)]">{error}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/50 text-xs font-medium text-[var(--wms-muted)]">
                  <th className="px-3 py-2">Order</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">Channel</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2">Payment status</th>
                  <th className="px-3 py-2">Fulfillment status</th>
                  <th className="px-3 py-2">Items</th>
                  <th className="px-3 py-2">Delivery status</th>
                  <th className="px-3 py-2">Delivery method</th>
                  <th className="px-3 py-2">Tags</th>
                </tr>
              </thead>
              <tbody>
                {page?.rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => setOpenId(r.legacyId)}
                    className="cursor-pointer border-b border-[var(--wms-border)]/60 hover:bg-[var(--wms-surface-elevated)]/60"
                  >
                    <td className="px-3 py-2.5 font-semibold text-[var(--wms-fg)]">
                      <span className={r.cancelledAt ? "line-through opacity-70" : ""}>{r.name}</span>
                      {r.test ? <span className="ml-1.5 text-xs font-normal text-[var(--wms-muted)]">test</span> : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[var(--wms-fg)]/85">{shopifyDate(r.createdAt)}</td>
                    <td className="px-3 py-2.5 text-[var(--wms-fg)]">{r.customer ?? <span className="text-[var(--wms-muted)]">No customer</span>}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[var(--wms-fg)]/85">{r.channel ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-[var(--wms-fg)]">
                      <span className={r.cancelledAt ? "line-through opacity-70" : ""}>{money(r.total)}</span>
                    </td>
                    <td className="px-3 py-2.5"><PaymentBadge s={r.financialStatus} /></td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        <FulfillmentBadge s={r.fulfillmentStatus} />
                        {r.returnStatus && r.returnStatus !== "NO_RETURN" ? <Badge label={title(r.returnStatus)} tone="warning" /> : null}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[var(--wms-fg)]/85">
                      {r.items} {r.items === 1 ? "item" : "items"}
                    </td>
                    <td className="px-3 py-2.5"><DeliveryBadge s={r.deliveryStatus} /></td>
                    <td className="px-3 py-2.5 text-[var(--wms-fg)]/85">{r.deliveryMethod ?? ""}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {r.tags.map((t) => (
                          <span key={t} className="rounded-md bg-[var(--wms-surface-elevated)] px-1.5 py-0.5 text-xs text-[var(--wms-fg)]/80">{t}</span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
                {page && !page.rows.length ? (
                  <tr>
                    <td colSpan={11} className="px-4 py-10 text-center text-sm text-[var(--wms-muted)]">
                      {query ? "No orders match this search." : "No orders in this view."}
                    </td>
                  </tr>
                ) : null}
                {!page && loading ? (
                  <tr>
                    <td colSpan={11} className="px-4 py-10 text-center text-sm text-[var(--wms-muted)]">
                      <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading orders from Shopify…
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}

        {page && page.rows.length ? (
          <div className="flex items-center justify-between gap-2 border-t border-[var(--wms-border)] px-3 py-2">
            <span className="font-mono text-xs text-[var(--wms-muted)]">
              {first}–{last}
              {page.count !== null ? ` of ${page.count}${page.countIsExact ? "" : "+"}` : ""}
            </span>
            <div className="flex gap-1">
              <button
                type="button"
                aria-label="Previous page"
                className="wms-btn inline-flex items-center gap-1.5 max-md:min-h-11"
                disabled={!page.pageInfo.hasPreviousPage || loading}
                onClick={() => {
                  setCursor({ before: page.pageInfo.startCursor ?? undefined });
                  setPageIndex((i) => Math.max(0, i - 1));
                }}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Next page"
                className="wms-btn inline-flex items-center gap-1.5 max-md:min-h-11"
                disabled={!page.pageInfo.hasNextPage || loading}
                onClick={() => {
                  setCursor({ after: page.pageInfo.endCursor ?? undefined });
                  setPageIndex((i) => i + 1);
                }}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <p className="font-mono text-xs text-[var(--wms-muted)]">
        Read live from Shopify and refreshed every minute.
      </p>

      {openId ? <SaleDrawer key={openId} id={openId} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}

/* ─────────────────────────────── one order ─────────────────────────────── */

function SaleDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [sale, setSale] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Mounted fresh per order (key={id} below), so there is nothing to reset here.
    let alive = true;
    fetch(`/api/shopify/sales/${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok) setError(j?.error || `Could not load the order (${r.status})`);
        else setSale(j as Detail);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const lines = useMemo(() => sale?.lines.filter((l) => l.quantity > 0) ?? [], [sale]);
  /* Shopify's order page lists the subtotal BEFORE discounts and the discount
     on its own line, so subtotal − discount + shipping + taxes = total. The
     API's subtotal is already discounted; showing it beside the discount
     counted the discount twice. */
  const grossSubtotal = useMemo<Money | null>(() => {
    const priced = lines.filter((l) => l.unit);
    if (!priced.length) return sale?.subtotal ?? null;
    return {
      amount: String(priced.reduce((t, l) => t + Number(l.unit!.amount) * l.quantity, 0)),
      currencyCode: priced[0].unit!.currencyCode,
    };
  }, [lines, sale]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-xl flex-col overflow-y-auto bg-[var(--wms-bg)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
        aria-label="Order details"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-[var(--wms-border)] bg-[var(--wms-bg)] px-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-[var(--wms-fg)]">{sale?.name ?? "Order"}</h2>
              {sale ? (
                <>
                  <PaymentBadge s={sale.financialStatus} />
                  <FulfillmentBadge s={sale.fulfillmentStatus} />
                  {sale.cancelledAt ? <Badge label="Canceled" tone="critical" /> : null}
                  {sale.closed ? <Badge label="Archived" tone="neutral" /> : null}
                </>
              ) : null}
            </div>
            {sale ? (
              <p className="mt-0.5 text-xs text-[var(--wms-muted)]">
                {shopifyDate(sale.createdAt)} · {sale.channel ?? ""}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {sale ? (
              <a className="wms-btn inline-flex items-center gap-1.5 max-md:min-h-11" href={sale.adminUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" /> Shopify
              </a>
            ) : null}
            <button type="button" aria-label="Close" className="wms-btn inline-flex items-center gap-1.5 max-md:min-h-11" onClick={onClose}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {error ? <p className="p-4 text-sm text-[var(--wms-status-danger-fg)]">{error}</p> : null}
        {!sale && !error ? (
          <p className="p-4 text-sm text-[var(--wms-muted)]">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading from Shopify…
          </p>
        ) : null}

        {sale ? (
          <div className="flex flex-col gap-3 p-4">
            <section className="rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]">
              <div className="flex items-center justify-between border-b border-[var(--wms-border)] px-4 py-2">
                <FulfillmentBadge s={sale.fulfillmentStatus} />
                {sale.deliveryMethod ? <span className="text-xs text-[var(--wms-muted)]">{sale.deliveryMethod}</span> : null}
              </div>
              <ul>
                {lines.map((l, i) => (
                  <li key={i} className="flex items-center gap-3 border-b border-[var(--wms-border)]/60 px-4 py-2.5 last:border-0">
                    {l.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={l.image} alt="" className="h-12 w-12 shrink-0 rounded-md border border-[var(--wms-border)] object-cover" />
                    ) : (
                      <div className="h-12 w-12 shrink-0 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-[var(--wms-fg)]">{l.title}</div>
                      {l.variant ? <div className="text-xs text-[var(--wms-muted)]">{l.variant}</div> : null}
                      {l.sku ? <div className="font-mono text-xs text-[var(--wms-muted)]">SKU: {l.sku}</div> : null}
                    </div>
                    <div className="shrink-0 text-right text-sm tabular-nums text-[var(--wms-fg)]/85">
                      {money(l.unit)} × {l.quantity}
                    </div>
                    <div className="w-20 shrink-0 text-right text-sm tabular-nums text-[var(--wms-fg)]">
                      {money(l.unit ? { amount: String(Number(l.unit.amount) * l.quantity), currencyCode: l.unit.currencyCode } : null)}
                    </div>
                  </li>
                ))}
                {!lines.length ? <li className="px-4 py-3 text-sm text-[var(--wms-muted)]">No items left on this order.</li> : null}
              </ul>
              {sale.tracking.length ? (
                <div className="border-t border-[var(--wms-border)] px-4 py-2 text-xs text-[var(--wms-muted)]">
                  {sale.tracking.map((t, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <DeliveryBadge s={t.status} />
                      <span>{t.company}</span>
                      {t.url ? (
                        <a className="text-[var(--wms-accent)] underline-offset-2 hover:underline" href={t.url} target="_blank" rel="noreferrer">
                          {t.number}
                        </a>
                      ) : (
                        <span className="font-mono">{t.number}</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
            </section>

            <section className="rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] px-4 py-3">
              <div className="mb-2"><PaymentBadge s={sale.financialStatus} /></div>
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                <dt className="text-[var(--wms-fg)]/85">Subtotal · {sale.items} {sale.items === 1 ? "item" : "items"}</dt>
                <dd className="text-right tabular-nums">{money(grossSubtotal)}</dd>
                {sale.discounts && Number(sale.discounts.amount) > 0 ? (
                  <>
                    <dt className="text-[var(--wms-fg)]/85">Discount</dt>
                    <dd className="text-right tabular-nums">−{money(sale.discounts)}</dd>
                  </>
                ) : null}
                <dt className="text-[var(--wms-fg)]/85">Shipping</dt>
                <dd className="text-right tabular-nums">{money(sale.shipping)}</dd>
                <dt className="text-[var(--wms-fg)]/85">Taxes</dt>
                <dd className="text-right tabular-nums">{money(sale.tax)}</dd>
                <dt className="font-semibold text-[var(--wms-fg)]">Total</dt>
                <dd className="text-right font-semibold tabular-nums">{money(sale.total)}</dd>
                {sale.refunded && Number(sale.refunded.amount) > 0 ? (
                  <>
                    <dt className="text-[var(--wms-fg)]/85">Refunded</dt>
                    <dd className="text-right tabular-nums">−{money(sale.refunded)}</dd>
                  </>
                ) : null}
              </dl>
            </section>

            <section className="grid gap-3 rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] px-4 py-3 text-sm">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--wms-muted)]">Customer</h3>
                <p className="mt-1 text-[var(--wms-fg)]">{sale.customer ?? "No customer"}</p>
                {sale.customerOrders ? (
                  <p className="text-xs text-[var(--wms-muted)]">
                    {sale.customerOrders} {sale.customerOrders === "1" ? "order" : "orders"}
                  </p>
                ) : null}
              </div>
              {sale.email || sale.phone ? (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--wms-muted)]">Contact information</h3>
                  {sale.email ? <p className="mt-1 text-[var(--wms-fg)]">{sale.email}</p> : null}
                  {sale.phone ? <p className="text-[var(--wms-fg)]">{sale.phone}</p> : null}
                </div>
              ) : null}
              {sale.shippingAddress.length ? (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--wms-muted)]">Shipping address</h3>
                  {sale.shippingAddress.map((l, i) => <p key={i} className="text-[var(--wms-fg)]">{l}</p>)}
                </div>
              ) : null}
              {sale.billingAddress.length ? (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--wms-muted)]">Billing address</h3>
                  {sale.billingAddress.join("|") === sale.shippingAddress.join("|") ? (
                    <p className="text-[var(--wms-muted)]">Same as shipping address</p>
                  ) : (
                    sale.billingAddress.map((l, i) => <p key={i} className="text-[var(--wms-fg)]">{l}</p>)
                  )}
                </div>
              ) : null}
              {sale.note ? (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--wms-muted)]">Notes</h3>
                  <p className="whitespace-pre-wrap text-[var(--wms-fg)]">{sale.note}</p>
                </div>
              ) : null}
              {sale.tags.length ? (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--wms-muted)]">Tags</h3>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {sale.tags.map((t) => (
                      <span key={t} className="rounded-md bg-[var(--wms-surface-elevated)] px-1.5 py-0.5 text-xs">{t}</span>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
