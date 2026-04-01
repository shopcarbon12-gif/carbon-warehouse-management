# Carbon WMS

Next.js warehouse management UI (dev server uses port **3040** — see `package.json`).

## Local development

```bash
cp .env.example .env
# Set DATABASE_URL (Coolify Postgres internal URL in production).

npm install
npm run db:migrate   # apply schema (requires Postgres reachable)
npm run db:seed      # optional sample tenant, locations, orders, admin@example.com

npm run dev
```

Open [http://localhost:3040](http://localhost:3040). `npm run dev` sets `WMS_APP_PUBLIC_BASE_URL` and `NEXT_PUBLIC_BASE_URL` to that origin when omitted, matching the **same env keys** you use in production with `https://wms.shopcarbon.com` (see `.env.example` header).

## Coolify + PostgreSQL

Do the following in **your** Coolify dashboard:

### 1. Link Postgres and set `DATABASE_URL`

1. Open your **Coolify** project → select the **WMS** application (this Next service).
2. Under **Environment variables** (or **Production** / **Staging** env, depending on your Coolify version), add:
   - **`DATABASE_URL`** = the **internal** Postgres URL for the database linked to this app.  
     Use the value Coolify shows on the **PostgreSQL** resource (often `postgresql://USER:PASSWORD@HOST:5432/DB` on the Docker network).  
     If Coolify offers **“Connect to database”** / **linked variable**, prefer that so the URL stays in sync.
3. Save and **redeploy** the WMS service so the app picks up the variable.

### 2. One-time schema: `npm run db:migrate`

The production **Dockerfile** ships a **standalone** Next image: it usually does **not** include `scripts/` or `tsx`, so **`npm run db:migrate` may not work inside that running container**.

Pick **one** approach:

- **CI (recommended):** In GitHub Actions / your pipeline, after Postgres is up, run  
  `npm ci && npm run db:migrate` with **`DATABASE_URL`** as a secret (same string as in Coolify).
- **Your machine:** Temporarily allow access to that Postgres (VPN, SSH tunnel, or Coolify “open port” only if you accept the risk), then:  
  `DATABASE_URL="postgresql://..." npm run db:migrate`
- **Custom Coolify command:** Only if your command runs in an environment that has the **full repo** + `node_modules` (e.g. a separate “migrate” service or a build step), run `npm run db:migrate` there.

`db:migrate` applies [`scripts/schema.sql`](scripts/schema.sql), then every `*.sql` in [`scripts/migrations/`](scripts/migrations/) in sorted order (currently RFID core in [`001_rfid_core.sql`](scripts/migrations/001_rfid_core.sql)). The baseline schema is **not** fully idempotent on re-run (plain `CREATE TABLE`); migration files use `IF NOT EXISTS` / guarded `ALTER` so they are safe to repeat. For an **empty** database, run the full flow once; for an **existing** database, run `db:migrate` from a dev machine against `DATABASE_URL` so new migration files apply (or rely on `WMS_AUTO_MIGRATE=1` in Docker, which runs migrations even when the baseline was already applied).

### 3. Optional seed (staging only)

On a machine (or job) that has the repo and `DATABASE_URL`:

```bash
SEED_ADMIN_PASSWORD='your-strong-password' npm run db:seed
```

Do **not** use the default seed password in production.

---

**Also in Coolify:** set **`SESSION_SECRET`**, **`WMS_DEVICE_KEY`**, **`NODE_ENV=production`**, **`NEXT_PUBLIC_BASE_URL`**, **`WMS_APP_PUBLIC_BASE_URL`**, and any R2 / Lightspeed / email vars you use (see [`.env.example`](.env.example)).

### Public URL checklist (prod + local + OAuth)

| Where | Variables | Value |
|--------|-----------|--------|
| **Coolify (production)** | `NEXT_PUBLIC_BASE_URL`, `WMS_APP_PUBLIC_BASE_URL` | `https://wms.shopcarbon.com` (no trailing slash) |
| **Local** | same keys in gitignored **`.env.local`** | `http://localhost:3040` — or run **`npm run env:ensure-local`** |

**CLI (Coolify):** With write-capable **`COOLIFY_API_TOKEN`** + app UUID in **`.env.coolify.local`**, run **`npm run coolify:set-public-urls`** to PATCH both production URLs, then **`npm run deploy:coolify`** (rebuild so `NEXT_PUBLIC_*` is baked in). One shot: **`npm run sync:public-urls`** (local `.env.local` + Coolify patch if creds exist + deploy webhook).

Production hostname: **`https://wms.shopcarbon.com`**. In DNS, add a **`wms`** record (usually **CNAME** to the hostname Coolify shows for the app, or **A** to the server IP). In Coolify → WMS → **Configuration** → **General** → **Domains**, enter **`https://wms.shopcarbon.com`** (include **`https://`** for Let’s Encrypt / Traefik). Add **`https://www.wms.shopcarbon.com`** only if that host exists in DNS. Then **Save** and **Redeploy**.

**Lightspeed:** This app is built around **Lightspeed R-Series** (`api.lightspeedapp.com`, OAuth + `LS_ACCOUNT_ID`). Catalog sync and **`/api/lightspeed/sales`** use the R-Series JSON API first; **Retail (X-Series)** is an optional fallback if you set shop **`LS_DOMAIN_PREFIX`** and **`LS_PERSONAL_TOKEN`** (or X OAuth) — see **`.env.example`**.

**Lightspeed OAuth:** Register **`…/api/lightspeed/callback`** for **both** production and **`http://localhost:3040`** if you use local OAuth (must match **`LS_REDIRECT_URI`** / public base).

**Full DB mirror (local copy of prod data):** run **`npm run db:mirror:ssh`** if you have non-interactive **`ssh root@<Coolify host>`** access (uses `docker exec` on the WMS Postgres container, then `pg_restore` into **`docker compose`** — keep local Postgres major version aligned with prod, e.g. **18**). Details: **`scripts/db-mirror-coolify.example.sh`**. Do not commit dumps or passwords.

**Local = production parity (real data + real Lightspeed, no demo catalog):** keep a gitignored **`.env.coolify.local`** snapshot of Coolify vars, then:

1. **`docker compose up -d`**
2. **`npm run db:mirror:ssh`** — load prod Postgres into local `carbon_wms`
3. **`npm run env:parity-local`** — writes **`.env.local`** with local URLs, **`DATABASE_URL`** → local docker, **`WMS_LS_STRICT=1`**, and copied **`LS_*`** / R2 / email / session/device keys (not `COOLIFY_*`). **`LS_REDIRECT_URI`** is set to **`http://localhost:3040/api/lightspeed/callback`** — register that in Lightspeed if you OAuth locally.
4. **`npm run dev`**

Unset **`WMS_LS_STRICT`** (or use **`npm run env:ensure-local`** only) if you prefer the old fallback to simulated Lightspeed SKUs when the API is down.

After you **push** to the branch Coolify builds from, either wait for automatic deploy (if enabled) or click **Redeploy** on the application in Coolify.

**CLI deploy (`npm run deploy:coolify`):** In Coolify open the WMS app → **Configuration** → **Webhooks** and copy **Deploy Webhook** into **`COOLIFY_DEPLOY_WEBHOOK_URL`**. The API returns **401** without auth; create **Keys & Tokens** → **API Tokens** with the **deploy** permission, copy the token once into **`COOLIFY_API_TOKEN`**, then run:

```bash
set COOLIFY_DEPLOY_WEBHOOK_URL=...   # Windows CMD; use $env:... in PowerShell
set COOLIFY_API_TOKEN=...
npm run deploy:coolify
```

Keep both values in gitignored **`.env.coolify.local`** (not in git).

**API sanity check (`npm run coolify:api-check`):** calls **GET** `/api/v1/applications/{uuid}` using **`COOLIFY_API_TOKEN`** and the same base/uuid resolution as **`coolify:set-db`**. Official reference: [Authorization](https://coolify.io/docs/api-reference/authorization), [Get application](https://coolify.io/docs/api-reference/api/operations/get-application-by-uuid), [Bulk update envs](https://coolify.io/docs/api-reference/api/operations/update-envs-by-application-uuid) (**PATCH** returns **201** on success).

Optional: set **`WMS_BASE_PATH`** at **build time** if the app is served under a subpath (see `next.config.ts`).

Background worker (sync jobs): **`npm run worker`** — locally, a second terminal; on Coolify use **`Dockerfile.worker`** (see **`docs/WORKER.md`**, **`npm run coolify:provision-sync-worker`**).

## E2E

```bash
npx playwright install
npm run test:e2e
```

Use **`PLAYWRIGHT_SKIP_WEBSERVER=1`** if the dev server is already running.

## Docker

The included `Dockerfile` builds a **standalone** Next image (port `3000` in the container). Map Coolify’s public port as needed and inject `DATABASE_URL` (and any secrets) via Coolify environment variables — not baked into the image.

## Learn more

- [Next.js documentation](https://nextjs.org/docs)
