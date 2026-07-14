#!/bin/bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
CURRENT_STEP=
EXECUTED_STEPS=()

RUN_LAYOUT_CHECK=${RUN_LAYOUT_CHECK:-1}
RUN_BUILD=${RUN_BUILD:-1}
RUN_MINIPROGRAM_NATIVE_GOLDEN=${RUN_MINIPROGRAM_NATIVE_GOLDEN:-1}
RUN_MINIPROGRAM_SDK=${RUN_MINIPROGRAM_SDK:-1}
RUN_ARTIFACT_CHECK=${RUN_ARTIFACT_CHECK:-1}
RUN_INSTALL_CHECK=${RUN_INSTALL_CHECK:-1}
RUN_SERVICE_SMOKE=${RUN_SERVICE_SMOKE:-1}
RUN_TERRAIN_SERVICE_SMOKE=${RUN_TERRAIN_SERVICE_SMOKE:-1}
RUN_BUILDER_CLI_SMOKE=${RUN_BUILDER_CLI_SMOKE:-1}
RUN_BUILDER_1K_REBUILD=${RUN_BUILDER_1K_REBUILD:-1}
RUN_BUILDER_VIEWER_SMOKE=${RUN_BUILDER_VIEWER_SMOKE:-1}
RUN_VIEWER_SMOKE=${RUN_VIEWER_SMOKE:-1}
RUN_NAV3D_SMOKE=${RUN_NAV3D_SMOKE:-1}
RUN_VIEWER_INTERACTION=${RUN_VIEWER_INTERACTION:-1}

VIEWER_SMOKE_TIMEOUT_SECONDS=${VIEWER_SMOKE_TIMEOUT_SECONDS:-25}
NAV3D_SMOKE_TIMEOUT_SECONDS=${NAV3D_SMOKE_TIMEOUT_SECONDS:-45}
VIEWER_INTERACTION_TIMEOUT_SECONDS=${VIEWER_INTERACTION_TIMEOUT_SECONDS:-120}

should_run() {
  case "$1" in
    0|false|FALSE|no|NO)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

run_step() {
  CURRENT_STEP="$*"
  EXECUTED_STEPS+=("$*")
  echo
  echo "=========================================================="
  echo "STEP: $*"
  echo "=========================================================="
  "$@"
}

on_error() {
  local status=$?
  echo "Terra SDK baseline gate failed with status ${status}." >&2
  if [ -n "${CURRENT_STEP}" ]; then
    echo "Failed step: ${CURRENT_STEP}" >&2
  fi
  exit "${status}"
}
trap on_error ERR

echo "Starting Terra SDK CMake-only baseline gate..."
cd "${ROOT_DIR}"

if should_run "${RUN_LAYOUT_CHECK}"; then
  run_step bash scripts/check_cmake_only_layout.sh
fi

if should_run "${RUN_BUILD}"; then
  run_step bash scripts/build_cmake.sh
fi
if should_run "${RUN_MINIPROGRAM_NATIVE_GOLDEN}"; then
  run_step bash scripts/verify_miniprogram_native_golden.sh
fi
if should_run "${RUN_MINIPROGRAM_SDK}"; then
  run_step bash scripts/verify_miniprogram_sdk.sh
fi
if should_run "${RUN_ARTIFACT_CHECK}"; then
  run_step bash scripts/check_cmake_artifacts.sh
fi
if should_run "${RUN_INSTALL_CHECK}"; then
  run_step bash scripts/check_cmake_install_artifacts.sh
fi
if should_run "${RUN_SERVICE_SMOKE}"; then
  run_step bash scripts/verify_service_victms_cmake_smoke.sh
fi
if should_run "${RUN_TERRAIN_SERVICE_SMOKE}"; then
  run_step bash scripts/verify_terrain_service.sh
fi
if should_run "${RUN_BUILDER_CLI_SMOKE}"; then
  run_step bash scripts/verify_builder_cli_smoke.sh
fi
if should_run "${RUN_BUILDER_1K_REBUILD}"; then
  run_step bash scripts/verify_builder_1k_rebuild.sh
fi
if should_run "${RUN_BUILDER_VIEWER_SMOKE}"; then
  run_step env \
    VIEWER_TIMEOUT_SECONDS="${VIEWER_SMOKE_TIMEOUT_SECONDS}" \
    bash scripts/verify_builder_1k_rebuild_viewer_smoke.sh
fi
if should_run "${RUN_VIEWER_SMOKE}"; then
  run_step env \
    VIEWER_TIMEOUT_SECONDS="${VIEWER_SMOKE_TIMEOUT_SECONDS}" \
    LOG_FILE=viewer_verify_output/viewer/viewer_1k_smoke.log \
    CONTAINER_NAME=vic_cbdam_viewer_1k_smoke \
    bash scripts/verify_viewer_1k_smoke.sh
fi
if should_run "${RUN_NAV3D_SMOKE}"; then
  run_step env \
    NAV3D_TIMEOUT_SECONDS="${NAV3D_SMOKE_TIMEOUT_SECONDS}" \
    LOG_FILE=viewer_verify_output/nav3d/nav3d_1k_smoke.log \
    CONTAINER_NAME=vic_ratman_nav3d_1k_smoke \
    bash scripts/verify_nav3d_1k_smoke.sh
fi
if should_run "${RUN_VIEWER_INTERACTION}"; then
  run_step env \
    VIEWER_TIMEOUT_SECONDS="${VIEWER_INTERACTION_TIMEOUT_SECONDS}" \
    OUTPUT_DIR="${ROOT_DIR}/viewer_verify_output/1k" \
    CONTAINER_NAME=vic_cbdam_viewer_1k_interaction \
    bash scripts/verify_viewer_1k_interaction.sh
fi

echo
echo "Terra SDK CMake-only baseline gate passed."
echo "Executed steps:"
for step in "${EXECUTED_STEPS[@]}"; do
  echo "  - ${step}"
done
