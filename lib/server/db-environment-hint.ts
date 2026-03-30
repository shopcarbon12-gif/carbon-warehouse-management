/**
 * Detects when the app is almost certainly using a local/demo Postgres so we can
 * explain why catalogs and locations do not match production.
 */

export type DbEnvironmentHint = {
  title: string;
  body: string;
};

function isLocalDatabaseUrl(databaseUrl: string): boolean {
  const u = databaseUrl.trim();
  if (!u) return false;
  try {
    const normalized = u.replace(/^postgres(ql)?:/i, "http:");
    const parsed = new URL(normalized);
    const h = parsed.hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return /\blocalhost\b|127\.0\.0\.1/.test(u);
  }
}

/**
 * Shown in development when DATABASE_URL points at localhost — not in production builds.
 */
export function getDbEnvironmentHint(): DbEnvironmentHint | null {
  if (process.env.NODE_ENV !== "development") return null;
  if (process.env.WMS_HIDE_LOCAL_DB_BANNER === "1") return null;
  const url = process.env.DATABASE_URL?.trim() ?? "";
  if (!url || !isLocalDatabaseUrl(url)) return null;
  return {
    title: "You are on local/demo data",
    body:
      "Everything in this app—locations, matrix catalog, inventory, integrations—comes from the Postgres in your .env DATABASE_URL. The usual local URL is seeded with sample tenants (e.g. Orlando / Elementi) and demo SKUs, not your live store. To see real data: set DATABASE_URL to your production database (from Coolify; internal hostnames often need an SSH tunnel from your PC), run migrations if needed, then restart `npm run dev`. Catalog items also require a successful Lightspeed sync (live credentials), or you will still see the built-in simulated catalog.",
  };
}
