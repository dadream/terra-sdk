#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
SERVICE_BIN=${SERVICE_BIN:-/wksp/build/cmake/terra_terrain_service}
DATASET_ID=${DATASET_ID:-ps-1k}
TERRAIN_BASE=${TERRAIN_BASE:-/workspace/testdata/datasets/ps_1k/reference/terrain}
SERVICE_PORT=${SERVICE_PORT:-18081}
CONTAINER_NAME=${CONTAINER_NAME:-terra_terrain_service_smoke}
OUTPUT_DIR=${OUTPUT_DIR:-"${ROOT_DIR}/viewer_verify_output/terrain_service"}
EXPECTED_ROOT_SHA256=e7715fa22c5951e900e72656cf7fa9aaa4612fae3b4427e969ae22626792e799
EXPECTED_DETAIL_SHA256=840f43eff7d49de194239c9978b0cd0e9ced33f056988a78bb214b7ea7af2512

OUTPUT_DIR_ABS=$(realpath -m "${OUTPUT_DIR}")
OUTPUT_ROOT_ABS=$(realpath -m "${ROOT_DIR}/viewer_verify_output")
case "${OUTPUT_DIR_ABS}" in
  "${OUTPUT_ROOT_ABS}"/*)
    ;;
  *)
    echo "Refusing terrain service output outside viewer_verify_output: ${OUTPUT_DIR_ABS}" >&2
    exit 1
    ;;
esac

cleanup() {
  docker rm -f "${CONTAINER_NAME}" > /dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
rm -rf "${OUTPUT_DIR_ABS}"
mkdir -p "${OUTPUT_DIR_ABS}"

if find "${ROOT_DIR}/apps/miniprogram" -type f \
    \( -name '*.data' -o -name '*.root' \) -print -quit | grep -q .; then
  echo "Terrain repositories must not be packaged in apps/miniprogram." >&2
  exit 1
fi

docker run --rm \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  cmake --build /wksp/build/cmake \
    --target terra_terrain_service terra_terrain_service_contract \
    --parallel 4

docker run --rm \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -w /wksp/build/cmake \
  "${DOCKER_IMAGE}" \
  ctest --output-on-failure -R '^terra_terrain_service_contract$'

base_url="http://127.0.0.1:${SERVICE_PORT}/terra/v1/datasets/${DATASET_ID}"
docker run -d \
  --name "${CONTAINER_NAME}" \
  --user "$(id -u):$(id -g)" \
  --network host \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  "${SERVICE_BIN}" \
  --dataset-id "${DATASET_ID}" \
  --terrain "${TERRAIN_BASE}" \
  --bind 127.0.0.1 \
  --port "${SERVICE_PORT}" \
  --min-level 0 \
  --max-level 30 \
  --max-requests 8 \
  --texture-id blue-marble \
  --texture-kind global-geodetic \
  --texture-template 'https://example.invalid/blue-marble/{z}/{x}/{y}.jpg' \
  --texture-level-offset 0 \
  --texture-max-level 8 > /dev/null

ready=0
for _ in $(seq 1 30); do
  docker logs "${CONTAINER_NAME}" > "${OUTPUT_DIR_ABS}/service.log" 2>&1 || true
  if grep -q '^\[terrain-service\] ready ' "${OUTPUT_DIR_ABS}/service.log"; then
    ready=1
    break
  fi
  sleep 1
done
if [ "${ready}" -ne 1 ]; then
  echo "Terrain service did not become ready." >&2
  cat "${OUTPUT_DIR_ABS}/service.log" >&2 || true
  exit 1
fi

manifest_status=$(curl -sS \
  -D "${OUTPUT_DIR_ABS}/manifest.headers" \
  -o "${OUTPUT_DIR_ABS}/manifest.json" \
  -w '%{http_code}' \
  "${base_url}/manifest")
root_status=$(curl -sS \
  -D "${OUTPUT_DIR_ABS}/root.headers" \
  -o "${OUTPUT_DIR_ABS}/root.bin" \
  -w '%{http_code}' \
  "${base_url}/roots/0/0/268435456")
detail_status=$(curl -sS \
  -D "${OUTPUT_DIR_ABS}/detail.headers" \
  -o "${OUTPUT_DIR_ABS}/detail.bin" \
  -w '%{http_code}' \
  "${base_url}/patches/-268435456/0/268435456")

if [ "${manifest_status}" != 200 ] || [ "${root_status}" != 200 ] || \
   [ "${detail_status}" != 200 ]; then
  echo "Terrain service success status contract failed." >&2
  exit 1
fi

grep -q '"schema_version": 1' "${OUTPUT_DIR_ABS}/manifest.json"
grep -q '"dataset_id": "ps-1k"' "${OUTPUT_DIR_ABS}/manifest.json"
grep -q '/roots/{i}/{j}/{k}' "${OUTPUT_DIR_ABS}/manifest.json"
grep -q '/patches/{i}/{j}/{k}' "${OUTPUT_DIR_ABS}/manifest.json"
grep -qi '^Content-Type: application/vnd.terra.dataset+json;version=1' \
  "${OUTPUT_DIR_ABS}/manifest.headers"
grep -qi '^Content-Type: application/octet-stream' \
  "${OUTPUT_DIR_ABS}/root.headers"
grep -qi '^X-Terra-Checksum: fnv1a64:' \
  "${OUTPUT_DIR_ABS}/detail.headers"
grep -qi '^Cache-Control: public, max-age=31536000, immutable' \
  "${OUTPUT_DIR_ABS}/detail.headers"

echo "${EXPECTED_ROOT_SHA256}  ${OUTPUT_DIR_ABS}/root.bin" | sha256sum -c -
echo "${EXPECTED_DETAIL_SHA256}  ${OUTPUT_DIR_ABS}/detail.bin" | sha256sum -c -

etag=$(sed -n 's/^[Ee][Tt][Aa][Gg]:[[:space:]]*//p' \
  "${OUTPUT_DIR_ABS}/detail.headers" | tr -d '\r' | head -n 1)
if [ -z "${etag}" ]; then
  echo "Terrain detail response did not include an ETag." >&2
  exit 1
fi
conditional_status=$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "If-None-Match: ${etag}" \
  "${base_url}/patches/-268435456/0/268435456")
malformed_status=$(curl -sS -o "${OUTPUT_DIR_ABS}/malformed.json" \
  -w '%{http_code}' \
  "${base_url}/patches/not-a-key/0/0")
missing_status=$(curl -sS -o "${OUTPUT_DIR_ABS}/missing.json" \
  -w '%{http_code}' \
  "${base_url}/patches/123/456/789")
method_status=$(curl -sS -X POST -o "${OUTPUT_DIR_ABS}/method.json" \
  -w '%{http_code}' "${base_url}/manifest")
head_status=$(curl -sS -I -o "${OUTPUT_DIR_ABS}/head.headers" \
  -w '%{http_code}' "${base_url}/roots/0/0/268435456")

if [ "${conditional_status}" != 304 ] || [ "${malformed_status}" != 400 ] || \
   [ "${missing_status}" != 404 ] || [ "${method_status}" != 405 ] || \
   [ "${head_status}" != 200 ]; then
  echo "Terrain service HTTP failure or caching contract failed." >&2
  exit 1
fi

grep -q '"code":"malformed_patch_key"' \
  "${OUTPUT_DIR_ABS}/malformed.json"
grep -q '"code":"patch_not_found"' "${OUTPUT_DIR_ABS}/missing.json"
grep -q '"code":"method_not_allowed"' "${OUTPUT_DIR_ABS}/method.json"

docker wait "${CONTAINER_NAME}" > /dev/null
docker logs "${CONTAINER_NAME}" > "${OUTPUT_DIR_ABS}/service.log" 2>&1 || true
if grep -q '\[terrain-service\]\[error\]' "${OUTPUT_DIR_ABS}/service.log"; then
  cat "${OUTPUT_DIR_ABS}/service.log" >&2
  exit 1
fi
if [ "$(wc -l < "${OUTPUT_DIR_ABS}/service.log")" -gt 20 ]; then
  echo "Terrain service log exceeded the 20-line smoke budget." >&2
  exit 1
fi

cat > "${OUTPUT_DIR_ABS}/summary.json" <<JSON
{
  "passed": true,
  "dataset_id": "${DATASET_ID}",
  "manifest_status": ${manifest_status},
  "root_status": ${root_status},
  "detail_status": ${detail_status},
  "conditional_status": ${conditional_status},
  "malformed_status": ${malformed_status},
  "missing_status": ${missing_status},
  "method_status": ${method_status},
  "head_status": ${head_status},
  "root_sha256": "${EXPECTED_ROOT_SHA256}",
  "detail_sha256": "${EXPECTED_DETAIL_SHA256}"
}
JSON

trap - EXIT
cleanup
echo "Terrain service HTTP smoke passed."
echo "Summary: ${OUTPUT_DIR_ABS}/summary.json"
