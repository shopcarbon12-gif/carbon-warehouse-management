# Agent credential & access index

> ⚠️ **SERVER MIGRATION (2026-06-11):** Production moved from the old Hetzner box
> `178.156.136.112` to the **Netcup server `152.53.210.171`**. **Use `152.53.210.171` only.**
> The old Hetzner IP now just `socat`-forwards `:443`/`:80` to Netcup; its app/DB
> containers are orphaned. Same Coolify port `:8000`, same DB ports (2040/55432).

This file is **committed to git** and contains **no secret values** — only paths, variable names, and access patterns. Any agent (Claude Code, Cursor, etc.) reading the project should read this file first to learn what credentials exist on the local machine and how to reach production.

The actual secret values live on this developer machine in gitignored files (see "Where the values live" below). Don't copy values out of those files into chat, transcripts, or this document.

---

## Quick start for a new agent

1. **Local consolidated copy** (gitignored): `.env.agent-secrets` at repo root. One file with every credential the agent might need. If it's missing, regenerate it from the source files listed below.
2. **SSH to warehouse VM** (verified working): `ssh shopcarbon@192.168.1.219` using `~/.ssh/id_ed25519` (no passphrase). User on the VM is `shopcarbon`, hostname `carboncdm`.
3. **Fast prod facts**: WMS = `https://wms.shopcarbon.com`. CDM agent = `192.168.1.219`. Coolify = `http://152.53.210.171:8000`.

---

## Where the values live

### Source-of-truth env files (gitignored, real values)

| File | Purpose |
|---|---|
| `.env` | Local dev: `DATABASE_URL` (localhost), `SESSION_SECRET` (local), `SEED_ADMIN_PASSWORD` |
| `.env.local` | Production-parity local mode: same vars as `.env.coolify.local` but pointing at localhost DB |
| `.env.coolify.local` | **Production mirror** — every credential the running WMS uses (DB, Shopify, Lightspeed, R2, Resend, Coolify, session secret, WMS device key) |
| `apps/carbon-cdm/.env` | CDM agent **dev** env: `CARBON_CDM_TOKEN` (dev value), `CARBON_WMS_URL` |
| `~/.git-credentials` | **Empty (0 bytes).** The old `GITHUB_PAT` in `.env.agent-secrets` returns `401 Bad credentials`. HTTPS push does not work — see *Push to GitHub* below |
| `~/.gitconfig` | Git identity (`shopcarbon12-gif`, `shopcarbon12@gmail.com`) |
| `~/.ssh/config` | SSH host aliases for the repos that need their own key: `github-carbon-gen`, `github-loyalty` |
| `~/.ssh/id_ed25519` | Outbound SSH private key — `shopcarbon@192.168.1.219` (CDM agent VM) and `root@152.53.210.171` (Coolify host). On GitHub it authenticates as the **CARBON-POS deploy key**, which is why the other repos have their own keys |
| `~/.ssh/carbon_wms_deploy` | GitHub key for **this repo** — authenticates as the user `shopcarbon12-gif` |
| `~/.ssh/carbon_gen_deploy` | GitHub key for **carbon-gen**, reached through the `github-carbon-gen` alias |
| `~/.ssh/id_ed25519_loyalty` | GitHub key for the **Loyalty** repo, via the `github-loyalty` alias |
| `192.168.1.219:/opt/carbon-cdm/.env` | **Production CDM agent env** — `CARBON_CDM_TOKEN` (prod), `CARBON_WMS_URL` |
| `apps/carbonwms-pc/key.properties` + `apps/carbonwms-pc/keys/carbonwms-pc-release.jks` | **CarbonWMS-PC release signing key** (Android shell app, package `com.shopcarbon.wmspc`). Created 2026-08-25 by `scripts/build-release.sh`; every future APK must use it. Backup: `~/CarbonWmsPcRelease/keys-backup/`; values also mirrored in `.env.agent-secrets` |

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
- **From the warehouse LAN or this dev workstation**: `DATABASE_URL` from `.env.coolify.local` against `152.53.210.171:3000` (Coolify public port). May be firewalled from arbitrary IPs.
- **From inside the agent VM (.219)**: same URL works; the VM is on a network that reliably reaches Coolify's public port.
- **Diagnostic helper**: `node scripts/diagnose-wms-db.mjs` (auto-loads `.env.coolify.local`).

### Trigger a Coolify deploy
```bash
npm run deploy:coolify             # POSTs COOLIFY_DEPLOY_WEBHOOK_URL with COOLIFY_API_TOKEN
npm run deploy:coolify-worker      # same for the sync worker
```

### SSH to the Coolify host (production, netcup)
`~/.ssh/id_ed25519` reaches it as root — use it when a deploy fails for reasons
the API will not show you (disk, memory, container state, build logs):
```bash
ssh -i ~/.ssh/id_ed25519 root@152.53.210.171
df -h /                             # disk-full has taken prod down twice
docker system df                    # build cache grows unbounded
docker builder prune -af            # the usual recovery
```

### Push to GitHub
Every repo pushes over **SSH**. The `credential.helper = store` setting is a
leftover: `~/.git-credentials` is empty and the `GITHUB_PAT` in
`.env.agent-secrets` is dead (`401 Bad credentials`), so nothing pushes over
HTTPS. Do not try to revive the PAT — use the keys.

The keys are already loaded in the ssh-agent, so a plain `git push` works in each
repo without extra flags:

| Repo | Remote | Key |
|---|---|---|
| `carbon-warehouse-management` (this one) | `git@github.com:shopcarbon12-gif/carbon-warehouse-management.git` | `~/.ssh/carbon_wms_deploy` |
| `carbon-gen` | `git@github-carbon-gen:shopcarbon12-gif/carbon-gen.git` | `~/.ssh/carbon_gen_deploy` |
| `Loyalty` | `git@github-loyalty:…` | `~/.ssh/id_ed25519_loyalty` |

`github-carbon-gen` and `github-loyalty` are **`Host` aliases in `~/.ssh/config`,
not git remote names** — the remote in each repo is still `origin`. Passing an
alias where a remote name belongs fails with "repository does not exist".

Each repo needs its own key because a GitHub deploy key can only be attached to
one repository; `~/.ssh/id_ed25519` was already claimed by CARBON-POS, so adding
it elsewhere is rejected with "Key is already in use".

Verify a key without pushing:
```bash
ssh -T git@github.com            # → Hi shopcarbon12-gif!  (or a repo name for a deploy key)
ssh -T git@github-carbon-gen
```

---

## What is **not** in this repo

- No SSH credentials for the **Senitron CDM** VM (its IP is variable DHCP; access via warehouse LAN only).
- No production CDM agent token — that's only on `192.168.1.219:/opt/carbon-cdm/.env`.

---

## Regenerating `.env.agent-secrets`

`.env.agent-secrets` is a convenience aggregation. If it's missing or stale, rebuild it from the source files above. It is `.env.*` so it's automatically gitignored. Never put it in any other location, and never commit it.

---

## Security rule

`.cursor/rules/coolify-agent-env.mdc` is the binding policy: **never commit production secrets**, and rotate them in Coolify if they leak. Treat that rule as the constraint when designing any future credential workflow.
