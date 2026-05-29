"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { DateRangePicker, type DateRange } from "@/components/shared/date-range-picker";

/**
 * Item popup report tabs — Sales, Customers (Customer Items), and History
 * (Inventory Movement Logs). All three query the item's POS sales (+ movement
 * sources) via the custom-sku sales/movements endpoints, with a shared
 * date-range picker. Sale ids link into Carbon-POS at
 * https://pos.shopcarbon.com/sales/{storeCode3}/{saleId}.
 */

const POS_BASE = "https://pos.shopcarbon.com";
const DEFAULT_RANGE: DateRange = { from: "1900-01-01", to: "2038-01-01" };

function posSaleUrl(storeCode: string | null, saleId: number | string): string {
  const code = (storeCode ?? "").padStart(3, "0");
  return `${POS_BASE}/sales/${code}/${saleId}`;
}
function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(n);
}
function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}
function fmtDate(s: string): string {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString();
}
function fmtDateTime(s: string): string {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

type SaleRow = {
  sale_id: number;
  sale_number: string | null;
  store_code: string | null;
  date: string;
  status: string | null;
  sale_subtotal: number;
  sale_discount: number;
  sale_tax: number;
  sale_total: number;
  customer_id: number | null;
  customer_name: string | null;
  qty: number;
  unit_price: number;
  revenue: number;
  item_discount: number;
  item_tax: number;
  cost: number;
  profit: number;
  margin: number | null;
};
type SalesResp = { rows: SaleRow[]; unit_cost: number; locations: { id: string; code: string; name: string }[] };

/* -------------------------------------------------------------------------- */
/* Search bar shared by Sales + Customers                                     */
/* -------------------------------------------------------------------------- */

function SearchBar({
  range,
  setRange,
  query,
  setQuery,
  queryPlaceholder,
  locations,
  locationId,
  setLocationId,
  onSearch,
}: {
  range: DateRange;
  setRange: (r: DateRange) => void;
  query: string;
  setQuery: (s: string) => void;
  queryPlaceholder: string;
  locations?: { id: string; code: string; name: string }[];
  locationId?: string;
  setLocationId?: (s: string) => void;
  onSearch: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/50 p-2">
      <DateRangePicker value={range} onChange={setRange} />
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSearch()}
        placeholder={queryPlaceholder}
        className="min-w-[8rem] flex-1 rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-xs text-[var(--wms-fg)]"
      />
      {locations && setLocationId ? (
        <select
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-xs text-[var(--wms-fg)]"
          title="Location filter"
        >
          <option value="">All locations</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.code} · {l.name}
            </option>
          ))}
        </select>
      ) : null}
      <button
        type="button"
        onClick={onSearch}
        className="rounded-md border border-[var(--wms-accent)]/55 bg-[var(--wms-accent)]/15 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-accent)]/25"
      >
        Search
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sales tab                                                                  */
/* -------------------------------------------------------------------------- */

export function ItemSalesTab({ customSkuId }: { customSkuId: string }) {
  const [range, setRange] = useState<DateRange>(DEFAULT_RANGE);
  const [saleId, setSaleId] = useState("");
  const [locationId, setLocationId] = useState("");
  // Applied filters (only change on Search) so typing doesn't refetch.
  const [applied, setApplied] = useState({ ...DEFAULT_RANGE, saleId: "", locationId: "" });

  const key = `/api/inventory/catalog/custom-skus/${customSkuId}/sales?from=${applied.from}&to=${applied.to}&saleId=${encodeURIComponent(
    applied.saleId,
  )}&locationId=${applied.locationId}`;
  const { data, error, isLoading } = useSWR<SalesResp>(key, fetcher, { revalidateOnFocus: false });
  const rows = data?.rows ?? [];

  return (
    <div className="space-y-3">
      <SearchBar
        range={range}
        setRange={setRange}
        query={saleId}
        setQuery={setSaleId}
        queryPlaceholder="Sale ID / number"
        locations={data?.locations ?? []}
        locationId={locationId}
        setLocationId={setLocationId}
        onSearch={() => setApplied({ from: range.from, to: range.to, saleId, locationId })}
      />

      {error ? <p className="font-mono text-xs text-red-400/90">{(error as Error).message}</p> : null}
      <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">{rows.length} result(s)</p>

      <div className="overflow-x-auto rounded-lg border border-[var(--wms-border)]">
        <table className="w-full min-w-[860px] border-collapse font-mono text-xs">
          <thead className="bg-[var(--wms-surface-elevated)]/80 text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
            <tr>
              <th className="px-3 py-2 text-left">ID</th>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Retail</th>
              <th className="px-3 py-2 text-right">Subtotal</th>
              <th className="px-3 py-2 text-right">Discount</th>
              <th className="px-3 py-2 text-right">Tax</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2 text-left">Customer</th>
              <th className="px-3 py-2 text-left">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/50">
            {isLoading ? (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-[var(--wms-muted)]">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-[var(--wms-muted)]">No sales in range.</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.sale_id} className="align-top text-[var(--wms-fg)]">
                  <td className="px-3 py-2">
                    <a
                      href={posSaleUrl(r.store_code, r.sale_id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-[var(--wms-accent)] hover:underline"
                    >
                      {r.sale_number ?? r.sale_id}
                    </a>
                    <div className="text-[0.6rem] text-[var(--wms-muted)]">
                      cost {money(r.cost)} · profit {money(r.profit)} · margin {pct(r.margin)}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-[var(--wms-muted)]">{fmtDate(r.date)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.qty}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(r.unit_price)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(r.sale_subtotal)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(r.sale_discount)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(r.sale_tax)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(r.sale_total)}</td>
                  <td className="px-3 py-2 text-[var(--wms-muted)]">{r.customer_name ?? "—"}</td>
                  <td className="px-3 py-2 text-[var(--wms-muted)]">Carbon POS</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Customers tab (Customer Items)                                             */
/* -------------------------------------------------------------------------- */

type CustomerAgg = {
  customer_id: number | null;
  customer_name: string;
  qty: number;
  subtotal: number;
  discounts: number;
  total: number;
  cost: number;
  profit: number;
};

export function ItemCustomersTab({ customSkuId }: { customSkuId: string }) {
  const [range, setRange] = useState<DateRange>(DEFAULT_RANGE);
  const [customer, setCustomer] = useState("");
  const [applied, setApplied] = useState({ ...DEFAULT_RANGE, customer: "" });

  const key = `/api/inventory/catalog/custom-skus/${customSkuId}/sales?from=${applied.from}&to=${applied.to}&customer=${encodeURIComponent(
    applied.customer,
  )}`;
  const { data, error, isLoading } = useSWR<SalesResp>(key, fetcher, { revalidateOnFocus: false });

  const grouped = useMemo<CustomerAgg[]>(() => {
    const map = new Map<string, CustomerAgg>();
    for (const r of data?.rows ?? []) {
      const k = r.customer_id != null ? `c${r.customer_id}` : "none";
      const g =
        map.get(k) ??
        {
          customer_id: r.customer_id,
          customer_name: r.customer_name ?? "(no customer)",
          qty: 0,
          subtotal: 0,
          discounts: 0,
          total: 0,
          cost: 0,
          profit: 0,
        };
      g.qty += r.qty;
      g.subtotal += r.revenue;
      g.discounts += r.item_discount;
      g.total += r.revenue + r.item_tax;
      g.cost += r.cost;
      g.profit += r.profit;
      map.set(k, g);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [data]);

  return (
    <div className="space-y-3">
      <SearchBar
        range={range}
        setRange={setRange}
        query={customer}
        setQuery={setCustomer}
        queryPlaceholder="Customer"
        onSearch={() => setApplied({ from: range.from, to: range.to, customer })}
      />
      {error ? <p className="font-mono text-xs text-red-400/90">{(error as Error).message}</p> : null}
      <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">{grouped.length} result(s)</p>

      <div className="overflow-x-auto rounded-lg border border-[var(--wms-border)]">
        <table className="w-full min-w-[860px] border-collapse font-mono text-xs">
          <thead className="bg-[var(--wms-surface-elevated)]/80 text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
            <tr>
              <th className="px-3 py-2 text-left">Customer</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Subtotal</th>
              <th className="px-3 py-2 text-right">Discounts</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2 text-right">Cost</th>
              <th className="px-3 py-2 text-right">Profit</th>
              <th className="px-3 py-2 text-right">Margin</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/50">
            {isLoading ? (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-[var(--wms-muted)]">Loading…</td></tr>
            ) : grouped.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-[var(--wms-muted)]">No customer sales in range.</td></tr>
            ) : (
              grouped.map((g) => {
                const margin = g.subtotal !== 0 ? (g.profit / g.subtotal) * 100 : null;
                return (
                  <tr key={g.customer_id ?? "none"} className="text-[var(--wms-fg)]">
                    <td className="px-3 py-2 font-semibold text-[var(--wms-accent)]">{g.customer_name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{g.qty}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(g.subtotal)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(g.discounts)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(g.total)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(g.cost)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(g.profit)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{pct(margin)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* History tab (Inventory Movement Logs)                                      */
/* -------------------------------------------------------------------------- */

type MovementRow = {
  id: string;
  at: string;
  employee: string | null;
  reason: string | null;
  delta_qty: number | null;
  delta_value: number | null;
  source: string | null;
  customer: string | null;
  sale_id: string | null;
  store_code: string | null;
};

export function ItemHistoryTab({ customSkuId }: { customSkuId: string }) {
  const [range, setRange] = useState<DateRange>(DEFAULT_RANGE);
  const [applied, setApplied] = useState<DateRange>(DEFAULT_RANGE);

  const key = `/api/inventory/catalog/custom-skus/${customSkuId}/movements?from=${applied.from}&to=${applied.to}`;
  const { data, error, isLoading } = useSWR<{ rows: MovementRow[] }>(key, fetcher, {
    revalidateOnFocus: false,
  });
  const rows = data?.rows ?? [];

  const signed = (n: number | null) =>
    n == null ? "—" : `${n > 0 ? "+" : ""}${n}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/50 p-2">
        <DateRangePicker value={range} onChange={setRange} />
        <button
          type="button"
          onClick={() => setApplied(range)}
          className="rounded-md border border-[var(--wms-accent)]/55 bg-[var(--wms-accent)]/15 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-accent)]/25"
        >
          Search
        </button>
        <span className="font-mono text-[0.6rem] text-[var(--wms-muted)]">
          Sources: Carbon-POS sales + manual adjustments / transfers / counts.
        </span>
      </div>
      {error ? <p className="font-mono text-xs text-red-400/90">{(error as Error).message}</p> : null}
      <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">{rows.length} result(s)</p>

      <div className="overflow-x-auto rounded-lg border border-[var(--wms-border)]">
        <table className="w-full min-w-[820px] border-collapse font-mono text-xs">
          <thead className="bg-[var(--wms-surface-elevated)]/80 text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
            <tr>
              <th className="px-3 py-2 text-left">Date / Time</th>
              <th className="px-3 py-2 text-left">Employee</th>
              <th className="px-3 py-2 text-left">Reason</th>
              <th className="px-3 py-2 text-right">Δ Qty</th>
              <th className="px-3 py-2 text-right">Δ Value</th>
              <th className="px-3 py-2 text-left">Source</th>
              <th className="px-3 py-2 text-left">Customer</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/50">
            {isLoading ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-[var(--wms-muted)]">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-[var(--wms-muted)]">No movements in range.</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="text-[var(--wms-fg)]">
                  <td className="px-3 py-2 text-[var(--wms-muted)]">{fmtDateTime(r.at)}</td>
                  <td className="px-3 py-2">{r.employee ?? "—"}</td>
                  <td className="px-3 py-2">{r.reason ?? "—"}</td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${
                      (r.delta_qty ?? 0) < 0 ? "text-red-400/90" : (r.delta_qty ?? 0) > 0 ? "text-emerald-400/90" : ""
                    }`}
                  >
                    {signed(r.delta_qty)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(r.delta_value)}</td>
                  <td className="px-3 py-2 text-[var(--wms-muted)]">
                    {r.sale_id && r.store_code ? (
                      <a
                        href={posSaleUrl(r.store_code, r.sale_id)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--wms-accent)] hover:underline"
                      >
                        {r.source}
                      </a>
                    ) : (
                      r.source ?? "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-[var(--wms-muted)]">{r.customer ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
