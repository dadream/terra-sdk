#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
MANIFEST="${ROOT_DIR}/testdata/miniprogram/desktop_oracle_manifest.txt"

if [ ! -f "${MANIFEST}" ]; then
  echo "Missing desktop oracle manifest: ${MANIFEST}" >&2
  exit 2
fi

failure=0
baseline_commit=""

while read -r kind expected path; do
  if [ -z "${kind}" ] || [ "${kind:0:1}" = "#" ]; then
    continue
  fi

  case "${kind}" in
    baseline)
      baseline_commit="${expected}"
      if ! git -C "${ROOT_DIR}" cat-file -e "${baseline_commit}^{commit}" 2>/dev/null; then
        echo "Desktop oracle baseline commit is unavailable: ${baseline_commit}" >&2
        failure=1
      fi
      continue
      ;;
    tree|blob)
      ;;
    *)
      echo "Unknown desktop oracle manifest kind: ${kind}" >&2
      failure=1
      continue
      ;;
  esac

  actual=$(git -C "${ROOT_DIR}" rev-parse "HEAD:${path}" 2>/dev/null || true)
  if [ "${actual}" != "${expected}" ]; then
    echo "Desktop oracle changed at ${path}" >&2
    echo "  expected ${expected}" >&2
    echo "  actual   ${actual:-missing}" >&2
    failure=1
  fi

  if ! git -C "${ROOT_DIR}" diff --quiet -- "${path}" ||
     ! git -C "${ROOT_DIR}" diff --cached --quiet -- "${path}"; then
    echo "Desktop oracle has uncommitted changes at ${path}" >&2
    git -C "${ROOT_DIR}" status --short -- "${path}" >&2
    failure=1
  fi

  untracked=$(git -C "${ROOT_DIR}" ls-files --others --exclude-standard -- "${path}")
  if [ -n "${untracked}" ]; then
    echo "Desktop oracle has untracked files at ${path}:" >&2
    echo "${untracked}" >&2
    failure=1
  fi
done < "${MANIFEST}"

if [ -z "${baseline_commit}" ]; then
  echo "Desktop oracle manifest does not declare a baseline commit." >&2
  failure=1
elif ! git -C "${ROOT_DIR}" merge-base --is-ancestor "${baseline_commit}" HEAD; then
  echo "HEAD does not descend from desktop oracle ${baseline_commit}." >&2
  failure=1
fi

if [ "${failure}" -ne 0 ]; then
  exit 1
fi

echo "Desktop oracle unchanged from ${baseline_commit}."
