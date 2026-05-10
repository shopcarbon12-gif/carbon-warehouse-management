"use client";

import { useRef } from "react";
import {
  cellTruncate,
  DataTableContainer,
  pickTableLayout,
  ResizeHandle,
  useColResize,
} from "@/components/shared/data-table";

export type ReferralsTableRow = {
  redeemed_at: string;
  referrer_first: string | null;
  referrer_last: string | null;
  referee_first: string | null;
  referee_last: string | null;
  qualifying_amount: string | null;
  shopify_order_gid: string | null;
  pos_sale_id: string | number | null;
};

export function LoyaltyReferralsTable({ rows }: { rows: ReferralsTableRow[] }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 5);
  const cols: { label: string; align?: "right" }[] = [
    { label: "When" },
    { label: "Referrer" },
    { label: "Referee" },
    { label: "First order", align: "right" },
    { label: "Order" },
  ];
  return (
    <DataTableContainer maxHeight="min(70vh, 640px)">
      <table
        ref={tableRef}
        className="w-full min-w-[760px] border-collapse text-sm"
        style={{ tableLayout: pickTableLayout(colWidths) }}
      >
        <thead className="sticky top-0 z-10 bg-muted text-xs font-bold uppercase tracking-wider">
          <tr>
            {cols.map((c, i) => {
              const w = colWidths[i];
              return (
                <th
                  key={c.label}
                  style={w !== null ? { width: w, minWidth: w } : undefined}
                  className={`relative overflow-hidden px-3 py-2 ${c.align === "right" ? "text-right" : "text-left"}`}
                >
                  <span>{c.label}</span>
                  <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                No conversions yet.
              </td>
            </tr>
          ) : (
            rows.map((r, i) => {
              const referrer = [r.referrer_first, r.referrer_last].filter(Boolean).join(" ") || "—";
              const referee = [r.referee_first, r.referee_last].filter(Boolean).join(" ") || "—";
              const orderRef = r.shopify_order_gid ?? (r.pos_sale_id ? `pos:${r.pos_sale_id}` : "—");
              return (
                <tr key={i}>
                  <td className={`${cellTruncate} px-3 py-2`}>
                    {new Date(r.redeemed_at).toLocaleString()}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2`} title={referrer}>{referrer}</td>
                  <td className={`${cellTruncate} px-3 py-2`} title={referee}>{referee}</td>
                  <td className="overflow-hidden px-3 py-2 text-right tabular-nums">
                    {r.qualifying_amount ? `$${Number(r.qualifying_amount).toFixed(2)}` : "—"}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2 font-mono text-xs`} title={orderRef}>
                    {orderRef}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </DataTableContainer>
  );
}
