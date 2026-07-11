#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
BUILD_JOBS=${TERRA_SDK_BUILD_JOBS:-4}
BUILD_DIR="${ROOT_DIR}/workspace_old/build/cmake"

bash "${ROOT_DIR}/scripts/check_desktop_oracle.sh"

if [ ! -f "${BUILD_DIR}/CMakeCache.txt" ]; then
  echo "Missing CMake build tree. Run scripts/build_cmake.sh first." >&2
  exit 2
fi

docker run --rm \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  cmake --build /wksp/build/cmake \
  --target terra_sdk_cbdam_native_behavior_golden \
  --parallel "${BUILD_JOBS}"

docker run --rm \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -w /wksp/build/cmake \
  "${DOCKER_IMAGE}" \
  ctest --output-on-failure \
  -R '^terra_sdk_cbdam_native_behavior_golden$'

echo "Mini Program native behavior golden verification passed."
