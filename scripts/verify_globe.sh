#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
BUILD_JOBS=${TERRA_SDK_BUILD_JOBS:-4}
BUILD_DIR="${ROOT_DIR}/workspace_old/build/cmake"

if [ ! -f "${BUILD_DIR}/CMakeCache.txt" ]; then
  echo "Missing CMake build tree. Run scripts/build_cmake.sh first." >&2
  exit 2
fi

BUILD_CMD=(
  docker run --rm
  -v "${ROOT_DIR}:/workspace"
  -v "${ROOT_DIR}/workspace_old:/wksp"
  -w /workspace
  "${DOCKER_IMAGE}"
  cmake --build /wksp/build/cmake
  --target
  terra_sdk_geo_tilemap_smoke
  vic_app_cbdam_viewer
  vic_app_ratman_nav3d
  --parallel "${BUILD_JOBS}"
)
"${BUILD_CMD[@]}"

TEST_CMD=(
  docker run --rm
  -v "${ROOT_DIR}/workspace_old:/wksp"
  -w /wksp/build/cmake
  "${DOCKER_IMAGE}"
  ctest --output-on-failure
  -R "^terra_sdk_geo_tilemap_smoke$"
)
"${TEST_CMD[@]}"

GLOBE_DATA_DIR="${GLOBE_DATA_DIR:-/mnt/s/terra-data/globe}" \
  bash "${ROOT_DIR}/scripts/verify_terrain_service_globe.sh"
GLOBE_TEXTURE_MODE=blue-marble bash "${ROOT_DIR}/scripts/verify_viewer_globe.sh"
GLOBE_TEXTURE_MODE=blue-marble bash "${ROOT_DIR}/scripts/verify_nav3d_globe.sh"

if [ "${VERIFY_TIANDITU:-0}" = "1" ]; then
  if [ -z "${TIANDITU_TOKEN:-}" ]; then
    echo "VERIFY_TIANDITU=1 requires a server-side TIANDITU_TOKEN." >&2
    exit 2
  fi
  GLOBE_TEXTURE_MODE=tianditu bash "${ROOT_DIR}/scripts/verify_viewer_globe.sh"
  GLOBE_TEXTURE_MODE=tianditu bash "${ROOT_DIR}/scripts/verify_nav3d_globe.sh"
fi

echo "Globe verification passed."
