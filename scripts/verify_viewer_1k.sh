#!/bin/bash

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}

export DISPLAY=${DISPLAY:-:0}
X11_SOCKET_DIR=/tmp/.X11-unix
if [ -d /mnt/wslg/.X11-unix ]; then
    X11_SOCKET_DIR=/mnt/wslg/.X11-unix
fi

if command -v xhost &>/dev/null; then
    xhost +local:docker > /dev/null 2>&1 || true
fi

echo "=========================================================="
echo "Starting 1k viewer manual verification..."
echo "Dataset: 1k PS Terrain & Texture"
echo "Elevation: /workspace/testdata/datasets/ps_1k/reference/terrain"
echo "Texture: /workspace/testdata/datasets/ps_1k/reference/texture/victms.xml"
echo "=========================================================="

docker run --rm \
    --user "$(id -u):$(id -g)" \
    --network host \
    -v "${ROOT_DIR}:/workspace" \
    -v "${ROOT_DIR}/workspace_old:/wksp" \
    -v "${X11_SOCKET_DIR}:/tmp/.X11-unix" \
    -e DISPLAY="$DISPLAY" \
    -w /workspace \
    "${DOCKER_IMAGE}" \
    /wksp/build/cmake/vic_cbdam_viewer \
    --elevation /workspace/testdata/datasets/ps_1k/reference/terrain \
    /workspace/testdata/datasets/ps_1k/reference/texture/victms.xml

if command -v xhost &>/dev/null; then
    xhost -local:docker > /dev/null 2>&1 || true
fi

echo "=========================================================="
echo "Viewer manual verification finished."
echo "=========================================================="
