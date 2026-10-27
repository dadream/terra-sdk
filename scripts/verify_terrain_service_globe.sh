#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
GLOBE_DATA_DIR=${GLOBE_DATA_DIR:-/mnt/s/terra-data/globe}
SERVICE_PORT=${SERVICE_PORT:-18082}
CONTAINER_NAME=${CONTAINER_NAME:-terra_terrain_service_globe}
OUTPUT_DIR=${OUTPUT_DIR:-"${ROOT_DIR}/viewer_verify_output/terrain_service_globe"}
EXPECTED_ROOT_SHA256=48a11255aeb26ae5b1894c059c42c0047548386b3981ddd44114a501bc3905df
EXPECTED_DETAIL_SHA256=8768dee59a22796dffa19f9309c4a742970cc030dea445f064ca21eff531d93f

OUTPUT_DIR_ABS=$(realpath -m "${OUTPUT_DIR}")
OUTPUT_ROOT_ABS=$(realpath -m "${ROOT_DIR}/viewer_verify_output")
GLOBE_DATA_DIR_ABS=$(realpath -e "${GLOBE_DATA_DIR}")
case "${OUTPUT_DIR_ABS}" in
  "${OUTPUT_ROOT_ABS}"/*)
    ;;
  *)
    echo "Refusing globe service output outside viewer_verify_output." >&2
    exit 1
    ;;
esac

for suffix in xml root data; do
  if [ ! -e "${GLOBE_DATA_DIR_ABS}/terrain.${suffix}" ]; then
    echo "Missing globe terrain.${suffix}: ${GLOBE_DATA_DIR_ABS}" >&2
    exit 2
  fi
done
if [ "$(stat -Lc '%s' "${GLOBE_DATA_DIR_ABS}/terrain.data")" -lt 805306368 ]; then
  echo "Globe detail repository is smaller than the reviewed 768 MiB dataset." >&2
  exit 1
fi

cleanup() {
  docker rm -f "${CONTAINER_NAME}" > /dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
rm -rf "${OUTPUT_DIR_ABS}"
mkdir -p "${OUTPUT_DIR_ABS}"

docker run --rm \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  cmake --build /wksp/build/cmake \
    --target terra_terrain_service --parallel 4

docker run -d \
  --name "${CONTAINER_NAME}" \
  --user "$(id -u):$(id -g)" \
  --network host \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -v "${GLOBE_DATA_DIR_ABS}:/data/globe:ro" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  /wksp/build/cmake/terra_terrain_service \
  --dataset-id globe \
  --terrain /data/globe/terrain \
  --bind 127.0.0.1 \
  --port "${SERVICE_PORT}" \
  --min-level 0 \
  --max-level 30 \
  --max-requests 3 \
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
  echo "Globe terrain service did not become ready." >&2
  cat "${OUTPUT_DIR_ABS}/service.log" >&2 || true
  exit 1
fi

base_url="http://127.0.0.1:${SERVICE_PORT}/terra/v1/datasets/globe"
manifest_status=$(curl -sS -o "${OUTPUT_DIR_ABS}/manifest.json" \
  -w '%{http_code}' "${base_url}/manifest")
root_status=$(curl -sS -o "${OUTPUT_DIR_ABS}/root.bin" \
  -w '%{http_code}' \
  "${base_url}/roots/0/134217728/134217728")
detail_status=$(curl -sS -o "${OUTPUT_DIR_ABS}/detail.bin" \
  -w '%{http_code}' \
  "${base_url}/patches/-134217728/134217728/134217728")

if [ "${manifest_status}" != 200 ] || [ "${root_status}" != 200 ] || \
   [ "${detail_status}" != 200 ]; then
  echo "Globe terrain service request failed." >&2
  exit 1
fi

grep -q '"kind": "cylindrical"' "${OUTPUT_DIR_ABS}/manifest.json"
grep -q '"radius": 6378000' "${OUTPUT_DIR_ABS}/manifest.json"
grep -q '"root_count": 8' "${OUTPUT_DIR_ABS}/manifest.json"
echo "${EXPECTED_ROOT_SHA256}  ${OUTPUT_DIR_ABS}/root.bin" | sha256sum -c -
echo "${EXPECTED_DETAIL_SHA256}  ${OUTPUT_DIR_ABS}/detail.bin" | sha256sum -c -
cmp "${OUTPUT_DIR_ABS}/detail.bin" \
  "${ROOT_DIR}/testdata/miniprogram/golden/globe_patch_record.bin"

docker wait "${CONTAINER_NAME}" > /dev/null
docker logs "${CONTAINER_NAME}" > "${OUTPUT_DIR_ABS}/service.log" 2>&1 || true
if grep -q '\[terrain-service\]\[error\]' "${OUTPUT_DIR_ABS}/service.log"; then
  cat "${OUTPUT_DIR_ABS}/service.log" >&2
  exit 1
fi

cat > "${OUTPUT_DIR_ABS}/summary.json" <<JSON
{
  "passed": true,
  "dataset_id": "globe",
  "detail_repository_bytes": 805306368,
  "manifest_status": ${manifest_status},
  "root_status": ${root_status},
  "detail_status": ${detail_status},
  "root_sha256": "${EXPECTED_ROOT_SHA256}",
  "detail_sha256": "${EXPECTED_DETAIL_SHA256}"
}
JSON

trap - EXIT
cleanup
echo "Globe terrain service verification passed."
echo "Summary: ${OUTPUT_DIR_ABS}/summary.json"