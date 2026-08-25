import Link from "next/link";
import { redirect } from "next/navigation";
import { Upload } from "lucide-react";
import { withDb } from "@/lib/db";
import { getSession } from "@/lib/get-session";
import ImportClient, { type LocationOption } from "./import-client";

/**
 * Rewards → Customers → Import. Upload a CSV or Excel file, preview the
 * mapped columns, then write every row to pos_customers (shared by POS,
 * Rewards and WMS). Points are managed by the Rewards service and are not
 * imported here.
 */
export default async function CustomerImportPage() {
  const session = await getSession();
  if (!session?.sub) redirect("/login?next=/rewards/customers/import");

  // Resolve human names via the WMS-owned locations table (pos_locations has
  // no name column) — same join the customers list/detail pages use.
  const locations = await withDb<LocationOption[]>(
    async (pool) => {
      const r = await pool.query<{ id: number; label: string }>(
        `SELECT pl.id, COALESCE(l.name, 'Location ' || pl.id::text) AS label
           FROM pos_locations pl
           LEFT JOIN locations l ON l.id = pl.wms_location_id
          WHERE pl.is_active
          ORDER BY label`,
      );
      return r.rows;
    },
    [],
  );

  return (
    <main className="p-6 lg:p-8 max-w-6xl max-md:p-4">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-muted-foreground">
          <Upload className="h-3.5 w-3.5" />
          Rewards · <Link className="underline" href="/rewards/customers">Customers</Link>
        </div>
        <h1 className="text-2xl font-bold mt-1">Import customers</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload a CSV or Excel (.xlsx) file. Columns are matched automatically
          (First Name, Last Name, DOB, Address, City, State, ZIP, Country,
          Phone 1/2, Email 1/2, Note). Existing customers are matched on email +
          phone and missing fields are backfilled — re-running a file is safe.
        </p>
      </header>

      <ImportClient locations={locations} />
    </main>
  );
}
