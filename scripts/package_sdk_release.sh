#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
BUILD_JOBS=${TERRA_SDK_BUILD_JOBS:-4}
BUILD_DIR="${ROOT_DIR}/workspace_old/build/cmake"
WASM_PACKAGE_DIR="${ROOT_DIR}/workspace_old/package/miniprogram"
RELEASE_DIR=$(realpath -m \
  "${TERRA_SDK_RELEASE_DIR:-${ROOT_DIR}/workspace_old/package/release}")
PACKAGE_ROOT=$(realpath -m "${ROOT_DIR}/workspace_old/package")
SDK_VERSION=$(sed -n \
  's/^project(TerraSdk VERSION \([^ ]*\).*/\1/p' \
  "${ROOT_DIR}/CMakeLists.txt")

case "${RELEASE_DIR}" in
  "${PACKAGE_ROOT}"/*) ;;
  *)
    echo "Release output must be below ${PACKAGE_ROOT}: ${RELEASE_DIR}" >&2
    exit 2
    ;;
esac

if [ -z "${SDK_VERSION}" ]; then
  echo "Unable to read Terra SDK version from CMakeLists.txt." >&2
  exit 2
fi
if [ ! -f "${BUILD_DIR}/cmake_install.cmake" ]; then
  echo "Missing CMake build tree. Run scripts/build_cmake.sh first." >&2
  exit 2
fi
if [ ! -f "${WASM_PACKAGE_DIR}/wasm/terra_sdk.wasm" ] || \
   [ ! -f "${WASM_PACKAGE_DIR}/release_manifest.json" ]; then
  echo "Missing verified Wasm package. Run verify_miniprogram_wasm.sh first." >&2
  exit 2
fi

RELEASE_CONTAINER_DIR="/wksp${RELEASE_DIR#"${ROOT_DIR}/workspace_old"}"
NATIVE_NAME="terra-sdk-${SDK_VERSION}-native"
MINIPROGRAM_NAME="terra-sdk-${SDK_VERSION}-miniprogram"
NATIVE_ARCHIVE="${NATIVE_NAME}.tar.gz"
MINIPROGRAM_ARCHIVE="${MINIPROGRAM_NAME}.tar.gz"

rm -rf "${RELEASE_DIR}"
mkdir -p "${RELEASE_DIR}"

docker run --rm \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -e BUILD_JOBS="${BUILD_JOBS}" \
  -e SDK_VERSION="${SDK_VERSION}" \
  -e RELEASE_DIR="${RELEASE_CONTAINER_DIR}" \
  -e NATIVE_NAME="${NATIVE_NAME}" \
  -e MINIPROGRAM_NAME="${MINIPROGRAM_NAME}" \
  -e NATIVE_ARCHIVE="${NATIVE_ARCHIVE}" \
  -e MINIPROGRAM_ARCHIVE="${MINIPROGRAM_ARCHIVE}" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  bash -lc '
    set -euo pipefail
    stage="${RELEASE_DIR}/stage"
    native="${stage}/${NATIVE_NAME}"
    miniprogram="${stage}/${MINIPROGRAM_NAME}"

    mkdir -p "${stage}"
    cmake --install /wksp/build/cmake \
      --prefix "${native}" \
      --component TerraSdk
    cp -a /wksp/package/miniprogram "${miniprogram}"

    test -s "${native}/lib64/libterra_core.a"
    test -s "${native}/lib64/libterra_codec.a"
    test -s "${native}/lib64/libterra_frame.a"
    test -s "${native}/lib64/libterra_c_api.a"
    test -s "${native}/share/licenses/TerraSdk/spacelib/COPYING"
    test -s "${native}/share/licenses/TerraSdk/ratman/LICENSE"
    test -s "${native}/share/doc/TerraSdk/examples/native_cpp/main.cpp"
    test -s "${native}/share/doc/TerraSdk/examples/native_c/main.c"
    test -s "${miniprogram}/licenses/spacelib/COPYING"
    test -s "${miniprogram}/licenses/ratman/LICENSE"

    if find "${native}" "${miniprogram}" -type f \
        \( -name "*.data" -o -name "*.root" \) -print -quit | grep -q .; then
      echo "SDK packages must not contain terrain repositories." >&2
      exit 1
    fi
    if grep -R -n -E \
        "Qt[0-9]*::|OpenGL::|X11::|GDAL::|PROJ::|CURL::|MPI::" \
        "${native}/lib64/cmake/TerraSdk"; then
      echo "Native SDK CMake exports contain desktop-only dependencies." >&2
      exit 1
    fi
    if nm -C --undefined-only "${native}"/lib64/libterra_*.a | \
        grep -E "Q(OpenGL|Widget|Application)|glX|GDAL|OGR_|proj_|curl_|MPI_"; then
      echo "Native SDK archives reference a desktop-only dependency." >&2
      exit 1
    fi
    if grep -R -n -E \
        "tk=[A-Za-z0-9]{16,}|tianditu(Token|_TOKEN).{0,32}[=:][[:space:]]*[A-Fa-f0-9]{32}" \
        "${native}" "${miniprogram}"; then
      echo "SDK package contains a credential-like value." >&2
      exit 1
    fi

    cat > "${native}/release_manifest.json" <<JSON
{
  "schema": "terra.sdk-package.v1",
  "sdk_version": "${SDK_VERSION}",
  "c_abi_version": 1,
  "kind": "native",
  "desktop_dependencies_included": false,
  "terrain_data_included": false
}
JSON
    (cd "${native}" && find . -type f -printf "%P\n" | LC_ALL=C sort) \
      > "${native}/FILES"
    (cd "${miniprogram}" && find . -type f -printf "%P\n" | LC_ALL=C sort) \
      > "${miniprogram}/FILES"

    create_archive() {
      local source_name=$1
      local destination=$2
      tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
        --format=gnu -czf "${destination}" -C "${stage}" "${source_name}"
    }

    create_archive "${NATIVE_NAME}" "${RELEASE_DIR}/${NATIVE_ARCHIVE}.first"
    create_archive "${NATIVE_NAME}" "${RELEASE_DIR}/${NATIVE_ARCHIVE}.second"
    cmp "${RELEASE_DIR}/${NATIVE_ARCHIVE}.first" \
        "${RELEASE_DIR}/${NATIVE_ARCHIVE}.second"
    mv "${RELEASE_DIR}/${NATIVE_ARCHIVE}.first" \
       "${RELEASE_DIR}/${NATIVE_ARCHIVE}"
    rm "${RELEASE_DIR}/${NATIVE_ARCHIVE}.second"

    create_archive "${MINIPROGRAM_NAME}" \
      "${RELEASE_DIR}/${MINIPROGRAM_ARCHIVE}.first"
    create_archive "${MINIPROGRAM_NAME}" \
      "${RELEASE_DIR}/${MINIPROGRAM_ARCHIVE}.second"
    cmp "${RELEASE_DIR}/${MINIPROGRAM_ARCHIVE}.first" \
        "${RELEASE_DIR}/${MINIPROGRAM_ARCHIVE}.second"
    mv "${RELEASE_DIR}/${MINIPROGRAM_ARCHIVE}.first" \
       "${RELEASE_DIR}/${MINIPROGRAM_ARCHIVE}"
    rm "${RELEASE_DIR}/${MINIPROGRAM_ARCHIVE}.second"

    cd "${RELEASE_DIR}"
    sha256sum "${NATIVE_ARCHIVE}" "${MINIPROGRAM_ARCHIVE}" > SHA256SUMS
    native_sha=$(sha256sum "${NATIVE_ARCHIVE}" | awk "{print \$1}")
    miniprogram_sha=$(sha256sum "${MINIPROGRAM_ARCHIVE}" | awk "{print \$1}")
    cat > release_manifest.json <<JSON
{
  "schema": "terra.sdk-release.v1",
  "sdk_version": "${SDK_VERSION}",
  "c_abi_version": 1,
  "native_archive": "${NATIVE_ARCHIVE}",
  "native_sha256": "${native_sha}",
  "miniprogram_archive": "${MINIPROGRAM_ARCHIVE}",
  "miniprogram_sha256": "${miniprogram_sha}",
  "manual_device_acceptance": "pending_owner_signoff"
}
JSON

    extract="${RELEASE_DIR}/verify_extract"
    mkdir -p "${extract}"
    tar -xzf "${NATIVE_ARCHIVE}" -C "${extract}"
    prefix="${extract}/${NATIVE_NAME}"
    package_dir="${prefix}/lib64/cmake/TerraSdk"
    examples="${prefix}/share/doc/TerraSdk/examples"

    cmake -S "${examples}/native_cpp" \
      -B "${RELEASE_DIR}/build/native_cpp" \
      -DCMAKE_BUILD_TYPE=Release \
      -DTerraSdk_DIR="${package_dir}"
    cmake --build "${RELEASE_DIR}/build/native_cpp" \
      --parallel "${BUILD_JOBS}"
    "${RELEASE_DIR}/build/native_cpp/terra_sdk_cpp_example"

    cmake -S "${examples}/native_c" \
      -B "${RELEASE_DIR}/build/native_c" \
      -DCMAKE_BUILD_TYPE=Release \
      -DTerraSdk_DIR="${package_dir}"
    cmake --build "${RELEASE_DIR}/build/native_c" \
      --parallel "${BUILD_JOBS}"
    "${RELEASE_DIR}/build/native_c/terra_sdk_c_example"
  '

echo "Terra SDK ${SDK_VERSION} release packages verified."
echo "Release manifest: ${RELEASE_DIR}/release_manifest.json"
