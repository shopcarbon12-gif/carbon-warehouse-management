#!/bin/sh
set -e
cd /app

if [ -n "$DATABASE_URL" ] && [ "${WMS_AUTO_MIGRATE:-}" = "1" ]; then
  if psql "$DATABASE_URL" -tAc "select 1 from information_schema.tables where table_schema='public' and table_name='users'" 2>/dev/null | grep -q 1; then
    echo "wms: schema already present (users table), skipping migrate"
  else
    echo "wms: applying schema (WMS_AUTO_MIGRATE=1)"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /app/scripts/schema.sql
  fi
fi

if [ -n "$DATABASE_URL" ] && [ "${WMS_AUTO_SEED:-}" = "1" ]; then
  echo "wms: bootstrap seed (WMS_AUTO_SEED=1)"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /app/scripts/seed-bootstrap.sql
fi

exec su-exec nextjs:nodejs "$@"
