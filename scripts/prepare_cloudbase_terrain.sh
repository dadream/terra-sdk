#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
BUILD_DIR="${ROOT_DIR}/workspace_old/build/cmake"
SERVICE_BIN="${BUILD_DIR}/terra_terrain_service"
TEMPLATE_DIR="${ROOT_DIR}/deploy/cloudbase/terrain"
STAGING_ROOT="${ROOT_DIR}/viewer_verify_output/cloudbase/staging"

if [ ! -x "${SERVICE_BIN}" ]; then
  echo "Missing terrain service binary: ${SERVICE_BIN}" >&2
  echo "Run scripts/build_cmake.sh first." >&2
  exit 2
fi
if ldd "${SERVICE_BIN}" | grep -q 'not found'; then
  echo "Terrain service has unresolved runtime libraries." >&2
  ldd "${SERVICE_BIN}" >&2
  exit 1
fi

mkdir -p "${STAGING_ROOT}"
for profile in ps-1k globe; do
  target="${STAGING_ROOT}/terra-terrain-${profile}"
  target_abs=$(realpath -m "${target}")
  case "${target_abs}" in
    "${STAGING_ROOT}"/*) ;;
    *)
      echo "Refusing to clean deployment context outside staging root." >&2
      exit 1
      ;;
  esac
  rm -rf "${target_abs}"
  mkdir -p "${target_abs}"
  target="${target_abs}"
  cp "${TEMPLATE_DIR}/Dockerfile" "${target}/Dockerfile"
  cp "${TEMPLATE_DIR}/entrypoint.sh" "${target}/entrypoint.sh"
  cp "${TEMPLATE_DIR}/${profile}.args" "${target}/service.args"
  cp "${SERVICE_BIN}" "${target}/terra_terrain_service"
  chmod 0755 "${target}/entrypoint.sh" "${target}/terra_terrain_service"
  (
    cd "${target}"
    sha256sum Dockerfile entrypoint.sh service.args terra_terrain_service \
      > artifact.sha256
  )
done

echo "CloudBase terrain deployment contexts prepared:"
echo "  ${STAGING_ROOT}/terra-terrain-ps-1k"
echo "  ${STAGING_ROOT}/terra-terrain-globe"
