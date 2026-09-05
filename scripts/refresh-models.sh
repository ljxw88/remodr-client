#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 22.18+ or 24+ is required to refresh model catalogs.' >&2
  exit 127
fi

exec node "$script_dir/refresh-models.cjs" "$@"
