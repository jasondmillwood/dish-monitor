#!/usr/bin/env bash
# Rejoin a dish Wi-Fi if NetworkManager gave up (e.g. after a dish reboot). Run every 2 min by the user timer.
# Config: ~/.config/dish-monitor/watchdog.conf, one line per dish:  <NetworkManager connection name><TAB><interface>
set -u
CONF="${WATCHDOG_CONF:-$HOME/.config/dish-monitor/watchdog.conf}"
[ -r "$CONF" ] || { echo "no $CONF; nothing to watch"; exit 0; }
check() {
  local con="$1" ifc="$2" ssid state
  ssid=$(nmcli -g 802-11-wireless.ssid con show "$con" 2>/dev/null) || { echo "unknown connection '$con'"; return; }
  state=$(nmcli -g GENERAL.STATE dev show "$ifc" 2>/dev/null)
  case "$state" in 100*) return;; esac
  if nmcli -t -f SSID dev wifi list ifname "$ifc" --rescan yes 2>/dev/null | grep -Fxq "$ssid"; then
    echo "$con on $ifc was down ($state); SSID visible, reconnecting"
    nmcli --wait 40 con up "$con" ifname "$ifc" && echo "$con reconnected" || echo "$con reconnect failed"
  else
    echo "$con on $ifc down; SSID not visible yet"
  fi
}
while IFS=$'\t' read -r con ifc; do
  [ -z "${con:-}" ] || [ "${con#\#}" != "$con" ] || check "$con" "$ifc"
done < "$CONF"
