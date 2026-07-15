#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
WASM_IMAGE=${TERRA_SDK_WASM_IMAGE:-terra-sdk-wasm:emscripten-3.1.5}
BUILD_JOBS=${TERRA_SDK_BUILD_JOBS:-4}

bash "${ROOT_DIR}/scripts/build_wasm_image.sh"

docker run --rm \
  -v "${ROOT_DIR}:/workspace" \
  -w /workspace/adapters/wasm \
  "${WASM_IMAGE}" \
  bash -lc '
    set -euo pipefail
    cmake --preset wasm-release
    cmake --build --preset wasm-release \
      --parallel "'"${BUILD_JOBS}"'"
  '

echo "Terra SDK Wasm: ${ROOT_DIR}/workspace_old/build/wasm/terra_sdk.wasm"
