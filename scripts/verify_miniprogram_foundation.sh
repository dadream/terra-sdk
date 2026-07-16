#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
APP_DIR="${ROOT_DIR}/apps/miniprogram"

bash "${ROOT_DIR}/scripts/check_desktop_oracle.sh"

required_files=(
  app.js
  app.json
  app.wxss
  project.config.json
  config/runtime.js
  pages/probe/index.js
  pages/probe/index.json
  pages/probe/index.wxml
  pages/probe/index.wxss
  utils/capability_probe.js
  wasm/probe.wasm
  wasm/probe.wat
)

for relative_path in "${required_files[@]}"; do
  if [ ! -s "${APP_DIR}/${relative_path}" ]; then
    echo "Missing Mini Program capability probe file: ${relative_path}" >&2
    exit 1
  fi
done

expected_wasm_hex="0061736d0100000001070160027f7f017f030201000707010361646400000a09010700200020016a0b"
actual_wasm_hex=$(od -An -v -tx1 "${APP_DIR}/wasm/probe.wasm" | tr -d ' \n')
if [ "${actual_wasm_hex}" != "${expected_wasm_hex}" ]; then
  echo "Mini Program probe Wasm does not match its reviewed source." >&2
  exit 1
fi

grep -Fq "WXWebAssembly.instantiate" "${APP_DIR}/utils/capability_probe.js"
grep -Fq "getContext('webgl'" "${APP_DIR}/utils/capability_probe.js"
grep -Fq "precision mediump float" "${APP_DIR}/utils/capability_probe.js"
grep -Fq "readPixels" "${APP_DIR}/utils/capability_probe.js"
grep -Fq "responseType: 'arraybuffer'" "${APP_DIR}/utils/capability_probe.js"

if command -v node >/dev/null 2>&1; then
  node --check "${APP_DIR}/app.js"
  node --check "${APP_DIR}/pages/probe/index.js"
  node --check "${APP_DIR}/utils/capability_probe.js"
  node "${ROOT_DIR}/tests/miniprogram/capability_probe_test.js"
else
  echo "Node.js unavailable; skipping optional host-side JavaScript checks."
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required for Mini Program device evidence verifier checks." >&2
  exit 2
fi
python3 "${ROOT_DIR}/scripts/verify_miniprogram_device_evidence.py" --self-test

echo "Mini Program foundation verification passed."
