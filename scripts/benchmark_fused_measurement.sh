#!/bin/bash
set -euo pipefail

# Deliberately independent of package/release builds and the manual Web service.
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
mountpoint -q "${ROOT_DIR}/viewer_verify_output"
BENCH_OUTPUT=${TERRA_FUSED_BENCH_OUTPUT:-"${ROOT_DIR}/viewer_verify_output/fused_measurement/$(date +%Y%m%dT%H%M%S)"}
case "${BENCH_OUTPUT}" in
  "${ROOT_DIR}/viewer_verify_output/"*) ;;
  *) echo 'Use the workspace viewer_verify_output mount for benchmark output.' >&2; exit 2 ;;
esac
mkdir -p "${BENCH_OUTPUT}"
BENCH_IMAGE=${TERRA_SDK_WASM_IMAGE:-terra-sdk-wasm:emscripten-3.1.5}
BENCH_CONTAINER="terra-fused-measurement-${BASHPID}"
cleanup() { docker rm -f "${BENCH_CONTAINER}" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT TERM

docker run --rm --name "${BENCH_CONTAINER}" --network none \
  -v "${ROOT_DIR}:/workspace:ro" -v "${BENCH_OUTPUT}:/experiment" \
  -w /workspace "${BENCH_IMAGE}" bash -lc '
    set -euo pipefail
    emcmake cmake -S tests/benchmarks/fused_measurement -B /experiment/build -DCMAKE_BUILD_TYPE=Release
    cmake --build /experiment/build --parallel 4
  ' > "${BENCH_OUTPUT}/build.log" 2>&1
set +e
if command -v rg >/dev/null 2>&1; then
  rg -n 'warning:' "${BENCH_OUTPUT}/build.log"
else
  grep -n 'warning:' "${BENCH_OUTPUT}/build.log"
fi
BENCH_WARNING_STATUS=$?
set -e
if [ "${BENCH_WARNING_STATUS}" -ne 1 ]; then
  echo 'Experimental compiler warning or unreadable build log; benchmark rejected.' >&2
  exit 1
fi

cd "${ROOT_DIR}"
TERRA_EXPERIMENT_COMMIT=$(git rev-parse HEAD) \
  "${WEB_SDK_NODE_BIN:-node}" tests/benchmarks/fused_measurement/benchmark.js \
  "${BENCH_OUTPUT}/build/fused_measurement_experiment.wasm" \
  "${BENCH_OUTPUT}/benchmark.json" > "${BENCH_OUTPUT}/benchmark.log" 2>&1
echo "Offline fused measurement experiment: ${BENCH_OUTPUT}/benchmark.json"
echo 'Not integrated into the SDK; no application deployment performed.'
