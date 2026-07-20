#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
GLOBE_DATA_DIR=${GLOBE_DATA_DIR:-/mnt/s/terra-data/globe/cbdam-srtm-v2-global-geodetic}
GLOBE_TERRAIN_NAME=${GLOBE_TERRAIN_NAME:-global_srtm_tol2}
OUTPUT_DIR=${OUTPUT_DIR:-"${ROOT_DIR}/viewer_verify_output/globe_terrain_beijing"}
BUILD_DIR=${BUILD_DIR:-/wksp/build/cmake}
CONTAINER_NAME=${CONTAINER_NAME:-terra_terrain_globe_beijing_verify}
SERVICE_PORT=${SERVICE_PORT:-18083}

GLOBE_DATA_DIR=$(realpath -e "${GLOBE_DATA_DIR}")
mkdir -p "${OUTPUT_DIR}"
OUTPUT_DIR=$(realpath -m "${OUTPUT_DIR}")
for suffix in xml root data; do
  if [ ! -f "${GLOBE_DATA_DIR}/${GLOBE_TERRAIN_NAME}.${suffix}" ]; then
    echo "Missing globe terrain file: ${GLOBE_TERRAIN_NAME}.${suffix}" >&2
    exit 2
  fi
done

cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Building Beijing globe terrain verification targets..."
set +e
docker run --rm \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  bash -lc '
    set -euo pipefail
    cmake -S /workspace -B /wksp/build/cmake \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/wksp/output
    cmake --build /wksp/build/cmake --parallel 4 --target \
      terra_sdk_globe_terrain_beijing_probe \
      terra_sdk_cbdam_topology_parity \
      terra_sdk_codec_hierarchy_legacy_parity \
      terra_sdk_c_api_parity
  ' 2>&1 | tee "${OUTPUT_DIR}/build.log"
build_status=${PIPESTATUS[0]}
set -e
if [ "${build_status}" -ne 0 ]; then
  exit "${build_status}"
fi
if grep -n 'warning:' "${OUTPUT_DIR}/build.log"; then
  echo "Compiler warning gate failed." >&2
  exit 1
fi

docker run --rm \
  -v "${ROOT_DIR}:/workspace:ro" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -w "${BUILD_DIR}" \
  "${DOCKER_IMAGE}" \
  ctest --output-on-failure -R \
    '^(terra_sdk_cbdam_topology_parity|terra_sdk_codec_hierarchy_legacy_parity|terra_sdk_c_api_parity)$' \
  | tee "${OUTPUT_DIR}/native_parity.log"

echo "Running native/Wasm SDK parity gate..."
bash "${ROOT_DIR}/scripts/verify_miniprogram_wasm.sh" \
  > >(tee "${OUTPUT_DIR}/wasm_parity.log") 2>&1

echo "Probing globe terrain at longitude 116, latitude 40..."
set +e
docker run --rm \
  -v "${ROOT_DIR}/workspace_old:/wksp:ro" \
  -v "${GLOBE_DATA_DIR}:/globe:ro" \
  -v "${OUTPUT_DIR}:/evidence" \
  "${DOCKER_IMAGE}" \
  "${BUILD_DIR}/terra_sdk_globe_terrain_beijing_probe" \
    "/globe/${GLOBE_TERRAIN_NAME}" /evidence/native_probe.json \
  2>&1 | tee "${OUTPUT_DIR}/native_probe.log"
probe_status=${PIPESTATUS[0]}
set -e
if [ "${probe_status}" -ne 0 ]; then
  echo "Globe terrain data gate failed; actual-data Wasm loading is blocked." >&2
  echo "Evidence: ${OUTPUT_DIR}/native_probe.json" >&2
  exit "${probe_status}"
fi

echo "Running actual-data Wasm service integration at 116,40..."
GLOBE_DATA_DIR="${GLOBE_DATA_DIR}" \
GLOBE_TERRAIN_NAME="${GLOBE_TERRAIN_NAME}" \
CONTAINER_NAME="${CONTAINER_NAME}" \
SERVICE_PORT="${SERVICE_PORT}" \
  bash "${ROOT_DIR}/scripts/start_globe_acceptance_service.sh" \
  2>&1 | tee "${OUTPUT_DIR}/wasm_data.log"

echo "Beijing globe terrain verification passed."
echo "Evidence: ${OUTPUT_DIR}"
