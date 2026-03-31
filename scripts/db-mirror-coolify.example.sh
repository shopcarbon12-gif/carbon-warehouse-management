#!/usr/bin/env bash
# Full data mirror: Coolify Postgres → local.
#
# Recommended (non-interactive SSH to Coolify host + docker exec + local docker compose):
#   npm run db:mirror:ssh
# Requires the same Postgres major version locally as prod (repo docker-compose uses postgres:18-alpine).
#
# Manual tunnel + pg_dump example:
#   ssh -L 15432:INTERNAL_POSTGRES_HOST:5432 user@YOUR_VPS
#   pg_dump -h 127.0.0.1 -p 15432 -U postgres -d postgres -Fc -f carbon_wms_prod.dump
#   pg_restore -h localhost -p 5432 -U postgres -d carbon_wms --clean --if-exists carbon_wms_prod.dump
#
# Never commit dumps or passwords.
