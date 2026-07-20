# Web SDK Automated Evidence

## Purpose

The Web gate is the continuous development evidence for the Mini Program SDK.
It runs the real `terra_sdk.wasm` through the public `TerraViewer` facade,
`TerraGlobeRuntime`, and `TerraWebGlRenderer` in a Chromium-compatible browser.
It is a test harness, not a supported product Web application.

## Run

From WSL:

```bash
cd /home/holo/terra-sdk-anti/terra-sdk-miniprogram
bash scripts/verify_web_sdk.sh
```

The command runs the native/Wasm package gate first. Set
`WEB_SDK_SKIP_WASM_GATE=1` only when iterating on the browser harness against an
already verified Wasm artifact. Override browser detection with
`WEB_SDK_BROWSER_BIN=/path/to/chromium` when needed.

When browser detection selects a Windows `.exe`, the gate uses
`scripts/run_chromium_evidence.js` and Chrome DevTools Protocol to wait for the
page's explicit terminal state and then close the browser. Windows Node.js 20+
must be visible to WSL as `node.exe`; override it with
`WEB_SDK_WINDOWS_NODE_BIN=/mnt/c/path/to/node.exe`. Native Linux Chromium keeps
the CLI `--dump-dom` path.

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

## Final Manual Acceptance

Web evidence does not prove `WXWebAssembly`, WeChat request-domain approval,
touch behavior, physical-device GPU drivers, frontend Tianditu authorization,
or production frame time and memory. After engineering completion, the user
performs the DevTools, Android, and iOS checklist in
`testdata/miniprogram/evidence/README.md`. Pending manual evidence does not block
SDK implementation progress; it controls the final production-release sign-off.
