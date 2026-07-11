#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
OUTPUT_SUBDIR=${OUTPUT_SUBDIR:-viewer_verify_output/builders/1k_rebuild}
OUTPUT_DIR="${ROOT_DIR}/${OUTPUT_SUBDIR}"
mkdir -p "${OUTPUT_DIR}"
RUN_DIR=$(mktemp -d "${OUTPUT_DIR}/run.XXXXXX")
printf "%s\n" "${RUN_DIR}" > "${OUTPUT_DIR}/latest_run.txt"

GEO_BUILDER_BIN=${GEO_BUILDER_BIN:-/wksp/build/cmake/vic_geo_raster_quadtree_builder}
CBDAM_BUILDER_BIN=${CBDAM_BUILDER_BIN:-/wksp/build/cmake/vic_cbdam_mpi_builder}

echo "=========================================================="
echo "Starting 1k builder rebuild verification..."
echo "Run directory: ${RUN_DIR}"
echo "=========================================================="

docker run --rm \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -e PREFIX=/wksp/output \
  -e LD_LIBRARY_PATH=/wksp/output/lib:/wksp/output/lib64 \
  -e BUILDER_RUN_DIR="/workspace/${OUTPUT_SUBDIR}/$(basename "${RUN_DIR}")" \
  -e GEO_BUILDER_BIN="${GEO_BUILDER_BIN}" \
  -e CBDAM_BUILDER_BIN="${CBDAM_BUILDER_BIN}" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  bash -lc '
    set -euo pipefail

    build_dataset() {
      local label=$1
      local cbdam_bin=$2
      local geo_bin=$3
      local out_dir="${BUILDER_RUN_DIR}/${label}"
      local tmp_dir="${BUILDER_RUN_DIR}/${label}_tmp"
      local terrain_log="${BUILDER_RUN_DIR}/${label}_terrain.log"
      local texture_log="${BUILDER_RUN_DIR}/${label}_texture.log"

      mkdir -p "${out_dir}" "${tmp_dir}"

      "${cbdam_bin}" \
        --tmp-dir "${tmp_dir}" \
        --planar \
        --patch-dim 64 \
        --height-scale 0.00625 \
        --tolerance 0 \
        --output-file "${out_dir}/terrain" \
        --pattern ps_height_1k.png \
        /workspace/testdata/datasets/ps_1k/source \
        > "${terrain_log}" 2>&1

      "${geo_bin}" \
        --create \
        --quadtree-base-dir "${out_dir}" \
        --quadtree-name texture \
        --quadtree-profile none \
        --quadtree-srs EPSG:4326 \
        --quadtree-u0 0 \
        --quadtree-v0 0 \
        --quadtree-u1 1024 \
        --quadtree-v1 1024 \
        --quadtree-nu 1 \
        --quadtree-nv 1 \
        > "${texture_log}" 2>&1

      "${geo_bin}" \
        --update \
        --quadtree-dir "${out_dir}/texture" \
        --input-tiles-default-srs EPSG:4326 \
        --input-tiles-directory /workspace/testdata/datasets/ps_1k/source \
        --input-tiles-pattern ps_texture_1k.png \
        >> "${texture_log}" 2>&1

      for required_file in \
        "${out_dir}/terrain.xml" \
        "${out_dir}/terrain.root" \
        "${out_dir}/terrain.data" \
        "${out_dir}/texture/victms.xml"; do
        if [ ! -s "${required_file}" ]; then
          echo "${label}: missing or empty ${required_file}" >&2
          return 1
        fi
      done

      if ! grep -q "Planar" "${out_dir}/terrain.xml" && \
         ! grep -q "planar" "${out_dir}/terrain.xml"; then
        echo "${label}: terrain.xml is missing planar marker" >&2
        cat "${out_dir}/terrain.xml" >&2
        return 1
      fi
      if ! grep -q "EPSG:4326" "${out_dir}/texture/victms.xml"; then
        echo "${label}: texture/victms.xml is missing EPSG:4326" >&2
        cat "${out_dir}/texture/victms.xml" >&2
        return 1
      fi

      echo "${label}: rebuilt 1k terrain and texture metadata"
    }

    build_dataset dataset "${CBDAM_BUILDER_BIN}" "${GEO_BUILDER_BIN}"

    echo "1k builder rebuild passed."
  '

echo "1k builder rebuild verification passed."
