#!/bin/bash
set -uo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
TIMEOUT_SECONDS=${NAV3D_TIMEOUT_SECONDS:-45}
POST_LOAD_SECONDS=${NAV3D_POST_LOAD_SECONDS:-3}
MAX_LOG_LINES=${NAV3D_MAX_LOG_LINES:-300}
LOG_FILE=${LOG_FILE:-"${ROOT_DIR}/viewer_verify_output/nav3d/nav3d_1k_smoke.log"}
EXIT_FILE=${EXIT_FILE:-"${LOG_FILE%.log}.exit"}
CONTAINER_NAME=${CONTAINER_NAME:-vic_ratman_nav3d_1k_smoke}
NAV3D_BIN=${NAV3D_BIN:-/wksp/build/cmake/vic_ratman_nav3d}
NAV3D_CONFIG=${NAV3D_CONFIG:-/workspace/testdata/nav3d/1k/local_1k.xml}
NAV3D_GEORATMAN_DIR=${NAV3D_GEORATMAN_DIR:-"/workspace/viewer_verify_output/nav3d/georatman_${CONTAINER_NAME}/"}
NAV3D_GEORATMAN_TEMPLATE_DIR=${NAV3D_GEORATMAN_TEMPLATE_DIR:-"${ROOT_DIR}/testdata/nav3d/1k/georatman"}
LOCK_FILE=${LOCK_FILE:-"${ROOT_DIR}/viewer_verify_output/nav3d/nav3d_smoke.lock"}

export DISPLAY=${DISPLAY:-:0}
X11_SOCKET_DIR=/tmp/.X11-unix
if [ -d /mnt/wslg/.X11-unix ]; then
  X11_SOCKET_DIR=/mnt/wslg/.X11-unix
fi

mkdir -p "$(dirname "${LOG_FILE}")" "$(dirname "${LOCK_FILE}")"
rm -f "${LOG_FILE}" "${EXIT_FILE}"

NAV3D_OUTPUT_ROOT=$(realpath -m "${ROOT_DIR}/viewer_verify_output/nav3d")
NAV3D_GEORATMAN_HOST_DIR=
case "${NAV3D_GEORATMAN_DIR}" in
  /workspace/viewer_verify_output/nav3d/georatman_*)
    candidate="${ROOT_DIR}${NAV3D_GEORATMAN_DIR#/workspace}"
    candidate=$(realpath -m "${candidate}")
    case "${candidate}" in
      "${NAV3D_OUTPUT_ROOT}"/*)
        NAV3D_GEORATMAN_HOST_DIR="${candidate}"
        ;;
      *)
        echo "Refusing GEORATMAN_DIR outside nav3d output: ${candidate}" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "NAV3D_GEORATMAN_DIR must use the isolated output prefix." >&2
    exit 1
    ;;
esac

if [ ! -d "${NAV3D_GEORATMAN_TEMPLATE_DIR}" ]; then
  echo "Missing GEORATMAN template: ${NAV3D_GEORATMAN_TEMPLATE_DIR}" >&2
  exit 1
fi
mkdir -p "${NAV3D_GEORATMAN_HOST_DIR}"
find "${NAV3D_GEORATMAN_HOST_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a "${NAV3D_GEORATMAN_TEMPLATE_DIR}/." "${NAV3D_GEORATMAN_HOST_DIR}/"

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

has_failure_marker() {
  grep -Eq '^\[(nav3d|terrain)\]\[error\]|^\[terrain\]\[warning\]|connected=false|OpenGL.*(failed|unsupported)|Segmentation fault|Aborted|qFatal' "${LOG_FILE}"
}

has_required_markers() {
  grep -Fq "[nav3d] process_started" "${LOG_FILE}" &&
  grep -Fq "[nav3d] config_loaded url=${NAV3D_CONFIG}" "${LOG_FILE}" &&
  grep -Fq "[terrain] repository_opened url=" "${LOG_FILE}" &&
  grep -Fq "[terrain] geometry_root_ready connected=true" "${LOG_FILE}" &&
  grep -Fq "[terrain] texture_source_connected url=" "${LOG_FILE}" &&
  grep -Fq "[terrain] texture_root_ready count=" "${LOG_FILE}" &&
  grep -Eq '^\[nav3d\] texture_layers_ready base_count=[1-9][0-9]*' "${LOG_FILE}" &&
  grep -Fq "[nav3d] terrain_ready" "${LOG_FILE}" &&
  grep -Fq "[nav3d] update_thread_started" "${LOG_FILE}" &&
  grep -Fq "[nav3d] renderer_initialized" "${LOG_FILE}" &&
  grep -Fq "[nav3d] ui_ready" "${LOG_FILE}"
}

container_is_running() {
  docker ps --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"
}

echo "Starting 1k nav3d smoke verification..."
echo "Nav3D: ${NAV3D_BIN}"
echo "Timeout: ${TIMEOUT_SECONDS}s; log budget: ${MAX_LOG_LINES} lines"

docker rm -f "${CONTAINER_NAME}" > /dev/null 2>&1 || true
if ! docker run -d \
  --name "${CONTAINER_NAME}" \
  --user "$(id -u):$(id -g)" \
  --network host \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -v "${X11_SOCKET_DIR}:/tmp/.X11-unix" \
  -e DISPLAY="$DISPLAY" \
  -e GEORATMAN_DIR="${NAV3D_GEORATMAN_DIR}" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  "${NAV3D_BIN}" \
  --home_url "${NAV3D_CONFIG}" > /dev/null; then
  echo "docker run failed for nav3d smoke verification." >&2
  exit 125
fi

nav3d_status=1
ready_seen_at=-1
for ((i=0; i<TIMEOUT_SECONDS; ++i)); do
  docker logs "${CONTAINER_NAME}" > "${LOG_FILE}" 2>&1 || true
  if has_failure_marker; then
    break
  fi
  if has_required_markers && container_is_running; then
    if [ "${ready_seen_at}" -lt 0 ]; then
      ready_seen_at=${i}
    fi
    if (( i - ready_seen_at >= POST_LOAD_SECONDS )); then
      nav3d_status=0
      break
    fi
  fi
  if ! container_is_running; then
    break
  fi
  sleep 1
done

docker logs "${CONTAINER_NAME}" > "${LOG_FILE}" 2>&1 || true
line_count=$(wc -l < "${LOG_FILE}")
if [ "${line_count}" -gt "${MAX_LOG_LINES}" ]; then
  echo "Nav3D log budget exceeded: ${line_count} > ${MAX_LOG_LINES}" >&2
  nav3d_status=1
fi
if grep -Eq 'TRACE\(-1\): URL:|HTTP error: curlcode=|^\[DEBUG\]|#{8,}|Group Active|START REAL RUN|=== BEGIN TERRAIN' "${LOG_FILE}"; then
  echo "Nav3D log contains a retired spam pattern." >&2
  nav3d_status=1
fi
if has_failure_marker; then
  nav3d_status=1
fi
if ! container_is_running; then
  echo "Nav3D exited before the smoke stability window completed." >&2
  nav3d_status=1
fi

echo "${nav3d_status}" > "${EXIT_FILE}"
cat "${LOG_FILE}"
if [ "${nav3d_status}" -eq 0 ]; then
  echo "Nav3D smoke passed: terrain, texture, update thread, UI, and renderer are ready."
else
  echo "Nav3D smoke verification failed." >&2
fi
exit "${nav3d_status}"
