import { loadEnvConfig } from "@next/env";
import bcrypt from "bcryptjs";
import { Pool } from "pg";

loadEnvConfig(process.cwd());

function requireDatabaseUrl(): string {
  const u = process.env.DATABASE_URL?.trim();
  if (!u) {
    console.error("DATABASE_URL is required (copy .env.example to .env).");
    throw new Error("DATABASE_URL is required");
  }
  return u;
}

async function main() {
  const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 1 });

  const password =
    process.env.SEED_ADMIN_PASSWORD?.trim() || "devpassword-change-me";
  const hash = await bcrypt.hash(password, 10);

  const insTenant = await pool.query<{ id: string; slug: string }>(
    `INSERT INTO tenants (slug, name)
     VALUES ('cj', 'Carbon Jewelry (sample)')
     ON CONFLICT (slug) DO NOTHING
     RETURNING id, slug`,
  );

  let t = insTenant.rows[0];
  if (!t) {
    const rows = await pool.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM tenants WHERE slug = 'cj' LIMIT 1`,
    );
    t = rows.rows[0];
  }

  if (!t) throw new Error("Failed to resolve tenant cj");

  await pool.query(
    `INSERT INTO locations (tenant_id, code, name)
     VALUES
       ($1, '001', 'Orlando Warehouse'),
       ($1, '003', 'Elementi Florida Mall')
     ON CONFLICT (tenant_id, code) DO NOTHING`,
    [t.id],
  );

  const locs = await pool.query<{ id: string; code: string }>(
    `SELECT id, code FROM locations WHERE tenant_id = $1 AND code IN ('001', '003')`,
    [t.id],
  );
  const loc001 = locs.rows.find((l) => l.code === "001");
  const loc003 = locs.rows.find((l) => l.code === "003");
  if (!loc001 || !loc003) {
    throw new Error("Expected locations 001 and 003 after seed");
  }

  await pool.query(
    `INSERT INTO users (email, password_hash)
     VALUES ('admin@example.com', $1)
     ON CONFLICT (email) DO NOTHING`,
    [hash],
  );

  const u = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email = 'admin@example.com' LIMIT 1`,
  );
  const user = u.rows[0];
  if (!user) throw new Error("Failed to resolve user");

  await pool.query(
    `INSERT INTO memberships (user_id, tenant_id, role)
     VALUES ($1::uuid, $2::uuid, 'admin')
     ON CONFLICT (user_id, tenant_id) DO NOTHING`,
    [user.id, t.id],
  );

  const orderCount = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM orders`,
  );
  if (Number(orderCount.rows[0]?.count ?? 0) === 0) {
    await pool.query(
      `INSERT INTO orders (tenant_id, location_id, external_ref, source, status, line_count)
       VALUES
         ($1::uuid, $2::uuid, 'LS-10021', 'lightspeed', 'picking', 4),
         ($1::uuid, $2::uuid, 'SH-55402', 'shopify', 'pending', 2)`,
      [t.id, loc001.id],
    );
  }

  const invCount = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM inventory_items`,
  );
  if (Number(invCount.rows[0]?.count ?? 0) === 0) {
    await pool.query(
      `INSERT INTO inventory_items (location_id, asset_id, sku, name, zone, qty)
       VALUES
         ($1::uuid, '210000001206', 'C125311010701', 'AVA MINI DRESS BLACK S', 'rfid', 2),
         ($1::uuid, '210000007117', '—', 'ISLA KNIT BLACK OS', 'bin', 24)`,
      [loc001.id],
    );
  }

  const intCount = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM integration_connections`,
  );
  if (Number(intCount.rows[0]?.count ?? 0) === 0) {
    await pool.query(
      `INSERT INTO integration_connections (tenant_id, location_id, provider, status, last_ok_at)
       VALUES
         ($1::uuid, $2::uuid, 'lightspeed', 'connected', now()),
         ($1::uuid, $2::uuid, 'shopify', 'configure', NULL)`,
      [t.id, loc001.id],
    );
  }

  const excCount = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM exceptions`,
  );
  if (Number(excCount.rows[0]?.count ?? 0) === 0) {
    await pool.query(
      `INSERT INTO exceptions (tenant_id, location_id, type, severity, state, detail)
       VALUES (
         $1::uuid,
         $2::uuid,
         'pos_mismatch',
         'review',
         'new',
         '210000007117 · RFID 24 vs Ext 0'
       )`,
      [t.id, loc001.id],
    );
  }

  await pool.query(`
    INSERT INTO status_labels (
      legacy_id, name, include_in_inventory, hide_in_search_filters, hide_in_item_details, display_in_group_page
    )
    VALUES
      (2624, 'Unknown', false, true, false, false),
      (2625, 'Live', true, false, false, false),
      (2626, 'Damaged', false, false, false, false),
      (2627, 'Display', true, true, false, false),
      (2628, 'Sold', false, false, false, false),
      (2629, 'Stolen', false, true, false, false),
      (2630, 'Pending Visibility', false, true, true, false),
      (2631, 'Waiting To Ship', false, true, false, false),
      (2632, 'Return To Factory', false, true, true, false),
      (2633, 'Removed', false, true, false, false),
      (2634, 'Shipped', false, true, false, false),
      (2635, 'Tag Killed', false, true, false, false),
      (2636, 'Pending Visibility - Single Count', false, true, false, false),
      (2637, 'Pending Visibility - Unknown', true, true, false, false),
      (2638, 'Transferred Out', false, true, false, false),
      (2639, 'Checked In', true, true, false, false),
      (2640, 'Checked Out', true, true, false, false),
      (2641, 'In Transit', false, true, false, true),
      (2642, 'Return', false, true, false, false),
      (3529, 'Transfer Out', false, true, false, false)
    ON CONFLICT (name) DO UPDATE SET
      legacy_id = EXCLUDED.legacy_id,
      include_in_inventory = EXCLUDED.include_in_inventory,
      hide_in_search_filters = EXCLUDED.hide_in_search_filters,
      hide_in_item_details = EXCLUDED.hide_in_item_details,
      display_in_group_page = EXCLUDED.display_in_group_page,
      updated_at = now()
  `);

  await pool.end();
  console.log("Seed complete.");
  console.log("  Tenant:", t.slug, t.id);
  console.log("  Login: admin@example.com /", password);
}

main().catch((e) => {
  const refused = (e as { code?: string })?.code === "ECONNREFUSED";
  if (refused) {
    console.error(
      "Postgres refused the connection (nothing listening on DATABASE_URL).\n" +
        "  Start local DB: docker compose up -d\n" +
        "  Then: npm run db:migrate && npm run db:seed",
    );
  }
  console.error(e);
  process.exit(1);
});
