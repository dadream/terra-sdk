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

The checked-in test configuration uses CloudBase environment
`shunlu-api-test-d9fvhxfy3199a35a`:

- planar terrain calls `terra-terrain-1k` through
  `wx.cloud.callContainer`;
- globe terrain calls `terra-terrain-globe` through
  `wx.cloud.callContainer`;
- Tianditu imagery loads from the public HTTPS endpoint of
  `terra-tianditu-proxy`.

The proxy domain is configuration, not a credential. The Tianditu token remains
only in the proxy service environment and must not be stored in the Mini
Program. Before real-device or release validation, add the proxy HTTPS domain
to the Mini Program network-domain configuration required for
`canvas.createImage`.

Local origins still take precedence when
`terra.terrainServiceOrigin` or `terra.planarServiceOrigin` is set in
storage. Remove those keys to exercise CloudBase. See
`docs/miniprogram/GLOBE_RUNTIME.md` for controls, cache/retry behavior, and
required device evidence. Follow
`docs/cloudbase/MINIPROGRAM_ACCEPTANCE.md` for the complete planar/globe
CloudBase manual acceptance checklist.