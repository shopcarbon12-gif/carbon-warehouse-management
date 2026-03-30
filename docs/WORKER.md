# Background worker (`npm run worker`)

The repo ships a Node worker (`scripts/worker.ts`) that drains queued **Lightspeed** pull jobs and related sync work. It uses the same database and env as the Next.js app (`DATABASE_URL`, Lightspeed credentials, etc.).

## Local

```bash
npm run worker
```

Run it in a second terminal while `npm run dev` serves the web app.

## Production (Coolify)

1. Add a **second resource** in the same project (or a duplicate service) that runs **`npm run worker`** instead of starting Next — same image/build as the web app is fine if your Dockerfile’s default `CMD` is overridden in Coolify to `npm run worker`.
2. Point it at the **same** environment variables as the web container (especially `DATABASE_URL`).
3. **Redeploy** after changing worker code or Dockerfile.

## Web UI “Trigger manual sync”

The dashboard button typically **enqueues** work (e.g. `lightspeed_pull` rows). The worker **consumes** that queue. If nothing processes jobs, triggers will stack up and catalog will look stale until the worker runs.

## Health

The worker does not need HTTP. Rely on **Coolify logs** and DB job tables for status; keep **`GET /api/health`** on the web service only (see Next.js + Coolify hardening rules).
