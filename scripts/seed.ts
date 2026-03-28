import { loadEnvConfig } from "@next/env";
import bcrypt from "bcryptjs";
import postgres from "postgres";

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
  const sql = postgres(requireDatabaseUrl(), { max: 1, prepare: false });

  const password =
    process.env.SEED_ADMIN_PASSWORD?.trim() || "devpassword-change-me";
  const hash = await bcrypt.hash(password, 10);

  const [insertedTenant] = await sql<{ id: string; slug: string }[]>`
    INSERT INTO tenants (slug, name)
    VALUES ('cj', 'Carbon Jewelry (sample)')
    ON CONFLICT (slug) DO NOTHING
    RETURNING id, slug
  `;

  let t = insertedTenant;
  if (!t) {
    const rows = await sql<{ id: string; slug: string }[]>`
      SELECT id, slug FROM tenants WHERE slug = 'cj' LIMIT 1
    `;
    t = rows[0];
  }

  if (!t) throw new Error("Failed to resolve tenant cj");

  await sql`
    INSERT INTO locations (tenant_id, code, name)
    VALUES
      (${t.id}, '001', 'Orlando Warehouse'),
      (${t.id}, '003', 'Elementi Florida Mall')
    ON CONFLICT (tenant_id, code) DO NOTHING
  `;

  const locs = await sql<{ id: string; code: string }[]>`
    SELECT id, code FROM locations WHERE tenant_id = ${t.id} AND code IN ('001', '003')
  `;
  const loc001 = locs.find((l) => l.code === "001");
  const loc003 = locs.find((l) => l.code === "003");
  if (!loc001 || !loc003) {
    throw new Error("Expected locations 001 and 003 after seed");
  }

  await sql`
    INSERT INTO users (email, password_hash)
    VALUES ('admin@example.com', ${hash})
    ON CONFLICT (email) DO NOTHING
  `;

  const [u] = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE email = 'admin@example.com' LIMIT 1
  `;
  if (!u) throw new Error("Failed to resolve user");

  await sql`
    INSERT INTO memberships (user_id, tenant_id, role)
    VALUES (${u.id}, ${t.id}, 'admin')
    ON CONFLICT (user_id, tenant_id) DO NOTHING
  `;

  const [{ count: orderCountStr }] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM orders
  `;
  if (Number(orderCountStr) === 0) {
    await sql`
      INSERT INTO orders (tenant_id, location_id, external_ref, source, status, line_count)
      VALUES
        (${t.id}, ${loc001.id}, 'LS-10021', 'lightspeed', 'picking', 4),
        (${t.id}, ${loc001.id}, 'SH-55402', 'shopify', 'pending', 2)
    `;
  }

  const [{ count: invCountStr }] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM inventory_items
  `;
  if (Number(invCountStr) === 0) {
    await sql`
      INSERT INTO inventory_items (location_id, asset_id, sku, name, zone, qty)
      VALUES
        (${loc001.id}, '210000001206', 'C125311010701', 'AVA MINI DRESS BLACK S', 'rfid', 2),
        (${loc001.id}, '210000007117', '—', 'ISLA KNIT BLACK OS', 'bin', 24)
    `;
  }

  const [{ count: intCountStr }] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM integration_connections
  `;
  if (Number(intCountStr) === 0) {
    await sql`
      INSERT INTO integration_connections (tenant_id, location_id, provider, status, last_ok_at)
      VALUES
        (${t.id}, NULL, 'senitron', 'connected', now()),
        (${t.id}, ${loc001.id}, 'lightspeed', 'connected', now()),
        (${t.id}, ${loc001.id}, 'shopify', 'configure', NULL)
    `;
  }

  const [{ count: excCountStr }] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM exceptions
  `;
  if (Number(excCountStr) === 0) {
    await sql`
      INSERT INTO exceptions (tenant_id, location_id, type, severity, state, detail)
      VALUES (
        ${t.id},
        ${loc001.id},
        'pos_mismatch',
        'review',
        'new',
        '210000007117 · RFID 24 vs Ext 0'
      )
    `;
  }

  await sql.end();
  console.log("Seed complete.");
  console.log("  Tenant:", t.slug, t.id);
  console.log("  Login: admin@example.com /", password);
}

main().catch((e) => {
  const refused =
    (e as { code?: string })?.code === "ECONNREFUSED" ||
    (e as { errors?: { code?: string }[] })?.errors?.some(
      (x) => x?.code === "ECONNREFUSED",
    );
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
