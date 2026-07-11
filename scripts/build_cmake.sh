#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
TERRA_SDK_BUILD_JOBS=${TERRA_SDK_BUILD_JOBS:-4}
CMAKE_BUILD_LOG=${CMAKE_BUILD_LOG:-"${ROOT_DIR}/viewer_verify_output/cmake_build_latest.log"}

if [ ! -f "${ROOT_DIR}/CMakeLists.txt" ]; then
  echo "Missing terra-sdk monorepo: ${ROOT_DIR}" >&2
  exit 1
fi

echo "Starting Docker Terra SDK monorepo build..."
echo "Source root: ${ROOT_DIR}"
echo "Install prefix: /wksp/output"
echo "Build jobs: ${TERRA_SDK_BUILD_JOBS}"
echo "Build log: ${CMAKE_BUILD_LOG}"

mkdir -p "${ROOT_DIR}/workspace_old"
mkdir -p "$(dirname "${CMAKE_BUILD_LOG}")"

set +e
docker run --rm \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -e PREFIX=/wksp/output \
  -e TERRA_SDK_BUILD_JOBS="${TERRA_SDK_BUILD_JOBS}" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  bash -lc '
    set -euo pipefail
    if [ -f /wksp/build/cmake/CMakeCache.txt ]; then
      cached_source=$(sed -n "s/^CMAKE_HOME_DIRECTORY:INTERNAL=//p" /wksp/build/cmake/CMakeCache.txt)
      if [ "${cached_source}" != "/workspace" ]; then
        test "$(realpath -m /wksp/build/cmake)" = "/wksp/build/cmake"
        echo "Resetting CMake build tree created from ${cached_source:-an unknown source}."
        cmake -E remove_directory /wksp/build/cmake
      fi
    fi

    cmake -S /workspace -B /wksp/build/cmake \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/wksp/output
    cmake --build /wksp/build/cmake --target terra_sdk_cmake_smoke \
      --clean-first --parallel "${TERRA_SDK_BUILD_JOBS}"
    cd /wksp/build/cmake
    EXPECTED_CTESTS=(
      terra_sdk_base_math_xml_smoke
      terra_sdk_base_img_smoke
      terra_sdk_base_curlstream_smoke
      terra_sdk_base_qxml_smoke
      terra_sdk_base_fetcher_smoke
      terra_sdk_base_persistent_smoke
      terra_sdk_base_mpi_smoke
      terra_sdk_base_gl_smoke
      terra_sdk_geo_tilemap_smoke
      terra_sdk_geo_victms_smoke
      terra_sdk_geo_srs_smoke
      terra_sdk_geo_builder_smoke
      terra_sdk_vfs_repository_smoke
      terra_sdk_cbdam_geo_smoke
      terra_sdk_cbdam_repository_smoke
      terra_sdk_ratman_core_smoke
    )
    for expected_ctest in "${EXPECTED_CTESTS[@]}"; do
      if ! ctest -N -R "^${expected_ctest}$" | grep -Eq "Test #[0-9]+: ${expected_ctest}$"; then
        echo "Missing expected CTest: ${expected_ctest}" >&2
        exit 1
      fi
    done
    CTEST_MATCH_COUNT=$(ctest -N -R "terra_sdk_.*_smoke" | awk "/Total Tests:/ {print \$3}")
    if [ "${CTEST_MATCH_COUNT}" != "${#EXPECTED_CTESTS[@]}" ]; then
      echo "Expected ${#EXPECTED_CTESTS[@]} matching CTests for terra_sdk_*_smoke, found ${CTEST_MATCH_COUNT:-0}" >&2
      exit 1
    fi
    ctest --output-on-failure -R "terra_sdk_.*_smoke"
  ' 2>&1 | tee "${CMAKE_BUILD_LOG}"
build_status=${PIPESTATUS[0]}
set -e

if [ "${build_status}" -ne 0 ]; then
  echo "CMake monorepo build failed with status ${build_status}." >&2
  exit "${build_status}"
fi

if grep -n "warning:" "${CMAKE_BUILD_LOG}"; then
  echo "CMake compiler warning gate failed." >&2
  exit 1
fi

echo "CMake compiler warning gate passed."
