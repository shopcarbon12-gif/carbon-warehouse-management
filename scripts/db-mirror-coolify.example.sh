#!/usr/bin/env bash
# Full data mirror: Coolify Postgres → local (example — fill HOST/USER/DB, use SSH tunnel if needed).
#
# 1) From your machine (tunnel example):
#    ssh -L 15432:INTERNAL_POSTGRES_HOST:5432 user@YOUR_VPS
# 2) Dump (production):
#    export PGPASSWORD='...'
#    pg_dump -h 127.0.0.1 -p 15432 -U postgres -d postgres -Fc -f carbon_wms_prod.dump
# 3) Restore into local Docker/Postgres:
#    pg_restore -h localhost -p 5432 -U postgres -d carbon_wms --clean --if-exists carbon_wms_prod.dump
#
# Never commit dumps or passwords. See README “Local ↔ Production”.
