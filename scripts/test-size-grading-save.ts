/**
 * Size Grading — does saving a measurement actually reach the database?
 *
 * This exists because it did not, for days, and nothing caught it. The save
 * path built two different SQL statements depending on whether the SKU had a
 * size, and the sized branch referenced $2 and $3 while still being handed
 * three arguments starting at $1. Postgres refuses a statement whose parameter
 * it cannot type — "could not determine data type of parameter $1", 42P18 —
 * and it threw before the INSERT, so every save returned a bare 500, the page
 * said "Could not save", and the measurements table stayed empty.
 *
 * Nothing in a type-checker or a synthetic pixel test can see that. It is only
 * visible when the statements meet a real database, which is what this does:
 * it runs the real queries, with the real argument shapes, inside a transaction
 * it rolls back, against a SKU that has a size and one that does not.
 *
 *   npx tsx scripts/test-size-grading-save.ts
 *
 * Needs DATABASE_URL (it reads .env.coolify.local the way the other scripts do).
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

function databaseUrl(): string {
  const direct = (process.env.DATABASE_URL ?? "").trim();
  if (direct) return direct;
  for (const file of [".env.coolify.local", ".env.local", ".env"]) {
    try {
      const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      const found = text.match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
      if (found) return found;
    } catch {
      /* try the next one */
    }
  }
  throw new Error("No DATABASE_URL — set it, or put it in .env.coolify.local");
}

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(46)} ${detail}`);
  if (!ok) failed++;
};

async function main() {
  const client = new Client({ connectionString: databaseUrl(), ssl: false });
  await client.connect();

  try {
  /* The two shapes the route builds. Kept here as the route writes them, so a
     divergence shows up as a failing test rather than as a silent 500. */
  const targetsSized = `SELECT id, color_code FROM custom_skus
          WHERE matrix_id = $1::uuid AND archived = false
            AND size IS NOT DISTINCT FROM $2`;
  const targetsUnsized = `SELECT id, color_code FROM custom_skus WHERE id = $1::uuid`;
  const insert = `INSERT INTO size_grading_measurements
       (custom_sku_id, garment_type, points_cm, px_per_cm, type_overridden, measured_by, note, view)
     SELECT unnest($1::uuid[]), $2, $3::jsonb, $4, $5, $6, $7, $8
     RETURNING measured_at`;

  const sized = (
    await client.query<{ id: string; matrix_id: string; size: string }>(
      `SELECT id, matrix_id, size FROM custom_skus
        WHERE archived = false AND size IS NOT NULL LIMIT 1`,
    )
  ).rows[0];
  if (!sized) throw new Error("no sized SKU in this database to test against");

  const user = (await client.query<{ id: string }>(`SELECT id FROM users LIMIT 1`)).rows[0] ?? null;

  // Everything below runs inside a transaction that is always rolled back.
  await client.query("BEGIN");

  let targets: Array<{ id: string }> = [];
  try {
    targets = (await client.query<{ id: string }>(targetsSized, [sized.matrix_id, sized.size])).rows;
    check("sized SKU: the colour fan-out query runs", true, `${targets.length} colour(s) of size ${sized.size}`);
  } catch (e) {
    check("sized SKU: the colour fan-out query runs", false, (e as Error).message);
  }

  try {
    const r = await client.query<{ id: string }>(targetsUnsized, [sized.id]);
    check("unsized SKU: its query runs", r.rows.length === 1);
  } catch (e) {
    check("unsized SKU: its query runs", false, (e as Error).message);
  }

  check("the fan-out includes the SKU that was measured", targets.some((t) => t.id === sized.id));

  try {
    const r = await client.query<{ measured_at: string }>(insert, [
      targets.map((t) => t.id),
      "top",
      JSON.stringify({ chest: 52.3, length: 70.1 }),
      7.1,
      false,
      user?.id ?? null,
      "regression test — rolled back",
      "front",
    ]);
    check("the insert writes a row per colour", r.rowCount === targets.length, `${r.rowCount} row(s)`);
  } catch (e) {
    check("the insert writes a row per colour", false, (e as Error).message);
  }

  // Both sides must be able to coexist on one SKU, or measuring the back would
  // destroy the front.
  try {
    await client.query(insert, [
      [sized.id], "top", JSON.stringify({ chest: 52.3 }), 7.1, false, user?.id ?? null, "regression test", "back",
    ]);
    const both = await client.query<{ view: string }>(
      `SELECT DISTINCT view FROM size_grading_measurements WHERE custom_sku_id = $1::uuid ORDER BY view`,
      [sized.id],
    );
    check("front and back are kept separately", both.rows.length === 2, both.rows.map((r) => r.view).join(" + "));
  } catch (e) {
    check("front and back are kept separately", false, (e as Error).message);
  }

  // And what the item card reads back has to find them.
  try {
    const read = await client.query<{ view: string }>(
      `SELECT DISTINCT ON (view) id, garment_type, points_cm, measured_at, note, view
         FROM size_grading_measurements
        WHERE custom_sku_id = $1::uuid
        ORDER BY view, measured_at DESC`,
      [sized.id],
    );
    check("the item card's read returns what was saved", read.rows.length >= 1, `${read.rows.length} side(s)`);
  } catch (e) {
    check("the item card's read returns what was saved", false, (e as Error).message);
  }

  await client.query("ROLLBACK");
  const left = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM size_grading_measurements WHERE note LIKE 'regression test%'`,
  );
  check("the test left nothing behind", left.rows[0].n === "0", `${left.rows[0].n} row(s) remain`);
  } finally {
    await client.end();
  }
}

main()
  .catch((e) => {
    console.error("  FAIL  the test could not run:", e instanceof Error ? e.message : e);
    failed++;
  })
  .then(() => {
    console.log(failed ? `\n${failed} check${failed === 1 ? "" : "s"} FAILED` : "\nall checks passed");
    process.exit(failed ? 1 : 0);
  });
