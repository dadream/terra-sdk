#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
ARTIFACT_MANIFEST=${ARTIFACT_MANIFEST:-"${ROOT_DIR}/scripts/cmake_artifacts.tsv"}
INSTALL_STAGE=${INSTALL_STAGE:-"${ROOT_DIR}/viewer_verify_output/cmake_install_stage"}
STAGED_PREFIX_RELATIVE="wksp/output"

INSTALL_STAGE_ABS=$(realpath -m "${INSTALL_STAGE}")
OUTPUT_ROOT_ABS=$(realpath -m "${ROOT_DIR}/viewer_verify_output")
case "${INSTALL_STAGE_ABS}" in
  "${OUTPUT_ROOT_ABS}"/*)
    ;;
  *)
    echo "Refusing install stage outside viewer_verify_output: ${INSTALL_STAGE_ABS}" >&2
    exit 1
    ;;
esac

DOCKER_INSTALL_STAGE="/workspace${INSTALL_STAGE_ABS#"${ROOT_DIR}"}"
STAGED_PREFIX="${INSTALL_STAGE_ABS}/${STAGED_PREFIX_RELATIVE}"
STAGED_LIB_DIR="${STAGED_PREFIX}/lib64"
STAGED_BIN_DIR="${STAGED_PREFIX}/bin"

echo "Checking staged CMake install artifacts..."
echo "Artifact manifest: ${ARTIFACT_MANIFEST}"
echo "Install stage: ${INSTALL_STAGE_ABS}"

ARTIFACT_MANIFEST="${ARTIFACT_MANIFEST}" bash "${ROOT_DIR}/scripts/validate_cmake_artifacts_manifest.sh"

rm -rf "${INSTALL_STAGE_ABS}"
mkdir -p "${INSTALL_STAGE_ABS}"

docker run --rm \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -e CMAKE_INSTALL_STAGE="${DOCKER_INSTALL_STAGE}" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  bash -lc '
    set -euo pipefail
    test -f /wksp/build/cmake/cmake_install.cmake
    DESTDIR="$CMAKE_INSTALL_STAGE" cmake --install /wksp/build/cmake
  '

missing=0
while IFS=$'\t' read -r kind artifact mode extra || [ -n "${kind:-}" ]; do
  case "${kind}" in
    ""|\#*)
      continue
      ;;
    sl|lib|module)
      path="${STAGED_LIB_DIR}/${artifact}"
      ;;
    bin)
      path="${STAGED_BIN_DIR}/${artifact}"
      ;;
  esac

  if [ ! -s "${path}" ]; then
    echo "MISSING or empty installed artifact: ${path}" >&2
    missing=1
    continue
  fi
  if [ "${mode}" = "executable" ] && [ ! -x "${path}" ]; then
    echo "NOT EXECUTABLE: ${path}" >&2
    missing=1
    continue
  fi
  echo "OK installed ${kind}: ${path}"
done < "${ARTIFACT_MANIFEST}"

if [ "${missing}" -ne 0 ]; then
  echo "Staged CMake install artifact check failed." >&2
  exit 1
fi

echo "Staged CMake install artifact check passed."
