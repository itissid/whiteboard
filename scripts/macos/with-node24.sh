#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"

if (( $# == 0 )); then
  echo "usage: $0 command [args ...]" >&2
  exit 2
fi

node_bin_dir="${WHITEBOARD_NODE24_BIN:-}"
if [[ -z "$node_bin_dir" ]] && command -v node >/dev/null 2>&1; then
  active_node_dir="$(dirname -- "$(command -v node)")"
  if [[ "$($active_node_dir/node -p 'process.versions.node.split(".")[0]')" == "24" ]] &&
    [[ -x "$active_node_dir/pnpm" ]]; then
    node_bin_dir="$active_node_dir"
  fi
fi

if [[ -z "$node_bin_dir" ]]; then
  for candidate in "$HOME"/.nvm/versions/node/v24.*/bin; do
    if [[ -x "$candidate/node" && -x "$candidate/pnpm" ]]; then
      node_bin_dir="$candidate"
    fi
  done
fi

if [[ -z "$node_bin_dir" || ! -x "$node_bin_dir/node" || ! -x "$node_bin_dir/pnpm" ]]; then
  echo "Node 24 with pnpm is required. Set WHITEBOARD_NODE24_BIN to its bin directory." >&2
  exit 1
fi

node_major="$($node_bin_dir/node -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" != "24" ]]; then
  echo "WHITEBOARD_NODE24_BIN must contain Node 24; found $($node_bin_dir/node --version)." >&2
  exit 1
fi

cd "$REPO_ROOT"
expected_pnpm="$($node_bin_dir/node -p 'require("./package.json").packageManager.split("@").at(-1)')"
actual_pnpm="$($node_bin_dir/pnpm --version)"
if [[ "$actual_pnpm" != "$expected_pnpm" ]]; then
  echo "pnpm $expected_pnpm is required; found $actual_pnpm in $node_bin_dir." >&2
  exit 1
fi

export PATH="$node_bin_dir:$PATH"
printf 'Using Node %s and pnpm %s\n' "$(node --version)" "$actual_pnpm"
exec "$@"
