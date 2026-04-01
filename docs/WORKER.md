# Background worker (`npm run worker`)

The repo ships a Node worker (`scripts/worker.ts`) that drains queued **Lightspeed** pull jobs and related sync work. It uses the same database and env as the Next.js app (`DATABASE_URL`, Lightspeed credentials, etc.).

Referenced from the web deep audit (`docs/web-deep-audit-report.html` §6): if Coolify runs **only** the Next container, manual sync jobs may queue until this worker (or an equivalent process) runs.

## Local

```bash
npm run worker
```

Run it in a second terminal while `npm run dev` serves the web app.

## Production (Coolify)

Use a **second Coolify application** that builds **`Dockerfile.worker`** from this repo — not an extra process inside the web container. The web image’s `CMD` is Next.js; the worker image runs `npx tsx scripts/worker.ts` only.

### Automated setup (recommended)

Requires **`.env.coolify.local`** with a Coolify API token that can **create applications**, **PATCH env**, and **trigger deploy** (not deploy-only).

1. Ensure **`COOLIFY_DEPLOY_WEBHOOK_URL`** points at the **WMS web** app (existing).
2. Run:

```bash
npm run coolify:provision-sync-worker
```

This will:

- `POST /applications/private-deploy-key` → app name **`carbon-wms-sync-worker`**, **`dockerfile_location`:** `/Dockerfile.worker`
- Copy runtime env from the web app (same `DATABASE_URL`, Lightspeed keys, etc.), forcing **`WMS_AUTO_MIGRATE=0`** on the worker (migrations stay on the web deploy)
- Queue a deploy via **`POST /api/v1/deploy?uuid=<worker-uuid>&force=false`**

3. Add to **`.env.coolify.local`** (script prints these):

- **`COOLIFY_WORKER_APP_UUID`**
- **`COOLIFY_WORKER_DEPLOY_WEBHOOK_URL`** — worker app → Configuration → Webhooks (same shape as the web deploy URL, different `uuid=`)

Worker-only deploy from your machine:

```bash
npm run deploy:coolify:worker
```

Re-run **`npm run coolify:provision-sync-worker`** after adding **`COOLIFY_WORKER_APP_UUID`** to refresh env from the web app (skips create; handles duplicate name with **409**).

### Manual setup (UI)

1. **Coolify → CARBON WMS → production → New resource → Application**
2. Same **Git** repo + branch as WMS web.
3. **Build:** Dockerfile at **`Dockerfile.worker`** (not `/Dockerfile`).
4. **Env:** mirror the web app (`DATABASE_URL`, `LS_*`, etc.); set **`WMS_AUTO_MIGRATE=0`**.
5. **No public domain** required.
6. **Redeploy** when `Dockerfile.worker`, `scripts/worker.ts`, or worker-related `lib/` code changes.

If you **only** run the web container, **queued** `sync_jobs` rows (`lightspeed_pull` from **Enqueue** on Live compare) stay **`queued`** until something runs the worker.

## Web UI sync vs queue

- **Inventory → Sync → Sync engine → “Trigger manual sync”** runs catalog sync **inside the web request** (`POST /api/inventory/sync/trigger`) — **no worker required**.
- **Live compare → “Enqueue Lightspeed catalog pull”** inserts **`queued`** jobs — the **worker** drains those (same `performLightspeedCatalogSync` pipeline as manual sync).

## Health

The worker does not need HTTP. Rely on **Coolify logs** and DB job tables for status; keep **`GET /api/health`** on the web service only (see Next.js + Coolify hardening rules).

## Database URL on the WMS web app (Coolify)

If the browser shows **`Database unavailable`** (e.g. on **Settings → Mobile OTA** upload, or **Active location** stuck on **Loading…**), the Next.js container has **no usable Postgres config**: `getPool()` is `null` when **`DATABASE_URL`** is unset/empty, or queries fail if the value is wrong.

### Fix in Coolify (UI)

1. Open **CARBON WMS → production →** your **WMS application** (not only the Postgres resource).
2. **Configuration → Environment variables**.
3. Find **`DATABASE_URL`**:
   - If the **value** is empty, the literal word `DATABASE_URL`, or anything that is **not** a full `postgresql://…` URL, fix it.
4. Copy the **internal** URL from **the Postgres service in the same environment** (e.g. **postgresql-database-… → General → Postgres URL (internal)**). Hostname must be the **Docker service name** (e.g. `postgresql-database-….internal` or similar), **not** `localhost` from your laptop.
5. Paste into **`DATABASE_URL`** on the **WMS** application. Ensure **Available at Runtime** is enabled for that variable.
6. **Save** all environment variables, then **Redeploy** the WMS app (rebuild from Git if needed so the running container picks up env).

### Optional CLI

- **`npm run coolify:sync-postgres-url`** — reads the **internal** Postgres URL from the Coolify API for the database in the **same environment** as the WMS app, PATCHes **`DATABASE_URL`** (runtime + buildtime), then run **`npm run deploy:coolify`**. Needs **`COOLIFY_API_TOKEN`** (env write) + **`COOLIFY_DEPLOY_WEBHOOK_URL`** (or **`COOLIFY_APP_UUID`**) in **`.env.coolify.local`**.
- **`npm run coolify:set-db`** — sets **`DATABASE_URL`** from **`COOLIFY_DATABASE_URL`** in **`.env.coolify.local`** if you prefer to paste the internal URL locally. Same token requirements; then redeploy.

Deploy-only API tokens cannot PATCH application envs.

### Same check for the worker app

Any **second service** running **`npm run worker`** must also receive the **same** valid **`DATABASE_URL`**.
