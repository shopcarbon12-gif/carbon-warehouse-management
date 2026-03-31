/** Extract PostgreSQL driver error fields for logs / optional client hints. */
export function getPgErrorMeta(err: unknown): { code: string | undefined; message: string } {
  if (err && typeof err === "object" && "code" in err) {
    const o = err as { code?: unknown; message?: unknown };
    const code = o.code != null ? String(o.code) : undefined;
    const msg =
      err instanceof Error
        ? err.message
        : o.message != null && typeof o.message === "string"
          ? o.message
          : String(err);
    return { code: code || undefined, message: msg };
  }
  return {
    code: undefined,
    message: err instanceof Error ? err.message : String(err),
  };
}

export function hintForPgCode(code: string | undefined): string {
  if (code === "42703") {
    return "A database column is missing. Apply migrations: set WMS_AUTO_MIGRATE=1 in Coolify (container start runs scripts/migrations/*.sql), or run npm run db:migrate against production DATABASE_URL from a trusted machine.";
  }
  if (code === "42P01") {
    return "A database table is missing — baseline schema or migrations were not applied.";
  }
  return "Check container logs for the full PostgreSQL error. Temporarily set WMS_EXPOSE_DB_ERRORS=1 to return db.code / db.message in this JSON response.";
}
