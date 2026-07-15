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
