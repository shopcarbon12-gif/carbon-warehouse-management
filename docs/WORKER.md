# Background worker (`npm run worker`)

The repo ships a Node worker (`scripts/worker.ts`) that drains queued **Lightspeed** pull jobs and related sync work. It uses the same database and env as the Next.js app (`DATABASE_URL`, Lightspeed credentials, etc.).

Referenced from the web deep audit (`docs/web-deep-audit-report.html` §6): if Coolify runs **only** the Next container, manual sync jobs may queue until this worker (or an equivalent process) runs.

## Local

```bash
npm run worker
```

Run it in a second terminal while `npm run dev` serves the web app.

## Production (Coolify)

Use a **second application** (or duplicate service) that runs the worker process — not an extra process inside the web container.

1. **Coolify → your project → environment → New resource → Application** (or duplicate the WMS app).
2. **Same Git repository and branch** as the web app; same **Dockerfile** / build if you use Docker.
3. **Start command** (or Docker command override): `npm run worker` — **not** `npm start`. If the image’s default `CMD` is Next.js, override it in the UI so only the worker runs.
4. **Environment variables:** copy or link the **same** env as the web app (`DATABASE_URL`, Lightspeed keys, etc.). The worker does not need `PORT` for HTTP.
5. **No public domain** required; do not replace your web app URL with this service.
6. **Redeploy** when `scripts/worker.ts` or worker-related deps change.

If you **only** run the web container, `sync_jobs` / Lightspeed queue rows may sit until something runs `npm run worker` locally or you add this service.

## Web UI “Trigger manual sync”

The dashboard button typically **enqueues** work (e.g. `lightspeed_pull` rows). The worker **consumes** that queue. If nothing processes jobs, triggers will stack up and catalog will look stale until the worker runs.

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
