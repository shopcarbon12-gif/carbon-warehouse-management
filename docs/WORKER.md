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
