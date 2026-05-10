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

export type CustomersTableRow = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  mobile_phone: string | null;
  phone: string | null;
  balance: string;
  last_event_at: string | null;
  shopify_customer_gid: string | null;
  created_at: string;
  created_via: string;
  created_at_geo: string | null;
  pos_location_name: string | null;
  created_by_email: string | null;
};

export function LoyaltyCustomersTable({
  rows,
  sourceLabels,
}: {
  rows: CustomersTableRow[];
  sourceLabels: Record<string, { label: string; tone: string }>;
}) {
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 9);
  const cols: { label: string; align?: "right"; noResize?: boolean }[] = [
    { label: "Name" },
    { label: "Email" },
    { label: "Phone" },
    { label: "Balance", align: "right" },
    { label: "Source" },
    { label: "Where added" },
    { label: "Added by" },
    { label: "Added on" },
    { label: "", noResize: true },
  ];
  return (
    <DataTableContainer maxHeight="min(70vh, 640px)">
      <table
        ref={tableRef}
        className="w-full min-w-[1100px] border-collapse text-sm"
        style={{ tableLayout: pickTableLayout(colWidths) }}
      >
        <thead className="sticky top-0 z-10 bg-muted text-xs font-bold uppercase tracking-wider">
          <tr>
            {cols.map((c, i) => {
              const w = colWidths[i];
              return (
                <th
                  key={c.label || `col-${i}`}
                  style={w !== null ? { width: w, minWidth: w } : undefined}
                  className={`relative overflow-hidden px-3 py-2 ${c.align === "right" ? "text-right" : "text-left"}`}
                >
                  <span>{c.label}</span>
                  {c.noResize ? null : (
                    <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                No customers match.
              </td>
            </tr>
          ) : (
            rows.map((r) => {
              const src = sourceLabels[r.created_via] ?? sourceLabels.legacy;
              const where = r.pos_location_name ?? r.created_at_geo ?? "—";
              const fullName =
                [r.first_name, r.last_name].filter(Boolean).join(" ") || "—";
              return (
                <tr key={r.id}>
                  <td className={`${cellTruncate} px-3 py-2 font-semibold`} title={fullName}>
                    <Link href={`/loyalty/customers/${r.id}`} className="hover:underline">
                      {fullName}
                    </Link>
                  </td>
                  <td className={`${cellTruncate} px-3 py-2`} title={r.email ?? ""}>
                    {r.email ?? "—"}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2`} title={r.mobile_phone ?? r.phone ?? ""}>
                    {r.mobile_phone ?? r.phone ?? "—"}
                  </td>
                  <td className="overflow-hidden px-3 py-2 text-right tabular-nums font-bold">
                    {Number(r.balance).toLocaleString()}
                  </td>
                  <td className="overflow-hidden px-3 py-2">
                    <span
                      className={`inline-block rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${src?.tone ?? ""}`}
                    >
                      {src?.label ?? r.created_via}
                    </span>
                  </td>
                  <td className={`${cellTruncate} px-3 py-2`} title={where}>
                    {where}
                    {r.shopify_customer_gid && r.created_via !== "shopify" ? (
                      <span className="ml-1 text-[10px] font-bold text-emerald-600">
                        ↗ shopify-linked
                      </span>
                    ) : null}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2`} title={r.created_by_email ?? ""}>
                    {r.created_by_email ?? "—"}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2 text-muted-foreground`}>
                    {new Date(r.created_at).toLocaleDateString()}{" "}
                    {new Date(r.created_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="overflow-hidden px-3 py-2">
                    <Link className="text-xs underline" href={`/loyalty/customers/${r.id}`}>
                      View
                    </Link>
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
