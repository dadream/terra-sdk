# Mini Program Globe Runtime

## Purpose

`apps/miniprogram/pages/globe/` is the M6 Blue Marble runtime. It is a
thin WeChat WebGL 1 client: Wasm selects and decodes terrain records, while the
page owns Mini Program lifecycle, HTTPS I/O, image decode, cache policy, and
gestures. It does not change or link the desktop viewer or nav3d targets.

## Prepare A Local Run

Run these commands from the repository root in WSL:

```bash
bash scripts/verify_miniprogram_wasm.sh
bash scripts/stage_miniprogram_globe.sh
```

The first command builds and verifies the SDK package. The second stages the
generated Wasm and manifest under `apps/miniprogram/wasm/`; both staged files
are ignored by Git. Open `apps/miniprogram/` in WeChat DevTools after staging.

The terrain service and every imagery host in its manifest must use HTTPS and
be registered as Mini Program request domains. Configure a credential-free
terrain origin locally, then restart the page:

```js
wx.setStorageSync('terra.terrainServiceOrigin', 'https://terrain.example')
```

`apps/miniprogram/config/runtime.js` intentionally has no deployment URL or
credential. Do not commit local origins, DevTools settings, tokens, generated
Wasm files, screenshots containing credentials, or device reports with tokens.

## Runtime Contract

The page fetches the v1 globe manifest, validates its cylindrical transform and
global-geodetic Blue Marble descriptor, and maps it into the Terra C ABI.
Terrain records must have a matching `Content-Length` and
`X-Terra-Checksum: fnv1a64:<hash>` header before Wasm receives them.

The runtime keeps bounded terrain-record, geometry, and texture LRU caches.
It cancels stale terrain and image requests, retries each resource twice
with bounded delay, and exposes a Retry command after a final failure. Device
DPR, screen size, texture limit, request concurrency, upload time, and cache
sizes determine the per-frame budget. Mesh vertices remain camera-relative on
the GPU to preserve precision at globe scale. The status panel publishes at
most four times per second unless a critical state changes, so report UI work
does not compete with gesture rendering.

## Tianditu img_c Profile

Blue Marble remains the checked-in default. To prepare an authorized local
Tianditu run, set only local Mini Program storage:

    wx.setStorageSync('terra.imageryProfile', 'tianditu-img-c')
    wx.setStorageSync('terra.tiandituToken', '<authorized frontend credential>')

The profile uses HTTPS img_c WMTS with matrices 1 through 18, maps SDK internal
level L to matrix L + 1, keeps the native north-origin row, and selects
subdomain (row + column) % 8. It renders the required Tianditu attribution while active.
Register the terrain-service origin and all t0 through t7.tianditu.gov.cn
request domains in the authorized Mini Program.

Do not use a service-only credential in the Mini Program. The profile keeps the
credential in a closure rather than runtime state; query values are redacted
from diagnostics and copied reports. It uses only the existing in-memory image
cache. Approval of the provider's current terms, notices, attribution, and
request-domain configuration remains a release and device-evidence requirement.

## Controls And State

- One finger drag: yaw and tilt.
- Two finger pinch: zoom.
- `-` / `+`: fixed zoom out/in.
- `45`: set a -45 degree tilt.
- `R`: reset the exact initial SDK camera state.
- `Retry`: requeue terrain records or imagery that exhausted the bounded retry policy.
- `C`: copy the current runtime report for evidence collection.

The report includes frame counts, camera state, the safe imagery profile ID,
cache sizes, request activity, budget, renderer counters, diagnostics, and
context status. It never includes imagery credentials.

## Verification Evidence

Before M6/M7 can exit, collect DevTools, Android, and iOS evidence for
Blue Marble initial, zoom, tilt, yaw, reset, context loss/restore, weak-network
retry, and authorized Tianditu imagery alignment. Store
local screenshots and copied reports under
`testdata/miniprogram/evidence/local/`, which is ignored. Confirm the globe has
no cracks, inverted hemisphere, or north/south image-row mismatch, then record
frame time, memory, and cache observations against the M1 reference thresholds.

Repository gates cover the deterministic parts:

```bash
bash scripts/verify_miniprogram_wasm.sh
bash scripts/verify_baseline.sh
bash scripts/verify_globe.sh
VERIFY_TIANDITU=1 bash scripts/verify_globe.sh
```
