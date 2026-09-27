#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
APP_DIR="$REPO_ROOT/apps/review-desktop"
PACKAGED_APP="$APP_DIR/VSCode-darwin-arm64/Whiteboard.app"
ENTITLEMENTS="$APP_DIR/code-oss/build/darwin/entitlements/app.plist"

if (( $# > 0 )); then
  echo "usage: $0" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "The local Whiteboard bundle requires an arm64 Mac." >&2
  exit 1
fi

cd "$REPO_ROOT"
pnpm install --frozen-lockfile
SKIP_NOTARIZE=1 pnpm --filter @dev.fast/review-desktop app:package:macos

if [[ ! -d "$PACKAGED_APP" ]]; then
  echo "The Desktop build did not create $PACKAGED_APP." >&2
  exit 1
fi

# package-macos.sh mutates the generated bundle before its release-signing step.
# A local install recursively applies an ad-hoc signature because staging
# mutates both the outer bundle and nested Electron components.
codesign --force --deep --sign - --entitlements "$ENTITLEMENTS" "$PACKAGED_APP"
codesign --verify --deep --strict --verbose=2 "$PACKAGED_APP"

printf 'Built local Whiteboard bundle: %s\n' "$PACKAGED_APP"
