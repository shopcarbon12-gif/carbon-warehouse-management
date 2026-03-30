#!/bin/sh
set -e
cd /app

# Optional DB bootstrap: failures must NOT exit the script — Coolify/Docker health checks
# need Node listening; a bad DATABASE_URL or a conflicting migration otherwise kills the
# container on every deploy (restart loop).
if [ -n "$DATABASE_URL" ] && [ "${WMS_AUTO_MIGRATE:-}" = "1" ]; then
  set +e
  if psql "$DATABASE_URL" -tAc "select 1 from information_schema.tables where table_schema='public' and table_name='users'" 2>/dev/null | grep -q 1; then
    echo "wms: baseline schema present (users table), skipping scripts/schema.sql"
  else
    echo "wms: applying baseline schema (WMS_AUTO_MIGRATE=1)"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /app/scripts/schema.sql
    _s=$?
    if [ "$_s" -ne 0 ]; then echo "wms: WARNING schema.sql exited $_s — fix DB and redeploy; starting app anyway" >&2; fi
  fi
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
