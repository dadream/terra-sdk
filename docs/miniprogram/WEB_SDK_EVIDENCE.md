# Web SDK Automated Evidence

## Purpose

The Web gate is the continuous development evidence for the Mini Program SDK.
It runs the real `terra_sdk.wasm`, `TerraGlobeRuntime`, and
`TerraWebGlRenderer` in a Chromium-compatible browser. It is a test harness,
not a supported product Web application.

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

## Evidence

The gate creates `viewer_verify_output/web_sdk/` with:

- `initial.png`, `zoom.png`, `tilt_45.png`, `yaw_30.png`, `reset.png`;
- `context_restored.png`;
- `report.json` and `summary.json` for machine checks;
- `report.html` for offline visual review;
- raw browser, HTTP server, and DOM logs for diagnosis.

The fixture globe repeats two canonical real root records across all eight root
keys. Patch placement, camera, culling, geometry, requests, and draws still come
from the real SDK; repetition only keeps the checked-in test data small and the
complete globe visible.

The checker requires exact camera actions, nonblank `640x360` PNGs, distinct
zoom/tilt/yaw frame hashes, reset equivalence, transient terrain retry recovery,
and WebGL context loss/restore recovery. Evidence must contain no credential-like
query value.

## Final Manual Acceptance

Web evidence does not prove `WXWebAssembly`, WeChat request-domain approval,
touch behavior, physical-device GPU drivers, frontend Tianditu authorization,
or production frame time and memory. After engineering completion, the user
performs the DevTools, Android, and iOS checklist in
`testdata/miniprogram/evidence/README.md`. Pending manual evidence does not block
SDK implementation progress; it controls the final production-release sign-off.
