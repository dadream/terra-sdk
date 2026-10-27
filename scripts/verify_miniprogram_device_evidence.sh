#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
EVIDENCE_DIR=${MINIPROGRAM_EVIDENCE_DIR:-"${ROOT_DIR}/testdata/miniprogram/evidence/local"}
MILESTONES=${MINIPROGRAM_EVIDENCE_MILESTONES:-M1,M6,M7}

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required for Mini Program device evidence validation." >&2
  exit 2
fi

args=(
  --evidence-dir "${EVIDENCE_DIR}"
  --milestones "${MILESTONES}"
)
args+=("$@")

exec python3 "${ROOT_DIR}/scripts/verify_miniprogram_device_evidence.py" \
  "${args[@]}"
