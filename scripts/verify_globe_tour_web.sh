#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
OUTPUT_DIR=$(realpath -m "${GLOBE_TOUR_OUTPUT_DIR:-${ROOT_DIR}/viewer_verify_output/globe_tour_web_verify}")
TERRAIN_PORT=${GLOBE_TOUR_TERRAIN_PORT:-18182}
IMAGERY_PORT=${GLOBE_TOUR_IMAGERY_PORT:-18183}
WEB_PORT=${GLOBE_TOUR_WEB_PORT:-18767}
BROWSER_TIMEOUT_SECONDS=${GLOBE_TOUR_BROWSER_TIMEOUT_SECONDS:-300}
BROWSER_BIN=${GLOBE_TOUR_BROWSER_BIN:-}
LAUNCHER_PID=
BROWSER_PROFILE=
TERRAIN_CONTAINER=${GLOBE_TOUR_TERRAIN_CONTAINER:-terra_globe_tour_verify_terrain}
IMAGERY_CONTAINER=${GLOBE_TOUR_IMAGERY_CONTAINER:-terra_globe_tour_verify_imagery}
WEB_CONTAINER=${GLOBE_TOUR_WEB_CONTAINER:-terra_globe_tour_verify_web}
IMAGERY_PROFILE=${GLOBE_TOUR_IMAGERY_PROFILE:-tianditu-img-c}

export GLOBE_TOUR_OUTPUT_DIR="${OUTPUT_DIR}"
export GLOBE_TOUR_TERRAIN_PORT="${TERRAIN_PORT}"
export GLOBE_TOUR_IMAGERY_PORT="${IMAGERY_PORT}"
export GLOBE_TOUR_WEB_PORT="${WEB_PORT}"
export GLOBE_TOUR_TERRAIN_CONTAINER="${TERRAIN_CONTAINER}"
export GLOBE_TOUR_IMAGERY_CONTAINER="${IMAGERY_CONTAINER}"
export GLOBE_TOUR_WEB_CONTAINER="${WEB_CONTAINER}"
export GLOBE_TOUR_IMAGERY_PROFILE="${IMAGERY_PROFILE}"

remove_browser_profile() {
  if [ -z "${BROWSER_PROFILE}" ] || [ ! -e "${BROWSER_PROFILE}" ]; then
    return 0
  fi
  for _ in $(seq 1 30); do
    rm -rf "${BROWSER_PROFILE}" >/dev/null 2>&1 || true
    if [ ! -e "${BROWSER_PROFILE}" ]; then
      return 0
    fi
    sleep 0.1
  done
  echo "Cleanup failed; browser profile remains: ${BROWSER_PROFILE}" >&2
  return 1
}

capture_service_log() {
  local container=$1
  local output=$2
  if docker inspect "${container}" >/dev/null 2>&1; then
    docker logs "${container}" >"${output}" 2>&1 || true
  fi
}

capture_service_logs() {
  mkdir -p "${OUTPUT_DIR}"
  capture_service_log "${TERRAIN_CONTAINER}" "${OUTPUT_DIR}/terrain_service.log"
  capture_service_log "${IMAGERY_CONTAINER}" "${OUTPUT_DIR}/imagery_service.log"
  capture_service_log "${WEB_CONTAINER}" "${OUTPUT_DIR}/web_service.log"
}

cleanup() {
  local status=0
  capture_service_logs
  if [ -n "${LAUNCHER_PID}" ] && kill -0 "${LAUNCHER_PID}" 2>/dev/null; then
    kill "${LAUNCHER_PID}" >/dev/null 2>&1 || true
    wait "${LAUNCHER_PID}" >/dev/null 2>&1 || true
  fi
  docker rm -f "${WEB_CONTAINER}" "${IMAGERY_CONTAINER}" \
    "${TERRAIN_CONTAINER}" >/dev/null 2>&1 || true
  remove_browser_profile || status=1
  return "${status}"
}
trap cleanup EXIT INT TERM

if [ "${IMAGERY_PROFILE}" = "tianditu-img-c" ] && \
   [ -z "${TIANDITU_TOKEN:-}" ]; then
  echo "TIANDITU_TOKEN is required for local browser verification." >&2
  exit 2
fi

mkdir -p "${ROOT_DIR}/viewer_verify_output"
bash "${ROOT_DIR}/scripts/start_globe_tour_web.sh" \
  >"${ROOT_DIR}/viewer_verify_output/globe_tour_web_launcher.log" 2>&1 &
LAUNCHER_PID=$!
for _ in $(seq 1 240); do
  if [ -f "${OUTPUT_DIR}/services.ready" ] && \
     curl --silent --fail "http://127.0.0.1:${WEB_PORT}/" >/dev/null; then
    break
  fi
  if ! kill -0 "${LAUNCHER_PID}" 2>/dev/null; then
    cat "${ROOT_DIR}/viewer_verify_output/globe_tour_web_launcher.log" >&2
    exit 1
  fi
  sleep 0.25
done
if [ ! -f "${OUTPUT_DIR}/services.ready" ]; then
  echo "Local globe tour launcher timed out." >&2
  exit 1
fi

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
  echo "No Chromium-compatible browser found; set GLOBE_TOUR_BROWSER_BIN." >&2
  exit 2
fi

if [[ "${BROWSER_BIN}" == *.exe ]]; then
  BROWSER_PROFILE="/mnt/c/tmp/terra-globe-tour-$PPID-$$"
  mkdir -p "${BROWSER_PROFILE}"
  WINDOWS_NODE_BIN=${GLOBE_TOUR_WINDOWS_NODE_BIN:-$(command -v node.exe || true)}
  if [ -z "${WINDOWS_NODE_BIN}" ]; then
    echo "Windows Node.js is required; set GLOBE_TOUR_WINDOWS_NODE_BIN." >&2
    exit 2
  fi
else
  BROWSER_PROFILE="${OUTPUT_DIR}/browser-profile"
  mkdir -p "${BROWSER_PROFILE}"
fi

run_evidence() {
  local label=$1
  local width=$2
  local height=$3
  local profile_path="${BROWSER_PROFILE}/${label}"
  mkdir -p "${profile_path}"
  rm -f "${OUTPUT_DIR}/${label}_dom.html" "${OUTPUT_DIR}/${label}.png" \
    "${OUTPUT_DIR}/${label}_browser.log"
  if [[ "${BROWSER_BIN}" == *.exe ]]; then
    "${WINDOWS_NODE_BIN}" \
      "$(wslpath -w "${ROOT_DIR}/scripts/run_chromium_evidence.js")" \
      --browser "$(wslpath -w "${BROWSER_BIN}")" \
      --profile "$(wslpath -w "${profile_path}")" \
      --url "http://127.0.0.1:${WEB_PORT}/?verify=1&imagery=${IMAGERY_PROFILE}" \
      --dom-output "$(wslpath -w "${OUTPUT_DIR}/${label}_dom.html")" \
      --log-output "$(wslpath -w "${OUTPUT_DIR}/${label}_browser.log")" \
      --screenshot-output "$(wslpath -w "${OUTPUT_DIR}/${label}.png")" \
      --width "${width}" --height "${height}" \
      --timeout "${BROWSER_TIMEOUT_SECONDS}"
  else
    node "${ROOT_DIR}/scripts/run_chromium_evidence.js" \
      --browser "${BROWSER_BIN}" --profile "${profile_path}" \
      --url "http://127.0.0.1:${WEB_PORT}/?verify=1&imagery=${IMAGERY_PROFILE}" \
      --dom-output "${OUTPUT_DIR}/${label}_dom.html" \
      --log-output "${OUTPUT_DIR}/${label}_browser.log" \
      --screenshot-output "${OUTPUT_DIR}/${label}.png" \
      --width "${width}" --height "${height}" \
      --timeout "${BROWSER_TIMEOUT_SECONDS}"
  fi
  docker run --rm -v "${ROOT_DIR}:/workspace:ro" -w /workspace \
    "${TERRA_SDK_WASM_IMAGE:-terra-sdk-wasm:emscripten-3.1.5}" \
    node scripts/check_globe_tour_web_evidence.js \
      "/workspace/${OUTPUT_DIR#"${ROOT_DIR}/"}/${label}_dom.html"
}

run_evidence desktop 1280 900
run_evidence mobile 390 844

cleanup
LAUNCHER_PID=
BROWSER_PROFILE=
for name in "${WEB_CONTAINER}" "${IMAGERY_CONTAINER}" "${TERRAIN_CONTAINER}"; do
  if docker ps -a --format '{{.Names}}' | grep -qx "${name}"; then
    echo "Cleanup failed; container remains: ${name}" >&2
    exit 1
  fi
done
printf 'Local globe tour verification passed; all test services stopped.\n'
