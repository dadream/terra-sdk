#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SDK_VERSION=$(sed -n 's/^project(TerraSdk VERSION \([^ ]*\).*/\1/p' "${ROOT_DIR}/CMakeLists.txt")
SDK_C_ABI_VERSION=$(sed -n 's/^#define TERRA_C_API_VERSION \([0-9][0-9]*\)U$/\1/p' \
  "${ROOT_DIR}/sdk/include/terra/c_api/terra.h")
test -n "${SDK_C_ABI_VERSION}"
NATIVE_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
WASM_IMAGE=${TERRA_SDK_WASM_IMAGE:-terra-sdk-wasm:emscripten-3.1.5}
BUILD_JOBS=${TERRA_SDK_BUILD_JOBS:-4}
MAX_WASM_SIZE=${TERRA_SDK_WASM_MAX_SIZE_BYTES:-1048576}
CORE_SIZE_REFERENCE=${TERRA_SDK_MINIPROGRAM_CORE_SIZE_REFERENCE_BYTES:-524288}
BUILD_DIR="${ROOT_DIR}/workspace_old/build/wasm"
PACKAGE_DIR="${ROOT_DIR}/workspace_old/package/miniprogram"
LOG_FILE="${ROOT_DIR}/viewer_verify_output/miniprogram_wasm_verify.log"

bash "${ROOT_DIR}/scripts/check_desktop_oracle.sh"
bash "${ROOT_DIR}/scripts/build_wasm_image.sh"
node "${ROOT_DIR}/scripts/stage_sdk_js.js" "${ROOT_DIR}/apps/miniprogram/vendor/terra" miniprogram
rm -rf "${PACKAGE_DIR}"
mkdir -p "${BUILD_DIR}" "${PACKAGE_DIR}/include/terra/c_api" \
  "${PACKAGE_DIR}/wasm" \
  "${PACKAGE_DIR}/docs" "${PACKAGE_DIR}/licenses/spacelib" \
  "${PACKAGE_DIR}/licenses/ratman" \
  "$(dirname "${LOG_FILE}")"

set +e
{
  set -e
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
    node tests/wasm/terra_wasm_incremental.js workspace_old/build/wasm/terra_sdk.wasm

  # Exercise the actual persistent C++ work on Wasm32 via private test exports.
  # This executable stays in the data-disk test mount, outside SDK packages.
  docker run --rm -v "${ROOT_DIR}:/workspace" -w /workspace \
    "${WASM_IMAGE}" bash -lc '
      set -euo pipefail
      emcmake cmake -S tests/wasm/region_compaction \
        -B viewer_verify_output/native_region_compaction_contract/build -DCMAKE_BUILD_TYPE=Release
      cmake --build viewer_verify_output/native_region_compaction_contract/build \
        --parallel "'"${BUILD_JOBS}"'"
      node tests/wasm/region_compaction_contract.js \
        viewer_verify_output/native_region_compaction_contract/build/region_compaction_contract.wasm \
        testdata/miniprogram/golden/region_compaction_v1.bin
    '

  docker run --rm -v "${ROOT_DIR}:/workspace" -w /workspace \
    "${WASM_IMAGE}" bash -lc '
      set -euo pipefail
      node tests/js/generate_surface_projection_golden.js testdata/miniprogram/golden/surface_projection_v1.bin --check
      emcmake cmake -S tests/wasm/surface_projection \
        -B viewer_verify_output/native_surface_projection_contract/build -DCMAKE_BUILD_TYPE=Release
      cmake --build viewer_verify_output/native_surface_projection_contract/build \
        --parallel "'"${BUILD_JOBS}"'"
      node tests/wasm/surface_projection_contract.js \
        viewer_verify_output/native_surface_projection_contract/build/surface_projection_contract.wasm \
        testdata/miniprogram/golden/surface_projection_v1.bin \
        viewer_verify_output/native_surface_projection_contract/report.json
      node tests/wasm/surface_model_contract.js \
        viewer_verify_output/native_surface_projection_contract/build/surface_projection_contract.wasm \
        viewer_verify_output/native_surface_projection_contract/model-report.json
    '

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/wasm/terra_worker_contract.js workspace_old/build/wasm/terra_sdk.wasm

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/wasm/terra_wasm_imagery.js workspace_old/build/wasm/terra_sdk.wasm

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/js/sdk_structure_test.js

  docker run --rm -v "${ROOT_DIR}:/workspace" -w /workspace \
    "${WASM_IMAGE}" node tests/js/terra_wasm_loader_test.js

  docker run --rm -v "${ROOT_DIR}:/workspace" -w /workspace \
    "${WASM_IMAGE}" node tests/js/frame_coordinator_test.js

  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/region_compaction_test.js

  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/abi_teardown_test.js

  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/resource_ledger_test.js
  docker run --rm -v "${ROOT_DIR}:/workspace" -w /workspace \
    "${WASM_IMAGE}" node tests/js/resource_cache_test.js
  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/resource_reclamation_test.js
  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/shared_mesh_coordinates_test.js

  docker run --rm -v "${ROOT_DIR}:/workspace" -w /workspace \
    "${WASM_IMAGE}" node tests/js/native_mesh_budget_test.js
  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/native_record_budget_test.js
  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/height_work_batch_test.js
  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/resource_pressure_test.js
  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/height_queries_test.js
  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/ground_demands_test.js
  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/terrain_walk_test.js
  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/depth_encoding_test.js
  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/submission_queue_test.js

  docker run --rm -v "${ROOT_DIR}:/workspace" -w /workspace \
    "${WASM_IMAGE}" node tests/js/texture_reservation_test.js

  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/encoded_texture_store_test.js
  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/benchmarks/imagery_pipeline_test.js
  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/image_texture_store_test.js
  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/imagery_group_admission_test.js
  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/resource_workspace_test.js
  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node tests/js/partition_groups_test.js

  docker run --rm -v "${ROOT_DIR}:/workspace" -w /workspace \
    "${WASM_IMAGE}" node tests/web_sdk/navigation_scenarios_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/js/terra_globe_common_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/js/terra_interaction_controller_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/js/terra_camera_motion_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/js/terra_viewer_test.js

  docker run --rm -v "${ROOT_DIR}:/workspace" -w /workspace \
    "${WASM_IMAGE}" node tests/js/terra_imagery_adapter_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/js/terra_imagery_profiles_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/js/terra_local_resource_url_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/suzhou_tour_fixture_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/terra_cloudbase_transport_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/js/terra_webgl_renderer_test.js

  docker run --rm -v "${ROOT_DIR}:/workspace" -w /workspace \
    "${WASM_IMAGE}" node tests/js/terra_imagery_presentation_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/js/terra_surface_plan_test.js

  docker run --rm -v "${ROOT_DIR}:/workspace" -w /workspace \
    "${WASM_IMAGE}" node tests/js/surface_replacement_test.js

  docker run --rm -v "${ROOT_DIR}:/workspace" -w /workspace \
    "${WASM_IMAGE}" node tests/js/mesh_receipts_test.js

  docker run --rm -v "${ROOT_DIR}:/workspace" -w /workspace \
    "${WASM_IMAGE}" node tests/js/mesh_transfer_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/js/terra_worker_scheduling_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/js/terra_worker_client_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/js/terra_imagery_frontier_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/js/terra_globe_runtime_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/miniprogram/globe_page_test.js

  docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    "${WASM_IMAGE}" \
    node tests/js/terra_planar_runtime_test.js

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
node "${ROOT_DIR}/scripts/stage_sdk_js.js" "${PACKAGE_DIR}"
cp "${ROOT_DIR}/docs/miniprogram/WASM_SDK_V1.md" \
  "${PACKAGE_DIR}/README.md"
cp "${ROOT_DIR}/docs/miniprogram/SDK_PRODUCT_API.md" \
  "${PACKAGE_DIR}/docs/SDK_PRODUCT_API.md"
cp "${ROOT_DIR}/docs/SDK_RELEASE.md" "${PACKAGE_DIR}/docs/SDK_RELEASE.md"
cp "${ROOT_DIR}/docs/SDK_CANONICAL_IMAGERY_INPUT.md" "${PACKAGE_DIR}/docs/SDK_CANONICAL_IMAGERY_INPUT.md"
cp "${ROOT_DIR}/apps/miniprogram/README.md" \
  "${PACKAGE_DIR}/docs/MINIPROGRAM_APP.md"
cp "${ROOT_DIR}/LICENSE" "${PACKAGE_DIR}/licenses/LICENSE"
cp "${ROOT_DIR}/NOTICE" "${PACKAGE_DIR}/licenses/NOTICE"
cp "${ROOT_DIR}/spacelib/COPYING" \
  "${PACKAGE_DIR}/licenses/spacelib/COPYING"
cp "${ROOT_DIR}/ratman/LICENSE" "${PACKAGE_DIR}/licenses/ratman/LICENSE"

docker run --rm -v "${ROOT_DIR}:/workspace" -w /workspace \
  "${WASM_IMAGE}" node scripts/minify_sdk_package.js workspace_old/package/miniprogram

docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
  "${WASM_IMAGE}" node -e \
  "require('./workspace_old/package/miniprogram')"

# Reuse source contracts against the exact distributed modules. Compression
# must not change public properties, scheduling or rendering.
docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
  "${WASM_IMAGE}" node -r ./tests/js/use_packaged_sdk.js \
  tests/wasm/imagery_scratch_contract.js workspace_old/package/miniprogram/wasm/terra_sdk.wasm
docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
  "${WASM_IMAGE}" node -r ./tests/js/use_packaged_sdk.js \
  tests/wasm/abi_teardown_contract.js workspace_old/package/miniprogram/wasm/terra_sdk.wasm
docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
  "${WASM_IMAGE}" node -r ./tests/js/use_packaged_sdk.js \
  tests/wasm/native_surface_measurement_contract.js workspace_old/package/miniprogram/wasm/terra_sdk.wasm
for contract in terra_viewer terra_globe_common terra_camera_motion terra_surface_plan \
  terra_imagery_presentation terra_webgl_renderer terra_worker_client \
  terra_worker_scheduling terra_globe_runtime native_record_budget height_work_batch resource_ledger resource_cache resource_reclamation shared_mesh_coordinates native_mesh_budget resource_pressure height_queries ground_demands terrain_walk depth_encoding submission_queue texture_reservation encoded_texture_store imagery_group_admission resource_workspace partition_groups surface_replacement mesh_receipts mesh_transfer region_compaction abi_teardown; do
  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${WASM_IMAGE}" node -r ./tests/js/use_packaged_sdk.js \
    "tests/js/${contract}_test.js"
done
docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
  "${WASM_IMAGE}" node -r ./tests/js/use_packaged_sdk.js tests/js/frame_coordinator_test.js

wasm_sha256=$(sha256sum "${PACKAGE_DIR}/wasm/terra_sdk.wasm" | awk '{print $1}')
core_size=${wasm_size}
while IFS= read -r core_file; do
  core_size=$((core_size + $(stat -c %s "${PACKAGE_DIR}/${core_file}")))
done < <(node -e 'for (const file of require(process.argv[1])) console.log(file)' "${PACKAGE_DIR}/miniprogram_files.json")
all_platform_size=$((wasm_size + $(stat -c %s "${PACKAGE_DIR}/terra_worker.js")))
while IFS= read -r -d '' core_file; do
  all_platform_size=$((all_platform_size + $(stat -c %s "${core_file}")))
done < <(find "${PACKAGE_DIR}/sdk" "${PACKAGE_DIR}/adapters" -type f -name '*.js' -print0)

if [ "${core_size}" -gt "${CORE_SIZE_REFERENCE}" ]; then
  echo "Mini Program core size ${core_size} bytes exceeds the ${CORE_SIZE_REFERENCE}-byte reference (advisory only)."
fi
cat > "${PACKAGE_DIR}/release_manifest.json" <<JSON
{
  "schema": "terra.sdk-package.v1",
  "sdk_version": "${SDK_VERSION}",
  "c_abi_version": ${SDK_C_ABI_VERSION},
  "wasm_size": ${wasm_size},
  "core_size": ${core_size},
  "worker_size": $(stat -c %s "${PACKAGE_DIR}/terra_worker.js"),
  "all_platform_size": ${all_platform_size},
  "wasm_sha256": "${wasm_sha256}",
  "credentials_included": false,
  "terrain_data_included": false
}
JSON

printf 'Mini Program Wasm verification passed: %s bytes, package %s\n' \
  "${wasm_size}" "${PACKAGE_DIR}"
