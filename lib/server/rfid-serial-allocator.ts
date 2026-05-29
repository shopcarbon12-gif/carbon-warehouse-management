import type { PoolClient } from "pg";

/**
 * Carbon-Jeans serial-allocation policy (2026-05-29):
 *   - Every items.serial_number is an integer in [100_000, 999_999] —
 *     exactly 6 digits, no exceptions, no leading zeros.
 *   - Uniqueness is enforced *per custom_sku_id, across all locations*.
 *     SGTIN-96 packs (companyPrefix, lsSystemId=sku, serial); items.epc
 *     is globally UNIQUE in Postgres, so two items with the same (sku,
 *     serial) would generate the same EPC and collide on INSERT anyway.
 *     We pre-check inside the active transaction to fail fast instead
 *     of relying on the constraint to trip after a costly EPC build.
 *
 * Random over sequential — historical context:
 *   The pre-2026-05-29 allocator used MAX(serial_number)+1 scoped to
 *   (sku, location) with a 100_001 floor. That produced unique serials
 *   inside a sku but the sequence was guessable and a single bad row
 *   (e.g. a stuck reprint that left serial = 12) wedged every later
 *   write. Random 6-digit serials sidestep both: 900_000 slot space
 *   gives effectively zero collision at warehouse scale (<1k tags per
 *   sku), and the sequence carries no info about the order chips were
 *   written.
 *
 * Concurrency:
 *   We pre-check existence inside the same connection's transaction
 *   (read-your-writes). The caller is expected to hold a transaction
 *   so a second tab racing to pick the same random number still gets
 *   stopped by `items.epc` UNIQUE on INSERT. Callers should be ready
 *   to retry on 23505 from the INSERT.
 */

const SERIAL_MIN = 100_000;
const SERIAL_MAX_EXCLUSIVE = 1_000_000; // upper bound (exclusive) → 999_999 max

/**
 * Pick a random 6-digit serial that isn't already used by another items
 * row for this [customSkuId]. Throws after 200 unsuccessful attempts
 * (effectively means the sku has more than ~900k tags — unreachable
 * for any Carbon Jeans inventory today).
 */
export async function pickRandomUniqueSerial(
  client: PoolClient,
  customSkuId: string,
): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const serial =
      Math.floor(Math.random() * (SERIAL_MAX_EXCLUSIVE - SERIAL_MIN)) + SERIAL_MIN;
    const dup = await client.query<{ one: number }>(
      `SELECT 1 AS one
         FROM items
        WHERE custom_sku_id = $1::uuid
          AND serial_number = $2::bigint
        LIMIT 1`,
      [customSkuId, serial],
    );
    if ((dup.rowCount ?? 0) === 0) return serial;
  }
  throw new Error(
    "SERVER:Could not allocate a unique 6-digit serial after 200 attempts",
  );
}

/**
 * Multi-serial variant for batch writers (commission qty=N). Returns N
 * distinct random 6-digit serials. Uses an in-memory `seen` set so
 * the random draws within the batch can't collide with each other
 * before the per-row INSERTs happen.
 */
export async function pickRandomUniqueSerialBatch(
  client: PoolClient,
  customSkuId: string,
  count: number,
): Promise<number[]> {
  const seen = new Set<number>();
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    let serial = -1;
    for (let attempt = 0; attempt < 200; attempt++) {
      const candidate =
        Math.floor(Math.random() * (SERIAL_MAX_EXCLUSIVE - SERIAL_MIN)) + SERIAL_MIN;
      if (seen.has(candidate)) continue;
      const dup = await client.query<{ one: number }>(
        `SELECT 1 AS one
           FROM items
          WHERE custom_sku_id = $1::uuid
            AND serial_number = $2::bigint
          LIMIT 1`,
        [customSkuId, candidate],
      );
      if ((dup.rowCount ?? 0) === 0) {
        serial = candidate;
        break;
      }
    }
    if (serial < 0) {
      throw new Error(
        "SERVER:Could not allocate a unique 6-digit serial after 200 attempts",
      );
    }
    seen.add(serial);
    out.push(serial);
  }
  return out;
}

/**
 * Validate that an existing serial fits the Carbon-Jeans rule (exactly
 * 6 digits, no leading zeros). Used by the sanitizer + reports.
 */
export function isValidSixDigitSerial(serial: number | bigint | string | null | undefined): boolean {
  if (serial === null || serial === undefined) return false;
  const n =
    typeof serial === "number"
      ? serial
      : typeof serial === "bigint"
        ? Number(serial)
        : Number.parseInt(serial, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return false;
  return n >= SERIAL_MIN && n < SERIAL_MAX_EXCLUSIVE;
}
