#!/usr/bin/env bash
# Example policy routing so BOTH NICs can reach 192.168.100.1 (same IP, different LANs).
# Edit IFACE_*/GW_*/LOCAL_* to match `ip -br addr` / `ip route` on your PC.
#
# Usage (as root):
#   DISH1_IFACE=wlan0 DISH1_GW=192.168.1.1 DISH1_LOCAL=192.168.1.50 \
#   DISH2_IFACE=wlan1 DISH2_GW=192.168.1.1 DISH2_LOCAL=192.168.1.60 \
#   sudo -E ./scripts/linux-dual-nic-routes.sh
#
# Note: Starlink router LAN IPs often collide (both 192.168.1.1). Prefer SO_BINDTODEVICE
# (this app's Python iface proxy) over routes alone. If routers are in non-bypass and you
# can reach each dish only via its router, you may instead set different "address" values
# in config.json once you discover a unique path per LAN.

set -euo pipefail

DISH1_IFACE=${DISH1_IFACE:-wlan0}
DISH2_IFACE=${DISH2_IFACE:-wlan1}
DISH1_GW=${DISH1_GW:-}
DISH2_GW=${DISH2_GW:-}
DISH1_LOCAL=${DISH1_LOCAL:-}
DISH2_LOCAL=${DISH2_LOCAL:-}
TARGET=${TARGET:-192.168.100.1}

if [[ -z "$DISH1_GW" || -z "$DISH2_GW" || -z "$DISH1_LOCAL" || -z "$DISH2_LOCAL" ]]; then
  echo "Set DISH1_IFACE DISH1_GW DISH1_LOCAL DISH2_IFACE DISH2_GW DISH2_LOCAL" >&2
  exit 1
fi

# Table 101 = dish 1, 102 = dish 2
ip route replace "$TARGET"/32 via "$DISH1_GW" dev "$DISH1_IFACE" table 101
ip route replace default via "$DISH1_GW" dev "$DISH1_IFACE" table 101
ip rule del from "$DISH1_LOCAL" table 101 2>/dev/null || true
ip rule add from "$DISH1_LOCAL" table 101 priority 1010

ip route replace "$TARGET"/32 via "$DISH2_GW" dev "$DISH2_IFACE" table 102
ip route replace default via "$DISH2_GW" dev "$DISH2_IFACE" table 102
ip rule del from "$DISH2_LOCAL" table 102 2>/dev/null || true
ip rule add from "$DISH2_LOCAL" table 102 priority 1020

echo "Installed policy routes for $TARGET via $DISH1_IFACE / $DISH2_IFACE"
ip rule list | grep -E '1010|1020' || true
