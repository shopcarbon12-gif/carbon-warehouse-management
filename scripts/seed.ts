import { loadEnvConfig } from "@next/env";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import {
  DEFAULT_EPC_PROFILES,
  DEFAULT_EPC_SETTINGS,
  DEFAULT_HANDHELD_SETTINGS,
} from "../lib/settings/tenant-settings-defaults";
import { generateOrlandoWarehouseBinCodes } from "../lib/server/orlando-bin-grid";

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

  await pool.query(
    `UPDATE locations
     SET lightspeed_shop_id = 1, is_active = true
     WHERE tenant_id = $1::uuid AND code = '001'`,
    [t.id],
  );
  await pool.query(
    `UPDATE locations
     SET lightspeed_shop_id = NULL, is_active = true
     WHERE tenant_id = $1::uuid AND code = '003'`,
    [t.id],
  );

  await pool.query(`
    INSERT INTO user_roles (name, permissions)
    VALUES
      ('Super Admin', '{}'::jsonb),
      ('Retail- Limited acess', '{}'::jsonb),
      ('Warehouse - Limited Access', '{}'::jsonb)
    ON CONFLICT (name) DO UPDATE SET
      updated_at = now()
  `);

  const locs = await pool.query<{ id: string; code: string }>(
    `SELECT id, code FROM locations WHERE tenant_id = $1 AND code IN ('001', '003')`,
    [t.id],
  );
  const loc001 = locs.rows.find((l) => l.code === "001");
  const loc003 = locs.rows.find((l) => l.code === "003");
  if (!loc001 || !loc003) {
    throw new Error("Expected locations 001 and 003 after seed");
  }

  const orlandoBins = generateOrlandoWarehouseBinCodes();
  await pool.query(
    `INSERT INTO bins (location_id, code)
     SELECT $1::uuid, unnest($2::text[])
     ON CONFLICT (location_id, code) DO NOTHING`,
    [loc001.id, orlandoBins],
  );

  await pool.query(
    `INSERT INTO tenant_settings (tenant_id, epc_settings, epc_profiles, handheld_settings)
     VALUES ($1::uuid, $2::jsonb, $3::jsonb, $4::jsonb)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [
      t.id,
      JSON.stringify(DEFAULT_EPC_SETTINGS),
      JSON.stringify(DEFAULT_EPC_PROFILES),
      JSON.stringify(DEFAULT_HANDHELD_SETTINGS),
    ],
  );

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

  await pool.query(
    `UPDATE users u
     SET role_id = ur.id
     FROM user_roles ur
     WHERE u.id = $1::uuid AND ur.name = 'Super Admin'`,
    [user.id],
  );

  await pool.query(
    `INSERT INTO user_locations (user_id, location_id)
     SELECT $1::uuid, l.id
     FROM locations l
     WHERE l.tenant_id = $2::uuid
     ON CONFLICT DO NOTHING`,
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
         ($1::uuid, $2::uuid, 'LS-10022', 'lightspeed', 'pending', 2)`,
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
         ($1::uuid, $2::uuid, 'lightspeed', 'connected', now())`,
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

  const clean10 = [
    {
      legacyId: 1,
      name: "LIVE",
      displayLabel: "Live — sellable, visible everywhere",
      isSellable: true,
      scanner: true,
      ui: true,
      superLock: false,
      system: false,
    },
    {
      legacyId: 2,
      name: "RETURN",
      displayLabel: "Return — not sellable; visible on handheld and in UI",
      isSellable: false,
      scanner: true,
      ui: true,
      superLock: false,
      system: false,
    },
    {
      legacyId: 3,
      name: "DAMAGED",
      displayLabel: "Damaged — not sellable; only Super Admin can return to Live",
      isSellable: false,
      scanner: true,
      ui: true,
      superLock: true,
      system: false,
    },
    {
      legacyId: 4,
      name: "SOLD",
      displayLabel: "Sold — not sellable; only Super Admin can return to Live",
      isSellable: false,
      scanner: true,
      ui: true,
      superLock: true,
      system: false,
    },
    {
      legacyId: 5,
      name: "STOLEN",
      displayLabel: "Stolen — confirmed loss. Handhelds IGNORE this tag.",
      isSellable: false,
      scanner: false,
      ui: false,
      superLock: true,
      system: false,
    },
    {
      legacyId: 6,
      name: "TAG KILLED",
      displayLabel: "Tag killed — scanner and UI hidden. Handhelds IGNORE.",
      isSellable: false,
      scanner: false,
      ui: false,
      superLock: true,
      system: false,
    },
    {
      legacyId: 7,
      name: "UNKNOWN",
      displayLabel: "Unknown — scanner and UI hidden. Handhelds IGNORE.",
      isSellable: false,
      scanner: false,
      ui: false,
      superLock: true,
      system: false,
    },
    {
      legacyId: 8,
      name: "PENDING VISIBILITY",
      displayLabel: "System staging — staff cannot select; handheld ignores.",
      isSellable: false,
      scanner: false,
      ui: false,
      superLock: true,
      system: true,
    },
    {
      legacyId: 9,
      name: "IN TRANSIT",
      displayLabel: "In transit — system workflow; visible, not sellable",
      isSellable: false,
      scanner: true,
      ui: true,
      superLock: false,
      system: true,
    },
    {
      legacyId: 10,
      name: "PENDING TRANSACTION",
      displayLabel: "Pending transaction — system workflow; visible, not sellable",
      isSellable: false,
      scanner: true,
      ui: true,
      superLock: false,
      system: true,
    },
  ] as const;

  for (const row of clean10) {
    await pool.query(
      `INSERT INTO status_labels (
         legacy_id, name, display_label,
         is_sellable, is_visible_to_scanner, is_visible_in_ui, super_admin_locked, is_system_only
       )
       VALUES ($1::int, $2, $3, $4::boolean, $5::boolean, $6::boolean, $7::boolean, $8::boolean)
       ON CONFLICT (name) DO UPDATE SET
         legacy_id = EXCLUDED.legacy_id,
         display_label = EXCLUDED.display_label,
         is_sellable = EXCLUDED.is_sellable,
         is_visible_to_scanner = EXCLUDED.is_visible_to_scanner,
         is_visible_in_ui = EXCLUDED.is_visible_in_ui,
         super_admin_locked = EXCLUDED.super_admin_locked,
         is_system_only = EXCLUDED.is_system_only,
         updated_at = now()`,
      [
        row.legacyId,
        row.name,
        row.displayLabel,
        row.isSellable,
        row.scanner,
        row.ui,
        row.superLock,
        row.system,
      ],
    );
  }

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
