# Web SDK Automated Evidence

## Purpose

The Web gate is the continuous development evidence for the Mini Program SDK.
It runs the real `terra_sdk.wasm` through the public `TerraViewer` facade,
`TerraGlobeRuntime`, and `TerraWebGlRenderer` in a Chromium-compatible browser.
It is a test harness, not a supported product Web application.

## Run

On the current Linux workstation:

```bash
cd /home/holo/wksp/terra-sdk-anti/terra-sdk-miniprogram
bash scripts/verify_web_sdk.sh
```

The command runs the native/Wasm package gate first. Set
`WEB_SDK_SKIP_WASM_GATE=1` only when iterating on the browser harness against an
already verified Wasm artifact. Override browser detection with
`WEB_SDK_BROWSER_BIN=/path/to/chromium` when needed.

The gate uses `scripts/run_chromium_evidence.js` and Chrome DevTools Protocol to
wait for the page's explicit terminal state and then close the browser. Native
Linux uses `WEB_SDK_NODE_BIN` (default `node`). The legacy Windows `.exe` branch
requires Windows Node.js visible to WSL as `node.exe`, overridable through
`WEB_SDK_WINDOWS_NODE_BIN`; it is not the current workstation workflow.

## Evidence

The gate creates `viewer_verify_output/web_sdk/` with:

- `initial_world.png`, `beijing_top.png`, and `beijing_zoom.png`;
- `beijing_tilt_45.png`, `beijing_heading_30.png`,
  `beijing_north_45.png`, and `beijing_top_north.png`;
- `reset_world.png` and `context_restored.png`;
- `report.json` and `summary.json` for machine checks;
- `report.html` for offline visual review;
- raw browser, HTTP server, and DOM logs for diagnosis.

The fixture globe repeats canonical real root/detail records across requested
keys. Patch placement, target transforms, camera, culling, geometry, requests,
and draws still come from the real SDK; repetition only keeps the checked-in
test data small. The automated focus distance is intentionally shallower than
the Mini Program `BJ` distance so the compact fixture does not simulate a full
regional terrain repository.

The checker requires Beijing target coordinates, exact camera actions,
nonblank `640x360` PNGs, distinct focus/zoom/pitch/heading/north/top frames,
reset equivalence, transient terrain retry recovery, public-facade POI
projection/picking, route overlay creation, and WebGL context loss/restore
recovery. Evidence must contain no credential-like query value.

## Product demo navigation evidence

The manual service runs independently of the session on port 18766. Open its
globe demo and explicitly run a roam, flight or oblique scenario. The normal
page does not start automated trajectories. The eight seconds shown on the
button describe motion only: start preparation and endpoint settlement each
have a separate 30-second bound. The phase label shows which stage is running.
Stop cancels the test and leaves the current pose; normal completion or failure
restores the original pose after recording the endpoint/failure state.

Downloadable `terra.navigation-evidence.v3` records contain:

- Preparation and settlement state samples, duration, pending reasons and the
  actual view; settlement is observed before restoration.
- Motion-only diagnostics and sampled coverage/publication counts, reset after
  preparation; `performanceAfterSettlement` includes motion and settlement.
- Explicit terrain limitations: stable scheduling is not proof of target
  terrain precision. `targetReady=false` remains a limited result.
- Failure/cancellation phase and samples; a timeout does not discard the report
  or leave the controls busy.

Conditioning requires 250ms of stable samples, current submitted coverage,
imagery target precision and drained terrain, UV, handoff, frame and GPU work.
It does not make network/cache conditions deterministic. Percentiles retain
their bounded recent-sample meaning (`count` versus `windowCount`); do not infer
a speedup by comparing different completed workloads or claim continuous pixel
quality from sampled zero blanks.

`tests/web_sdk/product_navigation_driver.js` is an explicit injection for the
bounded Chromium runner. It uses the same public demo controls, checks the
conditioned endpoints, fails on timeout and stores failure UI/state evidence.
Its optional `testScenario` URL parameter selects one scenario in the driver;
the ordinary app does not interpret it. All test-owned browsers, contexts,
profiles and temporary servers must be closed and their exit verified after
success or failure. Keep the requested manual service running; use process and
service-manager checks for cleanup rather than continued endpoint polling.

## Final Manual Acceptance

Web evidence does not prove `WXWebAssembly`, WeChat request-domain approval,
touch behavior, physical-device GPU drivers, frontend Tianditu authorization,
or production frame time and memory. After engineering completion, the user
performs the DevTools, Android, and iOS checklist in
`testdata/miniprogram/evidence/README.md`. Pending manual evidence does not block
SDK implementation progress; it controls the final production-release sign-off.
