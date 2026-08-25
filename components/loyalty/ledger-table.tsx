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
  // hideMobile: column is CSS-hidden below md (th + td in lockstep). The
  // array order / useColResize indices are untouched.
  const cols: { label: string; align?: "right"; hideMobile?: boolean }[] = [
    { label: "When" },
    { label: "Customer" },
    { label: "Δ Pts", align: "right" },
    { label: "Reason" },
    { label: "Source" },
    { label: "Ref", hideMobile: true },
    { label: "Basis", align: "right", hideMobile: true },
  ];
  // Compact timestamp for phones ("8/25/26, 3:04 PM"); desktop keeps the
  // full toLocaleString() text via a md-gated sibling span.
  const fmtShort = (v: string) =>
    new Date(v).toLocaleString(undefined, {
      month: "numeric",
      day: "numeric",
      year: "2-digit",
      hour: "numeric",
      minute: "2-digit",
    });
  return (
    <DataTableContainer maxHeight="min(70vh, 640px)">
      <table
        ref={tableRef}
        className="w-full min-w-[900px] border-collapse text-sm max-md:min-w-[520px]"
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
                  className={`relative overflow-hidden px-3 py-2 ${c.align === "right" ? "text-right" : "text-left"}${c.hideMobile ? " max-md:hidden" : ""}`}
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
                  <span className="md:hidden">{fmtShort(row.created_at)}</span>
                  <span className="hidden md:inline">{new Date(row.created_at).toLocaleString()}</span>
                </td>
                <td className={`${cellTruncate} px-3 py-2`} title={row.customer_name}>
                  {row.customer_id ? (
                    <Link className="underline" href={`/rewards/customers/${row.customer_id}`}>
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
                <td className={`${cellTruncate} px-3 py-2 max-md:whitespace-normal`} title={row.reason}>{row.reason}</td>
                <td className={`${cellTruncate} px-3 py-2 max-md:whitespace-normal`} title={row.source}>{row.source}</td>
                <td className={`${cellTruncate} px-3 py-2 font-mono text-xs max-md:hidden`} title={row.source_ref ?? ""}>
                  {row.source_ref ?? "—"}
                </td>
                <td className="overflow-hidden px-3 py-2 text-right tabular-nums max-md:hidden">
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
