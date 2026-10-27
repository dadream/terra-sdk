#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
OUTPUT_DIR=$(realpath -m "${VISIBILITY_DEPTH_OUTPUT_DIR:-${ROOT_DIR}/viewer_verify_output/visibility_depth_copy}")
NODE_BIN=${WEB_SDK_NODE_BIN:-node}
BROWSER_BIN=${WEB_SDK_BROWSER_BIN:-}
PORT=${VISIBILITY_DEPTH_PORT:-18765}
SERVER_PID=

case "${OUTPUT_DIR}" in
  "${ROOT_DIR}/viewer_verify_output"/*) ;;
  *) echo "VISIBILITY_DEPTH_OUTPUT_DIR must be below viewer_verify_output" >&2; exit 2 ;;
esac
if [ -z "${BROWSER_BIN}" ]; then
  for candidate in chromium chromium-browser google-chrome google-chrome-stable; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      BROWSER_BIN=$(command -v "${candidate}"); break
    fi
  done
fi
test -n "${BROWSER_BIN}" || { echo "Set WEB_SDK_BROWSER_BIN to a Chromium-compatible browser" >&2; exit 2; }
command -v "${NODE_BIN}" >/dev/null
mkdir -p "${OUTPUT_DIR}/site"
test ! -e "${OUTPUT_DIR}/browser-profile"

cleanup() {
  local result=$?
  trap - EXIT
  if [ -n "${SERVER_PID}" ]; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" >/dev/null 2>&1 || true
    if kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
      echo "Visibility fixture server remains: ${SERVER_PID}" >&2; result=1
    fi
  fi
  # The bounded runner owns browser shutdown and profile removal on every exit.
  # Do not remove a remaining profile and pretend its owner has stopped.
  if [ -e "${OUTPUT_DIR}/browser-profile" ]; then
    echo "Visibility fixture browser cleanup is unproven" >&2; result=1
  fi
  exit "${result}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
cp "${ROOT_DIR}/tests/web_sdk/visibility_depth_copy.html" "${OUTPUT_DIR}/site/index.html"
python3 -m http.server "${PORT}" --bind 127.0.0.1 --directory "${OUTPUT_DIR}/site" \
  > "${OUTPUT_DIR}/server.log" 2>&1 &
SERVER_PID=$!
for _ in {1..50}; do
  kill -0 "${SERVER_PID}" >/dev/null 2>&1 || { cat "${OUTPUT_DIR}/server.log" >&2; exit 1; }
  if curl --silent --fail "http://127.0.0.1:${PORT}/" >/dev/null; then break; fi
  sleep 0.1
done
kill -0 "${SERVER_PID}" >/dev/null 2>&1
mkdir "${OUTPUT_DIR}/browser-profile"
"${NODE_BIN}" "${ROOT_DIR}/scripts/run_chromium_evidence.js" \
  --browser "${BROWSER_BIN}" --profile "${OUTPUT_DIR}/browser-profile" \
  --url "http://127.0.0.1:${PORT}/" --dom-output "${OUTPUT_DIR}/browser.html" \
  --log-output "${OUTPUT_DIR}/browser.log" --timeout 45
python3 - "${OUTPUT_DIR}" <<'PY'
import json, sys
from pathlib import Path
from html.parser import HTMLParser

class Evidence(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.value = ''
    def handle_starttag(self, tag, attrs):
        if tag == 'pre' and dict(attrs).get('id') == 'evidence':
            self.active = True
    def handle_endtag(self, tag):
        if tag == 'pre':
            self.active = False
    def handle_data(self, data):
        if self.active:
            self.value += data

root = Path(sys.argv[1])
parser = Evidence()
parser.feed((root / 'browser.html').read_text())
report = json.loads(parser.value)
(root / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
assert report['passed'], report
assert report['single']['samples'] == 0
assert report['multisample']['samples'] > 0 and report['multisample']['unsafeResolve']
print('Single-sample control passed; resolved MSAA depth lost visible samples.')
PY
