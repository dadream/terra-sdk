#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_IMAGE=${TERRA_SDK_DOCKER_IMAGE:-qt-dev-env}
MOD_VICTMS_SO=${MOD_VICTMS_SO:-/wksp/build/cmake/mod_victms.so}
OUTPUT_DIR=${OUTPUT_DIR:-"${ROOT_DIR}/viewer_verify_output/service_victms_cmake"}
APACHE_PORT=${APACHE_PORT:-18080}

mkdir -p "$(dirname "${OUTPUT_DIR}")"
OUTPUT_DIR_ABS=$(realpath -m "${OUTPUT_DIR}")
OUTPUT_ROOT_ABS=$(realpath -m "${ROOT_DIR}/viewer_verify_output")

case "${OUTPUT_DIR_ABS}" in
  "${OUTPUT_ROOT_ABS}"/*)
    ;;
  *)
    echo "Refusing to use service smoke output outside viewer_verify_output: ${OUTPUT_DIR_ABS}" >&2
    exit 1
    ;;
esac

DOCKER_OUTPUT_DIR="/workspace${OUTPUT_DIR_ABS#"${ROOT_DIR}"}"

echo "Running CMake mod_victms service smoke..."
echo "Module: ${MOD_VICTMS_SO}"
echo "Output: ${OUTPUT_DIR_ABS}"

rm -rf "${OUTPUT_DIR_ABS}"
mkdir -p "${OUTPUT_DIR_ABS}"

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "${ROOT_DIR}:/workspace" \
  -v "${ROOT_DIR}/workspace_old:/wksp" \
  -e MOD_VICTMS_SO="${MOD_VICTMS_SO}" \
  -e SERVICE_SMOKE_OUTPUT="${DOCKER_OUTPUT_DIR}" \
  -e APACHE_PORT="${APACHE_PORT}" \
  -w /workspace \
  "${DOCKER_IMAGE}" \
  bash -lc '
    set -euo pipefail

    if [ ! -s "${MOD_VICTMS_SO}" ]; then
      echo "MISSING CMake mod_victms module: ${MOD_VICTMS_SO}" >&2
      exit 1
    fi

    apache_root=$(mktemp -d /tmp/victms-smoke.XXXXXX)
    apache_pid=""

    cleanup() {
      if [ -n "${apache_pid}" ] && kill -0 "${apache_pid}" > /dev/null 2>&1; then
        kill "${apache_pid}" > /dev/null 2>&1 || true
        wait "${apache_pid}" > /dev/null 2>&1 || true
      fi
      rm -rf "${apache_root}"
    }
    trap cleanup EXIT

    mkdir -p "${SERVICE_SMOKE_OUTPUT}"
    mkdir -p "${apache_root}/run" "${apache_root}/www/victms/1.0.0"

    cat > "${apache_root}/www/victms/config.xml" << "XML"
<?xml version="1.0" encoding="UTF-8" ?>
<victms>
<tilemap
  name="ps-quadtree"
  profile="none"
  mime-type="image/jpeg"
  extension="jpg"
  max-level="2"
  srs="EPSG:4326"
  bbox_lo_0="0"
  bbox_lo_1="0"
  bbox_hi_0="1024"
  bbox_hi_1="1024"
  nu="1"
  nv="1"
  img_width="256"
  img_height="256"
/>
</victms>
XML

    cat > "${apache_root}/apache2.conf" << CONF
ServerRoot "${apache_root}"
ServerName localhost
PidFile "${apache_root}/run/apache.pid"
DefaultRuntimeDir "${apache_root}/run"
TypesConfig /etc/mime.types
Listen 127.0.0.1:${APACHE_PORT}

LoadModule mpm_event_module /usr/lib/apache2/modules/mod_mpm_event.so
LoadModule authz_core_module /usr/lib/apache2/modules/mod_authz_core.so
LoadModule authz_host_module /usr/lib/apache2/modules/mod_authz_host.so
LoadModule mime_module /usr/lib/apache2/modules/mod_mime.so
LoadModule victms_module ${MOD_VICTMS_SO}

DocumentRoot "${apache_root}/www"
<Directory "${apache_root}/www">
  Require all granted
  Options +FollowSymLinks -SymLinksIfOwnerMatch +Indexes
</Directory>

<LocationMatch "/victms">
  SetHandler victms
  Require all granted
</LocationMatch>

ErrorLog "${SERVICE_SMOKE_OUTPUT}/apache_stderr.log"
CONF

    apache2 -f "${apache_root}/apache2.conf" -DFOREGROUND > "${SERVICE_SMOKE_OUTPUT}/apache_stdout.log" 2>> "${SERVICE_SMOKE_OUTPUT}/apache_stderr.log" &
    apache_pid=$!

    base_url="http://127.0.0.1:${APACHE_PORT}"
    ready=0
    for _ in $(seq 1 30); do
      if curl -fsS "${base_url}/victms/" > "${SERVICE_SMOKE_OUTPUT}/root.xml" 2>/dev/null; then
        ready=1
        break
      fi
      sleep 1
    done
    if [ "${ready}" -ne 1 ]; then
      echo "Apache mod_victms smoke did not become ready." >&2
      cat "${SERVICE_SMOKE_OUTPUT}/apache_stderr.log" >&2 || true
      exit 1
    fi

    curl -fsS "${base_url}/victms/1.0.0/" > "${SERVICE_SMOKE_OUTPUT}/service.xml"
    curl -fsS "${base_url}/victms/1.0.0/ps-quadtree/" > "${SERVICE_SMOKE_OUTPUT}/tilemap.xml"

    grep -q "TileMapService" "${SERVICE_SMOKE_OUTPUT}/root.xml"
    grep -q "ps-quadtree" "${SERVICE_SMOKE_OUTPUT}/service.xml"
    grep -q "<TileMap" "${SERVICE_SMOKE_OUTPUT}/tilemap.xml"
    grep -q "<SRS>EPSG:4326</SRS>" "${SERVICE_SMOKE_OUTPUT}/tilemap.xml"

    cleanup
    trap - EXIT
    echo "CMake mod_victms service smoke passed."
  '
