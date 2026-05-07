# Agent credential & access index

This file is **committed to git** and contains **no secret values** — only paths, variable names, and access patterns. Any agent (Claude Code, Cursor, etc.) reading the project should read this file first to learn what credentials exist on the local machine and how to reach production.

The actual secret values live on this developer machine in gitignored files (see "Where the values live" below). Don't copy values out of those files into chat, transcripts, or this document.

---

## Quick start for a new agent

1. **Local consolidated copy** (gitignored): `.env.agent-secrets` at repo root. One file with every credential the agent might need. If it's missing, regenerate it from the source files listed below.
2. **SSH to warehouse VM** (verified working): `ssh shopcarbon@192.168.1.219` using `~/.ssh/id_ed25519` (no passphrase). User on the VM is `shopcarbon`, hostname `carboncdm`.
3. **Fast prod facts**: WMS = `https://wms.shopcarbon.com`. CDM agent = `192.168.1.219`. Coolify = `http://178.156.136.112:8000`.

---

## Where the values live

### Source-of-truth env files (gitignored, real values)

| File | Purpose |
|---|---|
| `.env` | Local dev: `DATABASE_URL` (localhost), `SESSION_SECRET` (local), `SEED_ADMIN_PASSWORD` |
| `.env.local` | Production-parity local mode: same vars as `.env.coolify.local` but pointing at localhost DB |
| `.env.coolify.local` | **Production mirror** — every credential the running WMS uses (DB, Shopify, Lightspeed, R2, Resend, Coolify, session secret, WMS device key) |
| `apps/carbon-cdm/.env` | CDM agent **dev** env: `CARBON_CDM_TOKEN` (dev value), `CARBON_WMS_URL` |
| `~/.git-credentials` | GitHub PAT in `https://user:TOKEN@github.com` form |
| `~/.gitconfig` | Git identity (`shopcarbon12-gif`, `shopcarbon12@gmail.com`) |
| `~/.ssh/id_ed25519` | Outbound SSH private key — used for `shopcarbon@192.168.1.219` |
| `~/.ssh/id_ed25519.pub` | Public counterpart (the same line should be in `/home/shopcarbon/.ssh/authorized_keys` on the agent VM) |
| `192.168.1.219:/opt/carbon-cdm/.env` | **Production CDM agent env** — `CARBON_CDM_TOKEN` (prod), `CARBON_WMS_URL` |

### Variable name reference

Look up real values in the env files above. Never paste values into chat or this file.

**Database** — `DATABASE_URL`
**Sessions** — `SESSION_SECRET`, `WMS_DEVICE_KEY`
**Shopify** — `SHOPIFY_APP_CLIENT_ID`, `SHOPIFY_APP_CLIENT_SECRET`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, `SHOPIFY_WEBHOOK_SECRET`, `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_REDIRECT_URI`, `SHOPIFY_SCOPES`
**Lightspeed R-Series** — `LS_CLIENT_ID`, `LS_CLIENT_SECRET`, `LS_REFRESH_TOKEN`, `LS_ACCOUNT_ID`, `LS_API_BASE`, `LS_DOMAIN_PREFIX`
**Cloudflare R2** — `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
**Email** — `RESEND_API_KEY`, `PUSH_NOTIFICATION_EMAIL`
**Coolify** — `COOLIFY_DEPLOY_WEBHOOK_URL`, `COOLIFY_API_TOKEN`, `COOLIFY_WORKER_DEPLOY_WEBHOOK_URL`, `COOLIFY_WORKER_APP_UUID`, `COOLIFY_POSTGRES_PUBLIC_PORT`, `COOLIFY_POSTGRES_UUID`
**CDM agent** — `CARBON_CDM_TOKEN` (different value in dev `.env` vs prod VM `.env`), `CARBON_WMS_URL`

---

## Common operations

### SSH to the CDM agent VM (warehouse)
```bash
ssh shopcarbon@192.168.1.219
# common ops once on the VM:
sudo systemctl status carbon-cdm-agent.service
sudo journalctl -u carbon-cdm-agent.service -f
sudo cat /opt/carbon-cdm/.env       # production token + WMS URL
```

### Read the production CDM agent token from a script
```bash
ssh shopcarbon@192.168.1.219 'grep CARBON_CDM_TOKEN /opt/carbon-cdm/.env | cut -d= -f2'
```

### Connect to the production database
- **From the warehouse LAN or this dev workstation**: `DATABASE_URL` from `.env.coolify.local` against `178.156.136.112:3000` (Coolify public port). May be firewalled from arbitrary IPs.
- **From inside the agent VM (.219)**: same URL works; the VM is on a network that reliably reaches Coolify's public port.
- **Diagnostic helper**: `node scripts/diagnose-wms-db.mjs` (auto-loads `.env.coolify.local`).

### Trigger a Coolify deploy
```bash
npm run deploy:coolify             # POSTs COOLIFY_DEPLOY_WEBHOOK_URL with COOLIFY_API_TOKEN
npm run deploy:coolify-worker      # same for the sync worker
```

### Push to GitHub
`~/.git-credentials` is preconfigured with `helper = store`; `git push` works without further setup.

---

## What is **not** in this repo

- No SSH credentials for the **Senitron CDM** VM (its IP is variable DHCP; access via warehouse LAN only).
- No SSH credentials for the **Coolify host** (`178.156.136.112`) — only the deploy webhook + API token.
- No production CDM agent token — that's only on `192.168.1.219:/opt/carbon-cdm/.env`.

---

## Regenerating `.env.agent-secrets`

`.env.agent-secrets` is a convenience aggregation. If it's missing or stale, rebuild it from the source files above. It is `.env.*` so it's automatically gitignored. Never put it in any other location, and never commit it.

---

## Security rule

`.cursor/rules/coolify-agent-env.mdc` is the binding policy: **never commit production secrets**, and rotate them in Coolify if they leak. Treat that rule as the constraint when designing any future credential workflow.
