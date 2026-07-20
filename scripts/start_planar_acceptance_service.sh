#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
WASM_IMAGE=${TERRA_SDK_WASM_IMAGE:-terra-sdk-wasm:emscripten-3.1.5}
CONTAINER_NAME=${CONTAINER_NAME:-terra_terrain_planar_acceptance}
SERVICE_PORT=${SERVICE_PORT:-18081}

docker run --rm \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  cmake --build /wksp/build/cmake \
    --target terra_terrain_service --parallel 4

docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
docker run -d \
  --name "${CONTAINER_NAME}" \
  --user "$(id -u):$(id -g)" \
  --network host \
  -v "${ROOT_DIR}:/workspace:ro" \
  -v "${ROOT_DIR}/workspace_old:/wksp:ro" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  /wksp/build/cmake/terra_terrain_service \
  --dataset-id ps-1k \
  --terrain /workspace/testdata/datasets/ps_1k/reference/terrain \
  --bind 127.0.0.1 \
  --port "${SERVICE_PORT}" \
  --min-level 0 \
  --max-level 30 \
  --texture-id ps-1k \
  --texture-kind planar-single \
  --texture-template /terra/v1/datasets/ps-1k/textures/ps-1k \
  --texture-file /workspace/testdata/datasets/ps_1k/source/ps_texture_1k.png \
  --texture-level-offset 0 \
  --texture-max-level 0 \
  --max-requests 0 >/dev/null

ready=0
for _ in $(seq 1 30); do
  if docker logs "${CONTAINER_NAME}" 2>&1 | \
      grep -q '^\[terrain-service\] ready '; then
    ready=1
    break
  fi
  sleep 1
done
if [ "${ready}" -ne 1 ]; then
  echo "Planar terrain service did not become ready." >&2
  docker logs "${CONTAINER_NAME}" >&2 || true
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  exit 1
fi

manifest_url="http://127.0.0.1:${SERVICE_PORT}/terra/v1/datasets/ps-1k/manifest"
service_origin="http://127.0.0.1:${SERVICE_PORT}"
if ! curl --silent --show-error --fail "${manifest_url}" >/dev/null; then
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  exit 1
fi
if ! docker run --rm \
    --network host \
    -v "${ROOT_DIR}:/workspace:ro" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/planar_load_service_integration.js \
      "${service_origin}"; then
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  exit 1
fi
printf 'Planar acceptance service is ready: %s\n' "${manifest_url}"
printf 'Container: %s\n' "${CONTAINER_NAME}"
