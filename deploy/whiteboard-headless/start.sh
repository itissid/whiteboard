#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/.build"
STATE_DIR="/home/dev/workspace/.service-data/whiteboard"
TOKEN_FILE="$STATE_DIR/review-server-token"

token="${WHITEBOARD_REVIEW_SERVER_TOKEN:-}"
unset WHITEBOARD_REVIEW_SERVER_TOKEN

if [[ -z "$token" ]]; then
  read -rsp "Whiteboard Review Server token: " token
  printf '\n'
fi

if [[ ! "$token" =~ ^[A-Za-z0-9_-]{32,}$ ]]; then
  echo "Whiteboard Review Server token must be at least 32 URL-safe characters." >&2
  exit 64
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
umask 077
printf '%s' "$token" >"$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
trap 'rm -rf "$BUILD_DIR"; unset token' EXIT

pnpm --dir "$REPO_ROOT" --filter @dev.fast/review build
package_name="$({ npm pack --ignore-scripts --pack-destination "$BUILD_DIR" "$REPO_ROOT/packages/review"; } | tail -n 1)"
mv "$BUILD_DIR/$package_name" "$BUILD_DIR/review.tgz"

sudo -n docker compose \
  --project-directory "$SCRIPT_DIR" \
  up --detach --build --force-recreate --wait --wait-timeout 120

printf 'Whiteboard headless server is ready.\n'
printf 'State: %s\n' "$STATE_DIR"
printf 'Mac tunnel: ssh -N -L 34125:whiteboard:34125 truenas-dev-2\n'
