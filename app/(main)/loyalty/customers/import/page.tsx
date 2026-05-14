import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { withDb } from "@/lib/db";
import { getSession } from "@/lib/get-session";
import {
  parseCsv,
  importRows,
  type ImportSummary,
  type ParsedRow,
} from "@/lib/csv-customer-import";
import { Upload } from "lucide-react";

/**
 * WMS Loyalty → Members → Import. Bulk add customers from any CSV.
 * Stamps created_via='wms_csv', the WMS user's id, and an optional
 * source location chosen at upload time.
 *
 * No balance migration here — that's a separate workflow on
 * rewards.shopcarbon.com/admin/customers/import which writes ledger
 * rows. WMS only writes customer records.
 */
export default async function CustomerImportPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string }>;
}) {
  const session = await getSession();
  if (!session?.sub) redirect("/login?next=/loyalty/customers/import");

  const sp = await searchParams;
  const cookieJar = await cookies();
  const summaryBlob = cookieJar.get("wms_csv_import_summary")?.value;
  const lastSummary: ImportSummary | null = summaryBlob ? JSON.parse(summaryBlob) : null;
  const previewBlob = cookieJar.get("wms_csv_import_preview")?.value;
  const preview = previewBlob ? JSON.parse(previewBlob) : null;

  const locations = await withDb(
    async (pool) => {
      const r = await pool.query<{ id: number; name: string }>(
        `SELECT id, name FROM pos_locations ORDER BY name`,
      );
      return r.rows;
    },
    [],
  );

  async function previewAction(formData: FormData) {
    "use server";
    const text = String(formData.get("csv_text") ?? "").trim();
    const locId = String(formData.get("pos_location_id") ?? "").trim();
    const c = await cookies();
    if (!text) {
      c.delete("wms_csv_import_preview");
      revalidatePath("/loyalty/customers/import");
      return;
    }
    const { rows, errors } = parseCsv(text);
    c.set(
      "wms_csv_import_preview",
      JSON.stringify({
        errors,
        rowCount: rows.length,
        sample: rows.slice(0, 10),
        text,
        locId,
      }),
      { httpOnly: true, path: "/loyalty/customers/import", maxAge: 60 * 10 },
    );
    revalidatePath("/loyalty/customers/import");
  }

  async function commitAction() {
    "use server";
    const session = await getSession();
    if (!session?.sub) redirect("/login");
    const c = await cookies();
    const blob = c.get("wms_csv_import_preview")?.value;
    if (!blob) return;
    const p = JSON.parse(blob) as { text?: string; locId?: string };
    if (!p.text) return;
    const { rows } = parseCsv(p.text);
    const summary = await importRows(rows, {
      actedByUserId: session.sub,
      createdAtLocationId: p.locId ? Number(p.locId) : null,
    });
    c.delete("wms_csv_import_preview");
    c.set("wms_csv_import_summary", JSON.stringify(summary), {
      httpOnly: true,
      path: "/loyalty/customers/import",
      maxAge: 60 * 10,
    });
    revalidatePath("/loyalty/customers/import");
    redirect("/loyalty/customers/import?done=1");
  }

  async function clearAction() {
    "use server";
    const c = await cookies();
    c.delete("wms_csv_import_preview");
    c.delete("wms_csv_import_summary");
    revalidatePath("/loyalty/customers/import");
    redirect("/loyalty/customers/import");
  }

  return (
    <main className="p-6 lg:p-8 max-w-5xl">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-muted-foreground">
          <Upload className="h-3.5 w-3.5" />
          Loyalty · <Link className="underline" href="/loyalty/customers">Members</Link>
        </div>
        <h1 className="text-2xl font-bold mt-1">Bulk import customers</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Paste any customer CSV (Shopify export, vendor list, event
          signup sheet). Match by email + phone, fall back to either
          alone. Re-running the same file is safe — matched rows just
          backfill missing fields.
        </p>
      </header>

      <div className="border border-border bg-card p-5 mb-4">
        <h2 className="text-base font-bold mb-2">Recognised columns</h2>
        <p className="text-sm">
          <code>first_name</code>, <code>last_name</code>, <code>email</code>,{" "}
          <code>phone</code> (or <code>mobile</code>),{" "}
          <code>birthday</code> (yyyy-mm-dd or mm/dd/yyyy).
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          Aliases recognised: <code>firstname</code>, <code>lastname</code>,{" "}
          <code>mobile_phone</code>, <code>dob</code>.
        </p>
      </div>

      {sp.done === "1" && lastSummary ? (
        <ResultBlock summary={lastSummary} clear={clearAction} />
      ) : null}

      {!preview ? (
        <form action={previewAction} className="border border-border bg-card p-5 space-y-4">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
              Where are these customers being added from?
            </span>
            <select name="pos_location_id" defaultValue="" className="border border-border bg-card px-3 py-2">
              <option value="">Not at a store (vendor list / signup sheet / etc.)</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <span className="text-[11px] text-muted-foreground">
              Stamped on every NEW row. Existing matched rows keep their
              original location. Customers remain visible at every store
              regardless.
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
              CSV
            </span>
            <textarea
              name="csv_text"
              rows={14}
              required
              className="border border-border bg-card px-3 py-2 font-mono text-xs"
              placeholder={`first_name,last_name,email,phone,birthday\nSarah,Chen,sarah.chen@example.com,3055550142,1992-06-14`}
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="submit" className="px-4 py-2 border border-border bg-foreground text-background text-sm font-bold hover:opacity-90">
              Preview
            </button>
          </div>
        </form>
      ) : (
        <PreviewBlock preview={preview} commit={commitAction} clear={clearAction} />
      )}
    </main>
  );
}

function PreviewBlock({
  preview,
  commit,
  clear,
}: {
  preview: { errors: string[]; rowCount: number; sample: ParsedRow[] };
  commit: () => Promise<void>;
  clear: () => Promise<void>;
}) {
  if (preview.errors?.length) {
    return (
      <div className="border border-border bg-card p-5 mb-4">
        <h2 className="text-base font-bold mb-2 text-rose-700">Couldn&rsquo;t parse</h2>
        <ul className="text-sm list-disc list-inside">
          {preview.errors.map((e: string) => <li key={e}>{e}</li>)}
        </ul>
        <form action={clear} className="mt-3">
          <button className="px-4 py-2 border border-border text-sm">Try again</button>
        </form>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="border border-border bg-card p-5">
        <h2 className="text-base font-bold mb-2">Preview · {preview.rowCount.toLocaleString()} rows</h2>
        <p className="text-xs text-muted-foreground mb-3">
          Showing first {preview.sample.length} rows. Hit Import to commit
          all {preview.rowCount.toLocaleString()}.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted text-xs uppercase tracking-wider font-bold">
              <tr>
                <th className="text-left px-3 py-2">#</th>
                <th className="text-left px-3 py-2">First</th>
                <th className="text-left px-3 py-2">Last</th>
                <th className="text-left px-3 py-2">Email</th>
                <th className="text-left px-3 py-2">Phone</th>
                <th className="text-left px-3 py-2">Birthday</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {preview.sample.map((r) => (
                <tr key={r.rowIndex}>
                  <td className="px-3 py-2 text-muted-foreground">{r.rowIndex}</td>
                  <td className="px-3 py-2">{r.first_name ?? "—"}</td>
                  <td className="px-3 py-2">{r.last_name ?? "—"}</td>
                  <td className="px-3 py-2">{r.email ?? "—"}</td>
                  <td className="px-3 py-2">{r.phone ?? "—"}</td>
                  <td className="px-3 py-2">{r.birthday ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <form action={clear}>
          <button className="px-4 py-2 border border-border text-sm" type="submit">Cancel</button>
        </form>
        <form action={commit}>
          <button className="px-4 py-2 border border-border bg-foreground text-background text-sm font-bold hover:opacity-90" type="submit">
            Import {preview.rowCount.toLocaleString()} rows
          </button>
        </form>
      </div>
    </div>
  );
}

function ResultBlock({
  summary,
  clear,
}: {
  summary: ImportSummary;
  clear: () => Promise<void>;
}) {
  const issues = summary.outcomes.filter((o) => o.status === "error" || o.status === "skipped");
  return (
    <div className="border border-border bg-card p-5 mb-4 border-l-4 border-l-emerald-500">
      <h2 className="text-base font-bold mb-2">Import complete</h2>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
        <Stat label="Rows" value={summary.total.toLocaleString()} />
        <Stat label="Matched" value={summary.matched.toLocaleString()} />
        <Stat label="Created" value={summary.created.toLocaleString()} />
        <Stat label="Skipped" value={summary.skipped.toLocaleString()} />
        <Stat label="Errors" value={summary.errors.toLocaleString()} tone={summary.errors > 0 ? "bad" : undefined} />
      </div>
      {issues.length > 0 ? (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-bold">
            Issues ({issues.length})
          </summary>
          <ul className="text-xs mt-2 space-y-1">
            {issues.slice(0, 50).map((o) => (
              <li key={o.rowIndex}>
                <b>row {o.rowIndex}</b> · {o.identity ?? "—"} · {o.status} · {o.message ?? ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <form action={clear} className="mt-4">
        <button className="px-4 py-2 border border-border text-sm" type="submit">Import another file</button>
      </form>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  return (
    <div className="border border-border p-3">
      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{label}</p>
      <p className={`text-xl font-bold tabular-nums mt-1 ${tone === "bad" ? "text-rose-700" : ""}`}>
        {value}
      </p>
    </div>
  );
}
