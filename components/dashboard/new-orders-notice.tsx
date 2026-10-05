"use client";

/**
 * Home-screen notice: Shopify orders waiting to be fulfilled. Shown only when
 * there are some — at zero, and for anyone who may not see sales, it renders
 * nothing at all. Same count as the menu badge (lib/use-shopify-to-fulfill.ts).
 */
import Link from "next/link";
import { ChevronRight, ShoppingBag } from "lucide-react";
import { useShopifyToFulfill } from "@/lib/use-shopify-to-fulfill";

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
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function NewOrdersNotice() {
  const data = useShopifyToFulfill();
  if (!data || data.count <= 0) return null;
  const more = data.count - data.orders.length;
  return (
    <section
      aria-label="Shopify orders to fulfill"
      className="rounded-xl border border-[var(--wms-accent)]/50 bg-[color-mix(in_srgb,var(--wms-accent)_8%,var(--wms-surface))]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--wms-accent)]/25 px-4 py-3">
        <div className="flex items-center gap-2">
          <ShoppingBag className="h-5 w-5 text-[var(--wms-accent)]" />
          <h2 className="text-base font-semibold text-[var(--wms-fg)]">
            {data.count === 1 ? "1 new order to fulfill" : `${data.count} new orders to fulfill`}
          </h2>
        </div>
        <Link href="/shopify/sales" className="inline-flex items-center gap-1 text-sm font-medium text-[var(--wms-accent)] hover:underline max-md:min-h-11">
          View in Orders <ChevronRight className="h-4 w-4" />
        </Link>
      </div>
      <ul>
        {data.orders.map((o) => (
          <li key={o.legacyId} className="border-b border-[var(--wms-border)]/50 last:border-0">
            <Link
              href={`/shopify/sales?order=${o.legacyId}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 hover:bg-[var(--wms-surface-elevated)]/60 max-md:min-h-11"
            >
              <span className="font-semibold text-[var(--wms-fg)]">{o.name}</span>
              <span className="min-w-0 flex-1 text-sm text-[var(--wms-fg)]/85">{o.customer ?? "No customer"}</span>
              <span className="text-sm text-[var(--wms-muted)]">
                {o.items} {o.items === 1 ? "item" : "items"}
              </span>
              <span className="text-sm tabular-nums text-[var(--wms-fg)]">{money(o.total)}</span>
              <span className="w-24 text-right text-xs text-[var(--wms-muted)]">{ago(o.createdAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {more > 0 ? (
        <p className="px-4 py-2 text-xs text-[var(--wms-muted)]">
          and {more} more — <Link href="/shopify/sales" className="text-[var(--wms-accent)] hover:underline">see them all</Link>
        </p>
      ) : null}
    </section>
  );
}
