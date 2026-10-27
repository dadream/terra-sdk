#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
LOG_FILE="${ROOT_DIR}/viewer_verify_output/sdk_release_verify.log"

mkdir -p "$(dirname "${LOG_FILE}")"
: > "${LOG_FILE}"

run_step() {
  local name=$1
  shift

  printf '\n==> %s\n' "${name}" | tee -a "${LOG_FILE}"
  set +e
  "$@" 2>&1 | tee -a "${LOG_FILE}"
  local status=${PIPESTATUS[0]}
  set -e

  if [ "${status}" -ne 0 ]; then
    echo "Terra SDK release gate failed during ${name} with status ${status}." >&2
    exit "${status}"
  fi
}

if [ "${SDK_RELEASE_SKIP_BUILD:-0}" != "1" ]; then
  run_step "CMake build and core regression gate" \
    bash "${ROOT_DIR}/scripts/build_cmake.sh"
fi
run_step "native Mini Program SDK gate" \
  bash "${ROOT_DIR}/scripts/verify_miniprogram_sdk.sh"
run_step "terrain service gate" \
  bash "${ROOT_DIR}/scripts/verify_terrain_service.sh"
run_step "Mini Program Wasm gate" \
  bash "${ROOT_DIR}/scripts/verify_miniprogram_wasm.sh"
run_step "Web SDK evidence gate" \
  env WEB_SDK_SKIP_WASM_GATE=1 bash "${ROOT_DIR}/scripts/verify_web_sdk.sh"
run_step "SDK release package gate" \
  bash "${ROOT_DIR}/scripts/package_sdk_release.sh"
run_step "product site package gate" \
  bash "${ROOT_DIR}/scripts/verify_product_site.sh"
# Every code-producing gate validates its own compiler-only build log. The
# aggregate release log also contains non-compiler Docker infrastructure output.

echo "Terra SDK automated release gate passed."
echo "Mini Program DevTools/Android/iOS acceptance remains pending owner sign-off."
