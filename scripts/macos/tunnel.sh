#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
LABEL="dev.fast.review-tunnel"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$SCRIPT_DIR/$LABEL.plist.in"
LOG_DIR="$HOME/Library/Logs/Whiteboard"
SSH_HOST="${SSH_HOST:-truenas-dev-2}"
LOCAL_PORT="${LOCAL_PORT:-34125}"
REMOTE_HOST="${REMOTE_HOST:-whiteboard}"
REMOTE_PORT="${REMOTE_PORT:-34125}"
AUTOSSH="${AUTOSSH_PATH:-$(command -v autossh || true)}"

if (( $# != 1 )); then
  echo "usage: $0 install|start|stop|restart|status|uninstall" >&2
  exit 2
fi

loaded() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

listener_present() {
  lsof -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN >/dev/null 2>&1
}

endpoint_status() {
  curl --noproxy '*' --silent --output /dev/null --max-time 3 \
    --write-out '%{http_code}' "http://127.0.0.1:$LOCAL_PORT/health" || true
}

bootout() {
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
}

wait_ready() {
  for _ in $(seq 1 150); do
    if listener_present && [[ "$(endpoint_status)" == "401" ]]; then
      return
    fi
    sleep 0.2
  done
  echo "Tunnel did not reach the Review Server at 127.0.0.1:$LOCAL_PORT." >&2
  [[ -f "$LOG_DIR/tunnel.stderr.log" ]] && tail -n 20 "$LOG_DIR/tunnel.stderr.log" >&2
  exit 1
}

render_plist() {
  if [[ -z "$AUTOSSH" || ! -x "$AUTOSSH" ]]; then
    echo "autossh is required; install it with: brew install autossh" >&2
    exit 1
  fi
  ssh -G "$SSH_HOST" >/dev/null 2>&1 || {
    echo "SSH host alias '$SSH_HOST' is not configured." >&2
    exit 1
  }
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  tmp="$PLIST.tmp.$$"
  python3 - "$TEMPLATE" "$tmp" "$AUTOSSH" "$SSH_HOST" "$LOCAL_PORT" "$REMOTE_HOST" "$REMOTE_PORT" "$LOG_DIR" <<'PY'
import plistlib
from pathlib import Path
import sys
source, destination, autossh, ssh_host, local_port, remote_host, remote_port, log_dir = sys.argv[1:]
text = Path(source).read_text()
for marker, value in {
    "__AUTOSSH__": autossh,
    "__SSH_HOST__": ssh_host,
    "__LOCAL_PORT__": local_port,
    "__REMOTE_HOST__": remote_host,
    "__REMOTE_PORT__": remote_port,
    "__LOG_DIR__": log_dir,
}.items():
    text = text.replace(marker, value)
plistlib.loads(text.encode())
Path(destination).write_text(text)
PY
  chmod 644 "$tmp"
  mv "$tmp" "$PLIST"
  plutil -lint "$PLIST" >/dev/null
}

start() {
  if loaded; then
    launchctl kickstart -k "$DOMAIN/$LABEL"
  else
    if [[ ! -f "$PLIST" ]]; then
      echo "LaunchAgent is not installed; run make install-tunnel first." >&2
      exit 1
    fi
    if listener_present; then
      echo "Local TCP port $LOCAL_PORT is already occupied." >&2
      lsof -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN >&2 || true
      exit 1
    fi
    launchctl bootstrap "$DOMAIN" "$PLIST"
  fi
  wait_ready
  printf 'Whiteboard tunnel is ready: http://127.0.0.1:%s\n' "$LOCAL_PORT"
}

case "$1" in
  install)
    bootout
    for _ in $(seq 1 50); do listener_present || break; sleep 0.1; done
    if listener_present; then
      echo "Local TCP port $LOCAL_PORT is occupied by a non-LaunchAgent process." >&2
      lsof -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN >&2 || true
      exit 1
    fi
    render_plist
    start
    ;;
  start)
    start
    ;;
  stop)
    bootout
    for _ in $(seq 1 50); do listener_present || break; sleep 0.1; done
    listener_present && { echo "TCP port $LOCAL_PORT remains occupied." >&2; exit 1; }
    echo "Whiteboard tunnel stopped."
    ;;
  restart)
    bootout
    for _ in $(seq 1 50); do listener_present || break; sleep 0.1; done
    start
    ;;
  status)
    printf 'LaunchAgent loaded: %s\n' "$(loaded && echo yes || echo no)"
    printf 'Local listener: %s\n' "$(listener_present && echo yes || echo no)"
    status="$(endpoint_status)"
    printf 'Unauthenticated health status: %s\n' "${status:-unreachable}"
    loaded && listener_present && [[ "$status" == "401" ]]
    ;;
  uninstall)
    bootout
    rm -f -- "$PLIST" "$LOG_DIR/tunnel.stdout.log" "$LOG_DIR/tunnel.stderr.log"
    rmdir "$LOG_DIR" 2>/dev/null || true
    echo "Whiteboard tunnel LaunchAgent removed."
    ;;
  *)
    echo "usage: $0 install|start|stop|restart|status|uninstall" >&2
    exit 2
    ;;
esac
