import Link from "next/link";
import { redirect } from "next/navigation";
import { withDb } from "@/lib/db";
import { getSession } from "@/lib/get-session";
import { UserPlus } from "lucide-react";

/**
 * Loyalty → Members → Add. Single-customer WMS form. Stamps:
 *   created_via       = 'wms_manual'
 *   created_by_user_id = WMS-authenticated user's id
 *   pos_location_id    = location picked here (optional)
 */
export default async function AddCustomerPage() {
  const session = await getSession();
  if (!session?.sub) redirect("/login?next=/rewards/customers/new");

  const locations = await withDb(
    async (pool) => {
      const r = await pool.query<{ id: number; name: string }>(
        `SELECT id, name FROM pos_locations ORDER BY name`,
      );
      return r.rows;
    },
    [],
  );

  async function create(formData: FormData) {
    "use server";
    const session = await getSession();
    if (!session?.sub) redirect("/login");
    const first = String(formData.get("first_name") ?? "").trim();
    const last = String(formData.get("last_name") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim().toLowerCase() || null;
    const phone = String(formData.get("mobile_phone") ?? "").trim() || null;
    const birthday = String(formData.get("birthday") ?? "").trim() || null;
    const locId = String(formData.get("pos_location_id") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim() || null;
    if (!first) return;
    if (!email && !phone) return; // at least one matching key

    const newId = await withDb(
      async (pool) => {
        // Dedupe on email + phone (Kangaroo's matching rule), backfill if matched.
        let existingId: number | null = null;
        if (email && phone) {
          const r = await pool.query<{ id: number }>(
            `SELECT id FROM pos_customers
              WHERE LOWER(email) = $1
                AND (regexp_replace(COALESCE(mobile_phone,''), '[^0-9]', '', 'g')
                   = regexp_replace($2,'[^0-9]','','g')
                   OR regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g')
                   = regexp_replace($2,'[^0-9]','','g'))
              LIMIT 1`,
            [email, phone],
          );
          existingId = r.rows[0]?.id ?? null;
        }
        if (!existingId && email) {
          const r = await pool.query<{ id: number }>(
            `SELECT id FROM pos_customers WHERE LOWER(email) = $1 LIMIT 1`,
            [email],
          );
          existingId = r.rows[0]?.id ?? null;
        }
        if (existingId) return existingId;
        const ins = await pool.query<{ id: number }>(
          `INSERT INTO pos_customers
             (first_name, last_name, email, mobile_phone, birthday,
              pos_location_id, created_by_user_id, created_via, notes, created_at)
           VALUES ($1,$2,$3,$4,$5::date, $6::int, $7::uuid, 'wms_manual', $8, now())
           RETURNING id`,
          [first, last || null, email, phone, birthday, locId || null, session.sub, notes],
        );
        return ins.rows[0].id;
      },
      0,
    );
    if (newId) redirect(`/rewards/customers/${newId}`);
    redirect("/rewards/customers");
  }

  return (
    <main className="p-6 lg:p-8 max-w-2xl">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-muted-foreground">
          <UserPlus className="h-3.5 w-3.5" />
          Rewards · <Link className="underline" href="/rewards/customers">Members</Link>
        </div>
        <h1 className="text-2xl font-bold mt-1">Add customer</h1>
        <p className="text-sm text-muted-foreground mt-1">
          For walk-ins or vendor entries. Match by email + phone first; backfills the existing row instead of creating a duplicate.
        </p>
      </header>

      <form action={create} className="border border-border bg-card p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="First name" name="first_name" required />
          <Field label="Last name" name="last_name" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Email" name="email" type="email" />
          <Field label="Mobile phone" name="mobile_phone" type="tel" />
        </div>
        <p className="text-xs text-muted-foreground">
          At least one of email or phone is required so the system can dedupe and match future events.
        </p>
        <Field label="Birthday" name="birthday" type="date" />
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Where are you adding them?</span>
          <select name="pos_location_id" defaultValue="" className="border border-border bg-card px-3 py-2">
            <option value="">Not at a store</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <span className="text-[11px] text-muted-foreground">
            Stored as the customer&rsquo;s &ldquo;Where added&rdquo; — for analytics only.
            Customer can still earn and redeem at every other location.
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Notes (optional)</span>
          <textarea name="notes" rows={3} className="border border-border bg-card px-3 py-2" />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Link href="/rewards/customers" className="px-4 py-2 border border-border text-sm">Cancel</Link>
          <button type="submit" className="px-4 py-2 border border-border bg-foreground text-background text-sm font-bold hover:opacity-90">
            Add customer
          </button>
        </div>
      </form>
    </main>
  );
}

function Field({
  label,
  name,
  type = "text",
  required,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
        {label}{required ? " *" : ""}
      </span>
      <input
        type={type}
        name={name}
        required={required}
        className="border border-border bg-card px-3 py-2"
      />
    </label>
  );
}
