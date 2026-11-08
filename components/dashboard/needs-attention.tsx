"use client";

/**
 * Home-screen "Needs attention" box (owner 2026-11-08), under the Shopify
 * orders to fulfil: wholesale applications to review, wholesale orders to pack
 * and invoice, unpaid shipping invoices (red after 24 h) and returns waiting.
 * Shows only what has items; hidden when everything is handled, and for anyone
 * who may not see sales (401/403). Re-read every minute and when the tab comes back.
 */
import Link from "next/link";
import useSWR from "swr";
import { AlertTriangle, ChevronRight, ClipboardList } from "lucide-react";
import type { Attention, AttentionOrder } from "@/lib/server/attention";

const fetcher = async (u: string): Promise<Attention | null> => {
  const r = await fetch(u, { cache: "no-store" });
  if (r.status === 401 || r.status === 403) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as Attention;
};

function money(m: { amount: string; currencyCode: string } | null) {
  if (!m) return "";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: m.currencyCode }).format(Number(m.amount));
  } catch {
    return `${m.amount} ${m.currencyCode}`;
  }
}

function ago(iso: string) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return mins < 1 ? "just now" : `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

const shopifyOrder = (id: string) => `https://admin.shopify.com/store/shopcarbon1/orders/${id}`;

function Group({
  title,
  hint,
  href,
  hrefLabel,
  external,
  children,
}: {
  title: string;
  hint: string;
  href: string;
  hrefLabel: string;
  external?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-b border-[var(--wms-border)]/60 last:border-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3">
        <h3 className="text-sm font-semibold text-[var(--wms-fg)]">{title}</h3>
        {external ? (
          <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-[var(--wms-accent)] hover:underline max-md:min-h-11">
            {hrefLabel} <ChevronRight className="h-4 w-4" />
          </a>
        ) : (
          <Link href={href} className="inline-flex items-center gap-1 text-sm font-medium text-[var(--wms-accent)] hover:underline max-md:min-h-11">
            {hrefLabel} <ChevronRight className="h-4 w-4" />
          </Link>
        )}
      </div>
      <p className="px-4 pb-2 text-xs text-[var(--wms-muted)]">{hint}</p>
      {children ? <ul className="pb-2">{children}</ul> : null}
    </div>
  );
}

function OrderRow({ o, due }: { o: AttentionOrder; due?: boolean }) {
  return (
    <li>
      <a
        href={shopifyOrder(o.legacyId)}
        target="_blank"
        rel="noreferrer"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 hover:bg-[var(--wms-surface-elevated)]/60 max-md:min-h-11"
      >
        <span className="font-semibold text-[var(--wms-fg)]">{o.name}</span>
        <span className="min-w-0 flex-1 text-sm text-[var(--wms-fg)]/85">{o.company ?? "Wholesale"}</span>
        {due ? (
          <span className={`text-sm tabular-nums ${o.overdue ? "font-semibold text-[var(--wms-status-danger-fg)]" : "text-[var(--wms-fg)]"}`}>
            {money(o.outstanding)} due
          </span>
        ) : (
          <span className="text-sm tabular-nums text-[var(--wms-fg)]">{money(o.total)}</span>
        )}
        <span className={`w-32 text-right text-xs ${due && o.overdue ? "font-semibold text-[var(--wms-status-danger-fg)]" : "text-[var(--wms-muted)]"}`}>
          {due ? (o.overdue ? `overdue · ${ago(o.updatedAt)}` : `sent ${ago(o.updatedAt)}`) : ago(o.createdAt)}
        </span>
      </a>
    </li>
  );
}

export function NeedsAttention() {
  const { data } = useSWR<Attention | null>("/api/dashboard/attention", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
  });
  if (!data || data.total <= 0) return null;
  const a = data;
  const overdue = a.unpaidInvoices?.overdue ?? 0;

  return (
    <section
      aria-label="Needs attention"
      className={`rounded-xl border ${overdue > 0 ? "border-[var(--wms-status-danger-fg)]/60" : "border-[var(--wms-border)]"} bg-[var(--wms-surface)]`}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--wms-border)]/60 px-4 py-3">
        {overdue > 0 ? (
          <AlertTriangle className="h-5 w-5 text-[var(--wms-status-danger-fg)]" />
        ) : (
          <ClipboardList className="h-5 w-5 text-[var(--wms-accent)]" />
        )}
        <h2 className="text-base font-semibold text-[var(--wms-fg)]">
          Needs attention <span className="tabular-nums text-[var(--wms-muted)]">· {a.total}</span>
        </h2>
        {a.errors.length ? <span className="text-xs text-[var(--wms-muted)]">(could not read: {a.errors.join(", ")})</span> : null}
      </div>

      {a.applications && a.applications.count > 0 ? (
        <Group
          title={`${a.applications.count} wholesale application${a.applications.count === 1 ? "" : "s"} to review`}
          hint="Check the business, EIN, resale certificate and social accounts, then approve or decline."
          href="/shopify/wholesale"
          hrefLabel="Review"
        >
          {a.applications.items.map((x) => (
            <li key={x.id}>
              <Link
                href={`/shopify/wholesale?application=${x.id}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 hover:bg-[var(--wms-surface-elevated)]/60 max-md:min-h-11"
              >
                <span className="font-semibold text-[var(--wms-fg)]">{x.businessName}</span>
                <span className="min-w-0 flex-1 text-sm text-[var(--wms-fg)]/85">{x.cityState}</span>
                <span className="w-32 text-right text-xs text-[var(--wms-muted)]">{ago(x.createdAt)}</span>
              </Link>
            </li>
          ))}
        </Group>
      ) : null}

      {a.toInvoice && a.toInvoice.count > 0 ? (
        <Group
          title={`${a.toInvoice.count} wholesale order${a.toInvoice.count === 1 ? "" : "s"} to pack and invoice shipping`}
          hint="After packing: open the order in Shopify → Edit → Edit shipping fees → Add shipping fee → keep “Send invoice to customer” ticked → Update order."
          href="https://admin.shopify.com/store/shopcarbon1/orders?query=status%3Aopen"
          hrefLabel="Shopify orders"
          external
        >
          {a.toInvoice.items.map((o) => (
            <OrderRow key={o.legacyId} o={o} />
          ))}
        </Group>
      ) : null}

      {a.unpaidInvoices && a.unpaidInvoices.count > 0 ? (
        <Group
          title={`${a.unpaidInvoices.count} shipping invoice${a.unpaidInvoices.count === 1 ? "" : "s"} unpaid${overdue ? ` — ${overdue} overdue` : ""}`}
          hint="Unpaid after 24 hours: cancel the order in Shopify and release the items (we don't hold stock)."
          href="https://admin.shopify.com/store/shopcarbon1/orders?query=financial_status%3Apartially_paid"
          hrefLabel="Shopify orders"
          external
        >
          {a.unpaidInvoices.items.map((o) => (
            <OrderRow key={o.legacyId} o={o} due />
          ))}
        </Group>
      ) : null}

      {a.returns && a.returns.count > 0 ? (
        <Group
          title={`${a.returns.count} return${a.returns.count === 1 ? "" : "s"} waiting`}
          hint="Returns requested or in progress."
          href="/shopify/returns"
          hrefLabel="Returns"
        />
      ) : null}
    </section>
  );
}
