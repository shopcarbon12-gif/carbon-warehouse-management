import Link from "next/link";
import { withDb } from "@/lib/db";
import { UserSearch, UserPlus, Upload } from "lucide-react";
import { LoyaltyCustomersTable } from "@/components/loyalty/customers-table";

const PAGE_SIZE = 50;

const SOURCE_LABELS: Record<string, { label: string; tone: string }> = {
  pos:        { label: "Store",     tone: "bg-blue-100 text-blue-800" },
  shopify:    { label: "Online",    tone: "bg-emerald-100 text-emerald-800" },
  wms_manual: { label: "WMS · Manual", tone: "bg-purple-100 text-purple-800" },
  wms_csv:    { label: "WMS · CSV", tone: "bg-amber-100 text-amber-800" },
  admin:      { label: "Admin",     tone: "bg-slate-200 text-slate-800" },
  legacy:     { label: "Legacy",    tone: "bg-stone-200 text-stone-700" },
};

type Row = {
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

/**
 * Loyalty → Members. Pooled customer list — every member shows in
 * every location. New provenance columns answer who/when/where added
 * each customer for analytics + audit, but DO NOT scope visibility.
 */
export default async function LoyaltyMembers({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; via?: string; loc?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const via = (sp.via ?? "").trim();
  const loc = (sp.loc ?? "").trim();
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const { rows, total, locations } = await withDb(
    async (pool) => {
      const args: unknown[] = [];
      const where: string[] = [];
      if (q) {
        args.push(`%${q}%`);
        where.push(
          `(pc.first_name ILIKE $${args.length}
              OR pc.last_name ILIKE $${args.length}
              OR pc.email ILIKE $${args.length}
              OR pc.mobile_phone ILIKE $${args.length}
              OR pc.phone ILIKE $${args.length})`,
        );
      }
      if (via) {
        args.push(via);
        where.push(`pc.created_via = $${args.length}`);
      }
      if (loc) {
        args.push(Number(loc));
        where.push(`pc.pos_location_id = $${args.length}::int`);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const idx0 = args.length;
      args.push(PAGE_SIZE, offset);
      const r = await pool.query<Row>(
        `SELECT pc.id,
                pc.first_name,
                pc.last_name,
                pc.email,
                pc.mobile_phone,
                pc.phone,
                COALESCE(lb.balance, 0)::text AS balance,
                lb.last_event_at,
                pc.shopify_customer_gid,
                pc.created_at,
                pc.created_via,
                pc.created_at_geo,
                pl.name                       AS pos_location_name,
                u.email                       AS created_by_email
           FROM pos_customers pc
           LEFT JOIN loyalty_balance lb ON lb.customer_id = pc.id
           LEFT JOIN pos_locations  pl  ON pl.id = pc.pos_location_id
           LEFT JOIN users          u   ON u.id  = pc.created_by_user_id
           ${whereSql}
          ORDER BY pc.created_at DESC, pc.id DESC
          LIMIT $${idx0 + 1}::int OFFSET $${idx0 + 2}::int`,
        args,
      );
      const c = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM pos_customers pc ${whereSql}`,
        args.slice(0, idx0),
      );
      const locs = await pool.query<{ id: number; name: string }>(
        `SELECT id, name FROM pos_locations ORDER BY name`,
      );
      return {
        rows: r.rows,
        total: Number(c.rows[0]?.n ?? 0),
        locations: locs.rows,
      };
    },
    { rows: [], total: 0, locations: [] },
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showFrom = total === 0 ? 0 : offset + 1;
  const showTo = Math.min(offset + rows.length, total);
  const baseHref = (p: number) =>
    `?q=${encodeURIComponent(q)}&via=${encodeURIComponent(via)}&loc=${encodeURIComponent(loc)}&page=${p}`;

  return (
    <main className="p-6 lg:p-8 max-w-7xl">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-muted-foreground">
            <UserSearch className="h-3.5 w-3.5" />
            Loyalty
          </div>
          <h1 className="text-2xl font-bold mt-1">Members</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every <code>pos_customers</code> row, pooled across all locations.
            Click a row for the full ledger and to award/redeem.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          <Link
            href="/loyalty/customers/new"
            className="inline-flex items-center gap-2 px-4 py-2 border border-border bg-card hover:bg-muted text-sm font-semibold"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add customer
          </Link>
          <Link
            href="/loyalty/customers/import"
            className="inline-flex items-center gap-2 px-4 py-2 border border-border bg-foreground text-background hover:opacity-90 text-sm font-bold"
          >
            <Upload className="h-3.5 w-3.5" />
            Import CSV
          </Link>
        </div>
      </header>

      <form className="mb-4 flex flex-wrap gap-2 items-end">
        <label className="flex flex-col gap-1 flex-1 min-w-[260px]">
          <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Search</span>
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="Name, email, or phone…"
            className="border border-border bg-card px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Source</span>
          <select name="via" defaultValue={via} className="border border-border bg-card px-3 py-2">
            <option value="">All sources</option>
            {Object.entries(SOURCE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Added at location</span>
          <select name="loc" defaultValue={loc} className="border border-border bg-card px-3 py-2">
            <option value="">All locations</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="border border-border bg-card hover:bg-muted px-4 py-2 text-sm font-semibold">
          Filter
        </button>
        <Link href="/loyalty/customers" className="px-4 py-2 text-sm text-muted-foreground hover:underline">
          Clear
        </Link>
      </form>

      <div className="border border-border bg-card">
        <LoyaltyCustomersTable rows={rows} sourceLabels={SOURCE_LABELS} />
        <div className="px-3 py-2 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
          <span>Showing {showFrom}–{showTo} of {total.toLocaleString()}</span>
          <div className="flex gap-2">
            <Link
              href={baseHref(Math.max(1, page - 1))}
              className={`px-2 py-1 border border-border ${page === 1 ? "opacity-40 pointer-events-none" : ""}`}
            >Prev</Link>
            <span className="px-2 py-1">Page {page} / {totalPages}</span>
            <Link
              href={baseHref(Math.min(totalPages, page + 1))}
              className={`px-2 py-1 border border-border ${page === totalPages ? "opacity-40 pointer-events-none" : ""}`}
            >Next</Link>
          </div>
        </div>
      </div>
    </main>
  );
}
