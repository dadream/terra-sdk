#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
ORIGIN=${TERRA_LIGHTHOUSE_ORIGIN:-http://49.233.185.96}
ORIGIN=${ORIGIN%/}
OUTPUT_DIR=${TERRA_LIGHTHOUSE_VERIFY_OUTPUT:-"${ROOT_DIR}/viewer_verify_output/lighthouse/verification"}
EXPECTED_VERSION=$(sed -n \
  's/^project(TerraSdk VERSION \([^ ]*\).*/\1/p' \
  "${ROOT_DIR}/CMakeLists.txt")
mkdir -p "${OUTPUT_DIR}"
WORK_DIR=$(mktemp -d)
trap 'rm -rf "${WORK_DIR}"' EXIT

case "${ORIGIN}" in
  http://49.233.185.96|https://terra.tapirs.top) ;;
  *)
    echo "Unsupported Lighthouse verification origin: ${ORIGIN}" >&2
    exit 2
    ;;
esac

fetch_json() {
  local name=$1
  local path=$2
  curl --fail --silent --show-error --connect-timeout 10 --max-time 60 \
    "${ORIGIN}${path}" -o "${WORK_DIR}/${name}.json"
  python3 -m json.tool "${WORK_DIR}/${name}.json" \
    > "${OUTPUT_DIR}/${name}.json"
}

fetch_binary() {
  local name=$1
  local path=$2
  curl --fail --silent --show-error --connect-timeout 10 --max-time 60 \
    "${ORIGIN}${path}" -o "${WORK_DIR}/${name}"
  test -s "${WORK_DIR}/${name}"
  wc -c < "${WORK_DIR}/${name}"
}

fetch_text() {
  local name=$1
  local path=$2
  fetch_binary "${name}" "${path}" >/dev/null
  cp "${WORK_DIR}/${name}" "${OUTPUT_DIR}/${name}"
}

fetch_jpeg() {
  local name=$1
  local path=$2
  fetch_binary "${name}.jpg" "${path}" >/dev/null
  python3 - "${WORK_DIR}/${name}.jpg" <<'PY'
import pathlib
import sys

data = pathlib.Path(sys.argv[1]).read_bytes()
if len(data) < 4 or data[:3] != b"\xff\xd8\xff":
    raise SystemExit("response is not a JPEG")
PY
}

fetch_json edge-health /healthz
fetch_text home.html /
fetch_text globe-demo.html /demo/globe/
fetch_text planar-demo.html /demo/planar/
fetch_text browser-bundle.js /assets/terra_browser_bundle.js
WASM_BYTES=$(fetch_binary terra_sdk.wasm /assets/terra_sdk.wasm)
fetch_json site-release /assets/release.json
fetch_json planar-manifest /terra/v1/datasets/ps-1k/manifest
fetch_json globe-manifest /terra/v1/datasets/globe/manifest
fetch_json planar-imagery /terra/v1/imagery/ps-1k/manifest
fetch_json blue-marble-imagery /terra/v1/imagery/blue-marble/manifest

PLANAR_PATCH_BYTES=$(fetch_binary planar.patch \
  /terra/v1/datasets/ps-1k/patches/-268435456/0/268435456)
GLOBE_PATCH_BYTES=$(fetch_binary globe.patch \
  /terra/v1/datasets/globe/patches/-134217728/134217728/-134217728)
fetch_jpeg planar-tile /terra/v1/imagery/ps-1k/2/3/0.jpg
fetch_jpeg blue-marble-tile /terra/v1/imagery/blue-marble/7/210/35.jpg

grep -q '<h1 id="hero-title">Terra SDK</h1>' "${OUTPUT_DIR}/home.html"
grep -q 'data-mode="globe"' "${OUTPUT_DIR}/globe-demo.html"
grep -q 'data-mode="planar"' "${OUTPUT_DIR}/planar-demo.html"
grep -q 'global.TerraWebSdk' "${OUTPUT_DIR}/browser-bundle.js"

python3 - "${OUTPUT_DIR}" "${PLANAR_PATCH_BYTES}" \
  "${GLOBE_PATCH_BYTES}" "${WASM_BYTES}" "${ORIGIN}" \
  "${EXPECTED_VERSION}" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
planar = json.loads((root / "planar-manifest.json").read_text())
globe = json.loads((root / "globe-manifest.json").read_text())
planar_imagery = json.loads((root / "planar-imagery.json").read_text())
blue_marble = json.loads((root / "blue-marble-imagery.json").read_text())
release = json.loads((root / "site-release.json").read_text())
assert planar["dataset_id"] == "ps-1k"
assert globe["dataset_id"] == "globe"
assert globe["transform"]["kind"] == "cylindrical"
expected_origin = sys.argv[5]
for manifest in (planar, globe):
    textures = manifest.get("textures", [])
    assert textures
    for texture in textures:
        assert texture["manifest_url"].startswith(expected_origin + "/")
        assert texture["url_template"].startswith(expected_origin + "/")
assert planar_imagery["id"] == "ps-1k"
assert blue_marble["id"] == "blue-marble"
assert release["schema"] == "terra.product-site-release.v1"
assert release["version"] == sys.argv[6]
assert int(sys.argv[2]) > 0
assert int(sys.argv[3]) > 0
assert int(sys.argv[4]) > 10000
summary = {
    "schema": "terra.lighthouse.verification.v1",
    "origin": sys.argv[5],
    "site_version": release["version"],
    "planar_patch_bytes": int(sys.argv[2]),
    "globe_patch_bytes": int(sys.argv[3]),
    "wasm_bytes": int(sys.argv[4]),
    "status": "passed",
}
(root / "summary.json").write_text(
    json.dumps(summary, indent=2) + "\n", encoding="utf-8"
)
PY

echo "Lighthouse site and service verification passed: ${ORIGIN}"
echo "Evidence: ${OUTPUT_DIR}/summary.json"
