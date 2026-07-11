#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
OUTPUT_SUBDIR=${OUTPUT_SUBDIR:-viewer_verify_output/builders/1k_rebuild_viewer}
REBUILD_OUTPUT_SUBDIR=${REBUILD_OUTPUT_SUBDIR:-viewer_verify_output/builders/1k_rebuild_for_viewer}
OUTPUT_DIR="${ROOT_DIR}/${OUTPUT_SUBDIR}"

VIEWER_TIMEOUT_SECONDS=${VIEWER_TIMEOUT_SECONDS:-25}
VIEWER_BIN=${VIEWER_BIN:-/wksp/build/cmake/vic_cbdam_viewer}

mkdir -p "${OUTPUT_DIR}"

echo "=========================================================="
echo "Starting builder rebuild viewer smoke verification..."
echo "Rebuild output: ${ROOT_DIR}/${REBUILD_OUTPUT_SUBDIR}"
echo "Smoke output: ${OUTPUT_DIR}"
echo "Timeout: ${VIEWER_TIMEOUT_SECONDS}s"
echo "=========================================================="

OUTPUT_SUBDIR="${REBUILD_OUTPUT_SUBDIR}" \
    bash "${ROOT_DIR}/scripts/verify_builder_1k_rebuild.sh"

RUN_DIR_FILE="${ROOT_DIR}/${REBUILD_OUTPUT_SUBDIR}/latest_run.txt"
if [ ! -s "${RUN_DIR_FILE}" ]; then
    echo "Missing builder rebuild run marker: ${RUN_DIR_FILE}" >&2
    exit 1
fi

RUN_DIR=$(cat "${RUN_DIR_FILE}")
EXPECTED_PREFIX="${ROOT_DIR}/${REBUILD_OUTPUT_SUBDIR}/run."
case "${RUN_DIR}" in
    "${EXPECTED_PREFIX}"*)
        ;;
    *)
        echo "Unexpected builder rebuild run directory: ${RUN_DIR}" >&2
        echo "Expected prefix: ${EXPECTED_PREFIX}" >&2
        exit 1
        ;;
esac

RUN_NAME=$(basename "${RUN_DIR}")
DOCKER_RUN_DIR="/workspace/${REBUILD_OUTPUT_SUBDIR}/${RUN_NAME}"

echo "Using rebuilt dataset: ${RUN_DIR}"

env \
    VIEWER_BIN="${VIEWER_BIN}" \
    VIEWER_ELEVATION_PATH="${DOCKER_RUN_DIR}/dataset/terrain" \
    VIEWER_TEXTURE_PATH="${DOCKER_RUN_DIR}/dataset/texture/victms.xml" \
    VIEWER_TIMEOUT_SECONDS="${VIEWER_TIMEOUT_SECONDS}" \
    LOG_FILE="${OUTPUT_DIR}/viewer_rebuild_smoke.log" \
    CONTAINER_NAME=vic_cbdam_viewer_builder_rebuild_smoke \
    bash "${ROOT_DIR}/scripts/verify_viewer_1k_smoke.sh"

echo "Builder rebuild viewer smoke passed: CMake viewer loaded rebuilt outputs."
