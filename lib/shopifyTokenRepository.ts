import { ensureSqlReady, hasSqlDatabaseConfigured, sqlQuery } from "@/lib/sqlDb";
import { normalizeShopDomain } from "@/lib/shopify";

type DbMode = "sql";
export type ShopifyTokenRecord = {
  shop: string;
  accessToken: string;
  scope: string;
  installedAt: string | null;
};

function normalizeText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeLower(value: unknown) {
  return normalizeText(value).toLowerCase();
}

function hasCoolifySqlHint() {
  return Boolean(
    (process.env.COOLIFY_DATABASE_URL || "").trim() ||
      (process.env.COOLIFY_DATABASE_URL_FILE || "").trim() ||
      (process.env.DATABASE_URL_FILE || "").trim() ||
      process.env.COOLIFY_FQDN
  );
}

function getDbMode(): DbMode {
  const hasSql = hasSqlDatabaseConfigured();
  if (!hasSql && !hasCoolifySqlHint()) {
    throw new Error("SQL database is not configured.");
  }
  return "sql";
}

let _sqlTableEnsured = false;

async function ensureSqlTable() {
  if (_sqlTableEnsured) return;
  await ensureSqlReady();
  await sqlQuery(`
    CREATE TABLE IF NOT EXISTS shopify_tokens (
      shop TEXT PRIMARY KEY,
      access_token TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '',
      installed_at TIMESTAMPTZ DEFAULT now(),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await sqlQuery(
    `CREATE INDEX IF NOT EXISTS idx_shopify_tokens_installed_at ON shopify_tokens(installed_at DESC)`
  );
  _sqlTableEnsured = true;
}

export async function listInstalledShops(limit = 100): Promise<string[]> {
  getDbMode();
  await ensureSqlTable();
  const rows = await sqlQuery<{ shop: string }>(
    `SELECT shop
     FROM shopify_tokens
     ORDER BY installed_at DESC NULLS LAST
     LIMIT $1`,
    [Math.max(1, limit)]
  );
  return rows
    .map((row) => normalizeShopDomain(normalizeText(row?.shop)) || "")
    .filter(Boolean);
}

export async function getMostRecentInstalledShop(): Promise<string> {
  const shops = await listInstalledShops(1);
  return shops[0] || "";
}

export async function getShopifyAccessToken(shop: string): Promise<string> {
  const normalizedShop = normalizeLower(normalizeShopDomain(normalizeText(shop)) || "");
  if (!normalizedShop) return "";

  getDbMode();
  await ensureSqlTable();
  const rows = await sqlQuery<{ access_token: string }>(
    `SELECT access_token
     FROM shopify_tokens
     WHERE shop = $1
     ORDER BY installed_at DESC NULLS LAST
     LIMIT 1`,
    [normalizedShop]
  );
  return normalizeText(rows[0]?.access_token);
}

export async function getShopifyTokenRecord(shop: string): Promise<ShopifyTokenRecord | null> {
  const normalizedShop = normalizeLower(normalizeShopDomain(normalizeText(shop)) || "");
  if (!normalizedShop) return null;

  getDbMode();
  await ensureSqlTable();
  const rows = await sqlQuery<{
    shop: string;
    access_token: string;
    scope: string | null;
    installed_at: string | null;
  }>(
    `SELECT shop, access_token, scope, installed_at
     FROM shopify_tokens
     WHERE shop = $1
     ORDER BY installed_at DESC NULLS LAST
     LIMIT 1`,
    [normalizedShop]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    shop: normalizeShopDomain(normalizeText(row.shop)) || normalizedShop,
    accessToken: normalizeText(row.access_token),
    scope: normalizeText(row.scope),
    installedAt: normalizeText(row.installed_at) || null,
  };
}

export async function listShopifyTokenRecords(limit = 100): Promise<ShopifyTokenRecord[]> {
  getDbMode();
  const safeLimit = Math.max(1, limit);
  await ensureSqlTable();
  const rows = await sqlQuery<{
    shop: string;
    access_token: string;
    scope: string | null;
    installed_at: string | null;
  }>(
    `SELECT shop, access_token, scope, installed_at
     FROM shopify_tokens
     ORDER BY installed_at DESC NULLS LAST
     LIMIT $1`,
    [safeLimit]
  );
  return rows.map((row) => ({
    shop: normalizeShopDomain(normalizeText(row.shop)) || "",
    accessToken: normalizeText(row.access_token),
    scope: normalizeText(row.scope),
    installedAt: normalizeText(row.installed_at) || null,
  }));
}

export async function upsertShopifyToken(input: {
  shop: string;
  accessToken: string;
  scope?: string | null;
  installedAt?: string | null;
}): Promise<void> {
  const shop = normalizeLower(normalizeShopDomain(normalizeText(input.shop)) || "");
  if (!shop) throw new Error("Invalid Shopify shop.");
  const accessToken = normalizeText(input.accessToken);
  if (!accessToken) throw new Error("Missing Shopify access token.");
  const scope = normalizeText(input.scope);
  const installedAt = normalizeText(input.installedAt) || new Date().toISOString();

  getDbMode();
  await ensureSqlTable();
  await sqlQuery(
    `INSERT INTO shopify_tokens (shop, access_token, scope, installed_at, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (shop) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       scope = EXCLUDED.scope,
       installed_at = EXCLUDED.installed_at,
       updated_at = now()`,
    [shop, accessToken, scope || null, installedAt]
  );
}

export async function deleteShopifyToken(shop: string): Promise<void> {
  const normalizedShop = normalizeLower(normalizeShopDomain(normalizeText(shop)) || "");
  if (!normalizedShop) throw new Error("Invalid Shopify shop.");

  getDbMode();
  await ensureSqlTable();
  await sqlQuery(`DELETE FROM shopify_tokens WHERE shop = $1`, [normalizedShop]);
}
