#!/usr/bin/env bash
# Dish Monitor installer (Linux, systemd user service). Unofficial; not affiliated with SpaceX or Starlink.
#
#   curl -fsSL https://raw.githubusercontent.com/jasondmillwood/dish-monitor/v0.1.0/install.sh | bash -s -- --dishes 1
#   ./install.sh --dishes 2 --iface1 wlan0 --iface2 wlan1 [--watchdog]
#   ./install.sh --dry-run ...      # print every step, change nothing
#   ./install.sh --uninstall [--purge]
#
# Never uses root. Optional root-only extras (dual-NIC policy routes) are printed, not run.
set -euo pipefail

# GitHub user or organisation that owns the repo (forks: change this one line)
GITHUB_OWNER="jasondmillwood"
REPO_URL="${DISH_MONITOR_REPO:-https://github.com/${GITHUB_OWNER}/dish-monitor.git}"
REF="${DISH_MONITOR_REF:-v0.1.0}"
PREFIX="${DISH_MONITOR_PREFIX:-$HOME/.local/share/dish-monitor}"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dish-monitor"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/dish-monitor"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DISHES=1 IFACE1="" IFACE2="" PORT=8787 HOST=0.0.0.0 WATCHDOG=0 DRY=0 UNINSTALL=0 PURGE=0 SOURCE="" NO_SYSTEMD=0 MOCK=0

usage() { sed -n "2,9p" "${BASH_SOURCE[0]}" 2>/dev/null | sed 's/^# \{0,1\}//'; cat <<U
Options: --dishes 1|2  --iface1 IF  --iface2 IF  --port N  --host ADDR  --watchdog  --mock
         --source DIR (install from a local checkout)  --prefix DIR  --no-systemd
         --dry-run  --uninstall  --purge (with --uninstall: also delete config + data)
U
}
while [ $# -gt 0 ]; do
  case "$1" in
    --dishes) DISHES="$2"; shift ;;
    --iface1) IFACE1="$2"; shift ;;
    --iface2) IFACE2="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --host) HOST="$2"; shift ;;
    --watchdog) WATCHDOG=1 ;;
    --mock) MOCK=1 ;;
    --source) SOURCE="$2"; shift ;;
    --prefix) PREFIX="$2"; shift ;;
    --no-systemd) NO_SYSTEMD=1 ;;
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { printf '==> %s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }
write() { # write <path> <mode>  (content on stdin)
  if [ "$DRY" = 1 ]; then printf '[dry-run] write %s (mode %s):\n' "$1" "$2"; sed 's/^/    | /'; else
    mkdir -p "$(dirname "$1")"; umask 077; cat > "$1.tmp"; chmod "$2" "$1.tmp"; mv "$1.tmp" "$1"; fi
}
have_systemd() { [ "$NO_SYSTEMD" = 0 ] && command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; }

case "$DISHES" in 1|2) ;; *) echo "--dishes must be 1 or 2" >&2; exit 2 ;; esac
case "$PORT" in ''|*[!0-9]*) echo "--port must be a number" >&2; exit 2 ;; esac
for i in "$IFACE1" "$IFACE2"; do case "$i" in *[!A-Za-z0-9_.:-]*) echo "bad interface name: $i" >&2; exit 2 ;; esac; done

# ---------------- uninstall ----------------
if [ "$UNINSTALL" = 1 ]; then
  say "Uninstalling Dish Monitor"
  if have_systemd; then
    run systemctl --user disable --now dish-monitor.service wifi-watchdog.timer 2>/dev/null || true
  fi
  run rm -f "$UNIT_DIR/dish-monitor.service" "$UNIT_DIR/wifi-watchdog.service" "$UNIT_DIR/wifi-watchdog.timer"
  have_systemd && run systemctl --user daemon-reload || true
  run rm -rf "$PREFIX"
  if [ "$PURGE" = 1 ]; then run rm -rf "$CONF_DIR" "$STATE_DIR"; else say "Kept $CONF_DIR and $STATE_DIR (use --purge to delete)"; fi
  say "Done."
  exit 0
fi

# ---------------- preflight ----------------
say "Preflight"
command -v node >/dev/null || { echo "Node.js >= 20 is required (https://nodejs.org)" >&2; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node.js >= 20 required, found $(node -v)" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required" >&2; exit 1; }
if [ "$DISHES" = 2 ] && { [ -z "$IFACE1" ] || [ -z "$IFACE2" ]; }; then
  echo "note: 2 dishes without --iface1/--iface2 runs in single-NIC mode (one dish LIVE at a time)." >&2
fi

# ---------------- fetch code ----------------
say "Installing code into $PREFIX"
if [ -n "$SOURCE" ]; then
  [ -f "$SOURCE/package.json" ] || { echo "--source $SOURCE has no package.json" >&2; exit 1; }
  run mkdir -p "$PREFIX"
  if [ "$DRY" = 1 ]; then echo "[dry-run] copy $SOURCE -> $PREFIX (without node_modules, dist, data, config.json)"; else
    tar -C "$SOURCE" --exclude=node_modules --exclude=dist --exclude=data --exclude=config.json --exclude=.git -cf - . | tar -C "$PREFIX" -xf -; fi
elif [ -n "$REPO_URL" ]; then
  case "$REPO_URL" in *"<OWNER>"*) echo "This copy of install.sh has no repository set (GITHUB_OWNER is a placeholder). Use --source DIR or DISH_MONITOR_REPO=<git url>." >&2; exit 1 ;; esac
  command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
  if [ -d "$PREFIX/.git" ]; then run git -C "$PREFIX" fetch --depth 1 origin "$REF"; run git -C "$PREFIX" checkout -q FETCH_HEAD
  else run git clone -q --depth 1 --branch "$REF" "$REPO_URL" "$PREFIX"; fi
else
  echo "No source: pass --source DIR, or set DISH_MONITOR_REPO to the public repository URL." >&2; exit 1
fi
if [ "$DRY" = 1 ]; then echo "[dry-run] (cd $PREFIX && npm ci --no-audit --no-fund && npm run build)"; else
  (cd "$PREFIX" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent); fi

# ---------------- config (never overwritten) ----------------
CONF="$CONF_DIR/config.json"
if [ -f "$CONF" ]; then
  say "Keeping existing $CONF"
else
  say "Writing $CONF ($DISHES dish(es))"
  if [ "$DISHES" = 1 ]; then
    write "$CONF" 600 <<J
{
  "title": "Dish Monitor",
  "subtitle": "One dish",
  "pollIntervalMs": 3000,
  "mode": "auto",
  "dishes": [
    { "slot": "dish1", "label": "Dish", "address": "192.168.100.1:9200", "interface": "$IFACE1",
      "wifiHint": "Connect this machine to the dish Wi-Fi or Ethernet." }
  ]
}
J
  else
    write "$CONF" 600 <<J
{
  "title": "Dish Monitor",
  "subtitle": "Two dishes",
  "pollIntervalMs": 3000,
  "mode": "auto",
  "dishes": [
    { "slot": "dish1", "label": "Dish 1", "kind": "standard", "address": "192.168.100.1:9200", "interface": "$IFACE1",
      "wifiHint": "First network adapter, joined to dish 1." },
    { "slot": "dish2", "label": "Dish 2", "kind": "mini", "address": "192.168.100.1:9200", "interface": "$IFACE2",
      "wifiHint": "Second network adapter, joined to dish 2." }
  ]
}
J
  fi
fi
run mkdir -p "$STATE_DIR"

# ---------------- service ----------------
ENV_MOCK=""; [ "$MOCK" = 1 ] && ENV_MOCK="Environment=MOCK=1"
write "$UNIT_DIR/dish-monitor.service" 644 <<U
[Unit]
Description=Dish Monitor (live dish status, port $PORT)
After=network-online.target

[Service]
WorkingDirectory=$PREFIX
Environment=PORT=$PORT HOST=$HOST CONFIG_PATH=$CONF DATA_DIR=$STATE_DIR NODE_ENV=production
$ENV_MOCK
ExecStart=$(command -v npm) start --silent
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
U

if [ "$WATCHDOG" = 1 ]; then
  command -v nmcli >/dev/null || echo "warning: --watchdog needs NetworkManager (nmcli)" >&2
  [ -f "$CONF_DIR/watchdog.conf" ] || write "$CONF_DIR/watchdog.conf" 600 <<W
# <NetworkManager connection name><TAB><interface>   (see: nmcli -t -f NAME,DEVICE con show)
W
  write "$UNIT_DIR/wifi-watchdog.service" 644 <<U
[Unit]
Description=Rejoin dish Wi-Fi if dropped
[Service]
Type=oneshot
ExecStart=$PREFIX/scripts/wifi-watchdog.sh
U
  write "$UNIT_DIR/wifi-watchdog.timer" 644 <<U
[Unit]
Description=Check dish Wi-Fi every 2 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
U
fi

if have_systemd; then
  run systemctl --user daemon-reload
  run systemctl --user enable --now dish-monitor.service
  [ "$WATCHDOG" = 1 ] && run systemctl --user enable --now wifi-watchdog.timer
  say "Tip: 'loginctl enable-linger \$USER' keeps it running after logout (may need sudo)."
else
  say "systemd user session not available: start manually with"
  echo "    cd $PREFIX && PORT=$PORT HOST=$HOST CONFIG_PATH=$CONF DATA_DIR=$STATE_DIR npm start"
fi
if [ "$DISHES" = 2 ] && [ -n "$IFACE1" ] && [ -n "$IFACE2" ]; then
  say "Two dishes share 192.168.100.1. Interface binding is used automatically (Linux >= 5.7, no root)."
  echo "    If that fails, see README 'Policy routing' for the optional root-only route script."
fi
say "Done. Open http://localhost:$PORT  ·  config: $CONF  ·  uninstall: install.sh --uninstall"
