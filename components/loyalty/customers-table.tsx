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
  created_by_first: string | null;
  created_by_last: string | null;
};

const DASH = "—";

// Money, blank ("—") when there's nothing.
const usd = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0
    ? n.toLocaleString(undefined, { style: "currency", currency: "USD" })
    : DASH;
};

// Plain count / number, blank when zero or missing.
const count = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n.toLocaleString() : DASH;
};

// Date only (MM/DD/YYYY in store time) — never a time, blank when missing.
const fmtDate = (v: string | null) => {
  if (!v) return DASH;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
};

// "Elior Perez" -> "Elior P." (never the email); blank when no name on file.
const addedBy = (first: string | null, last: string | null) => {
  const f = (first ?? "").trim();
  if (!f) return DASH;
  const l = (last ?? "").trim();
  return l ? `${f} ${l[0].toUpperCase()}.` : f;
};

export function LoyaltyCustomersTable({ rows }: { rows: CustomersTableRow[] }) {
  const tableRef = useRef<HTMLTableElement>(null);
  // hideMobile: column is CSS-hidden below md (th + td in lockstep). The
  // array order / useColResize indices are untouched.
  const cols: { label: string; align?: "right"; hideMobile?: boolean }[] = [
    { label: "First name" },
    { label: "Last name" },
    { label: "Phone 1" },
    { label: "Phone 2", hideMobile: true },
    { label: "Email 1" },
    { label: "Email 2", hideMobile: true },
    { label: "Sales", align: "right" },
    { label: "Points", align: "right" },
    { label: "Store credit", align: "right" },
    { label: "Created", hideMobile: true },
    { label: "Created by", hideMobile: true },
    { label: "Location created", hideMobile: true },
  ];
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, cols.length);
  return (
    <DataTableContainer maxHeight="min(70vh, 640px)">
      <table
        ref={tableRef}
        className="w-full min-w-[1300px] border-collapse text-sm max-md:min-w-[560px]"
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
                  className={`relative overflow-hidden whitespace-nowrap px-3 py-2 ${c.align === "right" ? "text-right" : "text-left"}${c.hideMobile ? " max-md:hidden" : ""}`}
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
              const where = r.pos_location_name ?? r.created_at_geo ?? DASH;
              return (
                <tr key={r.id}>
                  <td className={`${cellTruncate} px-3 py-2 font-semibold`} title={r.first_name ?? ""}>
                    <Link href={`/rewards/customers/${r.id}`} className="hover:underline">
                      {r.first_name ?? DASH}
                    </Link>
                  </td>
                  <td className={`${cellTruncate} px-3 py-2`} title={r.last_name ?? ""}>
                    {r.last_name ?? DASH}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2`} title={r.phone ?? ""}>
                    {r.phone ?? DASH}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2 max-md:hidden`} title={r.phone_2 ?? ""}>
                    {r.phone_2 ?? DASH}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2`} title={r.email ?? ""}>
                    {r.email ?? DASH}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2 max-md:hidden`} title={r.email_2 ?? ""}>
                    {r.email_2 ?? DASH}
                  </td>
                  <td className="overflow-hidden px-3 py-2 text-right tabular-nums">
                    {count(r.sales)}
                  </td>
                  <td className="overflow-hidden px-3 py-2 text-right tabular-nums font-bold">
                    {count(r.points)}
                  </td>
                  <td className="overflow-hidden px-3 py-2 text-right tabular-nums">
                    {usd(r.store_credit_balance)}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2 text-muted-foreground max-md:hidden`}>
                    {fmtDate(r.created_at)}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2 max-md:hidden`}>
                    {addedBy(r.created_by_first, r.created_by_last)}
                  </td>
                  <td className={`${cellTruncate} px-3 py-2 max-md:hidden`} title={where}>
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
