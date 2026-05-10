"use client";

import { useRef } from "react";
import Link from "next/link";
import {
  cellTruncate,
  DataTableContainer,
  pickTableLayout,
  ResizeHandle,
  useColResize,
} from "@/components/shared/data-table";

export type LedgerTableRow = {
  id: string;
  delta_points: number;
  reason: string;
  source: string;
  source_ref: string | null;
  amount_basis: string | null;
  created_at: string;
  customer_name: string;
  customer_id: number | null;
};

export function LoyaltyLedgerTable({ rows }: { rows: LedgerTableRow[] }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 7);
  const cols: { label: string; align?: "right" }[] = [
    { label: "When" },
    { label: "Customer" },
    { label: "Δ Pts", align: "right" },
    { label: "Reason" },
    { label: "Source" },
    { label: "Ref" },
    { label: "Basis", align: "right" },
  ];
  return (
    <DataTableContainer maxHeight="min(70vh, 640px)">
      <table
        ref={tableRef}
        className="w-full min-w-[900px] border-collapse text-sm"
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
              <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                No ledger rows match.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id}>
                <td className={`${cellTruncate} px-3 py-2`}>
                  {new Date(row.created_at).toLocaleString()}
                </td>
                <td className={`${cellTruncate} px-3 py-2`} title={row.customer_name}>
                  {row.customer_id ? (
                    <Link className="underline" href={`/loyalty/customers/${row.customer_id}`}>
                      {row.customer_name}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">{row.customer_name}</span>
                  )}
                </td>
                <td
                  className={`overflow-hidden px-3 py-2 text-right tabular-nums font-bold ${row.delta_points > 0 ? "text-emerald-600" : "text-rose-700"}`}
                >
                  {row.delta_points > 0 ? "+" : ""}
                  {row.delta_points}
                </td>
                <td className={`${cellTruncate} px-3 py-2`} title={row.reason}>{row.reason}</td>
                <td className={`${cellTruncate} px-3 py-2`} title={row.source}>{row.source}</td>
                <td className={`${cellTruncate} px-3 py-2 font-mono text-xs`} title={row.source_ref ?? ""}>
                  {row.source_ref ?? "—"}
                </td>
                <td className="overflow-hidden px-3 py-2 text-right tabular-nums">
                  {row.amount_basis ? `$${Number(row.amount_basis).toFixed(2)}` : "—"}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </DataTableContainer>
  );
}
