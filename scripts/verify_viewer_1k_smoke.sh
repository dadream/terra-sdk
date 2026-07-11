#!/bin/bash
set -uo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
TIMEOUT_SECONDS=${VIEWER_TIMEOUT_SECONDS:-25}
MAX_LOG_LINES=${VIEWER_MAX_LOG_LINES:-200}
LOG_FILE=${LOG_FILE:-"${ROOT_DIR}/viewer_verify_output/viewer/viewer_1k_smoke.log"}
CONTAINER_NAME=${CONTAINER_NAME:-vic_cbdam_viewer_1k_smoke}
VIEWER_BIN=${VIEWER_BIN:-/wksp/build/cmake/vic_cbdam_viewer}
VIEWER_ELEVATION_PATH=${VIEWER_ELEVATION_PATH:-/workspace/testdata/datasets/ps_1k/reference/terrain}
VIEWER_TEXTURE_PATH=${VIEWER_TEXTURE_PATH:-/workspace/testdata/datasets/ps_1k/reference/texture/victms.xml}

export DISPLAY=${DISPLAY:-:0}
X11_SOCKET_DIR=/tmp/.X11-unix
if [ -d /mnt/wslg/.X11-unix ]; then
  X11_SOCKET_DIR=/mnt/wslg/.X11-unix
fi

mkdir -p "$(dirname "${LOG_FILE}")"
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
  grep -Eq '^\[(viewer|terrain)\]\[(error|warning)\]|connected=false|OpenGL.*(failed|unsupported)|Segmentation fault|Aborted|qFatal' "${LOG_FILE}"
}

has_required_markers() {
  grep -Fq "[viewer] process_started" "${LOG_FILE}" &&
  grep -Fq "[viewer] terrain_connected projection=" "${LOG_FILE}" &&
  grep -Fq "[viewer] update_thread_started" "${LOG_FILE}" &&
  grep -Fq "[viewer] texture_layer_connected url=${VIEWER_TEXTURE_PATH}" "${LOG_FILE}" &&
  grep -Fq "[viewer] opengl_initialized" "${LOG_FILE}" &&
  grep -Fq "[viewer] initial_camera_set position=" "${LOG_FILE}"
}

container_is_running() {
  docker ps --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"
}

echo "Starting 1k viewer smoke verification..."
echo "Viewer: ${VIEWER_BIN}"
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
  -w /workspace \
  "${DOCKER_IMAGE}" \
  "${VIEWER_BIN}" \
  --elevation "${VIEWER_ELEVATION_PATH}" \
  "${VIEWER_TEXTURE_PATH}" > /dev/null; then
  echo "docker run failed for viewer smoke verification." >&2
  exit 125
fi

viewer_status=1
for ((i=0; i<TIMEOUT_SECONDS; ++i)); do
  docker logs "${CONTAINER_NAME}" > "${LOG_FILE}" 2>&1 || true
  if has_failure_marker; then
    break
  fi
  if has_required_markers && container_is_running; then
    viewer_status=0
    break
  fi
  if ! container_is_running; then
    break
  fi
  sleep 1
done

docker logs "${CONTAINER_NAME}" > "${LOG_FILE}" 2>&1 || true
line_count=$(wc -l < "${LOG_FILE}")
if [ "${line_count}" -gt "${MAX_LOG_LINES}" ]; then
  echo "Viewer log budget exceeded: ${line_count} > ${MAX_LOG_LINES}" >&2
  viewer_status=1
fi
if grep -Eq 'TRACE\(-1\): URL:|HTTP error: curlcode=|^\[DEBUG\]|^mouse:|^keyboard:' "${LOG_FILE}"; then
  echo "Viewer log contains a retired spam pattern." >&2
  viewer_status=1
fi
if has_failure_marker; then
  viewer_status=1
fi

cat "${LOG_FILE}"
if [ "${viewer_status}" -eq 0 ]; then
  echo "Viewer smoke passed: terrain, texture, update thread, OpenGL, and camera are ready."
else
  echo "Viewer smoke verification failed." >&2
fi
exit "${viewer_status}"
