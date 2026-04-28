# Carbon CDM agent

Runs at the warehouse. Replaces what Senitron's CDM did:

- Maintains persistent connections to fixed RFID readers
- Streams tag reads to `wms.shopcarbon.com`
- Reports health back to the WMS dashboard

This is **v0.1.0 — skeleton**. It connects, heartbeats, and pulls its
reader/antenna config from the WMS. It logs what it would spawn but does
not yet run `MonsoonReader` subprocesses (next iteration).

## Layout

```
apps/carbon-cdm/
├── src/
│   ├── index.ts           ← entrypoint: heartbeat loop + config poll
│   ├── config.ts          ← env loading + validation
│   ├── log.ts             ← structured logging
│   ├── wms-client.ts      ← HTTP client to wms.shopcarbon.com
│   ├── heartbeat.ts       ← periodic heartbeat
│   └── reader-supervisor.ts  ← reconciles desired vs. running readers
├── deploy/
│   └── carbon-cdm.service ← systemd unit for /etc/systemd/system/
├── .env.example
└── package.json
```

## Local dev (on the WMS dev laptop)

```bash
cd apps/carbon-cdm
npm install
cp .env.example .env
# Fill in CARBON_WMS_URL and CARBON_CDM_TOKEN (issued from /hardware_config)
npm run dev
```

You should see:

```
... [INFO] Carbon CDM agent starting {"version":"0.1.0", ...}
... [INFO] config pulled {"agent":"orlando-cdm","location":"001","readers":1}
... [INFO] would spawn MonsoonReader {"reader_id":"...","cmdline":"..."}
```

The agent's status pill in WMS `/hardware_config` flips to **online** within
~30 seconds.

## Production deploy on the Ubuntu VM

### Initial install (once)

```bash
# As root or via sudo on the warehouse Ubuntu VM:
useradd -m -s /bin/bash carbon || true
mkdir -p /opt/carbon-cdm
chown carbon:carbon /opt/carbon-cdm
```

### Each release — rsync from your dev laptop

From the repo root:

```bash
cd apps/carbon-cdm
npm install --omit=dev
npm run build
rsync -avz --delete \
  --exclude=.env --exclude=src --exclude=deploy \
  --include=dist/ --include=node_modules/ --include=package.json \
  ./ carbon@<vm-ip>:/opt/carbon-cdm/
scp deploy/carbon-cdm.service carbon@<vm-ip>:/tmp/
```

### On the VM — install/update systemd unit

```bash
sudo mv /tmp/carbon-cdm.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable carbon-cdm
sudo systemctl restart carbon-cdm
sudo journalctl -u carbon-cdm -f
```

### `.env` on the VM

```bash
# /opt/carbon-cdm/.env  (chmod 600, owner carbon)
CARBON_WMS_URL=https://wms.shopcarbon.com
CARBON_CDM_TOKEN=cdm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CARBON_HEARTBEAT_INTERVAL_SEC=30
CARBON_CONFIG_POLL_INTERVAL_SEC=60
CARBON_MONSOON_BINARY=/opt/carbon-cdm/MonsoonReader
CARBON_LOG_LEVEL=info
```

Issue the token via WMS `/hardware_config` → **Add agent** (or **Rotate** on
an existing one). The token is shown ONCE — copy it directly into `.env`.

## Healthcheck

- WMS `/hardware_config` shows the agent status pill: **online** /
  **degraded** / **offline**
- `degraded` = agent is heartbeating but its last config pull failed (network,
  bad token, server error)
- `offline` = no heartbeat in the last ~2× heartbeat interval

## Roadmap

| Version | What |
|---|---|
| 0.1.0 (now) | heartbeat + config pull + reader supervisor skeleton |
| 0.2.0 | actually spawn `MonsoonReader`, parse port-30100 stream, POST tag reads |
| 0.3.0 | dynamic per-antenna power via `--control` port |
| 0.4.0 | WebSocket from WMS for instant Start/Stop scan |
| 0.5.0 | label printing relay (replace CDM's CUPS bridge) |
