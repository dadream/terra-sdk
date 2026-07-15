#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
IMAGE_NAME=${TERRA_SDK_WASM_IMAGE:-terra-sdk-wasm:emscripten-3.1.5}
BASE_IMAGE=${TERRA_SDK_WASM_BASE_IMAGE:-ubuntu:22.04@sha256:0bced47fffa3361afa981854fcabcd4577cd43cebbb808cea2b1f33a3dd7f508}
HOST_UID=${TERRA_SDK_DOCKER_UID:-$(id -u)}
HOST_GID=${TERRA_SDK_DOCKER_GID:-$(id -g)}
REBUILD=${TERRA_SDK_WASM_REBUILD:-0}

if [[ "${REBUILD}" != "1" ]] && docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
  echo "Reusing Terra SDK Wasm image: ${IMAGE_NAME}"
else
  echo "Building Terra SDK Wasm image..."
  echo "Image: ${IMAGE_NAME}"
  echo "Base image: ${BASE_IMAGE}"
  echo "UID:GID: ${HOST_UID}:${HOST_GID}"

  docker build \
    --build-arg TERRA_SDK_WASM_BASE_IMAGE="${BASE_IMAGE}" \
    --build-arg UID="${HOST_UID}" \
    --build-arg GID="${HOST_GID}" \
    -t "${IMAGE_NAME}" \
    -f "${ROOT_DIR}/docker/Dockerfile.wasm" \
    "${ROOT_DIR}"
fi

echo "Validating Terra SDK Wasm image: ${IMAGE_NAME}"
docker run --rm "${IMAGE_NAME}" bash -lc '
  set -e
  em++ --version | head -n 1
  wasm-opt --version
  node --version
  cmake --version | head -n 1
'