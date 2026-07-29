#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SDK_VERSION=$(sed -n 's/^project(TerraSdk VERSION \([^ ]*\).*/\1/p' "${ROOT_DIR}/CMakeLists.txt")
NATIVE_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
WASM_IMAGE=${TERRA_SDK_WASM_IMAGE:-terra-sdk-wasm:emscripten-3.1.5}
BUILD_JOBS=${TERRA_SDK_BUILD_JOBS:-4}
MAX_WASM_SIZE=${TERRA_SDK_WASM_MAX_SIZE_BYTES:-1048576}
MAX_CORE_SIZE=${TERRA_SDK_MINIPROGRAM_CORE_MAX_SIZE_BYTES:-524288}
BUILD_DIR="${ROOT_DIR}/workspace_old/build/wasm"
PACKAGE_DIR="${ROOT_DIR}/workspace_old/package/miniprogram"
LOG_FILE="${ROOT_DIR}/viewer_verify_output/miniprogram_wasm_verify.log"

bash "${ROOT_DIR}/scripts/check_desktop_oracle.sh"
bash "${ROOT_DIR}/scripts/build_wasm_image.sh"
rm -rf "${PACKAGE_DIR}"
mkdir -p "${BUILD_DIR}" "${PACKAGE_DIR}/include/terra/c_api" \
  "${PACKAGE_DIR}/utils" "${PACKAGE_DIR}/wasm" \
  "${PACKAGE_DIR}/docs" "${PACKAGE_DIR}/licenses/spacelib" \
  "${PACKAGE_DIR}/licenses/ratman" \
  "$(dirname "${LOG_FILE}")"

set +e
{
  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -v "${ROOT_DIR}/workspace_old:/wksp" \
    -w /workspace \
    "${NATIVE_IMAGE}" \
    bash -lc '
      set -euo pipefail
      cmake -S /workspace -B /wksp/build/cmake \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/wksp/output
      cmake --build /wksp/build/cmake \
        --target terra_sdk_c_api_tests --parallel "'"${BUILD_JOBS}"'"
      cd /wksp/build/cmake
      ctest --output-on-failure -R "^terra_sdk_c_api_(contract|parity|sparse_globe)$"
      /wksp/build/cmake/sdk/tests/terra_sdk_c_api_parity \
        /workspace/testdata/miniprogram/golden/globe_root_0_record.bin \
        /workspace/testdata/miniprogram/golden/globe_root_0_detail_record.bin \
        /workspace/testdata/miniprogram/golden/globe_root_3_record.bin \
        /workspace/testdata/miniprogram/golden/globe_root_3_detail_record.bin \
        /workspace/testdata/miniprogram/golden/globe_patch_record.bin \
        > /wksp/build/wasm/native_parity.txt
      /wksp/build/cmake/sdk/tests/terra_sdk_c_api_planar \
        /workspace/testdata/miniprogram/golden/planar_root_record.bin \
        /workspace/testdata/miniprogram/golden/planar_root_detail_record.bin \
        > /wksp/build/wasm/native_planar_parity.txt
    '

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace/adapters/wasm \
    "${WASM_IMAGE}" \
    bash -lc '
      set -euo pipefail
      cmake --preset wasm-release
      cmake --build --preset wasm-release --clean-first \
        --parallel "'"${BUILD_JOBS}"'"
      sha256sum /workspace/workspace_old/build/wasm/terra_sdk.wasm \
        | awk "{print \$1}" \
        > /workspace/workspace_old/build/wasm/first_build.sha256
    '

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/wasm/terra_wasm_parity.js \
      workspace_old/build/wasm/terra_sdk.wasm \
      testdata/miniprogram/golden/globe_root_0_record.bin \
      testdata/miniprogram/golden/globe_root_0_detail_record.bin \
      testdata/miniprogram/golden/globe_root_3_record.bin \
      testdata/miniprogram/golden/globe_root_3_detail_record.bin \
      testdata/miniprogram/golden/globe_patch_record.bin \
      workspace_old/build/wasm/native_parity.txt \
      workspace_old/build/wasm/package

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/wasm/terra_wasm_planar.js \
      workspace_old/build/wasm/terra_sdk.wasm \
      testdata/miniprogram/golden/planar_root_record.bin \
      testdata/miniprogram/golden/planar_root_detail_record.bin \
      workspace_old/build/wasm/native_planar_parity.txt

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/terra_wasm_loader_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/terra_globe_common_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/terra_interaction_controller_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/terra_viewer_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/terra_imagery_profiles_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/terra_cloudbase_transport_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/terra_webgl_renderer_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/terra_globe_runtime_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/globe_page_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/terra_planar_runtime_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/planar_page_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/terra_planar_load_probe_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/planar_load_page_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace/adapters/wasm \
    "${WASM_IMAGE}" \
    bash -lc '
      set -euo pipefail
      cmake --build --preset wasm-release --clean-first \
        --parallel "'"${BUILD_JOBS}"'"
      second_hash=$(sha256sum \
        /workspace/workspace_old/build/wasm/terra_sdk.wasm | awk "{print \$1}")
      first_hash=$(cat \
        /workspace/workspace_old/build/wasm/first_build.sha256)
      if [ "${first_hash}" != "${second_hash}" ]; then
        echo "Wasm reproducibility check failed: ${first_hash} != ${second_hash}" >&2
        exit 1
      fi
      echo "Wasm reproducibility passed: ${second_hash}"
    '
} 2>&1 | tee "${LOG_FILE}"
verify_status=${PIPESTATUS[0]}
set -e

if [ "${verify_status}" -ne 0 ]; then
  echo "Mini Program Wasm verification failed with status ${verify_status}." >&2
  exit "${verify_status}"
fi
if grep -n "warning:" "${LOG_FILE}"; then
  echo "Mini Program Wasm compiler warning gate failed." >&2
  exit 1
fi

wasm_size=$(stat -c %s "${BUILD_DIR}/terra_sdk.wasm")
if [ "${wasm_size}" -gt "${MAX_WASM_SIZE}" ]; then
  echo "Wasm size ${wasm_size} exceeds limit ${MAX_WASM_SIZE}." >&2
  exit 1
fi

cp "${BUILD_DIR}/terra_sdk.wasm" "${PACKAGE_DIR}/wasm/terra_sdk.wasm"
cp "${BUILD_DIR}/package/terra_sdk_wasm_manifest.json" \
  "${PACKAGE_DIR}/wasm/terra_sdk_wasm_manifest.json"
cp "${ROOT_DIR}/sdk/include/terra/c_api/terra.h" \
  "${PACKAGE_DIR}/include/terra/c_api/terra.h"
cp "${ROOT_DIR}/apps/miniprogram/utils/terra_wasm.js" \
  "${PACKAGE_DIR}/utils/terra_wasm.js"
cp "${ROOT_DIR}/apps/miniprogram/utils/terra_globe_common.js" \
  "${PACKAGE_DIR}/utils/terra_globe_common.js"
cp "${ROOT_DIR}/apps/miniprogram/utils/terra_interaction_controller.js" \
  "${PACKAGE_DIR}/utils/terra_interaction_controller.js"
cp "${ROOT_DIR}/apps/miniprogram/utils/terra_miniprogram_interaction.js" \
  "${PACKAGE_DIR}/utils/terra_miniprogram_interaction.js"
cp "${ROOT_DIR}/apps/miniprogram/utils/terra_viewer.js" \
  "${PACKAGE_DIR}/utils/terra_viewer.js"
cp "${ROOT_DIR}/apps/miniprogram/utils/terra_viewer.d.ts" \
  "${PACKAGE_DIR}/utils/terra_viewer.d.ts"
cp "${ROOT_DIR}/apps/miniprogram/utils/terra_imagery_profiles.js" \
  "${PACKAGE_DIR}/utils/terra_imagery_profiles.js"
cp "${ROOT_DIR}/apps/miniprogram/utils/terra_webgl_renderer.js" \
  "${PACKAGE_DIR}/utils/terra_webgl_renderer.js"
cp "${ROOT_DIR}/apps/miniprogram/utils/terra_globe_runtime.js" \
  "${PACKAGE_DIR}/utils/terra_globe_runtime.js"
cp "${ROOT_DIR}/docs/miniprogram/WASM_SDK_V1.md" \
  "${PACKAGE_DIR}/README.md"
cp "${ROOT_DIR}/docs/miniprogram/SDK_PRODUCT_API.md" \
  "${PACKAGE_DIR}/docs/SDK_PRODUCT_API.md"
cp "${ROOT_DIR}/docs/SDK_RELEASE.md" "${PACKAGE_DIR}/docs/SDK_RELEASE.md"
cp "${ROOT_DIR}/apps/miniprogram/README.md" \
  "${PACKAGE_DIR}/docs/MINIPROGRAM_APP.md"
cp "${ROOT_DIR}/LICENSE" "${PACKAGE_DIR}/licenses/LICENSE"
cp "${ROOT_DIR}/NOTICE" "${PACKAGE_DIR}/licenses/NOTICE"
cp "${ROOT_DIR}/spacelib/COPYING" \
  "${PACKAGE_DIR}/licenses/spacelib/COPYING"
cp "${ROOT_DIR}/ratman/LICENSE" "${PACKAGE_DIR}/licenses/ratman/LICENSE"

wasm_sha256=$(sha256sum "${PACKAGE_DIR}/wasm/terra_sdk.wasm" | awk '{print $1}')
core_size=${wasm_size}
for core_file in "${PACKAGE_DIR}/utils/"*.js; do
  core_size=$((core_size + $(stat -c %s "${core_file}")))
done
if [ "${core_size}" -gt "${MAX_CORE_SIZE}" ]; then
  echo "Mini Program core size ${core_size} exceeds limit ${MAX_CORE_SIZE}." >&2
  exit 1
fi
cat > "${PACKAGE_DIR}/release_manifest.json" <<JSON
{
  "schema": "terra.sdk-package.v1",
  "sdk_version": "${SDK_VERSION}",
  "c_abi_version": 1,
  "wasm_size": ${wasm_size},
  "core_size": ${core_size},
  "wasm_sha256": "${wasm_sha256}",
  "credentials_included": false,
  "terrain_data_included": false
}
JSON

printf 'Mini Program Wasm verification passed: %s bytes, package %s\n' \
  "${wasm_size}" "${PACKAGE_DIR}"
