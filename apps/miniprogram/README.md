# Terra SDK Mini Program

This directory contains the native WeChat Mini Program capability probe for
roadmap milestone M1. It is additive and does not share code or targets with
viewer or nav3d.

Open this directory in WeChat DevTools. The checked-in `touristappid` supports
local simulator inspection. Real-device evidence requires an authorized local
project configuration; keep `project.private.config.json` untracked.

The first screen creates a WebGL canvas, renders a deterministic triangle,
reads back framebuffer samples, instantiates `wasm/probe.wasm` through
`WXWebAssembly`, and produces capability JSON. The network result is marked
skipped until local storage key `terra.arrayBufferProbeUrl` contains a
credential-free HTTPS endpoint whose domain is registered for the application.

Run the repository-side gates first:

```bash
bash scripts/verify_miniprogram_foundation.sh
bash scripts/verify_miniprogram_wasm.sh
```

The production M5 facade is `utils/terra_wasm.js`. The generated
`terra_sdk.wasm`, C header, facade, and package manifest are staged under
`workspace_old/package/miniprogram/`; generated binaries are not committed.

M1 is not complete from simulator output alone. Follow
`docs/miniprogram/CAPABILITY_PROBE.md` for Android and iOS evidence.

## Globe Runtime

The default page is the M6 Blue Marble globe runtime. Build the verified Wasm
package and stage its ignored local artifacts before opening this app in
DevTools:

```bash
bash scripts/verify_miniprogram_wasm.sh
bash scripts/stage_miniprogram_globe.sh
```

Set `terra.terrainServiceOrigin` in local storage to an HTTPS terrain-service
origin registered in the Mini Program request-domain allowlist. The manifest's
imagery host must also be registered. The checked-in runtime configuration has
no deployment URL or credential. See `docs/miniprogram/GLOBE_RUNTIME.md` for
the controls, cache/retry behavior, and required device evidence.

For an authorized Tianditu img_c run, set the local profile and frontend
credential described in docs/miniprogram/GLOBE_RUNTIME.md. The default remains
credential-free Blue Marble; do not put either frontend or service credentials
in tracked configuration.
