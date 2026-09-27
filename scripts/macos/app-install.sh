#!/usr/bin/env bash
set -euo pipefail

SOURCE_APP="${WHITEBOARD_APP_SOURCE:-}"
DEST_APP="${WHITEBOARD_APP_DEST:-/Applications/Whiteboard.app}"
BUNDLE_ID="dev.fast.review"

if (( $# != 1 )); then
  echo "usage: $0 install|uninstall" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Whiteboard.app can only be installed on macOS." >&2
  exit 1
fi

quit_whiteboard() {
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 100); do
    if ! pgrep -f '/Whiteboard.app/Contents/MacOS/Whiteboard' >/dev/null 2>&1; then
      return
    fi
    sleep 0.1
  done
  echo "Whiteboard is still running; quit it before replacing the application." >&2
  exit 1
}

case "$1" in
  install)
    if [[ ! -d "$SOURCE_APP" ]]; then
      echo "Built application not found at $SOURCE_APP; run make build-app first." >&2
      exit 1
    fi
    codesign --verify --deep --strict "$SOURCE_APP"
    destination_dir="$(dirname -- "$DEST_APP")"
    if [[ ! -d "$destination_dir" || ! -w "$destination_dir" ]]; then
      echo "$destination_dir must exist and be writable." >&2
      exit 1
    fi

    quit_whiteboard
    stage="$destination_dir/.Whiteboard.app.install.$$"
    backup="$destination_dir/.Whiteboard.app.backup.$$"
    cleanup() { rm -rf -- "$stage"; }
    trap cleanup EXIT
    ditto "$SOURCE_APP" "$stage"
    xattr -dr com.apple.quarantine "$stage" 2>/dev/null || true
    codesign --verify --deep --strict "$stage"

    if [[ -e "$DEST_APP" ]]; then
      mv "$DEST_APP" "$backup"
    fi
    if mv "$stage" "$DEST_APP"; then
      rm -rf -- "$backup"
    else
      [[ ! -e "$DEST_APP" && -e "$backup" ]] && mv "$backup" "$DEST_APP"
      exit 1
    fi
    trap - EXIT
    printf 'Installed Whiteboard: %s\n' "$DEST_APP"
    printf '%s\n' 'If macOS asks for “Whiteboard Safe Storage,” enter your login password and choose Always Allow.'
    ;;
  uninstall)
    quit_whiteboard
    rm -rf -- "$DEST_APP"
    printf 'Removed Whiteboard: %s\n' "$DEST_APP"
    ;;
  *)
    echo "usage: $0 install|uninstall" >&2
    exit 2
    ;;
esac
