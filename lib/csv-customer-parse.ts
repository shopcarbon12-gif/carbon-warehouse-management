/**
 * Pure CSV / spreadsheet parsing + column normalisation for the Rewards
 * customer import. No `pg`, no `exceljs`, no node-only APIs — safe to import
 * from both client components (for the header list + types) and server code.
 *
 * Maps an arbitrary customer export onto the columns that already exist on
 * `pos_customers` (the shared POS / Rewards / WMS table). Every field except
 * the source system's "Customer ID" has a real column; the Customer ID is
 * preserved as a `srcid:<value>` tag so nothing is lost.
 */

export type ParsedRow = {
  rowIndex: number;
  external_id: string | null; // CSV "Customer ID" (source system's id)
  first_name: string | null;
  last_name: string | null;
  birthday: string | null; // CSV "DOB" -> yyyy-mm-dd
  created_at: string | null; // CSV "Created At" -> ISO, or null
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null; // CSV "Phone 1"
  phone_2: string | null; // CSV "Phone 2"
  email: string | null; // CSV "Email 1"
  email_2: string | null; // CSV "Email 2"
  notes: string | null; // CSV "Note"
  points: string | null; // CSV "Points" — shown in preview, NOT imported here
  raw: Record<string, string>;
};

/** Display columns + order for the preview table — exactly as requested. */
export const CUSTOMER_PREVIEW_COLUMNS: {
  header: string;
  field: keyof ParsedRow;
}[] = [
  { header: "Customer ID", field: "external_id" },
  { header: "First Name", field: "first_name" },
  { header: "Last Name", field: "last_name" },
  { header: "DOB", field: "birthday" },
  { header: "Created At", field: "created_at" },
  { header: "Address1", field: "address_line1" },
  { header: "Address2", field: "address_line2" },
  { header: "City", field: "city" },
  { header: "State", field: "state" },
  { header: "ZIP", field: "zip" },
  { header: "Country", field: "country" },
  { header: "Phone 1", field: "phone" },
  { header: "Phone 2", field: "phone_2" },
  { header: "Email 1", field: "email" },
  { header: "Email 2", field: "email_2" },
  { header: "Note", field: "notes" },
  { header: "Points", field: "points" },
];

// Field -> recognised header aliases (compared lowercased + trimmed).
const COL_ALIASES: Partial<Record<keyof ParsedRow, string[]>> = {
  external_id: ["customer id", "customer_id", "customerid", "id", "cust id", "customer number"],
  first_name: ["first name", "first_name", "firstname", "first", "given name", "given_name"],
  last_name: ["last name", "last_name", "lastname", "last", "family name", "family_name", "surname"],
  birthday: ["dob", "birthday", "birth date", "birth_date", "date of birth"],
  created_at: ["created at", "created_at", "createdat", "created", "created date", "date created", "signup date"],
  address_line1: ["address1", "address 1", "address_line1", "address line 1", "addressline1", "address", "street", "street1", "street 1"],
  address_line2: ["address2", "address 2", "address_line2", "address line 2", "addressline2", "street2", "street 2", "apt", "suite", "unit"],
  city: ["city", "town"],
  state: ["state", "province", "region"],
  zip: ["zip", "zip code", "zipcode", "postal code", "postalcode", "postcode", "postal"],
  country: ["country"],
  phone: ["phone 1", "phone1", "phone", "mobile", "mobile phone", "mobile_phone", "phone number", "cell", "telephone", "tel"],
  phone_2: ["phone 2", "phone2", "alt phone", "alternate phone", "secondary phone", "home phone", "work phone"],
  email: ["email 1", "email1", "email", "e-mail", "email address"],
  email_2: ["email 2", "email2", "alt email", "alternate email", "secondary email"],
  notes: ["note", "notes", "comment", "comments"],
  points: ["points", "points balance", "reward points", "loyalty points"],
};

const normEmail = (s: string) => s.trim().toLowerCase();
const normPhone = (s: string) => s.replace(/[^\d]/g, "");

function normBirthday(s: string): string {
  if (!s) return "";
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const mdy = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const [, a, b, y] = mdy;
    return `${y}-${a.padStart(2, "0")}-${b.padStart(2, "0")}`;
  }
  return "";
}

function normCreatedAt(s: string): string | null {
  if (!s) return null;
  const d = new Date(s.trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Build a normalised row from a header->value map and a 1-based row index. */
export function rowFromObject(
  obj: Record<string, string>,
  rowIndex: number,
  colMap: Partial<Record<keyof ParsedRow, string>>,
): ParsedRow {
  const get = (k: keyof ParsedRow) => {
    const h = colMap[k];
    return h ? (obj[h] ?? "").trim() : "";
  };
  return {
    rowIndex,
    external_id: get("external_id") || null,
    first_name: get("first_name") || null,
    last_name: get("last_name") || null,
    birthday: normBirthday(get("birthday")) || null,
    created_at: normCreatedAt(get("created_at")),
    address_line1: get("address_line1") || null,
    address_line2: get("address_line2") || null,
    city: get("city") || null,
    state: get("state") || null,
    zip: get("zip") || null,
    country: get("country") || null,
    phone: normPhone(get("phone")) || null,
    phone_2: normPhone(get("phone_2")) || null,
    email: normEmail(get("email")) || null,
    email_2: normEmail(get("email_2")) || null,
    notes: get("notes") || null,
    points: get("points") || null,
    raw: obj,
  };
}

/** Map lowercased headers -> ParsedRow field. */
export function buildColMap(headers: string[]): Partial<Record<keyof ParsedRow, string>> {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const colMap: Partial<Record<keyof ParsedRow, string>> = {};
  for (const key of Object.keys(COL_ALIASES) as (keyof ParsedRow)[]) {
    const aliases = COL_ALIASES[key] ?? [];
    const idx = lower.findIndex((h) => aliases.includes(h));
    if (idx >= 0) colMap[key] = headers[idx];
  }
  return colMap;
}

/** Turn a matrix (header row + data rows) into normalised rows. */
export function rowsFromMatrix(matrix: string[][]): {
  headers: string[];
  rows: ParsedRow[];
  errors: string[];
} {
  const errors: string[] = [];
  if (matrix.length === 0) return { headers: [], rows: [], errors: ["empty file"] };
  const headers = (matrix[0] ?? []).map((h) => String(h ?? "").trim());
  if (headers.length === 0 || headers.every((h) => h === ""))
    return { headers: [], rows: [], errors: ["no headers detected"] };

  const colMap = buildColMap(headers);
  if (colMap.email === undefined && colMap.phone === undefined) {
    errors.push("File must include an Email or Phone column so customers can be matched.");
  }

  const rows: ParsedRow[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const cells = matrix[i] ?? [];
    if (cells.every((c) => String(c ?? "").trim() === "")) continue;
    const obj: Record<string, string> = {};
    headers.forEach((h, j) => (obj[h] = String(cells[j] ?? "").trim()));
    rows.push(rowFromObject(obj, i, colMap));
  }
  return { headers, rows, errors };
}

/** RFC-4180-ish CSV splitter (quotes, escaped quotes, embedded newlines). */
export function splitCsv(s: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQ = false;
  const text = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { cur.push(field); field = ""; }
      else if (c === "\n") { cur.push(field); out.push(cur); cur = []; field = ""; }
      else field += c;
    }
  }
  if (field.length || cur.length) { cur.push(field); out.push(cur); }
  return out;
}

/** Parse raw CSV text into normalised rows. */
export function parseCsv(text: string): {
  headers: string[];
  rows: ParsedRow[];
  errors: string[];
} {
  return rowsFromMatrix(splitCsv(text));
}

export function identityLabel(r: ParsedRow): string {
  if (r.email) return r.email;
  if (r.phone) return r.phone;
  return [r.first_name, r.last_name].filter(Boolean).join(" ") || `row ${r.rowIndex}`;
}
