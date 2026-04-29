#!/usr/bin/env bash
# Carbon CDM — bootstrap the legacy-rfid bundle on the CarbonCDM VM.
#
# Idempotent. Runs on the VM (NOT the dev laptop). Sets up the isolated
# /opt/legacy-rfid/ layout, installs system libraries the legacy binaries
# need at runtime, creates the runtime working directory with a CarbonCDM-
# tuned config (zero outbound to any external service).
#
# The legacy binaries themselves (cdm, MonsoonReader, etc.) are NOT
# fetched by this script — they are rsync'd in separately from the dev
# laptop's staging dir BEFORE this script runs. This script just verifies
# they're in place and sets up everything around them.
#
# Usage on the VM:
#   sudo /opt/carbon-cdm/scripts/bootstrap-legacy-rfid.sh

set -euo pipefail

LEGACY_DIR="/opt/legacy-rfid"
RUNTIME_DIR="${LEGACY_DIR}/runtime"
LOG_DIR="${RUNTIME_DIR}/logs"
EXPECTED_BINARIES=( cdm MonsoonReader )

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run as root (sudo)." >&2
  exit 1
fi

echo "==> 1/6  installing legacy runtime libraries via apt"
DEBIAN_FRONTEND=noninteractive apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  libpq5 \
  libusb-1.0-0 \
  libmosquitto1 \
  libssl3 \
  libstdc++6 \
  libgcc-s1 \
  libudev1 \
  libcap2 \
  >/dev/null

echo "==> 2/6  ensuring directory layout (${LEGACY_DIR}, ${RUNTIME_DIR}, ${LOG_DIR})"
mkdir -p "${LEGACY_DIR}" "${RUNTIME_DIR}" "${LOG_DIR}"
# cdm expects ./handheld/{outgoing,incoming}/ in its cwd for handheld upload
# spooling. We don't ship handhelds with cdm, but it warns loudly without them.
mkdir -p "${RUNTIME_DIR}/handheld/outgoing" "${RUNTIME_DIR}/handheld/incoming"
# Same owner as the carbon-cdm-agent service so it can write/read both
chown -R shopcarbon:shopcarbon "${LEGACY_DIR}"


echo "==> 3/6  verifying binaries are present (rsync them in before running this)"
missing=()
for bin in "${EXPECTED_BINARIES[@]}"; do
  if [[ ! -x "${LEGACY_DIR}/${bin}" ]]; then
    missing+=( "${bin}" )
  fi
done
if (( ${#missing[@]} > 0 )); then
  echo "ERROR: missing legacy binaries in ${LEGACY_DIR}: ${missing[*]}" >&2
  echo "       Run from dev laptop:" >&2
  echo "         rsync -av /home/carbondev/legacy-rfid-bundle/ shopcarbon@<vm>:${LEGACY_DIR}/" >&2
  exit 2
fi

# Belt + suspenders: chmod +x in case rsync stripped the bit
chmod +x "${LEGACY_DIR}/cdm" \
         "${LEGACY_DIR}/MonsoonReader" \
         "${LEGACY_DIR}"/*.sh 2>/dev/null || true
[[ -d "${LEGACY_DIR}/zebra/app" ]] && chmod +x "${LEGACY_DIR}/zebra/app"/* 2>/dev/null || true

# cdm runs from RUNTIME_DIR but invokes drivers as ./MonsoonReader,
# ./new_monsoonreader, ./rfidapi etc. — relative to cwd. Symlink them
# from the bin dir so cdm finds them and we keep one source of truth.
for bin in MonsoonReader new_monsoonreader rfidapi cdm_pos wiznet-cli wiznet-cli2 led-control discover; do
  if [[ -x "${LEGACY_DIR}/${bin}" ]]; then
    ln -sfn "${LEGACY_DIR}/${bin}" "${RUNTIME_DIR}/${bin}"
  fi
done
# zebra/ subdir is referenced by relative path from rfidapi — symlink the dir.
[[ -d "${LEGACY_DIR}/zebra" ]] && ln -sfn "${LEGACY_DIR}/zebra" "${RUNTIME_DIR}/zebra"
[[ -f "${LEGACY_DIR}/alarm.ogg" ]] && ln -sfn "${LEGACY_DIR}/alarm.ogg" "${RUNTIME_DIR}/alarm.ogg"

echo "==> 4/6  writing CarbonCDM-tuned cdm.json (no outbound to anyone except localhost)"
cat > "${RUNTIME_DIR}/cdm.json" <<'JSON'
{
  "_carbon_note": "CarbonCDM-managed configuration. Zero outbound to any external service. cdm posts reads only to the local Carbon CDM agent.",

  "no_mqtt": 1,
  "external_connections": 0,
  "disable_sending_data_to_endpoint_api": true,
  "disable_sending_data_to_endpoint_api_for_instant_readers": true,
  "additional_endpoint_url": "http://127.0.0.1:8765/ingest",

  "mock_reader": 0,
  "debug_mode": 0,
  "manual_config": 1,
  "connect_delay": 1,
  "reads_to_csv": 0,
  "restart_time": "21:11",

  "relay_update_interval": 30,
  "relay_health_interval": 25,
  "relay_hello_interval": 30,

  "read_timeout": 30,
  "respawn_timeouts": 2,
  "listen_port": 8888,
  "pos_listen_port": 8889,
  "cdm_url": "http://localhost/",
  "database_folder": "/opt/legacy-rfid/runtime/",

  "mqtt_port": 1883,
  "mqtt_server": "127.0.0.1",
  "mqtt_user": "carboncdm",
  "mqtt_pass": "carboncdm",
  "mqtt_channel": "RRD",
  "refresh_interval": 60,
  "whitelist_expiration": "6 month",

  "limit_audio_alerts_per_epc_to": 1,
  "reset_audio_alert_for_epc_if_not_setoff_for_minutes": 10,
  "only_alert_again_if_not_seen_for_x_minutes": 15,

  "custom_endpoint_time_bucket": 1,
  "custom_endpoint_time_bucket_reset_count": 60,
  "display_tags_stolen_always_regardless_of_trigger": false,
  "instant_alert_delay_exceptions": [],
  "instant_alert_delay_in_seconds": 0,
  "instant_alert_if_seen_in_same_second_upload_higher_ping_reader": true,
  "instant_alert_if_seen_in_same_second_upload_higher_ping_reader_if_same_reader_as_lasttime_do_not_upload": true,

  "skip_first_sighting_of_epc": false,
  "log_uploads_to": "/opt/legacy-rfid/runtime/logs/uploads.log",
  "flush_log_uploads_after": 60,
  "heartbeat_injector_url": "",

  "print_delay_msecs": 500,

  "disable_sending_data_to_endpoint_api_for_readers": []
}
JSON
chown shopcarbon:shopcarbon "${RUNTIME_DIR}/cdm.json"

# Empty readers.json to start — Carbon CDM agent rewrites this from WMS config.
if [[ ! -f "${RUNTIME_DIR}/readers.json" ]]; then
  echo "[]" > "${RUNTIME_DIR}/readers.json"
  chown shopcarbon:shopcarbon "${RUNTIME_DIR}/readers.json"
fi

# cdm spawns ./killall.sh from cwd as part of its startup/cleanup cycle to
# reap any lingering reader-driver processes (MonsoonReader, rfidapi, etc.)
# from a prior crash. The script is tiny but mandatory — without it cdm
# loops in a "Not an executable file" error and never binds its HTTP API.
cat > "${RUNTIME_DIR}/killall.sh" <<'KILL'
#!/usr/bin/env bash
# Reaps any lingering reader-driver child processes between cdm cycles.
# Match by full command line so we don't kill unrelated processes.
for name in MonsoonReader new_monsoonreader rfidapi wiznet-cli wiznet-cli2 cdm_pos; do
  pkill -9 -f "/opt/legacy-rfid/${name}" 2>/dev/null || true
  pkill -9 -x "${name}" 2>/dev/null || true
done
exit 0
KILL
chmod 0755 "${RUNTIME_DIR}/killall.sh"
chown shopcarbon:shopcarbon "${RUNTIME_DIR}/killall.sh"

# Symlink expected by cdm (it looks for some files in cwd ./)
# We run cdm from RUNTIME_DIR so it finds cdm.json + readers.json there.

echo "==> 5/6  installing sudoers rule (shopcarbon may restart orchestrator)"
SUDOERS_FILE="/etc/sudoers.d/carbon-cdm"
cat > "${SUDOERS_FILE}" <<'SUDO'
# Allow the shopcarbon user (carbon-cdm-agent service) to manage the
# carbon-cdm-orchestrator unit without an interactive password.
shopcarbon ALL=(root) NOPASSWD: /bin/systemctl restart carbon-cdm-orchestrator.service
shopcarbon ALL=(root) NOPASSWD: /bin/systemctl is-active --quiet carbon-cdm-orchestrator.service
shopcarbon ALL=(root) NOPASSWD: /bin/systemctl is-active --quiet carbon-cdm-orchestrator
shopcarbon ALL=(root) NOPASSWD: /bin/systemctl status carbon-cdm-orchestrator.service
SUDO
chmod 0440 "${SUDOERS_FILE}"
visudo -cf "${SUDOERS_FILE}" >/dev/null

echo "==> 6/6  smoke test: cdm shared-library resolution"
sudo -u shopcarbon ldd "${LEGACY_DIR}/cdm" 2>&1 | grep -E "not found|=> /" | head -5

echo ""
echo "Bootstrap complete."
echo "  legacy bin dir:  ${LEGACY_DIR}"
echo "  runtime dir:     ${RUNTIME_DIR}"
echo "  config:          ${RUNTIME_DIR}/cdm.json (CarbonCDM-tuned, zero outbound)"
echo "  readers config:  ${RUNTIME_DIR}/readers.json (managed by Carbon CDM agent)"
echo ""
echo "Next: enable the carbon-cdm-agent + carbon-cdm-orchestrator systemd units."
