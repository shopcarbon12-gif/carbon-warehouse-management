import type { PoolClient } from "pg";
import { getPool } from "./db";
import {
  type ParsedRow,
  identityLabel,
  parseCsv,
} from "./csv-customer-parse";

/**
 * Bulk customer importer for the WMS Rewards → Customers surface. Writes to
 * `pos_customers` — the table shared by POS, Rewards and WMS — so an imported
 * customer is immediately visible in all three. Stamps:
 *
 *   created_via        = 'wms_csv'
 *   created_by_user_id = WMS user id
 *   pos_location_id    = optional, picked at upload time
 *
 * Matches existing customers on email + phone (falling back to either alone)
 * and backfills missing fields — re-running the same file is safe. No loyalty
 * balance is written here (the Rewards service owns the points ledger); the
 * CSV "Points" column is shown in the preview but intentionally not imported.
 */

export type { ParsedRow };
export { parseCsv };

export type RowOutcome = {
  rowIndex: number;
  status: "matched" | "created" | "skipped" | "error";
  pos_customer_id?: number;
  message?: string;
  identity?: string;
};

export type ImportSummary = {
  total: number;
  matched: number;
  created: number;
  skipped: number;
  errors: number;
  outcomes: RowOutcome[];
};

export async function importRows(
  rows: ParsedRow[],
  opts: { actedByUserId: string; createdAtLocationId: number | null },
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    total: rows.length,
    matched: 0,
    created: 0,
    skipped: 0,
    errors: 0,
    outcomes: [],
  };

  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL not configured");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      try {
        const o = await upsertOne(client, row, opts);
        summary.outcomes.push(o);
        summary[o.status === "error" ? "errors" : o.status]++;
      } catch (err) {
        summary.errors++;
        summary.outcomes.push({
          rowIndex: row.rowIndex,
          status: "error",
          message: (err as Error).message ?? "unknown",
          identity: identityLabel(row),
        });
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return summary;
}

async function findMatchId(
  client: PoolClient,
  row: ParsedRow,
): Promise<number | null> {
  if (row.email && row.phone) {
    const r = await client.query<{ id: number }>(
      `SELECT id FROM pos_customers
        WHERE LOWER(email) = $1
          AND (regexp_replace(COALESCE(phone,''),   '[^0-9]', '', 'g') = $2
               OR regexp_replace(COALESCE(phone_2,''), '[^0-9]', '', 'g') = $2)
        LIMIT 1`,
      [row.email, row.phone],
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  if (row.email) {
    const r = await client.query<{ id: number }>(
      `SELECT id FROM pos_customers WHERE LOWER(email) = $1 LIMIT 1`,
      [row.email],
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  if (row.phone) {
    const r = await client.query<{ id: number }>(
      `SELECT id FROM pos_customers
        WHERE regexp_replace(COALESCE(phone,''),   '[^0-9]', '', 'g') = $1
           OR regexp_replace(COALESCE(phone_2,''), '[^0-9]', '', 'g') = $1
        LIMIT 1`,
      [row.phone],
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  return null;
}

async function upsertOne(
  client: PoolClient,
  row: ParsedRow,
  opts: { actedByUserId: string; createdAtLocationId: number | null },
): Promise<RowOutcome> {
  if (!row.email && !row.phone) {
    return {
      rowIndex: row.rowIndex,
      status: "skipped",
      message: "no email or phone — can't match",
      identity: identityLabel(row),
    };
  }

  const matchId = await findMatchId(client, row);

  if (matchId) {
    // Backfill: only fill columns that are currently empty, never overwrite.
    await client.query(
      `UPDATE pos_customers SET
          first_name    = COALESCE(NULLIF(first_name,''), $1, first_name),
          last_name     = COALESCE(last_name,     $2),
          email         = COALESCE(email,         $3),
          email_2       = COALESCE(email_2,       $4),
          phone         = COALESCE(phone,         $5),
          phone_2       = COALESCE(phone_2,       $6),
          birthday      = COALESCE(birthday,      $7::date),
          address_line1 = COALESCE(address_line1, $8),
          address_line2 = COALESCE(address_line2, $9),
          city          = COALESCE(city,          $10),
          state         = COALESCE(state,         $11),
          zip           = COALESCE(zip,           $12),
          country       = COALESCE(country,       $13),
          notes         = COALESCE(notes,         $14)
        WHERE id = $15`,
      [
        row.first_name, row.last_name, row.email, row.email_2,
        row.phone, row.phone_2, row.birthday,
        row.address_line1, row.address_line2, row.city, row.state, row.zip, row.country,
        row.notes, matchId,
      ],
    );
    return {
      rowIndex: row.rowIndex,
      status: "matched",
      pos_customer_id: matchId,
      identity: identityLabel(row),
    };
  }

  // first_name is NOT NULL on pos_customers — fall back to a sensible label.
  const firstName =
    row.first_name || row.last_name || row.email || row.phone || "Customer";
  const tags = row.external_id ? [`srcid:${row.external_id}`] : null;

  const ins = await client.query<{ id: number }>(
    `INSERT INTO pos_customers
       (first_name, last_name, email, email_2, phone, phone_2, birthday,
        address_line1, address_line2, city, state, zip, country,
        notes, tags, pos_location_id, created_by_user_id, created_via, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::date,
             $8,$9,$10,$11,$12,$13,
             $14,$15::text[],$16::int,$17::uuid,'wms_csv',
             COALESCE($18::timestamptz, now()))
     RETURNING id`,
    [
      firstName, row.last_name, row.email, row.email_2, row.phone, row.phone_2, row.birthday,
      row.address_line1, row.address_line2, row.city, row.state, row.zip, row.country,
      row.notes, tags, opts.createdAtLocationId, opts.actedByUserId, row.created_at,
    ],
  );
  return {
    rowIndex: row.rowIndex,
    status: "created",
    pos_customer_id: ins.rows[0].id,
    identity: identityLabel(row),
  };
}
