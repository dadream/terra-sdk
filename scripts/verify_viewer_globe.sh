#!/bin/bash
set -uo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
GLOBE_DATA_DIR=${GLOBE_DATA_DIR:-/mnt/s/terra-data/globe}
TEXTURE_MODE=${GLOBE_TEXTURE_MODE:-blue-marble}
BASELINE_DIR=${BASELINE_DIR:-"${ROOT_DIR}/testdata/viewer_baseline/globe"}
OUTPUT_DIR=${OUTPUT_DIR:-"${ROOT_DIR}/viewer_verify_output/globe/viewer_${TEXTURE_MODE}"}
TIMEOUT_SECONDS=${VIEWER_TIMEOUT_SECONDS:-300}
WINDOW_SIZE=${VIEWER_WINDOW_SIZE:-1280x720}
VIEWER_BIN=${VIEWER_BIN:-/wksp/build/cmake/vic_cbdam_viewer}
CONTAINER_NAME=${CONTAINER_NAME:-"vic_cbdam_viewer_globe_${TEXTURE_MODE}"}
LOCK_FILE=${LOCK_FILE:-"${ROOT_DIR}/viewer_verify_output/globe/viewer.lock"}

if [ ! -f "${GLOBE_DATA_DIR}/terrain.xml" ] ||
   [ ! -f "${GLOBE_DATA_DIR}/terrain.data" ]; then
  echo "Missing globe terrain prefix: ${GLOBE_DATA_DIR}/terrain" >&2
  exit 2
fi
if [ ! -f "${BASELINE_DIR}/actions.txt" ]; then
  echo "Missing globe action script: ${BASELINE_DIR}/actions.txt" >&2
  exit 2
fi

DOCKER_ENV_ARGS=()
BASELINE_CHECK_ARGS=()
VIEWER_TEXTURE_ARGS=()
CONTRACT_FILE="${BASELINE_DIR}/log_contract.json"
case "${TEXTURE_MODE}" in
  blue-marble)
    BLUE_MARBLE_XML="${GLOBE_DATA_DIR}/blue-marble-global-geodetic/victms.xml"
    if [ ! -f "${BLUE_MARBLE_XML}" ]; then
      echo "Missing Blue Marble texture: ${BLUE_MARBLE_XML}" >&2
      exit 2
    fi
    VIEWER_TEXTURE_ARGS=(/globe/blue-marble-global-geodetic/victms.xml)
    BASELINE_CHECK_ARGS=(
      --max-baseline-diff
      "${VIEWER_MAX_BASELINE_DIFF:-2.0}"
    )
    ;;
  tianditu)
    if [ -z "${TIANDITU_TOKEN:-}" ]; then
      echo "A server-side TIANDITU_TOKEN is required for native verification." >&2
      exit 2
    fi
    DOCKER_ENV_ARGS=(-e TIANDITU_TOKEN)
    CONTRACT_FILE="${BASELINE_DIR}/tianditu_log_contract.json"
    VIEWER_TEXTURE_ARGS=(
      --wmts-url "https://t{s}.tianditu.gov.cn/img_c/wmts"
      --wmts-layer img
      --wmts-style default
      --wmts-format tiles
      --wmts-matrix-set c
      --wmts-level-offset 1
      --wmts-max-level 17
      --wmts-subdomains 8
      --wmts-token-parameter tk
      --wmts-token-env TIANDITU_TOKEN
    )
    ;;
  *)
    echo "Unsupported GLOBE_TEXTURE_MODE: ${TEXTURE_MODE}" >&2
    exit 2
    ;;
esac

mkdir -p "${OUTPUT_DIR}" "$(dirname "${LOCK_FILE}")"
BASELINE_DIR=$(cd "${BASELINE_DIR}" && pwd)
OUTPUT_DIR=$(cd "${OUTPUT_DIR}" && pwd)
LOG_FILE="${OUTPUT_DIR}/viewer.log"
EXIT_FILE="${OUTPUT_DIR}/viewer.exit"

export DISPLAY=${DISPLAY:-:0}
X11_SOCKET_DIR=/tmp/.X11-unix
if [ -d /mnt/wslg/.X11-unix ]; then
  X11_SOCKET_DIR=/mnt/wslg/.X11-unix
fi

if command -v flock &>/dev/null; then
  exec 9>"${LOCK_FILE}"
  flock 9
fi

cleanup() {
  docker rm -f "${CONTAINER_NAME}" > /dev/null 2>&1 || true
  if command -v xhost &>/dev/null; then
    xhost -local:docker > /dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

rm -f "${OUTPUT_DIR}"/*.png "${OUTPUT_DIR}"/state_*.json
rm -f "${OUTPUT_DIR}/summary.json" "${OUTPUT_DIR}/normalized_log.json"
rm -f "${OUTPUT_DIR}/report.html" "${EXIT_FILE}" "${LOG_FILE}"

if command -v xhost &>/dev/null; then
  xhost +local:docker > /dev/null 2>&1 || true
fi

echo "Starting globe viewer verification..."
echo "Texture mode: ${TEXTURE_MODE}"
echo "Dataset: ${GLOBE_DATA_DIR}"
echo "Output: ${OUTPUT_DIR}"

docker rm -f "${CONTAINER_NAME}" > /dev/null 2>&1 || true
DOCKER_CMD=(
  docker run -d
  --name "${CONTAINER_NAME}"
  --user "$(id -u):$(id -g)"
  --network host
  -v "${ROOT_DIR}:/workspace"
  -v "${ROOT_DIR}/workspace_old:/wksp"
  -v "${GLOBE_DATA_DIR}:/globe:ro"
  -v "${BASELINE_DIR}:/viewer-baseline:ro"
  -v "${OUTPUT_DIR}:/viewer-output"
  -v "${X11_SOCKET_DIR}:/tmp/.X11-unix"
  -e DISPLAY="${DISPLAY}"
  "${DOCKER_ENV_ARGS[@]}"
  -w /workspace
  "${DOCKER_IMAGE}"
  "${VIEWER_BIN}"
  --elevation /globe/terrain
  --verify-script /viewer-baseline/actions.txt
  --verify-output-dir /viewer-output
  --verify-exit
  --verify-window-size "${WINDOW_SIZE}"
  --verify-log-state
  "${VIEWER_TEXTURE_ARGS[@]}"
)
if ! "${DOCKER_CMD[@]}" > /dev/null; then
  echo "docker run failed for globe viewer verification." >&2
  exit 125
fi

viewer_status=124
for ((i=0; i<TIMEOUT_SECONDS; ++i)); do
  docker logs "${CONTAINER_NAME}" > "${LOG_FILE}" 2>&1 || true
  if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
    docker wait "${CONTAINER_NAME}" > "${EXIT_FILE}" 2>/dev/null || true
    viewer_status=$(cat "${EXIT_FILE}" 2>/dev/null || echo 1)
    [ -n "${viewer_status}" ] || viewer_status=1
    break
  fi
  sleep 1
done

docker logs "${CONTAINER_NAME}" > "${LOG_FILE}" 2>&1 || true
if docker ps --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
  echo "[viewer][error] verification_timeout" >> "${LOG_FILE}"
  echo "${viewer_status}" > "${EXIT_FILE}"
fi

CHECK_CMD=(
  python3 "${ROOT_DIR}/scripts/check_viewer_captures.py"
  --output-dir "${OUTPUT_DIR}"
  --baseline-dir "${BASELINE_DIR}"
  --log-file "${LOG_FILE}"
  --contract "${CONTRACT_FILE}"
  --expected-planar false
  --min-rendered-triangles 1
  "${BASELINE_CHECK_ARGS[@]}"
)
"${CHECK_CMD[@]}"
check_status=$?

if [ "${TEXTURE_MODE}" = "tianditu" ] &&
   grep -Fq "${TIANDITU_TOKEN}" "${LOG_FILE}"; then
  echo "Tianditu token leaked into viewer log." >&2
  check_status=1
fi

REPORT_CMD=(
  python3 "${ROOT_DIR}/scripts/render_viewer_baseline_report.py"
  --baseline-dir "${BASELINE_DIR}"
  --output-dir "${OUTPUT_DIR}"
  --report "${OUTPUT_DIR}/report.html"
  --embed-images
)
"${REPORT_CMD[@]}"
report_status=$?

if [ "${viewer_status}" != "0" ] ||
   [ "${check_status}" != "0" ] ||
   [ "${report_status}" != "0" ]; then
  tail -n 200 "${LOG_FILE}" || true
fi

echo "Globe viewer verification finished."
echo "Report: ${OUTPUT_DIR}/report.html"

if [ "${viewer_status}" != "0" ]; then
  exit "${viewer_status}"
fi
if [ "${check_status}" != "0" ]; then
  exit "${check_status}"
fi
exit "${report_status}"
