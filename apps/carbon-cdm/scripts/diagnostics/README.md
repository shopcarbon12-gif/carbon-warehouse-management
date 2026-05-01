# Carbon CDM diagnostics

Two scripts for one-off reader characterisation. They are *not* wired into the
agent runtime — run by hand when you need to see what a specific reader is
actually picking up.

## `capture-reader-saturation.mjs`

Runs **on the CarbonCDM VM** (the legacy-rfid bundle has to be at
`/opt/legacy-rfid/`). Spawns `MonsoonReader` directly against a single reader,
streams the binary `--stream` output, parses 50-byte records, and tracks every
unique EPC with its strongest RSSI and antenna number.

Saturation = N seconds with no new EPC (default 30s). Writes a JSON snapshot to
the path given by `--out`.

```bash
# Stop the agent first so its child doesn't fight for the WIZnet socket.
sudo systemctl stop carbon-cdm-agent.service
sudo killall -9 MonsoonReader || true

node capture-reader-saturation.mjs \
  --host 192.168.1.22 \
  --serialPort 10002 \
  --power 320 \
  --silenceMs 30000 \
  --out /tmp/captured-max.json
```

`--power` is the raw flag MonsoonReader expects (dBm × 10): 320 = 32 dBm,
300 = 30 dBm, 270 = 27 dBm. Restart the agent when done.

## `build-distance-report.mjs`

Runs **on the dev box** (or any Node host with outbound HTTPS to the WMS).
Reads the JSON snapshot, decodes every EPC with the project's actual
`decodeEpc()` formula (Carbon Jeans `tenant_epc_config`: F0A0B / 20+40+36
bits), then enriches with `custom_skus` + `matrices` via the WMS endpoint
`/api/cdm-agents/lookup-by-epc` (Bearer-authenticated with the agent token).

```bash
node build-distance-report.mjs \
  --in /tmp/captured-max.json \
  --out /home/carbondev/max_distance.html \
  --title "TEST3 (192.168.1.22) — Max Power · 32 dBm" \
  --token "$(ssh shopcarbon@192.168.1.219 'grep CARBON_CDM_TOKEN /opt/carbon-cdm/.env | cut -d= -f2')" \
  --wms https://wms.shopcarbon.com
```

If the lookup endpoint isn't reachable (proxy/deploy issue), the report still
generates — SKU / description columns degrade to `—` and a warning banner is
shown at the top.

## Output

Single HTML file per power level, sorted by best (least-negative) RSSI per EPC
(closest first). Columns:

1. row #
2. distance bucket (very close → fringe, heuristic from RSSI)
3. RSSI dBm
4. total reads in capture window
5. antenna number
6. binary (96 bits)
7. EPC hex (24 chars)
8. binary→EPC formula source (project's `stream-parser.ts`)
9. system_id (raw decimal — same value sent to the catalog lookup; no padding)
10. EPC→system_id formula source (`lib/server/epc-decode.ts` + `tenant_epc_config`)
11. `custom_skus.sku`
12. `matrices.description · color · size`
