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
  phone: string | null;
  phone_2: string | null;
  email: string | null;
  email_2: string | null;
  sales: string;
  points: string;
  store_credit_balance: string;
  created_at: string;
  created_at_geo: string | null;
  pos_location_name: string | null;
  created_by_email: string | null;
};

const usd = (v: string) =>
  Number(v).toLocaleString(undefined, { style: "currency", currency: "USD" });

export function LoyaltyCustomersTable({ rows }: { rows: CustomersTableRow[] }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const cols: { label: string; align?: "right" }[] = [
    { label: "First name" },
    { label: "Last name" },
    { label: "Phone 1" },
    { label: "Phone 2" },
    { label: "Email 1" },
    { label: "Email 2" },
    { label: "Sales", align: "right" },
    { label: "Points", align: "right" },
    { label: "Store credit", align: "right" },
    { label: "Created" },
    { label: "Created by" },
    { label: "Location created" },
  ];
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, cols.length);
  return (
    <DataTableContainer maxHeight="min(70vh, 640px)">
      <table
        ref={tableRef}
        className="w-full min-w-[1300px] border-collapse text-sm"
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
                  <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={cols.length} className="px-3 py-8 text-center text-muted-foreground">
                No customers match.
              </td>
            </tr>
          ) : (
            rows.map((r) => {
              const where = r.pos_location_name ?? r.created_at_geo ?? "—";
              return (
                <tr key={r.id}>
                  <td className={`${cellTruncate} px-3 py-2 font-semibold`} title={r.first_name ?? ""}>
                    <Link href={`/rewards/customers/${r.id}`} className="hover:underline">
                      {r.first_name ?? "—"}
                    </Link>
                  </td>
                  <td className={`${cellTruncate} px-3 py-2`} title={r.last_name ?? ""}>
                    {r.last_name ?? "—"}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2`} title={r.phone ?? ""}>
                    {r.phone ?? "—"}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2`} title={r.phone_2 ?? ""}>
                    {r.phone_2 ?? "—"}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2`} title={r.email ?? ""}>
                    {r.email ?? "—"}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2`} title={r.email_2 ?? ""}>
                    {r.email_2 ?? "—"}
                  </td>
                  <td className="overflow-hidden px-3 py-2 text-right tabular-nums">
                    {usd(r.sales)}
                  </td>
                  <td className="overflow-hidden px-3 py-2 text-right tabular-nums font-bold">
                    {Number(r.points).toLocaleString()}
                  </td>
                  <td className="overflow-hidden px-3 py-2 text-right tabular-nums">
                    {usd(r.store_credit_balance)}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2 text-muted-foreground`}>
                    {new Date(r.created_at).toLocaleDateString()}{" "}
                    {new Date(r.created_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2`} title={r.created_by_email ?? ""}>
                    {r.created_by_email ?? "—"}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2`} title={where}>
                    {where}
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
