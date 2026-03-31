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
  # Always apply schema.sql first: it is idempotent (CREATE IF NOT EXISTS). Do **not** gate on
  # `users` alone — another DB or partial bootstrap can have `users` without `locations`/`bins`,
  # which skips baseline, breaks migration 001 (ALTER locations), and yields 42P01 in the app.
  echo "wms: applying baseline scripts/schema.sql (idempotent, WMS_AUTO_MIGRATE=1)"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /app/scripts/schema.sql
  _s=$?
  if [ "$_s" -ne 0 ]; then echo "wms: WARNING schema.sql exited $_s — fix DB and redeploy; starting app anyway" >&2; fi
  if [ -d /app/scripts/migrations ]; then
    for f in /app/scripts/migrations/*.sql; do
      [ -f "$f" ] || continue
      echo "wms: applying migration $f"
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
      _s=$?
      if [ "$_s" -ne 0 ]; then echo "wms: WARNING migration $f exited $_s — continuing" >&2; fi
    done
  fi
  set -e
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
