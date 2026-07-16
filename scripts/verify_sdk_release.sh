#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
LOG_FILE="${ROOT_DIR}/viewer_verify_output/sdk_release_verify.log"

mkdir -p "$(dirname "${LOG_FILE}")"
rm -f "${LOG_FILE}"

set +e
{
  if [ "${SDK_RELEASE_SKIP_BUILD:-0}" != "1" ]; then
    bash "${ROOT_DIR}/scripts/build_cmake.sh"
  fi
  bash "${ROOT_DIR}/scripts/verify_miniprogram_sdk.sh"
  bash "${ROOT_DIR}/scripts/verify_terrain_service.sh"
  bash "${ROOT_DIR}/scripts/verify_miniprogram_wasm.sh"
  WEB_SDK_SKIP_WASM_GATE=1 bash "${ROOT_DIR}/scripts/verify_web_sdk.sh"
  bash "${ROOT_DIR}/scripts/package_sdk_release.sh"
} 2>&1 | tee "${LOG_FILE}"
verify_status=${PIPESTATUS[0]}
set -e

if [ "${verify_status}" -ne 0 ]; then
  echo "Terra SDK release gate failed with status ${verify_status}." >&2
  exit "${verify_status}"
fi
if grep -n "warning:" "${LOG_FILE}"; then
  echo "Terra SDK release compiler warning gate failed." >&2
  exit 1
fi

echo "Terra SDK automated release gate passed."
echo "Mini Program DevTools/Android/iOS acceptance remains pending owner sign-off."
