#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
BUILD_JOBS=${TERRA_SDK_BUILD_JOBS:-4}
BUILD_DIR="${ROOT_DIR}/workspace_old/build/cmake"
VERIFY_LOG="${ROOT_DIR}/viewer_verify_output/miniprogram_sdk_verify.log"

bash "${ROOT_DIR}/scripts/check_desktop_oracle.sh"

if [ ! -f "${BUILD_DIR}/CMakeCache.txt" ]; then
  echo "Missing CMake build tree. Run scripts/build_cmake.sh first." >&2
  exit 2
fi

mkdir -p "$(dirname "${VERIFY_LOG}")"
set +e
docker run --rm \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  bash -lc '
    set -euo pipefail
    cmake -S /workspace -B /wksp/build/cmake \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/wksp/output
    cmake --build /wksp/build/cmake \
      --target terra_core terra_codec terra_frame terra_c_api terra_sdk_core_tests \
        terra_sdk_codec_tests terra_sdk_frame_tests terra_sdk_c_api_tests \
      --parallel "'"${BUILD_JOBS}"'"
    cd /wksp/build/cmake
    ctest --output-on-failure -R "^terra_sdk_(core|codec|frame|c_api)_"

    cmake -E remove_directory /wksp/build/miniprogram_sdk_install
    cmake -E remove_directory /wksp/build/miniprogram_sdk_consumer
    cmake --install /wksp/build/cmake \
      --prefix /wksp/build/miniprogram_sdk_install \
      --component TerraSdk

    cmake -S /workspace/tests/sdk/consumer \
      -B /wksp/build/miniprogram_sdk_consumer \
      -DCMAKE_BUILD_TYPE=Release \
      -DTerraSdk_DIR=/wksp/build/miniprogram_sdk_install/lib64/cmake/TerraSdk
    cmake --build /wksp/build/miniprogram_sdk_consumer \
      --parallel "'"${BUILD_JOBS}"'"
    /wksp/build/miniprogram_sdk_consumer/terra_sdk_consumer
  ' 2>&1 | tee "${VERIFY_LOG}"
verify_status=${PIPESTATUS[0]}
set -e

if [ "${verify_status}" -ne 0 ]; then
  echo "Mini Program SDK verification failed with status ${verify_status}." >&2
  exit "${verify_status}"
fi
if grep -n "warning:" "${VERIFY_LOG}"; then
  echo "Mini Program SDK compiler warning gate failed." >&2
  exit 1
fi

echo "Mini Program SDK verification passed."
