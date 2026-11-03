/**
 * Wholesale applications (owner 2026-11-03).
 *
 * The /pages/wholesale form (theme section carbon-wholesale-after-dark) posts to
 * Shopify as it always has — Shopify emails it to the store contact address —
 * and also sends a copy to /api/storefront/wholesale-apply. That copy lands
 * here: one row per application, a "wholesale" push alert, and a list in
 * Shopify → Wholesale where the owner approves or declines.
 *
 * Approve = the Shopify side of a wholesale account: a company named after the
 * business, one location, the applicant as its buyer (Location admin, main
 * contact), tax-exempt, pay at checkout, then Shopify's customer account invite email.
 * Pricing and minimums need nothing here: the "Wholesale" B2B market covers
 * every company location, so the new company gets the B2B catalog (retail ÷
 * 2.1) and its quantity rules automatically (scripts/b2b-wholesale.mjs).
 *
 * Approve can be retried: a company already created for the row is reused,
 * so a step that failed half-way picks up where it stopped.
 */
import type { Pool } from "pg";
import { isAutomationUa } from "@/lib/server/shield/networks";
import { normalizeEmail, screenRequest } from "@/lib/server/welcome/rules";
import { userErrorText, welcomeGql, welcomeShopCtx } from "@/lib/server/welcome/config";
import { sendPush } from "@/lib/server/web-push";

/** Bots and repeat senders, like the email popup's limits. */
export const MAX_APPLICATIONS_PER_IP_PER_DAY = 3;
export const MAX_APPLICATIONS_PER_HOUR = 30;

export type WholesaleStatus = "new" | "approved" | "declined";

export type WholesaleApplication = {
  id: number;
  status: WholesaleStatus;
  businessName: string;
  contactName: string | null;
  email: string;
  phone: string | null;
  cityState: string;
  website: string | null;
  storeType: string | null;
  message: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  shopifyCompanyGid: string | null;
  welcomeEmailSent: boolean;
  lastError: string | null;
};

type Row = {
  id: string;
  status: WholesaleStatus;
  business_name: string;
  contact_name: string | null;
  email: string;
  phone: string | null;
  city_state: string;
  website: string | null;
  store_type: string | null;
  message: string | null;
  created_at: Date;
  decided_at: Date | null;
  decided_by_email: string | null;
  shopify_company_gid: string | null;
  shopify_customer_gid: string | null;
  welcome_email_sent: boolean;
  last_error: string | null;
};

function toApp(r: Row): WholesaleApplication {
  return {
    id: Number(r.id),
    status: r.status,
    businessName: r.business_name,
    contactName: r.contact_name,
    email: r.email,
    phone: r.phone,
    cityState: r.city_state,
    website: r.website,
    storeType: r.store_type,
    message: r.message,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
    decidedBy: r.decided_by_email,
    shopifyCompanyGid: r.shopify_company_gid,
    welcomeEmailSent: r.welcome_email_sent,
    lastError: r.last_error,
  };
}

/** Trimmed text, cut to `max`; empty → null. */
function text(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\s+/g, " ").trim().slice(0, max);
  return t || null;
}

export type ApplyInput = {
  businessName: unknown;
  contactName: unknown;
  email: unknown;
  phone: unknown;
  cityState: unknown;
  website: unknown;
  storeType: unknown;
  message: unknown;
  honeypot: unknown;
  openMs: unknown;
  path: unknown;
  ip: string | null;
  ua: string;
};

export type ApplyAnswer =
  | { ok: true; id: number; isNew: boolean }
  | { ok: false; error: "invalid" | "too_many" | "busy" | "server" }
  /** Screened out as a bot: answered like a success so it learns nothing. */
  | { ok: true; id: null; isNew: false };

export async function submitApplication(pool: Pool, input: ApplyInput): Promise<ApplyAnswer> {
  if (screenRequest({ honeypot: input.honeypot, openMs: input.openMs, ua: input.ua }) || isAutomationUa(input.ua)) {
    return { ok: true, id: null, isNew: false };
  }
  const email = normalizeEmail(input.email);
  const businessName = text(input.businessName, 160);
  const cityState = text(input.cityState, 160);
  if (!email || !businessName || !cityState) return { ok: false, error: "invalid" };

  const limits = await pool.query<{ ip_day: string; hour: string }>(
    `SELECT count(*) FILTER (WHERE ip = $1 AND created_at > now() - interval '24 hours') AS ip_day,
            count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS hour
       FROM wholesale_applications`,
    [input.ip],
  );
  const fields = [
    businessName,
    text(input.contactName, 120),
    email,
    text(input.phone, 40),
    cityState,
    text(input.website, 200),
    text(input.storeType, 80),
    typeof input.message === "string" ? input.message.trim().slice(0, 2000) || null : null,
    text(input.path, 200),
    input.ip,
    input.ua.slice(0, 300),
  ];

  // The same applicant sending again within a day (double click, resend): update, no new alert.
  const again = await pool.query<{ id: string }>(
    `UPDATE wholesale_applications
        SET contact_name = $2, phone = $4, city_state = $5, website = $6, store_type = $7,
            message = COALESCE($8, message), updated_at = now()
      WHERE id = (SELECT id FROM wholesale_applications
                   WHERE email = $3 AND lower(business_name) = lower($1) AND status = 'new'
                     AND created_at > now() - interval '24 hours'
                   ORDER BY id DESC LIMIT 1)
      RETURNING id`,
    fields.slice(0, 8),
  );
  if (again.rows[0]) return { ok: true, id: Number(again.rows[0].id), isNew: false };

  if (input.ip && Number(limits.rows[0]?.ip_day ?? 0) >= MAX_APPLICATIONS_PER_IP_PER_DAY) return { ok: false, error: "too_many" };
  if (Number(limits.rows[0]?.hour ?? 0) >= MAX_APPLICATIONS_PER_HOUR) return { ok: false, error: "busy" };

  const r = await pool.query<{ id: string }>(
    `INSERT INTO wholesale_applications
       (business_name, contact_name, email, phone, city_state, website, store_type, message, source_path, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    fields,
  );
  return { ok: true, id: Number(r.rows[0].id), isNew: true };
}

/** The phone alert for a new application. Never throws. */
export async function alertNewApplication(pool: Pool, id: number): Promise<void> {
  try {
    const r = await pool.query<Pick<Row, "business_name" | "city_state" | "store_type">>(
      `SELECT business_name, city_state, store_type FROM wholesale_applications WHERE id = $1`,
      [id],
    );
    const a = r.rows[0];
    if (!a) return;
    await sendPush(pool, {
      kind: "wholesale",
      title: "New wholesale application",
      body: [a.business_name, a.city_state, a.store_type].filter(Boolean).join(" · "),
      url: `/shopify/wholesale?application=${id}`,
      tag: `wholesale-${id}`,
      sound: "orders",
    });
  } catch (e) {
    console.error("[wholesale] alert failed", e);
  }
}

export async function listApplications(pool: Pool): Promise<{ applications: WholesaleApplication[]; counts: Record<WholesaleStatus, number> }> {
  const r = await pool.query<Row>(
    `SELECT id, status, business_name, contact_name, email, phone, city_state, website, store_type, message,
            created_at, decided_at, decided_by_email, shopify_company_gid, shopify_customer_gid,
            welcome_email_sent, last_error
       FROM wholesale_applications
      ORDER BY (status = 'new') DESC, created_at DESC
      LIMIT 500`,
  );
  const counts: Record<WholesaleStatus, number> = { new: 0, approved: 0, declined: 0 };
  for (const row of r.rows) counts[row.status]++;
  return { applications: r.rows.map(toApp), counts };
}

async function loadRow(pool: Pool, id: number): Promise<Row | null> {
  const r = await pool.query<Row>(`SELECT * FROM wholesale_applications WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function declineApplication(pool: Pool, id: number, by: string | null): Promise<WholesaleApplication | null> {
  const r = await pool.query<Row>(
    `UPDATE wholesale_applications
        SET status = 'declined', decided_at = now(), decided_by_email = $2, updated_at = now()
      WHERE id = $1 AND status = 'new'
      RETURNING *`,
    [id, by],
  );
  if (r.rows[0]) return toApp(r.rows[0]);
  const row = await loadRow(pool, id);
  return row ? toApp(row) : null;
}

type UserError = { field?: string[] | null; message: string; code?: string | null };

function splitName(full: string | null): { firstName?: string; lastName?: string } {
  if (!full) return {};
  const parts = full.split(" ");
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

export class ApproveError extends Error {}

/**
 * Create the Shopify company + buyer for an application and send Shopify's
 * welcome email. Throws ApproveError with a sentence for the owner.
 */
export async function approveApplication(pool: Pool, id: number, by: string | null): Promise<WholesaleApplication> {
  const row = await loadRow(pool, id);
  if (!row) throw new ApproveError("Application not found");
  if (row.status === "approved") return toApp(row);
  if (row.status === "declined") throw new ApproveError("This application was declined");

  const ctx = await welcomeShopCtx();
  if (!ctx) throw new ApproveError("Shopify is not connected");

  const fail = async (msg: string): Promise<never> => {
    await pool.query(`UPDATE wholesale_applications SET last_error = $2, updated_at = now() WHERE id = $1`, [id, msg]);
    throw new ApproveError(msg);
  };

  try {
    // 1. The company (reused when an earlier attempt already made it).
    let companyId = row.shopify_company_gid;
    if (!companyId) {
      const note = [
        `Wholesale application #${row.id} (CarbonWMS)`,
        row.city_state,
        row.store_type,
        row.website,
        row.phone ? `Phone ${row.phone}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const c = await welcomeGql<{ companyCreate: { company: { id: string } | null; userErrors: UserError[] } }>(
        ctx,
        `mutation WholesaleCompany($input: CompanyCreateInput!) {
          companyCreate(input: $input) { company { id } userErrors { field message code } }
        }`,
        {
          input: {
            company: { name: row.business_name, note },
            companyLocation: {
              name: row.city_state,
              // Pay at checkout: no payment terms, orders not held as drafts.
              buyerExperienceConfiguration: { checkoutToDraft: false, editableShippingAddress: true },
              // No sales tax: company to company, the buyer resells (owner 2026-11-03).
              taxExempt: true,
            },
          },
        },
      );
      if (!c.companyCreate.company) await fail(`Shopify did not create the company: ${userErrorText(c.companyCreate.userErrors)}`);
      companyId = c.companyCreate.company!.id;
      await pool.query(`UPDATE wholesale_applications SET shopify_company_gid = $2, updated_at = now() WHERE id = $1`, [id, companyId]);
    }

    const company = await welcomeGql<{
      company: {
        locations: { nodes: { id: string }[] };
        contactRoles: { nodes: { id: string; name: string }[] };
        contacts: { nodes: { id: string; customer: { id: string; email: string | null } }[] };
      } | null;
    }>(
      ctx,
      `query WholesaleCompanyParts($id: ID!) {
        company(id: $id) {
          locations(first: 1) { nodes { id } }
          contactRoles(first: 5) { nodes { id name } }
          contacts(first: 20) { nodes { id customer { id email } } }
        }
      }`,
      { id: companyId },
    );
    if (!company.company) await fail("The Shopify company for this application no longer exists");
    const locationId = company.company!.locations.nodes[0]?.id;
    const adminRole = company.company!.contactRoles.nodes.find((r) => /admin/i.test(r.name)) ?? company.company!.contactRoles.nodes[0];
    if (!locationId || !adminRole) await fail("The Shopify company has no location or buyer roles");

    // 2. The buyer: the applicant's existing Shopify customer, or a new one.
    let contact = company.company!.contacts.nodes.find((c) => c.customer.email?.toLowerCase() === row.email);
    if (!contact) {
      const existing = await welcomeGql<{ customers: { nodes: { id: string }[] } }>(
        ctx,
        `query WholesaleCustomer($q: String!) { customers(first: 1, query: $q) { nodes { id } } }`,
        { q: `email:"${row.email.replace(/"/g, "")}"` },
      );
      const customerId = existing.customers.nodes[0]?.id;
      if (customerId) {
        const a = await welcomeGql<{
          companyAssignCustomerAsContact: { companyContact: { id: string; customer: { id: string; email: string | null } } | null; userErrors: UserError[] };
        }>(
          ctx,
          `mutation WholesaleAssignCustomer($companyId: ID!, $customerId: ID!) {
            companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
              companyContact { id customer { id email } } userErrors { field message code }
            }
          }`,
          { companyId, customerId },
        );
        if (!a.companyAssignCustomerAsContact.companyContact) {
          await fail(`Shopify did not add the buyer: ${userErrorText(a.companyAssignCustomerAsContact.userErrors)}`);
        }
        contact = a.companyAssignCustomerAsContact.companyContact!;
      } else {
        const n = await welcomeGql<{
          companyContactCreate: { companyContact: { id: string; customer: { id: string; email: string | null } } | null; userErrors: UserError[] };
        }>(
          ctx,
          `mutation WholesaleContact($companyId: ID!, $input: CompanyContactInput!) {
            companyContactCreate(companyId: $companyId, input: $input) {
              companyContact { id customer { id email } } userErrors { field message code }
            }
          }`,
          { companyId, input: { email: row.email, ...splitName(row.contact_name) } },
        );
        if (!n.companyContactCreate.companyContact) {
          await fail(`Shopify did not create the buyer: ${userErrorText(n.companyContactCreate.userErrors)}`);
        }
        contact = n.companyContactCreate.companyContact!;
      }
    }
    await pool.query(`UPDATE wholesale_applications SET shopify_customer_gid = $2, updated_at = now() WHERE id = $1`, [
      id,
      contact.customer.id,
    ]);

    // 3. Ordering rights on the location + main contact. Shopify refuses a role
    //    the contact already has; that is fine on a retry.
    const role = await welcomeGql<{ companyContactAssignRole: { userErrors: UserError[] } }>(
      ctx,
      `mutation WholesaleRole($c: ID!, $r: ID!, $l: ID!) {
        companyContactAssignRole(companyContactId: $c, companyContactRoleId: $r, companyLocationId: $l) { userErrors { field message code } }
      }`,
      { c: contact.id, r: adminRole!.id, l: locationId },
    );
    const roleErr = role.companyContactAssignRole.userErrors.filter((e) => !/already/i.test(e.message));
    if (roleErr.length) await fail(`Shopify did not give the buyer ordering rights: ${userErrorText(roleErr)}`);
    await welcomeGql(
      ctx,
      `mutation WholesaleMain($companyId: ID!, $c: ID!) {
        companyAssignMainContact(companyId: $companyId, companyContactId: $c) { userErrors { field message } }
      }`,
      { companyId, c: contact.id },
    );

    // 4. Shopify emails the buyer (owner: always). Shopify's B2B welcome email
    //    (companyContactSendWelcomeEmail) is refused on our plan, so this is the
    //    customer account invite — Settings → Notifications → Customer account
    //    invite in Shopify holds its wording.
    let emailed = row.welcome_email_sent;
    if (!emailed) {
      const w = await welcomeGql<{ customerSendAccountInviteEmail: { userErrors: UserError[] } }>(
        ctx,
        `mutation WholesaleInvite($id: ID!) {
          customerSendAccountInviteEmail(customerId: $id) { userErrors { field message } }
        }`,
        { id: contact.customer.id },
      );
      if (w.customerSendAccountInviteEmail.userErrors.length) {
        await fail(`The account is ready, but Shopify did not send the email: ${userErrorText(w.customerSendAccountInviteEmail.userErrors)}`);
      }
      emailed = true;
    }

    const done = await pool.query<Row>(
      `UPDATE wholesale_applications
          SET status = 'approved', decided_at = now(), decided_by_email = $2, welcome_email_sent = $3,
              last_error = NULL, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, by, emailed],
    );
    return toApp(done.rows[0]);
  } catch (e) {
    if (e instanceof ApproveError) throw e;
    return fail(e instanceof Error ? e.message : "Shopify could not be reached");
  }
}
