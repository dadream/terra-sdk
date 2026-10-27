#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
SERVICE_BIN=${SERVICE_BIN:-/wksp/build/cmake/terra_terrain_service}
SERVICE_PORT=${SERVICE_PORT:-18083}
CONTAINER_NAME=${CONTAINER_NAME:-terra_cloud_env_smoke}
OUTPUT_DIR=${OUTPUT_DIR:-"${ROOT_DIR}/viewer_verify_output/terrain_service_cloud"}

cleanup() {
  docker rm -f "${CONTAINER_NAME}" > /dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
mkdir -p "${OUTPUT_DIR}"

if docker run --rm \
    -v "${ROOT_DIR}:/workspace" \
    -v "${ROOT_DIR}/workspace_old:/wksp" \
    -w /workspace \
    "${DOCKER_IMAGE}" \
    "${SERVICE_BIN}" \
    --dataset-id 'invalid"id' \
    --terrain /workspace/testdata/datasets/ps_1k/reference/terrain \
    > "${OUTPUT_DIR}/invalid_dataset.log" 2>&1; then
  echo "Terrain service accepted an invalid dataset ID." >&2
  exit 1
fi

docker run -d \
  --name "${CONTAINER_NAME}" \
  --network host \
  -e PORT="${SERVICE_PORT}" \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  "${SERVICE_BIN}" \
  --dataset-id ps-1k \
  --terrain /workspace/testdata/datasets/ps_1k/reference/terrain \
  --min-level 0 \
  --max-level 30 \
  --max-requests 2 > /dev/null

ready=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${SERVICE_PORT}/healthz" \
      > "${OUTPUT_DIR}/health.json"; then
    ready=1
    break
  fi
  sleep 1
done
if [ "${ready}" -ne 1 ]; then
  docker logs "${CONTAINER_NAME}" >&2 || true
  exit 1
fi

curl -fsS "http://127.0.0.1:${SERVICE_PORT}/readyz" \
  > "${OUTPUT_DIR}/ready.json"
docker wait "${CONTAINER_NAME}" > /dev/null
docker logs "${CONTAINER_NAME}" > "${OUTPUT_DIR}/service.log" 2>&1

grep -q "ready address=0.0.0.0 port=${SERVICE_PORT} dataset=ps-1k" \
  "${OUTPUT_DIR}/service.log"
grep -q '"dataset":"ps-1k"' "${OUTPUT_DIR}/health.json"
grep -q '"dataset":"ps-1k"' "${OUTPUT_DIR}/ready.json"
grep -q 'stopped requests=2 client_errors=0 errors=0' \
  "${OUTPUT_DIR}/service.log"
if grep -q '\[terrain-service\]\[error\]' "${OUTPUT_DIR}/service.log"; then
  cat "${OUTPUT_DIR}/service.log" >&2
  exit 1
fi

trap - EXIT
cleanup
echo "Terrain service cloud runtime verification passed."
