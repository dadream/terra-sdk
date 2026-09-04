#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
OUTPUT_DIR=$(realpath -m \
  "${TERRA_PRODUCT_SITE_OUTPUT:-${ROOT_DIR}/workspace_old/site}")
WASM_IMAGE=${TERRA_SDK_WASM_IMAGE:-terra-sdk-wasm:emscripten-3.1.5}

case "${OUTPUT_DIR}" in
  "${ROOT_DIR}"/*) ;;
  *)
    echo "Product site output must be below ${ROOT_DIR}." >&2
    exit 2
    ;;
esac

if [ ! -s "${ROOT_DIR}/workspace_old/package/miniprogram/wasm/terra_sdk.wasm" ]; then
  echo "Missing Mini Program Wasm package. Run verify_miniprogram_wasm.sh first." >&2
  exit 2
fi

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "${ROOT_DIR}:/workspace" \
  -w /workspace \
  "${WASM_IMAGE}" \
  node scripts/build_product_site.js /workspace \
    "/workspace/${OUTPUT_DIR#"${ROOT_DIR}/"}"
