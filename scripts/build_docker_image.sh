#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
IMAGE_NAME=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
HOST_UID=${TERRA_SDK_DOCKER_UID:-$(id -u)}
HOST_GID=${TERRA_SDK_DOCKER_GID:-$(id -g)}

echo "Building Terra SDK development image..."
echo "Image: ${IMAGE_NAME}"
echo "UID:GID: ${HOST_UID}:${HOST_GID}"

docker build --build-arg UID="${HOST_UID}" --build-arg GID="${HOST_GID}" \
  -t "${IMAGE_NAME}" -f "${ROOT_DIR}/docker/Dockerfile" "${ROOT_DIR}"
