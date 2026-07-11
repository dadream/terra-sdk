#!/bin/bash
set -u

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

NAV3D_BIN=${NAV3D_BIN:-/wksp/build/cmake/vic_ratman_nav3d}
NAV3D_CONFIG=${NAV3D_CONFIG:-/workspace/testdata/nav3d/1k/local_1k.xml}
NAV3D_GEORATMAN_DIR=${NAV3D_GEORATMAN_DIR:-/workspace/viewer_verify_output/nav3d/manual_georatman/}
NAV3D_GEORATMAN_TEMPLATE_DIR=${NAV3D_GEORATMAN_TEMPLATE_DIR:-"${ROOT_DIR}/testdata/nav3d/1k/georatman"}
NAV3D_GEORATMAN_HOST_DIR=
NAV3D_OUTPUT_ROOT=$(realpath -m "${ROOT_DIR}/viewer_verify_output/nav3d")

case "${NAV3D_GEORATMAN_DIR}" in
    /workspace/*)
        candidate="${ROOT_DIR}${NAV3D_GEORATMAN_DIR#/workspace}"
        candidate=$(realpath -m "${candidate}")
        case "${candidate}" in
            "${NAV3D_OUTPUT_ROOT}"/*)
                NAV3D_GEORATMAN_HOST_DIR="${candidate}"
                mkdir -p "${NAV3D_GEORATMAN_HOST_DIR}"
                ;;
            *)
                echo "Refusing to seed GEORATMAN_DIR outside viewer_verify_output/nav3d: ${candidate}" >&2
                exit 1
                ;;
        esac
        ;;
    *)
        echo "Warning: NAV3D_GEORATMAN_DIR is not under /workspace; the script cannot seed config.xml." >&2
        ;;
esac

if [ -n "${NAV3D_GEORATMAN_HOST_DIR}" ]; then
    if [ ! -d "${NAV3D_GEORATMAN_TEMPLATE_DIR}" ]; then
        echo "Missing GEORATMAN template directory: ${NAV3D_GEORATMAN_TEMPLATE_DIR}" >&2
        exit 1
    fi
    find "${NAV3D_GEORATMAN_HOST_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    cp -a "${NAV3D_GEORATMAN_TEMPLATE_DIR}/." "${NAV3D_GEORATMAN_HOST_DIR}/"
fi

echo "=========================================================="
echo "Starting 1k nav3d manual verification..."
echo "Dataset: 1k PS Terrain & Texture"
echo "Config: ${NAV3D_CONFIG}"
echo "Nav3D: ${NAV3D_BIN}"
echo "GEORATMAN_DIR: ${NAV3D_GEORATMAN_DIR}"
echo "Expected terrain: /workspace/testdata/datasets/ps_1k/reference/terrain"
echo "Expected texture: /workspace/testdata/datasets/ps_1k/reference/texture/victms.xml"
echo "Close the nav3d window to finish this manual check."
echo "=========================================================="

docker run --rm \
    --user "$(id -u):$(id -g)" \
    --network host \
    -v "${ROOT_DIR}:/workspace" \
    -v "${ROOT_DIR}/workspace_old:/wksp" \
    -v "${X11_SOCKET_DIR}:/tmp/.X11-unix" \
    -e DISPLAY="$DISPLAY" \
    -e GEORATMAN_DIR="${NAV3D_GEORATMAN_DIR}" \
    -w /workspace \
    "${DOCKER_IMAGE}" \
    "${NAV3D_BIN}" \
    --home_url "${NAV3D_CONFIG}"
nav3d_status=$?

if command -v xhost &>/dev/null; then
    xhost -local:docker > /dev/null 2>&1 || true
fi

echo "=========================================================="
echo "Nav3D manual verification finished with status ${nav3d_status}."
echo "=========================================================="
exit "${nav3d_status}"
