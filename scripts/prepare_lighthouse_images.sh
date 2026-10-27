#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
TAG=${1:-$(date -u +%Y%m%d%H%M%S)}
OUTPUT_DIR="${ROOT_DIR}/viewer_verify_output/lighthouse"
STAGING_ROOT="${ROOT_DIR}/viewer_verify_output/cloudbase/staging"
BUNDLE="${OUTPUT_DIR}/terra-images-${TAG}.tar.gz"

if [[ ! "${TAG}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid image tag: ${TAG}" >&2
  exit 2
fi

"${ROOT_DIR}/scripts/prepare_cloudbase_terrain.sh"
mkdir -p "${OUTPUT_DIR}"

docker build -t "terra/terrain-1k:${TAG}"   "${STAGING_ROOT}/terra-terrain-ps-1k"
docker build -t "terra/terrain-globe:${TAG}"   "${STAGING_ROOT}/terra-terrain-globe"
docker build -t "terra/imagery:${TAG}"   "${ROOT_DIR}/deploy/cloudbase/imagery"

docker save   "terra/terrain-1k:${TAG}"   "terra/terrain-globe:${TAG}"   "terra/imagery:${TAG}" | gzip -1 > "${BUNDLE}"
sha256sum "${BUNDLE}" > "${BUNDLE}.sha256"
printf '%s\n' "${TAG}" > "${OUTPUT_DIR}/image-tag.txt"

echo "Lighthouse images prepared: ${BUNDLE}"
