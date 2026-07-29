#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
GLOBE_DATA_ROOT=${GLOBE_DATA_ROOT:-/mnt/s/terra-data/globe/cbdam-srtm-v2-global-geodetic}
OUTPUT_DIR="${ROOT_DIR}/viewer_verify_output/cloudbase/local"
CACHE_DIR="${OUTPUT_DIR}/cache"

containers=(
  terra_cloudbase_1k_local
  terra_cloudbase_globe_local
  terra_cloudbase_proxy_local
)
cleanup() {
  for container in "${containers[@]}"; do
    docker rm -f "${container}" > /dev/null 2>&1 || true
  done
}
trap cleanup EXIT
cleanup
mkdir -p "${CACHE_DIR}"

docker run -d \
  --name terra_cloudbase_1k_local \
  --network host \
  -e PORT=18084 \
  -v "${ROOT_DIR}/testdata/datasets/ps_1k/reference:/mnt/terra-data/datasets/ps-1k/v1/terrain:ro" \
  -v "${ROOT_DIR}/testdata/datasets/ps_1k/source:/mnt/terra-data/datasets/ps-1k/v1/texture:ro" \
  terra-cloudbase-terrain-1k:local > /dev/null

docker run -d \
  --name terra_cloudbase_globe_local \
  --network host \
  -e PORT=18085 \
  -v "${GLOBE_DATA_ROOT}:/mnt/terra-data/datasets/globe/v1/terrain:ro" \
  terra-cloudbase-terrain-globe:local > /dev/null

docker run -d \
  --name terra_cloudbase_proxy_local \
  --network host \
  -e PORT=18086 \
  -e TIANDITU_TOKEN=local-validation-token \
  -v "${CACHE_DIR}:/mnt/terra-cache" \
  terra-cloudbase-tianditu-proxy:local > /dev/null

wait_for_url() {
  local url=$1
  local output=$2
  for _ in $(seq 1 60); do
    if curl -fsS "${url}" > "${output}"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_url "http://127.0.0.1:18084/readyz" "${OUTPUT_DIR}/1k_ready.json"
wait_for_url "http://127.0.0.1:18085/readyz" "${OUTPUT_DIR}/globe_ready.json"
wait_for_url "http://127.0.0.1:18086/readyz" "${OUTPUT_DIR}/proxy_ready.json"
curl -fsS \
  "http://127.0.0.1:18084/terra/v1/datasets/ps-1k/manifest" \
  > "${OUTPUT_DIR}/1k_manifest.json"
curl -fsS \
  "http://127.0.0.1:18085/terra/v1/datasets/globe/manifest" \
  > "${OUTPUT_DIR}/globe_manifest.json"

grep -q '"dataset_id": "ps-1k"' "${OUTPUT_DIR}/1k_manifest.json"
grep -q '"dataset_id": "globe"' "${OUTPUT_DIR}/globe_manifest.json"
grep -q '"kind": "cylindrical"' "${OUTPUT_DIR}/globe_manifest.json"
grep -q '"ok":true' "${OUTPUT_DIR}/proxy_ready.json"

for container in "${containers[@]}"; do
  docker logs "${container}" > "${OUTPUT_DIR}/${container}.log" 2>&1
  if grep -q '\]\[error\]' "${OUTPUT_DIR}/${container}.log"; then
    cat "${OUTPUT_DIR}/${container}.log" >&2
    exit 1
  fi
done

trap - EXIT
cleanup
echo "CloudBase deployment container verification passed."
