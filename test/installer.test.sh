#!/usr/bin/env bash
# Installer tests in a throwaway HOME: dry-run writes nothing; 1- and 2-dish installs; uninstall.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*"; exit 1; }
for n in 1 2; do
  H=$(mktemp -d); export HOME="$H" XDG_CONFIG_HOME="$H/.config" XDG_STATE_HOME="$H/.local/state"
  out=$(bash "$ROOT/install.sh" --dry-run --source "$ROOT" --dishes $n --no-systemd)
  [ -z "$(find "$H" -mindepth 1 -print -quit)" ] || fail "dry-run wrote files"
  grep -q '\[dry-run\] write .*config.json' <<<"$out" || fail "dry-run did not show config"
  args=(--source "$ROOT" --dishes $n --no-systemd --watchdog); [ $n = 2 ] && args+=(--iface1 wlan0 --iface2 wlan1)
  bash "$ROOT/install.sh" "${args[@]}" >/dev/null
  C="$H/.config/dish-monitor/config.json"
  [ "$(stat -c %a "$C")" = 600 ] || fail "config mode"
  node -e 'const c=require(process.argv[1]); if(c.dishes.length!=+process.argv[2]) process.exit(1)' "$C" $n || fail "dish count"
  [ -f "$H/.local/share/dish-monitor/dist/client/index.html" ] || fail "client not built"
  [ -f "$H/.config/systemd/user/dish-monitor.service" ] || fail "unit"
  [ -f "$H/.config/systemd/user/wifi-watchdog.timer" ] || fail "watchdog timer"
  echo '{"dishes":[{"slot":"keep"}]}' > "$C"
  bash "$ROOT/install.sh" --source "$ROOT" --dishes $n --no-systemd >/dev/null
  grep -q keep "$C" || fail "re-run overwrote config"
  bash "$ROOT/install.sh" --uninstall --no-systemd >/dev/null
  [ ! -e "$H/.local/share/dish-monitor" ] && [ -f "$C" ] || fail "uninstall (keep config)"
  bash "$ROOT/install.sh" --uninstall --purge --no-systemd >/dev/null
  [ ! -e "$H/.config/dish-monitor" ] || fail "purge"
  rm -rf "$H"; echo "installer ok ($n dish)"
done
bash "$ROOT/install.sh" --dishes 3 --dry-run >/dev/null 2>&1 && fail "accepted 3 dishes" || true
bash "$ROOT/install.sh" --iface1 'x;rm' --dry-run >/dev/null 2>&1 && fail "accepted bad iface" || true
out=$(HOME=$(mktemp -d) bash "$ROOT/install.sh" --dry-run --no-systemd 2>&1) || fail "dry-run from repo failed"
grep -q 'git clone -q --depth 1 --branch v0.1.0 https://github.com/jasondmillwood/dish-monitor.git' <<<"$out" || fail "owner repo URL not built"
grep -q 'GITHUB_OWNER="jasondmillwood"' "$ROOT/install.sh" || fail "GITHUB_OWNER"
echo "installer tests passed"
