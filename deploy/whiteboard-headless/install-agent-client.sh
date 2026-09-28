#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
wrapper="$script_dir/bin/whiteboard"
pi_bin_dir="$HOME/.pi/agent/bin"

pnpm --dir "$repo_root" --filter @dev.fast/review build

mkdir -p "$pi_bin_dir"
ln -sfn "$wrapper" "$pi_bin_dir/whiteboard"
ln -sfn "$wrapper" "$pi_bin_dir/review"

pi install "$repo_root/packages/agent-plugins/pi"

printf 'Installed Whiteboard CLI links:\n'
printf '  %s -> %s\n' "$pi_bin_dir/whiteboard" "$(readlink -f "$pi_bin_dir/whiteboard")"
printf '  %s -> %s\n' "$pi_bin_dir/review" "$(readlink -f "$pi_bin_dir/review")"
printf 'Installed Pi package: %s\n' "$repo_root/packages/agent-plugins/pi"
printf 'Run /reload in existing Pi sessions.\n'
