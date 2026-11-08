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
  /** Detailed form (owner 2026-11-08); empty on older applications. */
  tradeName: string | null;
  contactTitle: string | null;
  yearsInBusiness: string | null;
  ein: string | null;
  resalePermitNumber: string | null;
  resalePermitState: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  physicalStore: string | null;
  socialLinks: string[];
  otherLinks: string | null;
  orderSize: string | null;
  brandsCarried: string | null;
  heardFrom: string | null;
  agreedTerms: boolean;
  consentVerify: boolean;
  certificate: { filename: string; mime: string; sizeBytes: number } | null;
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
  trade_name?: string | null;
  contact_title?: string | null;
  years_in_business?: string | null;
  ein?: string | null;
  resale_permit_number?: string | null;
  resale_permit_state?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  physical_store?: string | null;
  social_links?: string[] | null;
  other_links?: string | null;
  order_size?: string | null;
  brands_carried?: string | null;
  heard_from?: string | null;
  agreed_terms?: boolean | null;
  consent_verify?: boolean | null;
  cert_filename?: string | null;
  cert_mime?: string | null;
  cert_size?: number | null;
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
    tradeName: r.trade_name ?? null,
    contactTitle: r.contact_title ?? null,
    yearsInBusiness: r.years_in_business ?? null,
    ein: r.ein ?? null,
    resalePermitNumber: r.resale_permit_number ?? null,
    resalePermitState: r.resale_permit_state ?? null,
    street: r.street ?? null,
    city: r.city ?? null,
    state: r.state ?? null,
    zip: r.zip ?? null,
    country: r.country ?? null,
    physicalStore: r.physical_store ?? null,
    socialLinks: r.social_links ?? [],
    otherLinks: r.other_links ?? null,
    orderSize: r.order_size ?? null,
    brandsCarried: r.brands_carried ?? null,
    heardFrom: r.heard_from ?? null,
    agreedTerms: Boolean(r.agreed_terms),
    consentVerify: Boolean(r.consent_verify),
    certificate: r.cert_filename ? { filename: r.cert_filename, mime: r.cert_mime ?? "", sizeBytes: Number(r.cert_size ?? 0) } : null,
  };
}

/** Social sites accepted as "direct links to current social accounts". */
const SOCIAL_HOSTS = [
  "instagram.com", "facebook.com", "fb.com", "tiktok.com", "x.com", "twitter.com", "linkedin.com",
  "pinterest.com", "youtube.com", "threads.net", "snapchat.com",
];

/**
 * Split the social-links box (one per line, or commas) into profile URLs on a
 * known social site with a path (a profile, not just the home page).
 * Returns null when any entry is not such a link.
 */
export function parseSocialLinks(raw: unknown): string[] | null {
  if (typeof raw !== "string") return [];
  const parts = raw.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean).slice(0, 8);
  const out: string[] = [];
  for (const p of parts) {
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(p) ? p : `https://${p}`);
    } catch {
      return null;
    }
    const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
    if (!SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return null;
    if (u.pathname.replace(/\/+$/, "").length < 2) return null;
    out.push(`https://${host}${u.pathname.replace(/\/+$/, "")}`.slice(0, 300));
  }
  return out;
}

/** EIN: 9 digits, shown as 12-3456789. Null when it is not 9 digits. */
export function normalizeEin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const d = raw.replace(/\D/g, "");
  return d.length === 9 ? `${d.slice(0, 2)}-${d.slice(2)}` : null;
}

export const MAX_CERTIFICATE_BYTES = 10 * 1024 * 1024;

/** PDF / JPEG / PNG / HEIC / WEBP by their first bytes (never trust the browser's type). */
export function sniffCertificate(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length < 12) return null;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  const ftyp = String.fromCharCode(b[4], b[5], b[6], b[7]);
  if (ftyp === "ftyp") {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]).toLowerCase();
    if (/^(heic|heix|hevc|mif1|msf1|heim|heis)$/.test(brand)) return "image/heic";
  }
  return null;
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

export type DetailedApplyInput = {
  fields: Record<string, unknown>;
  file: { name: string; bytes: Uint8Array } | null;
  ip: string | null;
  ua: string;
};

export type DetailedApplyAnswer =
  | { ok: true; id: number | null; isNew: boolean }
  | { ok: false; error: "invalid"; field: string }
  | { ok: false; error: "too_many" | "busy" | "server" };

/**
 * The detailed Wholesale form (owner 2026-11-08). Everything below is required
 * unless marked optional; the answer names the first field that is wrong so
 * the page can point at it. Returns before writing anything when it fails.
 */
export async function submitDetailedApplication(pool: Pool, input: DetailedApplyInput): Promise<DetailedApplyAnswer> {
  const f = input.fields;
  if (screenRequest({ honeypot: f.hp, openMs: f.t, ua: input.ua }) || isAutomationUa(input.ua)) {
    return { ok: true, id: null, isNew: false };
  }
  const bad = (field: string): DetailedApplyAnswer => ({ ok: false, error: "invalid", field });

  const contactName = text(f.name, 120);
  if (!contactName) return bad("name");
  const email = normalizeEmail(f.email);
  if (!email) return bad("email");
  const phone = text(f.phone, 40);
  if (!phone || phone.replace(/\D/g, "").length < 7) return bad("phone");
  const businessName = text(f.business, 160);
  if (!businessName) return bad("business");
  const storeType = text(f.store_type, 80);
  if (!storeType) return bad("store_type");
  // Tax proof (owner 2026-11-08): any ONE of EIN, resale permit number or the
  // certificate file is enough. A typed EIN must still be a real 9-digit EIN.
  const einRaw = text(f.ein, 20);
  const ein = einRaw ? normalizeEin(einRaw) : null;
  if (einRaw && !ein) return bad("ein");
  const permitNumber = text(f.permit_number, 60);
  const permitState = text(f.permit_state, 60);
  if (!permitState) return bad("permit_state");
  const street = text(f.street, 200);
  if (!street) return bad("street");
  const city = text(f.city, 100);
  if (!city) return bad("city");
  const state = text(f.state, 60);
  if (!state) return bad("state");
  const zip = text(f.zip, 20);
  if (!zip) return bad("zip");
  const country = text(f.country, 60) ?? "United States";
  const social = parseSocialLinks(f.social);
  if (!social || social.length === 0) return bad("social");
  if (f.agree_terms !== "on" && f.agree_terms !== "true") return bad("agree_terms");
  if (f.consent_verify !== "on" && f.consent_verify !== "true") return bad("consent_verify");
  const file = input.file && input.file.bytes.length > 0 ? input.file : null;
  if (file && file.bytes.length > MAX_CERTIFICATE_BYTES) return bad("certificate");
  const mime = file ? sniffCertificate(file.bytes) : null;
  if (file && !mime) return bad("certificate");
  if (!ein && !permitNumber && !file) return bad("tax_proof");

  const limits = await pool.query<{ ip_day: string; hour: string }>(
    `SELECT count(*) FILTER (WHERE ip = $1 AND created_at > now() - interval '24 hours') AS ip_day,
            count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS hour
       FROM wholesale_applications`,
    [input.ip],
  );
  if (input.ip && Number(limits.rows[0]?.ip_day ?? 0) >= MAX_APPLICATIONS_PER_IP_PER_DAY) return { ok: false, error: "too_many" };
  if (Number(limits.rows[0]?.hour ?? 0) >= MAX_APPLICATIONS_PER_HOUR) return { ok: false, error: "busy" };

  const message = typeof f.message === "string" ? f.message.trim().slice(0, 2000) || null : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<{ id: string }>(
      `INSERT INTO wholesale_applications
         (business_name, contact_name, email, phone, city_state, website, store_type, message, source_path, ip, user_agent,
          trade_name, contact_title, years_in_business, ein, resale_permit_number, resale_permit_state,
          street, city, state, zip, country, physical_store, social_links, other_links, order_size,
          brands_carried, heard_from, agreed_terms, consent_verify)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, true, true)
       RETURNING id`,
      [
        businessName, contactName, email, phone, `${city}, ${state}`, text(f.website, 200), storeType, message,
        text(f.p, 200), input.ip, input.ua.slice(0, 300),
        text(f.trade_name, 160), text(f.title, 80), text(f.years, 40), ein, permitNumber, permitState,
        street, city, state, zip, country, text(f.physical_store, 20), social,
        typeof f.other_links === "string" ? f.other_links.trim().slice(0, 1000) || null : null,
        text(f.order_size, 60), text(f.brands, 300), text(f.heard_from, 120),
      ],
    );
    const id = Number(r.rows[0].id);
    if (file && mime) {
      const safeName = (file.name || "certificate").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
      await client.query(
        `INSERT INTO wholesale_application_files (application_id, kind, filename, mime, size_bytes, data)
         VALUES ($1, 'resale_certificate', $2, $3, $4, $5)`,
        [id, safeName, mime, file.bytes.length, Buffer.from(file.bytes)],
      );
    }
    await client.query("COMMIT");
    return { ok: true, id, isNew: true };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** The uploaded resale certificate for an application (admins only — see the route). */
export async function getCertificate(pool: Pool, id: number): Promise<{ filename: string; mime: string; data: Buffer } | null> {
  const r = await pool.query<{ filename: string; mime: string; data: Buffer }>(
    `SELECT filename, mime, data FROM wholesale_application_files
      WHERE application_id = $1 AND kind = 'resale_certificate' ORDER BY id DESC LIMIT 1`,
    [id],
  );
  return r.rows[0] ?? null;
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
    `SELECT a.*, f.filename AS cert_filename, f.mime AS cert_mime, f.size_bytes AS cert_size
       FROM wholesale_applications a
       LEFT JOIN LATERAL (
         SELECT filename, mime, size_bytes FROM wholesale_application_files
          WHERE application_id = a.id AND kind = 'resale_certificate' ORDER BY id DESC LIMIT 1
       ) f ON true
      ORDER BY (a.status = 'new') DESC, a.created_at DESC
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
        row.trade_name ? `Store: ${row.trade_name}` : null,
        row.city_state,
        row.store_type,
        row.ein ? `EIN ${row.ein}` : null,
        row.resale_permit_number ? `Resale permit ${row.resale_permit_number}${row.resale_permit_state ? ` (${row.resale_permit_state})` : ""}` : null,
        row.website,
        ...(row.social_links ?? []),
        row.phone ? `Phone ${row.phone}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
        .slice(0, 5000);
      // The detailed form gives a full address: the location ships and bills there.
      const address =
        row.street && row.city && row.zip
          ? {
              recipient: row.trade_name || row.business_name,
              address1: row.street,
              city: row.city,
              zip: row.zip,
              countryCode: /^(us|usa|united states)/i.test(row.country ?? "United States") ? "US" : undefined,
              ...(row.state && /^[A-Za-z]{2}$/.test(row.state) ? { zoneCode: row.state.toUpperCase() } : {}),
              ...(row.phone ? { phone: row.phone } : {}),
            }
          : null;
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
              ...(row.resale_permit_number ? { taxRegistrationId: row.resale_permit_number.slice(0, 50) } : {}),
              ...(address && address.countryCode ? { shippingAddress: address, billingSameAsShipping: true } : {}),
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

    // Tag the buyer "wholesale" (owner 2026-11-08): the ShipRight checkout rule
    // hides every carrier (UPS/FedEx/DHL) for customers with this tag — shipping
    // is invoiced after packing. tagsAdd is idempotent, so a retry is fine.
    const tagged = await welcomeGql<{ tagsAdd: { userErrors: UserError[] } }>(
      ctx,
      `mutation WholesaleTag($id: ID!) { tagsAdd(id: $id, tags: ["wholesale"]) { userErrors { field message } } }`,
      { id: contact.customer.id },
    );
    if (tagged.tagsAdd.userErrors.length) {
      await fail(`Shopify did not tag the buyer "wholesale": ${userErrorText(tagged.tagsAdd.userErrors)}`);
    }

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
