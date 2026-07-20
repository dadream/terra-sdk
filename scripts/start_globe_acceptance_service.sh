#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
WASM_IMAGE=${TERRA_SDK_WASM_IMAGE:-terra-sdk-wasm:emscripten-3.1.5}
GLOBE_DATA_DIR=${GLOBE_DATA_DIR:-/mnt/s/terra-data/globe/cbdam-srtm-v2-global-geodetic}
GLOBE_TERRAIN_NAME=${GLOBE_TERRAIN_NAME:-global_srtm_tol2}
CONTAINER_NAME=${CONTAINER_NAME:-terra_terrain_globe_acceptance}
SERVICE_PORT=${SERVICE_PORT:-18082}

GLOBE_DATA_DIR_ABS=$(realpath -e "${GLOBE_DATA_DIR}")
for suffix in xml root data; do
  if [ ! -e "${GLOBE_DATA_DIR_ABS}/${GLOBE_TERRAIN_NAME}.${suffix}" ]; then
    echo "Missing globe ${GLOBE_TERRAIN_NAME}.${suffix}: ${GLOBE_DATA_DIR_ABS}" >&2
    exit 2
  fi
done

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
  -v "${GLOBE_DATA_DIR_ABS}:/data/globe:ro" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  /wksp/build/cmake/terra_terrain_service \
  --dataset-id globe \
  --terrain "/data/globe/${GLOBE_TERRAIN_NAME}" \
  --bind 127.0.0.1 \
  --port "${SERVICE_PORT}" \
  --min-level 0 \
  --max-level 30 \
  --texture-id blue-marble \
  --texture-kind global-geodetic \
  --texture-template 'https://example.invalid/blue-marble/{z}/{x}/{y}.jpg' \
  --texture-level-offset 0 \
  --texture-max-level 8 \
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
  echo "Globe terrain service did not become ready." >&2
  docker logs "${CONTAINER_NAME}" >&2 || true
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  exit 1
fi

manifest_url="http://127.0.0.1:${SERVICE_PORT}/terra/v1/datasets/globe/manifest"
manifest=$(curl --silent --show-error --fail "${manifest_url}") || {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  exit 1
}
if ! grep -q '"kind": "cylindrical"' <<<"${manifest}" || \
   ! grep -q '"root_count": 8' <<<"${manifest}"; then
  echo "Globe terrain service returned an unexpected manifest." >&2
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  exit 1
fi

WASM_PATH="${ROOT_DIR}/workspace_old/package/miniprogram/wasm/terra_sdk.wasm"
if [ ! -f "${WASM_PATH}" ]; then
  echo "Missing verified Mini Program Wasm package: ${WASM_PATH}" >&2
  echo "Run scripts/verify_miniprogram_wasm.sh before acceptance." >&2
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  exit 2
fi
if ! docker run --rm \
    --network host \
    -v "${ROOT_DIR}:/workspace:ro" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/globe_load_service_integration.js \
      "http://127.0.0.1:${SERVICE_PORT}" \
      workspace_old/package/miniprogram/wasm/terra_sdk.wasm; then
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  exit 1
fi

printf 'Globe acceptance service is ready: %s\n' "${manifest_url}"
printf 'Container: %s\n' "${CONTAINER_NAME}"
printf 'The service stays running for WeChat DevTools acceptance.\n'
