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

Open [http://localhost:3040](http://localhost:3040).

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

`db:migrate` applies [`scripts/schema.sql`](scripts/schema.sql). It is **not** fully idempotent on re-run (plain `CREATE TABLE`); run it **once** per empty database.

### 3. Optional seed (staging only)

On a machine (or job) that has the repo and `DATABASE_URL`:

```bash
SEED_ADMIN_PASSWORD='your-strong-password' npm run db:seed
```

Do **not** use the default seed password in production.

---

**Also in Coolify:** set **`SESSION_SECRET`**, **`WMS_DEVICE_KEY`**, **`SHOPIFY_WEBHOOK_SECRET`** as needed (see [`.env.example`](.env.example)).

Optional: set **`WMS_BASE_PATH`** at **build time** if the app is served under a subpath (see `next.config.ts`).

Background worker (sync jobs): **`npm run worker`** — run as a second process or Coolify service with the same **`DATABASE_URL`**.

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
