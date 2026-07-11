#!/bin/bash
set -uo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
GLOBE_DATA_DIR=${GLOBE_DATA_DIR:-/mnt/s/terra-data/globe}
TEXTURE_MODE=${GLOBE_TEXTURE_MODE:-blue-marble}
OUTPUT_DIR=${OUTPUT_DIR:-"${ROOT_DIR}/viewer_verify_output/globe/nav3d_${TEXTURE_MODE}"}
TIMEOUT_SECONDS=${NAV3D_TIMEOUT_SECONDS:-90}
VERIFY_DELAY_MS=${NAV3D_VERIFY_DELAY_MS:-20000}
WINDOW_SIZE=${NAV3D_WINDOW_SIZE:-1280x720}
NAV3D_BIN=${NAV3D_BIN:-/wksp/build/cmake/vic_ratman_nav3d}
CONTAINER_NAME=${CONTAINER_NAME:-"vic_ratman_nav3d_globe_${TEXTURE_MODE}"}
GEORATMAN_TEMPLATE_DIR=${GEORATMAN_TEMPLATE_DIR:-"${ROOT_DIR}/testdata/nav3d/1k/georatman"}
LOCK_FILE=${LOCK_FILE:-"${ROOT_DIR}/viewer_verify_output/globe/nav3d.lock"}

if [ ! -f "${GLOBE_DATA_DIR}/terrain.xml" ] ||
   [ ! -f "${GLOBE_DATA_DIR}/terrain.data" ]; then
  echo "Missing globe terrain prefix: ${GLOBE_DATA_DIR}/terrain" >&2
  exit 2
fi
if [ ! -d "${GEORATMAN_TEMPLATE_DIR}" ]; then
  echo "Missing nav3d runtime template: ${GEORATMAN_TEMPLATE_DIR}" >&2
  exit 2
fi

DOCKER_ENV_ARGS=()
BASELINE_CHECK_ARGS=()
TEXTURE_CHECK_MODE=tms
case "${TEXTURE_MODE}" in
  blue-marble)
    NAV3D_CONFIG=/workspace/testdata/nav3d/globe/local_blue_marble.xml
    BASELINE_CHECK_ARGS=(
      --baseline "${ROOT_DIR}/testdata/viewer_baseline/globe/nav3d_blue_marble.png"
    )
    if [ ! -f "${GLOBE_DATA_DIR}/blue-marble-global-geodetic/victms.xml" ]; then
      echo "Missing Blue Marble global-geodetic texture." >&2
      exit 2
    fi
    ;;
  tianditu)
    NAV3D_CONFIG=/workspace/testdata/nav3d/globe/tianditu.xml
    if [ -z "${TIANDITU_TOKEN:-}" ]; then
      echo "A server-side TIANDITU_TOKEN is required for native verification." >&2
      exit 2
    fi
    DOCKER_ENV_ARGS=(-e TIANDITU_TOKEN)
    TEXTURE_CHECK_MODE=wmts
    ;;
  *)
    echo "Unsupported GLOBE_TEXTURE_MODE: ${TEXTURE_MODE}" >&2
    exit 2
    ;;
esac

mkdir -p "${OUTPUT_DIR}" "$(dirname "${LOCK_FILE}")"
OUTPUT_DIR=$(cd "${OUTPUT_DIR}" && pwd)
LOG_FILE="${OUTPUT_DIR}/nav3d.log"
CAPTURE_FILE="${OUTPUT_DIR}/nav3d_globe.png"
SUMMARY_FILE="${OUTPUT_DIR}/summary.json"
GEORATMAN_HOST_DIR="${OUTPUT_DIR}/georatman"
GEORATMAN_DOCKER_DIR=/nav-output/georatman/

mkdir -p "${GEORATMAN_HOST_DIR}"
find "${GEORATMAN_HOST_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a "${GEORATMAN_TEMPLATE_DIR}/." "${GEORATMAN_HOST_DIR}/"
rm -f "${LOG_FILE}" "${CAPTURE_FILE}" "${SUMMARY_FILE}"

export DISPLAY=${DISPLAY:-:0}
X11_SOCKET_DIR=/tmp/.X11-unix
if [ -d /mnt/wslg/.X11-unix ]; then
  X11_SOCKET_DIR=/mnt/wslg/.X11-unix
fi

if command -v flock &>/dev/null; then
  exec 9>"${LOCK_FILE}"
  flock 9
fi
if command -v xhost &>/dev/null; then
  xhost +local:docker > /dev/null 2>&1 || true
fi

cleanup() {
  docker rm -f "${CONTAINER_NAME}" > /dev/null 2>&1 || true
  if command -v xhost &>/dev/null; then
    xhost -local:docker > /dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "Starting globe nav3d verification..."
echo "Texture mode: ${TEXTURE_MODE}"
echo "Dataset: ${GLOBE_DATA_DIR}"
echo "Output: ${OUTPUT_DIR}"

docker rm -f "${CONTAINER_NAME}" > /dev/null 2>&1 || true
DOCKER_CMD=(
  docker run --rm
  --user "$(id -u):$(id -g)"
  --network host
  -v "${ROOT_DIR}:/workspace"
  -v "${ROOT_DIR}/workspace_old:/wksp"
  -v "${GLOBE_DATA_DIR}:/globe:ro"
  --name "${CONTAINER_NAME}"
  -v "${OUTPUT_DIR}:/nav-output"
  -v "${X11_SOCKET_DIR}:/tmp/.X11-unix"
  -e DISPLAY="${DISPLAY}"
  -e GEORATMAN_DIR="${GEORATMAN_DOCKER_DIR}"
  "${DOCKER_ENV_ARGS[@]}"
  -w /workspace
  "${DOCKER_IMAGE}"
  "${NAV3D_BIN}"
  --home_url "${NAV3D_CONFIG}"
  --verify-output /nav-output/nav3d_globe.png
  --verify-delay-ms "${VERIFY_DELAY_MS}"
  --verify-window-size "${WINDOW_SIZE}"
)
timeout "${TIMEOUT_SECONDS}s" "${DOCKER_CMD[@]}" > "${LOG_FILE}" 2>&1
nav3d_status=$?

CHECK_CMD=(
  python3 "${ROOT_DIR}/scripts/check_nav3d_capture.py"
  --capture "${CAPTURE_FILE}"
  --log-file "${LOG_FILE}"
  --summary "${SUMMARY_FILE}"
  --texture-mode "${TEXTURE_CHECK_MODE}"
  "${BASELINE_CHECK_ARGS[@]}"
)
"${CHECK_CMD[@]}"
check_status=$?

if [ "${TEXTURE_MODE}" = "tianditu" ] &&
   grep -Fq "${TIANDITU_TOKEN}" "${LOG_FILE}"; then
  echo "Tianditu token leaked into nav3d log." >&2
  check_status=1
fi

if [ "${nav3d_status}" -ne 0 ] || [ "${check_status}" -ne 0 ]; then
  tail -n 200 "${LOG_FILE}" || true
fi

echo "Globe nav3d verification finished."
echo "Capture: ${CAPTURE_FILE}"
echo "Summary: ${SUMMARY_FILE}"

if [ "${nav3d_status}" -ne 0 ]; then
  exit "${nav3d_status}"
fi
exit "${check_status}"
