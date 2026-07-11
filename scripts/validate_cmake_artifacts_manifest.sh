#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
ARTIFACT_MANIFEST=${ARTIFACT_MANIFEST:-"${ROOT_DIR}/scripts/cmake_artifacts.tsv"}

if [ ! -f "${ARTIFACT_MANIFEST}" ]; then
  echo "MISSING artifact manifest: ${ARTIFACT_MANIFEST}" >&2
  exit 1
fi

declare -A seen_artifacts=()
row_count=0
error_count=0
line_no=0

while IFS=$'\t' read -r kind artifact mode extra || [ -n "${kind:-}" ]; do
  line_no=$((line_no + 1))
  case "${kind}" in
    ""|\#*)
      continue
      ;;
  esac

  if [ -n "${extra:-}" ] || [ -z "${artifact:-}" ] || [ -z "${mode:-}" ]; then
    echo "INVALID row ${line_no}: expected kind, artifact, mode" >&2
    error_count=$((error_count + 1))
    continue
  fi

  case "${kind}" in
    sl|lib|bin|module)
      ;;
    *)
      echo "INVALID row ${line_no}: unknown kind '${kind}'" >&2
      error_count=$((error_count + 1))
      ;;
  esac

  case "${mode}" in
    file|executable)
      ;;
    *)
      echo "INVALID row ${line_no}: unknown mode '${mode}'" >&2
      error_count=$((error_count + 1))
      ;;
  esac

  if [[ "${artifact}" == */* ]] || [[ "${artifact}" == *..* ]]; then
    echo "INVALID row ${line_no}: artifact must be a filename, got '${artifact}'" >&2
    error_count=$((error_count + 1))
  fi

  if [ "${kind}" = "sl" ] && { [ "${artifact}" != "libsl.a" ] || [ "${mode}" != "file" ]; }; then
    echo "INVALID row ${line_no}: sl entry must be 'sl<TAB>libsl.a<TAB>file'" >&2
    error_count=$((error_count + 1))
  fi

  key="${kind}:${artifact}"
  if [ -n "${seen_artifacts[${key}]:-}" ]; then
    echo "INVALID row ${line_no}: duplicate artifact '${key}'" >&2
    error_count=$((error_count + 1))
  else
    seen_artifacts["${key}"]="${line_no}"
  fi
  row_count=$((row_count + 1))
done < "${ARTIFACT_MANIFEST}"

if [ "${row_count}" -eq 0 ]; then
  echo "INVALID artifact manifest: no artifact rows found" >&2
  exit 1
fi
if [ "${error_count}" -ne 0 ]; then
  echo "Artifact manifest validation failed: ${error_count} error(s)." >&2
  exit 1
fi

echo "Artifact manifest validation passed: ${row_count} artifact row(s)."
