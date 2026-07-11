#!/bin/bash
set -u

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
BASELINE_DIR=${BASELINE_DIR:-"${ROOT_DIR}/testdata/viewer_baseline/1k"}
OUTPUT_DIR=${OUTPUT_DIR:-"${ROOT_DIR}/viewer_verify_output/1k"}
TIMEOUT_SECONDS=${VIEWER_TIMEOUT_SECONDS:-120}
CONTAINER_NAME=${CONTAINER_NAME:-vic_cbdam_viewer_1k_interaction}
WINDOW_SIZE=${VIEWER_WINDOW_SIZE:-1280x720}
VIEWER_BIN=${VIEWER_BIN:-/wksp/build/cmake/vic_cbdam_viewer}
VIEWER_ELEVATION_PATH=${VIEWER_ELEVATION_PATH:-/workspace/testdata/datasets/ps_1k/reference/terrain}
VIEWER_TEXTURE_PATH=${VIEWER_TEXTURE_PATH:-/workspace/testdata/datasets/ps_1k/reference/texture/victms.xml}

if [ ! -d "${BASELINE_DIR}" ]; then
    echo "Missing baseline directory: ${BASELINE_DIR}" >&2
    exit 2
fi
BASELINE_DIR=$(cd "${BASELINE_DIR}" && pwd)
mkdir -p "${OUTPUT_DIR}"
OUTPUT_DIR=$(cd "${OUTPUT_DIR}" && pwd)
LOG_FILE="${OUTPUT_DIR}/viewer.log"
LOCK_FILE=${LOCK_FILE:-"${OUTPUT_DIR}/viewer_interaction.lock"}
DOCKER_BASELINE_DIR=/viewer-baseline
DOCKER_OUTPUT_DIR=/viewer-output

export DISPLAY=${DISPLAY:-:0}
X11_SOCKET_DIR=/tmp/.X11-unix
if [ -d /mnt/wslg/.X11-unix ]; then
    X11_SOCKET_DIR=/mnt/wslg/.X11-unix
fi

echo "=========================================================="
echo "Starting 1k viewer interaction verification..."
echo "Dataset: 1k PS Terrain & Texture"
echo "Baseline: ${BASELINE_DIR}"
echo "Output: ${OUTPUT_DIR}"
echo "Elevation: ${VIEWER_ELEVATION_PATH}"
echo "Texture: ${VIEWER_TEXTURE_PATH}"
echo "Viewer: ${VIEWER_BIN}"
echo "Window: ${WINDOW_SIZE}"
echo "Timeout: ${TIMEOUT_SECONDS}s"
echo "=========================================================="

if command -v flock &>/dev/null; then
    exec 9>"${LOCK_FILE}"
    flock 9
else
    echo "Warning: flock not available; concurrent viewer interaction runs may interfere." >&2
fi

rm -f "${OUTPUT_DIR}"/*.png "${OUTPUT_DIR}"/state_*.json \
      "${OUTPUT_DIR}/summary.json" "${OUTPUT_DIR}/normalized_log.json" \
      "${OUTPUT_DIR}/report.html" "${OUTPUT_DIR}/viewer.exit" "${LOG_FILE}"

if command -v xhost &>/dev/null; then
    xhost +local:docker > /dev/null 2>&1 || true
fi

docker rm -f "${CONTAINER_NAME}" > /dev/null 2>&1 || true

viewer_status=124
if docker run -d \
    --name "${CONTAINER_NAME}" \
    --user "$(id -u):$(id -g)" \
    --network host \
    -v "${ROOT_DIR}:/workspace" \
    -v "${ROOT_DIR}/workspace_old:/wksp" \
    -v "${BASELINE_DIR}:${DOCKER_BASELINE_DIR}:ro" \
    -v "${OUTPUT_DIR}:${DOCKER_OUTPUT_DIR}" \
    -v "${X11_SOCKET_DIR}:/tmp/.X11-unix" \
    -e DISPLAY="$DISPLAY" \
    -w /workspace \
    "${DOCKER_IMAGE}" \
    "${VIEWER_BIN}" \
    --elevation "${VIEWER_ELEVATION_PATH}" \
    --verify-script "${DOCKER_BASELINE_DIR}/actions.txt" \
    --verify-output-dir "${DOCKER_OUTPUT_DIR}" \
    --verify-exit \
    --verify-window-size "${WINDOW_SIZE}" \
    --verify-log-state \
    "${VIEWER_TEXTURE_PATH}" > /dev/null; then
    for ((i=0; i<TIMEOUT_SECONDS; ++i)); do
        docker logs "${CONTAINER_NAME}" > "${LOG_FILE}" 2>&1 || true
        if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
            docker wait "${CONTAINER_NAME}" > "${OUTPUT_DIR}/viewer.exit" 2>/dev/null || true
            viewer_status=$(cat "${OUTPUT_DIR}/viewer.exit" 2>/dev/null || echo 1)
            if [ -z "${viewer_status}" ]; then
                viewer_status=1
            fi
            break
        fi
        sleep 1
    done

    docker logs "${CONTAINER_NAME}" > "${LOG_FILE}" 2>&1 || true
    if docker ps --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
        echo "Viewer interaction verification timed out." >> "${LOG_FILE}"
        echo "${viewer_status}" > "${OUTPUT_DIR}/viewer.exit"
        docker rm -f "${CONTAINER_NAME}" > /dev/null 2>&1 || true
    else
        docker rm -f "${CONTAINER_NAME}" > /dev/null 2>&1 || true
    fi
else
    viewer_status=125
    echo "${viewer_status}" > "${OUTPUT_DIR}/viewer.exit"
    echo "docker run failed for viewer interaction verification." > "${LOG_FILE}"
fi

python3 "${ROOT_DIR}/scripts/check_viewer_captures.py" \
    --output-dir "${OUTPUT_DIR}" \
    --baseline-dir "${BASELINE_DIR}" \
    --log-file "${LOG_FILE}" \
    --contract "${BASELINE_DIR}/log_contract.json"
check_status=$?

python3 "${ROOT_DIR}/scripts/render_viewer_baseline_report.py" \
    --baseline-dir "${BASELINE_DIR}" \
    --output-dir "${OUTPUT_DIR}" \
    --report "${OUTPUT_DIR}/report.html" \
    --embed-images
report_status=$?

if command -v xhost &>/dev/null; then
    xhost -local:docker > /dev/null 2>&1 || true
fi

if [ "${viewer_status}" != "0" ] || [ "${check_status}" != "0" ] || [ "${report_status}" != "0" ]; then
    tail -n 200 "${LOG_FILE}" || true
fi

echo "=========================================================="
echo "Viewer interaction verification finished."
echo "Report: ${OUTPUT_DIR}/report.html"
echo "=========================================================="

if [ "${viewer_status}" != "0" ]; then
    exit "${viewer_status}"
fi
if [ "${check_status}" != "0" ]; then
    exit "${check_status}"
fi
exit "${report_status}"
