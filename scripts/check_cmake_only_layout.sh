#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
mapfile -t retired_files < <(
  find "$ROOT_DIR/ratman" -type f \
    \( -name '*.pro' -o -name '*.pri' -o -name '*.prf' -o -name '.qmake.conf' \) \
    -print
)

if [ "${#retired_files[@]}" -ne 0 ]; then
  echo "Retired build-system files found:" >&2
  printf '  %s\n' "${retired_files[@]}" >&2
  exit 1
fi

echo "CMake-only source layout check passed."
