#!/bin/sh
set -e
cd /app

if [ -n "$DATABASE_URL" ] && [ "${WMS_AUTO_MIGRATE:-}" != "1" ]; then
  echo "wms: NOTE: DATABASE_URL is set but WMS_AUTO_MIGRATE is not 1 — SQL migrations will NOT run at startup. Missing columns (e.g. bins.status) cause API Query failed until you migrate." >&2
fi

# Optional DB bootstrap: failures must NOT exit the script — Coolify/Docker health checks
# need Node listening; a bad DATABASE_URL or a conflicting migration otherwise kills the
# container on every deploy (restart loop).
if [ -n "$DATABASE_URL" ] && [ "${WMS_AUTO_MIGRATE:-}" = "1" ]; then
  set +e
  # Use Node + `pg` (same as the app) and the **same gating** as `npm run db:migrate`:
  # legacy 001–003 are skipped when `public.matrices` exists. The old `psql` loop ran **every**
  # migration file on every boot — including 002’s DROP TABLE — and could fail differently than
  # the app’s TLS/URL handling.
  echo "wms: running node /app/scripts/docker-migrate.mjs (WMS_AUTO_MIGRATE=1)"
  node /app/scripts/docker-migrate.mjs
  _s=$?
  if [ "$_s" -ne 0 ]; then echo "wms: WARNING docker-migrate.mjs exited $_s — fix DB; starting app anyway" >&2; fi
  set -e
fi

# Always report core tables (even if WMS_AUTO_MIGRATE was off) — explains "DB up" + broken app.
if [ -n "$DATABASE_URL" ]; then
  missing=""
  for t in locations bins tenants users; do
    hit=$(psql "$DATABASE_URL" -tAc "select 1 from information_schema.tables where table_schema='public' and table_name='$t' limit 1" 2>/dev/null | tr -d " \t\r\n")
    if [ "$hit" != "1" ]; then
      missing="${missing}${missing:+ }${t}"
    fi
  done
  if [ -n "$missing" ]; then
    echo "wms: CRITICAL — missing public table(s): ${missing}. App APIs will fail (e.g. 42P01)." >&2
    echo "wms: Fix: WMS_AUTO_MIGRATE=1 + redeploy; confirm DATABASE_URL points at this app’s Postgres; DB user must own DB or have CREATE; scroll up for psql WARNING on schema/migrations." >&2
  else
    echo "wms: core schema OK (locations, bins, tenants, users)" >&2
  fi
fi

if [ -n "$DATABASE_URL" ] && [ "${WMS_AUTO_SEED:-}" = "1" ]; then
  echo "wms: bootstrap seed (WMS_AUTO_SEED=1)"
  set +e
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /app/scripts/seed-bootstrap.sql
  _s=$?
  set -e
  if [ "$_s" -ne 0 ]; then echo "wms: WARNING seed-bootstrap exited $_s — continuing" >&2; fi
fi

exec su-exec nextjs:nodejs "$@"
