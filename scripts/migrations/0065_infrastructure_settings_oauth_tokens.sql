-- Per-tenant Lightspeed OAuth secrets in infrastructure_settings.
--
-- Until now `ls_refresh_token` and `ls_personal_token` lived only in env
-- vars (see lib/server/infrastructure-settings-table.ts). That works on a
-- single-tenant deploy where Coolify holds one set of credentials, but
-- it breaks two real cases:
--   1. A redeploy that drops the LS_* env block silently downgrades the
--      catalog sync to "simulated" mode — exactly what happened on app
--      id 2 (wms.shopcarbon.com) when the env was rewritten and live
--      manual syncs started returning 0 records with the simulated-
--      payload message.
--   2. Multi-tenant: each tenant needs its own OAuth refresh / personal
--      token, which the env-only path can't express.
--
-- Adding the columns lets credentials live in the DB row alongside
-- ls_client_id / ls_client_secret. The resolver still prefers env when
-- present, so existing single-tenant deploys are unchanged.

ALTER TABLE infrastructure_settings
  ADD COLUMN IF NOT EXISTS ls_refresh_token text,
  ADD COLUMN IF NOT EXISTS ls_personal_token text;
