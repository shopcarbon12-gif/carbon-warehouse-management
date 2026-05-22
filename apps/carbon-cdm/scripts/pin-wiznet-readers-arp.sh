#!/bin/bash
# Persistent ARP-pin daemon for all WIZnet reader bridges.
#
# Defends against rogue LAN devices that ARP-poison the IPs the WIZnet
# bridges live at. Live evidence 2026-05-21: a device with MAC
# 8c:88:22:81:5a:bd claimed .1 / .66 / .69 simultaneously, intercepted TCP
# to 192.168.1.69:10002, accepted the connection, then sent nothing — the
# POS reader supervisor saw `cleanExit:true, totalRecords:0, ~300ms` on
# every spawn for hours and concluded the chip was wedged. The chip was
# fine; the bridge was just unreachable at the IP layer.
#
# Strategy: every INTERVAL, run `wiznet-cli -d` to discover all bridges
# (uses MAC-broadcast UDP, immune to ARP poisoning), parse each
# (IP, MAC) pair, and `ip neigh replace` them as permanent. This pins
# .219's kernel routing table to the true bridge MACs regardless of what
# the network claims.
#
# Safe because all WIZnet bridges run DHCP=N (static) — their IPs don't
# legitimately change.

set -u
IFACE=enp0s3
INTERVAL=30
WIZNET_CLI=/opt/legacy-rfid/wiznet-cli
LOG_TAG=pin-wiznet-arp

# Companion to pin-gateway-arp.service which pins ONLY the gateway. This
# script handles every reader bridge currently on the LAN.
mac_to_colon() {
  # 0008DC5956A8 -> 00:08:dc:59:56:a8
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/\(..\)/\1:/g; s/:$//'
}

while true; do
  if ! OUT=$("$WIZNET_CLI" -d 2>/dev/null); then
    sleep "$INTERVAL"
    continue
  fi
  # Each device line shape (column positions):
  #  N. MAC          IP            SUBNET         GATEWAY       PORT  DHCP  BAUD ...
  # Field 2 = MAC (12 hex chars), Field 3 = IP. Filter for plausible
  # WIZnet OUIs (00:08:DC) so we don't pin random ARP entries.
  echo "$OUT" | awk '
    /^ *[0-9]+\./ {
      mac=$2; ip=$3;
      if (mac ~ /^0008DC[0-9A-Fa-f]{6}$/ && ip ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) {
        print mac, ip
      }
    }
  ' | sort -u | while read -r MAC IP; do
    COLON_MAC=$(mac_to_colon "$MAC")
    CURRENT=$(ip neigh show "$IP" dev "$IFACE" 2>/dev/null | awk '{print $3}')
    if [ "$CURRENT" != "$COLON_MAC" ]; then
      ip neigh replace "$IP" lladdr "$COLON_MAC" nud permanent dev "$IFACE" 2>/dev/null
      logger -t "$LOG_TAG" "re-pinned $IP -> $COLON_MAC (was ${CURRENT:-none})"
    fi
  done
  sleep "$INTERVAL"
done
