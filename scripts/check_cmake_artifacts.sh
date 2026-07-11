#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
ARTIFACT_MANIFEST=${ARTIFACT_MANIFEST:-"${ROOT_DIR}/scripts/cmake_artifacts.tsv"}
CMAKE_BUILD_DIR=${CMAKE_BUILD_DIR:-"${ROOT_DIR}/workspace_old/build/cmake"}
CMAKE_ARTIFACT_REGISTRY=${CMAKE_ARTIFACT_REGISTRY:-"${CMAKE_BUILD_DIR}/terra_sdk_cmake_artifacts.tsv"}
CMAKE_SL_LIB=${CMAKE_SL_LIB:-"${CMAKE_BUILD_DIR}/spacelib/src/sl/libsl.a"}

echo "Checking CMake build artifacts..."
echo "Artifact manifest: ${ARTIFACT_MANIFEST}"
echo "Artifact registry: ${CMAKE_ARTIFACT_REGISTRY}"
echo "Build directory: ${CMAKE_BUILD_DIR}"

ARTIFACT_MANIFEST="${ARTIFACT_MANIFEST}" bash "${ROOT_DIR}/scripts/validate_cmake_artifacts_manifest.sh"

if [ ! -f "${CMAKE_ARTIFACT_REGISTRY}" ]; then
  echo "MISSING CMake artifact registry: ${CMAKE_ARTIFACT_REGISTRY}" >&2
  exit 1
fi

tmp_dir=$(mktemp -d)
trap 'rm -rf "${tmp_dir}"' EXIT
grep -v -E '^[[:space:]]*(#|$)' "${ARTIFACT_MANIFEST}" | sort > "${tmp_dir}/manifest"
grep -v -E '^[[:space:]]*(#|$)' "${CMAKE_ARTIFACT_REGISTRY}" | sort > "${tmp_dir}/registry"
if ! diff -u "${tmp_dir}/manifest" "${tmp_dir}/registry"; then
  echo "CMake artifact registry does not match the manifest." >&2
  exit 1
fi

missing=0
while IFS=$'\t' read -r kind artifact mode extra || [ -n "${kind:-}" ]; do
  case "${kind}" in
    ""|\#*)
      continue
      ;;
    sl)
      path="${CMAKE_SL_LIB}"
      ;;
    lib|bin|module)
      path="${CMAKE_BUILD_DIR}/${artifact}"
      ;;
  esac

  if [ ! -s "${path}" ]; then
    echo "MISSING or empty CMake artifact: ${path}" >&2
    missing=1
    continue
  fi
  if [ "${mode}" = "executable" ] && [ ! -x "${path}" ]; then
    echo "NOT EXECUTABLE: ${path}" >&2
    missing=1
    continue
  fi
  echo "OK ${kind}: ${path}"
done < "${ARTIFACT_MANIFEST}"

if [ "${missing}" -ne 0 ]; then
  echo "CMake build artifact check failed." >&2
  exit 1
fi

echo "CMake build artifact check passed."
