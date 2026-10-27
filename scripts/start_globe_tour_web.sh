#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
OUTPUT_DIR=$(realpath -m "${GLOBE_TOUR_OUTPUT_DIR:-${ROOT_DIR}/viewer_verify_output/globe_tour_web}")
ALLOWED_OUTPUT_ROOT="${ROOT_DIR}/viewer_verify_output"
SITE_DIR="${OUTPUT_DIR}/site"
LOCAL_DATA_DIR="${OUTPUT_DIR}/imagery-data"
CACHE_DIR="${OUTPUT_DIR}/tianditu-cache"
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
WASM_IMAGE=${TERRA_SDK_WASM_IMAGE:-terra-sdk-wasm:emscripten-3.1.5}
GLOBE_DATA_DIR=${GLOBE_DATA_DIR:-/mnt/s/terra-data/globe/cbdam-srtm-v2-global-geodetic}
GLOBE_TERRAIN_NAME=${GLOBE_TERRAIN_NAME:-global_srtm_tol2}
TERRAIN_PORT=${GLOBE_TOUR_TERRAIN_PORT:-18082}
IMAGERY_PORT=${GLOBE_TOUR_IMAGERY_PORT:-18083}
WEB_PORT=${GLOBE_TOUR_WEB_PORT:-18766}
TERRAIN_CONTAINER=${GLOBE_TOUR_TERRAIN_CONTAINER:-terra_globe_tour_terrain}
IMAGERY_CONTAINER=${GLOBE_TOUR_IMAGERY_CONTAINER:-terra_globe_tour_imagery}
WEB_CONTAINER=${GLOBE_TOUR_WEB_CONTAINER:-terra_globe_tour_web}
IMAGERY_PROFILE=${GLOBE_TOUR_IMAGERY_PROFILE:-tianditu-img-c}
BLUE_MARBLE_DIR=${GLOBE_TOUR_BLUE_MARBLE_DIR:-/mnt/s/terra-data/globe/blue-marble-global-geodetic}
STOPPED=0

case "${OUTPUT_DIR}" in
  "${ALLOWED_OUTPUT_ROOT}"/*) ;;
  *)
    echo "GLOBE_TOUR_OUTPUT_DIR must be below ${ALLOWED_OUTPUT_ROOT}" >&2
    exit 2
    ;;
esac

case "${IMAGERY_PROFILE}" in
  tianditu-img-c|blue-marble) ;;
  *)
    echo "Unsupported globe tour imagery profile: ${IMAGERY_PROFILE}" >&2
    exit 2
    ;;
esac

if [ "${IMAGERY_PROFILE}" = "tianditu-img-c" ] && \
   [ -z "${TIANDITU_TOKEN:-}" ]; then
  echo "TIANDITU_TOKEN is required for the local imagery proxy." >&2
  exit 2
fi

BLUE_MARBLE_DIR_ABS=
if [ "${IMAGERY_PROFILE}" = "blue-marble" ]; then
  BLUE_MARBLE_DIR_ABS=$(realpath -e "${BLUE_MARBLE_DIR}")
fi

GLOBE_DATA_DIR_ABS=$(realpath -e "${GLOBE_DATA_DIR}")
for suffix in xml root data; do
  if [ ! -e "${GLOBE_DATA_DIR_ABS}/${GLOBE_TERRAIN_NAME}.${suffix}" ]; then
    echo "Missing globe ${GLOBE_TERRAIN_NAME}.${suffix}: ${GLOBE_DATA_DIR_ABS}" >&2
    exit 2
  fi
done

cleanup() {
  if [ "${STOPPED}" -eq 1 ]; then
    return
  fi
  STOPPED=1
  docker rm -f "${WEB_CONTAINER}" "${IMAGERY_CONTAINER}" \
    "${TERRAIN_CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

cleanup
STOPPED=0
rm -rf "${SITE_DIR}"
mkdir -p "${SITE_DIR}" "${CACHE_DIR}" \
  "${LOCAL_DATA_DIR}/datasets/ps-1k/v1/imagery/ps-1k" \
  "${LOCAL_DATA_DIR}/datasets/globe/v1/imagery/blue-marble"
rm -f "${OUTPUT_DIR}/services.ready"

if [ "${GLOBE_TOUR_SKIP_BUILD:-0}" != "1" ]; then
  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -v "${ROOT_DIR}/workspace_old:/wksp" \
    -w /workspace \
    "${DOCKER_IMAGE}" \
    cmake --build /wksp/build/cmake \
      --target terra_terrain_service --parallel 4 \
      >"${OUTPUT_DIR}/terrain_build.log" 2>&1
fi

if [ ! -f "${ROOT_DIR}/workspace_old/package/miniprogram/wasm/terra_sdk.wasm" ]; then
  echo "Missing verified Wasm package; run scripts/verify_miniprogram_wasm.sh." >&2
  exit 2
fi

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "${ROOT_DIR}:/workspace" \
  -w /workspace \
  "${WASM_IMAGE}" \
  node scripts/build_globe_tour_web.js /workspace \
    "/workspace/${SITE_DIR#"${ROOT_DIR}/"}" \
    >"${OUTPUT_DIR}/web_build.log" 2>&1

docker run -d \
  --name "${TERRAIN_CONTAINER}" \
  --user "$(id -u):$(id -g)" \
  --network host \
  -v "${ROOT_DIR}/workspace_old:/wksp:ro" \
  -v "${GLOBE_DATA_DIR_ABS}:/data/globe:ro" \
  "${DOCKER_IMAGE}" \
  /wksp/build/cmake/terra_terrain_service \
  --dataset-id globe \
  --terrain "/data/globe/${GLOBE_TERRAIN_NAME}" \
  --bind 127.0.0.1 \
  --port "${TERRAIN_PORT}" \
  --min-level 0 \
  --max-level 30 \
  --texture-id blue-marble \
  --texture-kind global-geodetic \
  --texture-template 'https://example.invalid/blue-marble/{z}/{x}/{y}.jpg' \
  --texture-level-offset 0 \
  --texture-max-level 8 \
  --max-requests 0 >/dev/null

IMAGERY_DATA_MOUNTS=(
  -v "${LOCAL_DATA_DIR}:/data:ro"
)
if [ -n "${BLUE_MARBLE_DIR_ABS}" ]; then
  IMAGERY_DATA_MOUNTS+=(
    -v "${BLUE_MARBLE_DIR_ABS}:/data/datasets/globe/v1/imagery/blue-marble:ro"
  )
fi

docker run -d \
  --name "${IMAGERY_CONTAINER}" \
  --user "$(id -u):$(id -g)" \
  --network host \
  -e HOST=127.0.0.1 \
  -e PORT="${IMAGERY_PORT}" \
  -e DATA_ROOT=/data \
  -e CACHE_ROOT=/cache \
  -e TIANDITU_TOKEN="${TIANDITU_TOKEN:-offline-blue-marble}" \
  -v "${ROOT_DIR}:/workspace:ro" \
  "${IMAGERY_DATA_MOUNTS[@]}" \
  -v "${CACHE_DIR}:/cache" \
  -w /workspace \
  "${WASM_IMAGE}" \
  node deploy/cloudbase/imagery/server.js >/dev/null

docker run -d \
  --name "${WEB_CONTAINER}" \
  --user "$(id -u):$(id -g)" \
  --network host \
  -e HOST=127.0.0.1 \
  -e PORT="${WEB_PORT}" \
  -e TERRAIN_PORT="${TERRAIN_PORT}" \
  -e IMAGERY_PORT="${IMAGERY_PORT}" \
  -e IMAGERY_PROFILE="${IMAGERY_PROFILE}" \
  -e SITE_ROOT=/site \
  -v "${ROOT_DIR}:/workspace:ro" \
  -v "${SITE_DIR}:/site:ro" \
  -w /workspace \
  "${WASM_IMAGE}" \
  node scripts/serve_globe_tour_web.js /site >/dev/null

ready=0
for _ in $(seq 1 80); do
  if curl --silent --fail \
      "http://127.0.0.1:${TERRAIN_PORT}/terra/v1/datasets/globe/manifest" \
      >"${OUTPUT_DIR}/terrain_manifest.json" && \
     curl --silent --fail "http://127.0.0.1:${IMAGERY_PORT}/readyz" \
      >"${OUTPUT_DIR}/imagery_ready.json" && \
     curl --silent --fail "http://127.0.0.1:${WEB_PORT}/" >/dev/null; then
    ready=1
    break
  fi
  sleep 0.25
done

if [ "${ready}" -ne 1 ]; then
  echo "Local globe tour services did not become ready." >&2
  docker logs "${TERRAIN_CONTAINER}" >&2 || true
  docker logs "${IMAGERY_CONTAINER}" >&2 || true
  docker logs "${WEB_CONTAINER}" >&2 || true
  exit 1
fi

if ! grep -q '"kind": "cylindrical"' \
    "${OUTPUT_DIR}/terrain_manifest.json" || \
   ! grep -q '"root_count": 8' "${OUTPUT_DIR}/terrain_manifest.json"; then
  echo "Local globe terrain manifest is unexpected." >&2
  exit 1
fi

printf 'Local globe tour Web app: http://127.0.0.1:%s/?imagery=%s\n' \
  "${WEB_PORT}" "${IMAGERY_PROFILE}"
printf 'Terrain and %s imagery services are local processes. Press Ctrl+C to stop all services.\n' \
  "${IMAGERY_PROFILE}"
touch "${OUTPUT_DIR}/services.ready"

while docker ps --format '{{.Names}}' | grep -qx "${WEB_CONTAINER}"; do
  sleep 1
done
