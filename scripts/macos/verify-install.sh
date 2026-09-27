#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP="${WHITEBOARD_APP_DEST:-/Applications/Whiteboard.app}"
EXPECTED_BUNDLE_ID="dev.fast.review"
SSH_HOST="${SSH_HOST:-truenas-dev-2}"
LOCAL_PORT="${LOCAL_PORT:-34125}"
REMOTE_HOST="${REMOTE_HOST:-whiteboard}"
REMOTE_PORT="${REMOTE_PORT:-34125}"

if [[ ! -d "$APP" ]]; then
  echo "Installed Whiteboard app is missing at $APP." >&2
  exit 1
fi
actual_bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")"
if [[ "$actual_bundle_id" != "$EXPECTED_BUNDLE_ID" ]]; then
  echo "Unexpected Whiteboard bundle identifier: $actual_bundle_id" >&2
  exit 1
fi
codesign --verify --deep --strict "$APP"

SSH_HOST="$SSH_HOST" LOCAL_PORT="$LOCAL_PORT" REMOTE_HOST="$REMOTE_HOST" REMOTE_PORT="$REMOTE_PORT" \
  "$SCRIPT_DIR/tunnel.sh" status

printf 'Application: %s\n' "$APP"
printf 'Bundle identifier: %s\n' "$actual_bundle_id"
printf 'Tunnel endpoint: http://127.0.0.1:%s\n' "$LOCAL_PORT"
printf 'Whiteboard installation verification passed.\n'
