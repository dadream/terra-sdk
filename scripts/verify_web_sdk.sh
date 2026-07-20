#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
OUTPUT_DIR=$(realpath -m "${WEB_SDK_OUTPUT_DIR:-${ROOT_DIR}/viewer_verify_output/web_sdk}")
ALLOWED_OUTPUT_ROOT="${ROOT_DIR}/viewer_verify_output"
SITE_DIR="${OUTPUT_DIR}/site"
WASM_IMAGE=${TERRA_SDK_WASM_IMAGE:-terra-sdk-wasm:emscripten-3.1.5}
PORT=${WEB_SDK_PORT:-18765}
VIRTUAL_TIME_BUDGET_MS=${WEB_SDK_VIRTUAL_TIME_BUDGET_MS:-30000}
BROWSER_TIMEOUT_SECONDS=${WEB_SDK_BROWSER_TIMEOUT_SECONDS:-45}
BROWSER_BIN=${WEB_SDK_BROWSER_BIN:-}
SERVER_PID=
BROWSER_PROFILE=

case "${OUTPUT_DIR}" in
  "${ALLOWED_OUTPUT_ROOT}"/*) ;;
  *)
    echo "WEB_SDK_OUTPUT_DIR must be below ${ALLOWED_OUTPUT_ROOT}" >&2
    exit 2
    ;;
esac

cleanup() {
  if [ -n "${SERVER_PID}" ]; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
  fi
  if [ -n "${BROWSER_PROFILE}" ] && [ -d "${BROWSER_PROFILE}" ]; then
    rm -rf "${BROWSER_PROFILE}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

rm -rf "${OUTPUT_DIR}"
mkdir -p "${OUTPUT_DIR}"

if [ "${WEB_SDK_SKIP_WASM_GATE:-0}" != "1" ]; then
  bash "${ROOT_DIR}/scripts/verify_miniprogram_wasm.sh"
fi

if [ ! -f "${ROOT_DIR}/workspace_old/package/miniprogram/wasm/terra_sdk.wasm" ]; then
  echo "Verified Mini Program Wasm package is missing; run verify_miniprogram_wasm.sh" >&2
  exit 2
fi

docker run --rm \
  -v "${ROOT_DIR}:/workspace" \
  -w /workspace \
  "${WASM_IMAGE}" \
  node scripts/build_web_sdk_harness.js \
    /workspace \
    "/workspace/${SITE_DIR#"${ROOT_DIR}/"}"

if [ -z "${BROWSER_BIN}" ]; then
  for candidate in \
    chromium chromium-browser google-chrome google-chrome-stable \
    microsoft-edge msedge \
    "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
    "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      BROWSER_BIN=$(command -v "${candidate}")
      break
    fi
    if [ -x "${candidate}" ]; then
      BROWSER_BIN=${candidate}
      break
    fi
  done
fi

if [ -z "${BROWSER_BIN}" ]; then
  echo "No Chromium-compatible browser found; set WEB_SDK_BROWSER_BIN" >&2
  exit 2
fi

python3 -m http.server "${PORT}" --bind 0.0.0.0 \
  --directory "${SITE_DIR}" > "${OUTPUT_DIR}/http_server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  if curl --silent --fail "http://127.0.0.1:${PORT}/" >/dev/null; then
    break
  fi
  sleep 0.1
done
if ! kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
  cat "${OUTPUT_DIR}/http_server.log" >&2
  exit 1
fi
if ! curl --silent --fail "http://127.0.0.1:${PORT}/" >/dev/null; then
  echo "Web SDK evidence server did not start" >&2
  exit 1
fi

if [[ "${BROWSER_BIN}" == *.exe ]]; then
  BROWSER_PROFILE="/mnt/c/tmp/terra-web-sdk-$PPID-$$"
  mkdir -p "${BROWSER_PROFILE}"
  PROFILE_ARGUMENT=$(wslpath -w "${BROWSER_PROFILE}")
else
  BROWSER_PROFILE="${OUTPUT_DIR}/browser-profile"
  mkdir -p "${BROWSER_PROFILE}"
  PROFILE_ARGUMENT=${BROWSER_PROFILE}
fi

set +e
if [[ "${BROWSER_BIN}" == *.exe ]]; then
  WINDOWS_NODE_BIN=${WEB_SDK_WINDOWS_NODE_BIN:-$(command -v node.exe || true)}
  if [ -z "${WINDOWS_NODE_BIN}" ]; then
    echo "Windows Node.js is required for Edge evidence; set WEB_SDK_WINDOWS_NODE_BIN" >&2
    exit 2
  fi
  "${WINDOWS_NODE_BIN}" \
    "$(wslpath -w "${ROOT_DIR}/scripts/run_chromium_evidence.js")" \
    --browser "$(wslpath -w "${BROWSER_BIN}")" \
    --profile "${PROFILE_ARGUMENT}" \
    --url "http://127.0.0.1:${PORT}/" \
    --dom-output "$(wslpath -w "${OUTPUT_DIR}/browser_dom.html")" \
    --log-output "$(wslpath -w "${OUTPUT_DIR}/browser.log")" \
    --timeout "${BROWSER_TIMEOUT_SECONDS}"
else
  timeout --foreground --kill-after=5s "${BROWSER_TIMEOUT_SECONDS}s" \
    "${BROWSER_BIN}" \
    --headless=new \
    --no-sandbox \
    --no-first-run \
    --disable-extensions \
    --disable-background-networking \
    --disable-component-update \
    --enable-webgl \
    --enable-unsafe-swiftshader \
    --ignore-gpu-blocklist \
    --use-angle=swiftshader \
    --run-all-compositor-stages-before-draw \
    --virtual-time-budget="${VIRTUAL_TIME_BUDGET_MS}" \
    --window-size=1280,1000 \
    --user-data-dir="${PROFILE_ARGUMENT}" \
    --dump-dom \
    "http://127.0.0.1:${PORT}/" \
    > "${OUTPUT_DIR}/browser_dom.html" \
    2> "${OUTPUT_DIR}/browser.log"
fi
BROWSER_STATUS=$?
set -e

if [ "${BROWSER_STATUS}" -ne 0 ]; then
  if { [ "${BROWSER_STATUS}" -eq 124 ] || [ "${BROWSER_STATUS}" -eq 137 ]; } && \
     grep -Eq '<html[^>]*data-terra-status="passed"' \
       "${OUTPUT_DIR}/browser_dom.html"; then
    echo "Browser evidence completed before browser shutdown timeout."
  else
    cat "${OUTPUT_DIR}/browser.log" >&2
    exit "${BROWSER_STATUS}"
  fi
fi

python3 "${ROOT_DIR}/scripts/check_web_sdk_evidence.py" \
  "${OUTPUT_DIR}/browser_dom.html" \
  "${OUTPUT_DIR}"
