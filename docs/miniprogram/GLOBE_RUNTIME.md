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
bash scripts/start_globe_acceptance_service.sh
```

The first command builds and verifies the SDK package. The second stages the
generated Wasm and manifest under `apps/miniprogram/wasm/`; both staged files
are ignored by Git. Open `apps/miniprogram/` in WeChat DevTools after staging.

The third command starts the persistent local terrain service on port `18082`.
Keep its `terra_terrain_globe_acceptance` container running throughout manual
acceptance. Unlike this entry point, `verify_terrain_service_globe.sh` and
`verify_globe.sh` intentionally stop their temporary service after the gate.
Before reporting ready, the persistent entry point uses the real Wasm and globe
repository to verify the Beijing initial frame, four fixed zooms, antimeridian
texture selection, and sparse-detail parent fallback.

Production and physical-device terrain services must use HTTPS and be
registered as Mini Program request domains. For local DevTools acceptance
only, the runtime also accepts HTTP origins on `localhost`, `127.0.0.1`, or
`[::1]`; disable domain checking in the ignored
`project.private.config.json`, configure the loopback service, and restart the
page:

```js
wx.setStorageSync('terra.terrainServiceOrigin', 'http://127.0.0.1:18082')
```

Non-loopback HTTP origins remain invalid. Every imagery host must use HTTPS;
the local terrain exception does not relax Tianditu request-domain or
credential requirements.

Before relaunching the page, verify that the manifest is reachable from the
Windows host used by DevTools:

```text
http://127.0.0.1:18082/terra/v1/datasets/globe/manifest
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

The checked-in Mini Program configuration starts with Beijing centered at
`116.4074 E, 39.9042 N`. This is an application default; the generic runtime
keeps its neutral camera when no `initialTarget` is supplied. `R` returns to
the configured Beijing target after zoom, tilt, or yaw changes.

- `Move` plus one-finger drag: move the surface target, matching nav3d left drag.
- `Look` plus one-finger drag: change local heading and pitch, matching nav3d right drag.
- Two finger pinch: zoom.
- `BJ`: return to the configured Beijing target at regional inspection distance.
- `Top`: set top-down pitch without changing target, heading, or distance.
- `-` / `+`: fixed zoom out/in.
- `45`: set a -45 degree tilt.
- `N`: reset local heading to north-up.
- `R`: reset the exact initial SDK camera state.
- `Retry`: requeue terrain records or imagery that exhausted the bounded retry policy.
- `C`: copy the current runtime report for evidence collection.

WeChat DevTools does not map the desktop keyboard to these commands. Use the
dedicated control band below the WebGL canvas. A mouse drag simulates one
finger: select `Move` for surface navigation or `Look` for heading/pitch. Use
the fixed `-`/`+` commands when desktop pinch emulation is inconvenient. The
status band includes target coordinates, pitch, heading, and active imagery.
The full deterministic DevTools checklist is in
[GLOBE_VISUAL_ACCEPTANCE.md](GLOBE_VISUAL_ACCEPTANCE.md).
Before a Tianditu run, verify local storage without printing the credential,
then relaunch the page:

```js
wx.getStorageSync('terra.imageryProfile')
Boolean(wx.getStorageSync('terra.tiandituToken'))
wx.reLaunch({ url: '/pages/globe/index' })
```

The expected values are `tianditu-img-c` and `true`. A successful profile run
shows `imagery tianditu-img-c` and the Tianditu attribution above the toolbar.
If status shows `imagery blue-marble`, the page started before the local profile
was stored or the DevTools storage belongs to a different AppID/project.

The report includes frame counts, camera state, the safe imagery profile ID,
cache sizes, request activity, budget, renderer counters, diagnostics, and
context status. It never includes imagery credentials.

## Verification Evidence

The automated development gate calls the real Wasm SDK and WebGL renderer in a
test-only Chromium-compatible browser. It captures initial Beijing world view,
fixture-safe Beijing focus, zoom, -45 degree pitch, 30 degree heading,
north-up, top-down, reset, and context-restored frames. It checks exact camera
state, nonblank and distinct PNGs, transient terrain retry, and WebGL context
recovery. The automated focus uses a bounded synthetic-data distance; the `BJ`
button keeps the closer regional distance for full-service manual acceptance.

```bash
bash scripts/verify_web_sdk.sh
```

Outputs are written under `viewer_verify_output/web_sdk/`, including
`report.html`, `report.json`, `summary.json`, and one PNG per fixed action.
This gate does not validate `WXWebAssembly`, Mini Program domain authorization,
physical device performance, touch behavior, or an application credential.

After engineering completion, the user collects DevTools, Android, and iOS
evidence for Blue Marble, context loss/restore, weak-network retry, and
authorized Tianditu imagery alignment. Store the local packet under
`testdata/miniprogram/evidence/local/`, which is ignored, and validate it with:

```bash
MINIPROGRAM_EVIDENCE_MILESTONES=M1,M6,M7 \
  bash scripts/verify_miniprogram_device_evidence.sh
```

This final manual acceptance does not block M1, M6, or M7 engineering progress.
The verifier detects missing reports, invalid state transitions, blank PNGs,
threshold violations, and textual credential leaks. Human review remains
responsible for visual alignment, attribution, request-domain authorization,
provider terms, and ensuring screenshots reveal no credential.

The complete deterministic gates are:

```bash
bash scripts/verify_miniprogram_wasm.sh
bash scripts/verify_web_sdk.sh
bash scripts/verify_baseline.sh
bash scripts/verify_globe.sh
VERIFY_TIANDITU=1 bash scripts/verify_globe.sh
```
