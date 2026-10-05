"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export type PurchaseLineItem = {
  title: string | null;
  variant_title: string | null;
  sku: string | null;
  quantity: number | null;
  price: string | null;
};

export type PurchaseHistoryRow = {
  channel: "store" | "online";
  ref: string;
  number: string | null;
  placed_at: string | null;
  total: string | null;
  status: string;
  location_name: string | null;
  item_count: number | null;
  /** pos_locations.store_code — store rows only, for the POS sale link. */
  store_code: string | null;
  /** shopify_orders.line_items — online rows only. */
  line_items: PurchaseLineItem[] | null;
};

const DASH = "—";
const POS_BASE = "https://pos.shopcarbon.com";
// Admin handle, not the myshopify id ("30e7d3") — see adminBaseFor in
// lib/server/shopify-sales.ts.
const SHOPIFY_ADMIN = "https://admin.shopify.com/store/shopcarbon1";

const CHANNEL_LABELS: Record<PurchaseHistoryRow["channel"], { label: string; tone: string }> = {
  store:  { label: "In-store", tone: "bg-blue-100 text-blue-800" },
  online: { label: "Online",   tone: "bg-emerald-100 text-emerald-800" },
};

const STATUS_LABELS: Record<string, { label: string; tone: string }> = {
  completed:          { label: "Completed",          tone: "text-emerald-600" },
  refunded:           { label: "Refunded",           tone: "text-rose-700" },
  partially_refunded: { label: "Partially refunded", tone: "text-amber-700" },
  cancelled:          { label: "Cancelled",          tone: "text-muted-foreground line-through" },
};

const usd = (v: string | number | null) => {
  const n = Number(v);
  return v !== null && Number.isFinite(n)
    ? n.toLocaleString(undefined, { style: "currency", currency: "USD" })
    : DASH;
};

// Same link Carbon-POS uses (and the catalog item popup): /sales/{storeCode3}/{saleId}.
function saleHref(r: PurchaseHistoryRow): string | null {
  if (r.channel === "online") {
    const id = r.ref.split("/").pop();
    return id ? `${SHOPIFY_ADMIN}/orders/${id}` : null;
  }
  if (!r.store_code) return null;
  return `${POS_BASE}/sales/${r.store_code.padStart(3, "0")}/${r.ref}`;
}

/**
 * Customer detail → Purchase history. In-store (pos_sales) and online
 * (shopify_orders) purchases from the shared `customer_purchases` view.
 * Online rows expand to show their Shopify line items.
 */
export function PurchaseHistoryTable({ rows }: { rows: PurchaseHistoryRow[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (ref: string) => setOpen((o) => ({ ...o, [ref]: !o[ref] }));

  return (
    <table className="w-full text-sm">
      <thead className="bg-muted text-xs uppercase tracking-wider font-bold max-md:sticky max-md:top-0 max-md:z-10">
        <tr>
          <th className="text-left px-3 py-2">Channel</th>
          <th className="text-left px-3 py-2">Number</th>
          <th className="text-left px-3 py-2">When</th>
          <th className="text-left px-3 py-2 max-md:hidden">Store</th>
          <th className="text-right px-3 py-2">Items</th>
          <th className="text-right px-3 py-2">Total</th>
          <th className="text-left px-3 py-2">Status</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.length === 0 ? (
          <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">No purchases yet.</td></tr>
        ) : (
          rows.map((r) => {
            const ch = CHANNEL_LABELS[r.channel];
            const st = STATUS_LABELS[r.status] ?? { label: r.status, tone: "" };
            const href = saleHref(r);
            const items = r.line_items ?? [];
            const expandable = r.channel === "online" && items.length > 0;
            const isOpen = !!open[r.ref];
            return (
              <Fragment key={`${r.channel}:${r.ref}`}>
                <tr>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`inline-block px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${ch.tone}`}>
                      {ch.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      {expandable ? (
                        <button
                          type="button"
                          onClick={() => toggle(r.ref)}
                          aria-expanded={isOpen}
                          aria-label={isOpen ? "Hide items" : "Show items"}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </button>
                      ) : null}
                      {href ? (
                        <a className="underline font-semibold" href={href} target="_blank" rel="noreferrer">
                          {r.number ?? r.ref} ↗
                        </a>
                      ) : (
                        <span className="font-semibold">{r.number ?? r.ref}</span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.placed_at ? new Date(r.placed_at).toLocaleString() : DASH}
                  </td>
                  <td className="px-3 py-2 max-md:hidden">{r.location_name ?? DASH}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.item_count ?? DASH}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-bold">{usd(r.total)}</td>
                  <td className={`px-3 py-2 whitespace-nowrap ${st.tone}`}>{st.label}</td>
                </tr>
                {expandable && isOpen ? (
                  <tr className="bg-muted/40">
                    <td colSpan={7} className="px-3 py-2">
                      <ul className="space-y-1 pl-6 text-xs">
                        {items.map((li, i) => (
                          <li key={`${li.sku ?? ""}-${i}`} className="flex items-baseline justify-between gap-3">
                            <span className="min-w-0">
                              <span className="font-semibold">{li.title ?? DASH}</span>
                              {li.variant_title ? <span className="text-muted-foreground"> · {li.variant_title}</span> : null}
                              {li.sku ? <span className="font-mono text-muted-foreground"> · {li.sku}</span> : null}
                            </span>
                            <span className="whitespace-nowrap tabular-nums">
                              {li.quantity ?? 0} × {usd(li.price)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })
        )}
      </tbody>
    </table>
  );
}
