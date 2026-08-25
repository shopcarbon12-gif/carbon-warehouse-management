import Link from "next/link";
import { redirect } from "next/navigation";
import { UserPlus } from "lucide-react";
import { withDb } from "@/lib/db";
import { getSession } from "@/lib/get-session";

/**
 * Rewards → Customers → Add. Single-customer form, modelled on the POS
 * new-customer screen, writing to the shared pos_customers table so POS,
 * Rewards and WMS all see the record. Stamps created_via='wms_manual'.
 * Matches existing customers on email + phone and backfills instead of
 * creating a duplicate.
 */
export default async function AddCustomerPage() {
  const session = await getSession();
  if (!session?.sub) redirect("/login?next=/rewards/customers/new");

  // Resolve human names via the WMS-owned locations table (pos_locations has
  // no name column) — same join the customers list/detail pages use.
  const locations = await withDb<{ id: number; label: string }[]>(
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

  async function create(formData: FormData) {
    "use server";
    const session = await getSession();
    if (!session?.sub) redirect("/login");

    const val = (k: string) => String(formData.get(k) ?? "").trim();
    const first = val("first_name");
    const last = val("last_name") || null;
    const email = val("email").toLowerCase() || null;
    const email2 = val("email_2").toLowerCase() || null;
    const phone = val("phone").replace(/[^\d]/g, "") || null;
    const phone2 = val("phone_2").replace(/[^\d]/g, "") || null;
    const birthday = val("birthday") || null;
    const address1 = val("address_line1") || null;
    const address2 = val("address_line2") || null;
    const city = val("city") || null;
    const state = val("state") || null;
    const zip = val("zip") || null;
    const country = val("country") || null;
    const notes = val("notes") || null;
    const locId = val("pos_location_id") || null;

    if (!first) return;
    if (!email && !phone) return; // need at least one match key

    const newId = await withDb<number>(
      async (pool) => {
        // Dedupe on email + phone, backfilling empty fields if matched.
        let existingId: number | null = null;
        if (email) {
          const r = await pool.query<{ id: number }>(
            `SELECT id FROM pos_customers WHERE LOWER(email) = $1 LIMIT 1`,
            [email],
          );
          existingId = r.rows[0]?.id ?? null;
        }
        if (!existingId && phone) {
          const r = await pool.query<{ id: number }>(
            `SELECT id FROM pos_customers
              WHERE regexp_replace(COALESCE(phone,''),   '[^0-9]', '', 'g') = $1
                 OR regexp_replace(COALESCE(phone_2,''), '[^0-9]', '', 'g') = $1
              LIMIT 1`,
            [phone],
          );
          existingId = r.rows[0]?.id ?? null;
        }

        if (existingId) {
          await pool.query(
            `UPDATE pos_customers SET
                last_name     = COALESCE(last_name,     $1),
                email         = COALESCE(email,         $2),
                email_2       = COALESCE(email_2,       $3),
                phone         = COALESCE(phone,         $4),
                phone_2       = COALESCE(phone_2,       $5),
                birthday      = COALESCE(birthday,      $6::date),
                address_line1 = COALESCE(address_line1, $7),
                address_line2 = COALESCE(address_line2, $8),
                city          = COALESCE(city,          $9),
                state         = COALESCE(state,         $10),
                zip           = COALESCE(zip,           $11),
                country       = COALESCE(country,       $12),
                notes         = COALESCE(notes,         $13)
              WHERE id = $14`,
            [last, email, email2, phone, phone2, birthday, address1, address2, city, state, zip, country, notes, existingId],
          );
          return existingId;
        }

        const ins = await pool.query<{ id: number }>(
          `INSERT INTO pos_customers
             (first_name, last_name, email, email_2, phone, phone_2, birthday,
              address_line1, address_line2, city, state, zip, country,
              notes, pos_location_id, created_by_user_id, created_via, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,$13,
                   $14,$15::int,$16::uuid,'wms_manual', now())
           RETURNING id`,
          [first, last, email, email2, phone, phone2, birthday, address1, address2, city, state, zip, country, notes, locId, session.sub],
        );
        return ins.rows[0].id;
      },
      0,
    );

    if (newId) redirect(`/rewards/customers/${newId}`);
    redirect("/rewards/customers");
  }

  return (
    <main className="p-6 lg:p-8 max-w-3xl max-md:p-4">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-muted-foreground">
          <UserPlus className="h-3.5 w-3.5" />
          Rewards · <Link className="underline" href="/rewards/customers">Customers</Link>
        </div>
        <h1 className="text-2xl font-bold mt-1">Add customer</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Saved to the shared customer record so POS, Rewards and WMS all see
          it. Matched on email + phone — backfills an existing customer instead
          of creating a duplicate.
        </p>
      </header>

      <form action={create} className="border border-border bg-card p-5 space-y-5">
        <Section title="Name">
          <Field label="First name" name="first_name" required />
          <Field label="Last name" name="last_name" />
        </Section>

        <Section title="Contact">
          <Field label="Email" name="email" type="email" />
          <Field label="Email 2" name="email_2" type="email" />
          <Field label="Phone" name="phone" type="tel" />
          <Field label="Phone 2" name="phone_2" type="tel" />
        </Section>
        <p className="text-xs text-muted-foreground -mt-2">
          At least one of email or phone is required so the customer can be
          matched and deduped.
        </p>

        <Section title="Details">
          <Field label="Date of birth" name="birthday" type="date" />
          <label className="flex flex-col gap-1 max-md:min-w-0">
            <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
              Where are you adding them?
            </span>
            <select name="pos_location_id" defaultValue="" className="border border-border bg-card px-3 py-2 text-sm max-md:w-full max-md:min-w-0 max-md:max-w-full max-md:text-base">
              <option value="">Not at a store</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.label}</option>
              ))}
            </select>
          </label>
        </Section>

        <Section title="Address">
          <Field label="Address 1" name="address_line1" full />
          <Field label="Address 2" name="address_line2" full />
          <Field label="City" name="city" />
          <Field label="State" name="state" />
          <Field label="ZIP" name="zip" />
          <Field label="Country" name="country" />
        </Section>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
            Notes (optional)
          </span>
          <textarea name="notes" rows={3} className="border border-border bg-card px-3 py-2 text-sm max-md:text-base" />
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <Link href="/rewards/customers" className="px-4 py-2 border border-border text-sm">Cancel</Link>
          <button type="submit" className="px-4 py-2 border border-border bg-foreground text-background text-sm font-bold hover:opacity-90">
            Add customer
          </button>
        </div>
      </form>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mb-2">{title}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  required,
  full,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  full?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 ${full ? "sm:col-span-2" : ""}`}>
      <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
        {label}{required ? " *" : ""}
      </span>
      <input
        type={type}
        name={name}
        required={required}
        className="border border-border bg-card px-3 py-2 text-sm max-md:text-base"
      />
    </label>
  );
}
