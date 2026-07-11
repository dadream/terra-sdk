#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
OUTPUT_SUBDIR=${OUTPUT_SUBDIR:-viewer_verify_output/builders}
OUTPUT_DIR="${ROOT_DIR}/${OUTPUT_SUBDIR}"

GEO_BUILDER_BIN=${GEO_BUILDER_BIN:-/wksp/build/cmake/vic_geo_raster_quadtree_builder}
CBDAM_BUILDER_BIN=${CBDAM_BUILDER_BIN:-/wksp/build/cmake/vic_cbdam_mpi_builder}

mkdir -p "${OUTPUT_DIR}"

echo "=========================================================="
echo "Starting builder CLI smoke verification..."
echo "Output directory: ${OUTPUT_DIR}"
echo "=========================================================="

docker run --rm \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -e PREFIX=/wksp/output \
  -e LD_LIBRARY_PATH=/wksp/output/lib:/wksp/output/lib64 \
  -e BUILDER_OUTPUT_DIR="/workspace/${OUTPUT_SUBDIR}" \
  -e GEO_BUILDER_BIN="${GEO_BUILDER_BIN}" \
  -e CBDAM_BUILDER_BIN="${CBDAM_BUILDER_BIN}" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  bash -lc '
    set -euo pipefail

    check_noarg() {
      local label=$1
      local bin=$2
      local expected_status=$3
      local expected_pattern=$4
      local log_file="${BUILDER_OUTPUT_DIR}/${label}.log"
      local exit_file="${BUILDER_OUTPUT_DIR}/${label}.exit"

      if [ ! -x "${bin}" ]; then
        echo "Missing executable ${bin}" >&2
        return 1
      fi

      set +e
      "${bin}" > "${log_file}" 2>&1
      local status=$?
      set -e
      echo "${status}" > "${exit_file}"

      if [ "${status}" != "${expected_status}" ]; then
        echo "${label}: expected exit ${expected_status}, got ${status}" >&2
        cat "${log_file}" >&2
        return 1
      fi
      if ! grep -q "${expected_pattern}" "${log_file}"; then
        echo "${label}: expected log marker not found: ${expected_pattern}" >&2
        cat "${log_file}" >&2
        return 1
      fi
      echo "${label}: exit ${status}, marker matched: ${expected_pattern}"
    }

    check_geo_create() {
      local label=$1
      local bin=$2
      local create_root=$3
      local base_dir="${create_root}/${label}"
      local tree_name="texture"
      local tree_dir="${base_dir}/${tree_name}"
      local config_file="${tree_dir}/victms.xml"
      local log_file="${BUILDER_OUTPUT_DIR}/${label}_create.log"
      local exit_file="${BUILDER_OUTPUT_DIR}/${label}_create.exit"

      mkdir -p "${base_dir}"

      set +e
      "${bin}" \
        --create \
        --quadtree-base-dir "${base_dir}" \
        --quadtree-name "${tree_name}" \
        --quadtree-profile none \
        --quadtree-srs EPSG:4326 \
        --quadtree-u0 10 \
        --quadtree-v0 20 \
        --quadtree-u1 30 \
        --quadtree-v1 40 \
        --quadtree-nu 1 \
        --quadtree-nv 1 \
        --quadtree-img-width 64 \
        --quadtree-img-height 32 \
        --quadtree-img-format PNG \
        > "${log_file}" 2>&1
      local status=$?
      set -e
      echo "${status}" > "${exit_file}"

      if [ "${status}" != "0" ]; then
        echo "${label} create: expected exit 0, got ${status}" >&2
        cat "${log_file}" >&2
        return 1
      fi
      if [ ! -f "${config_file}" ]; then
        echo "${label} create: missing ${config_file}" >&2
        cat "${log_file}" >&2
        return 1
      fi
      if ! grep -q "<victms>" "${config_file}" || \
         ! grep -q "EPSG:4326" "${config_file}" || \
         ! grep -q "image/png" "${config_file}"; then
        echo "${label} create: generated victms.xml is missing expected markers" >&2
        cat "${config_file}" >&2
        return 1
      fi

      echo "${label} create: generated ${config_file}"
    }

    check_noarg geo_builder "${GEO_BUILDER_BIN}" 1 "Select --create or --update"
    check_noarg cbdam_mpi_builder "${CBDAM_BUILDER_BIN}" 2 "Missing input file name"

    create_root=$(mktemp -d "${BUILDER_OUTPUT_DIR}/geo_create.XXXXXX")
    check_geo_create geo_builder "${GEO_BUILDER_BIN}" "${create_root}"
  '

echo "Builder CLI smoke passed: CMake builder argument handling and create output validated."
