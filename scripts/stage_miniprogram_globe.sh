#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
PACKAGE_DIR="${ROOT_DIR}/workspace_old/package/miniprogram"
APP_WASM_DIR="${ROOT_DIR}/apps/miniprogram/wasm"

for artifact in terra_sdk.wasm terra_sdk_wasm_manifest.json; do
  if [ ! -f "${PACKAGE_DIR}/wasm/${artifact}" ]; then
    echo "Missing ${PACKAGE_DIR}/wasm/${artifact}." >&2
    echo "Run bash scripts/verify_miniprogram_wasm.sh first." >&2
    exit 1
  fi
done

mkdir -p "${APP_WASM_DIR}"
install -m 0644 "${PACKAGE_DIR}/wasm/terra_sdk.wasm" \
  "${APP_WASM_DIR}/terra_sdk.wasm"
install -m 0644 "${PACKAGE_DIR}/wasm/terra_sdk_wasm_manifest.json" \
  "${APP_WASM_DIR}/terra_sdk_wasm_manifest.json"

printf 'Staged Mini Program Globe Wasm artifacts in %s\n' "${APP_WASM_DIR}"
