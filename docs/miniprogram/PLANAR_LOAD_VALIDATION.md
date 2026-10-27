# Mini Program Planar Load Validation

## Purpose

The planar load probe isolates Mini Program terrain delivery from globe
interaction and rendering. It verifies the checked-in PS 1k planar repository
through the same HTTP and ArrayBuffer path used by the globe runtime.

The probe covers manifest loading, one canonical root record, one canonical
detail record, transport length and FNV-1a integrity, record length-prefix
framing, and a repeated detail read. It intentionally does not claim Wasm
decoding or rendering correctness. Use `PLANAR_VISUAL_VALIDATION.md` for the
complete planar SDK and WebGL acceptance path.

## Start The Service

From WSL:

```bash
cd /home/holo/terra-sdk-anti/terra-sdk-miniprogram
bash scripts/start_planar_acceptance_service.sh
```

The service binds only to `127.0.0.1:18081` and reads
`testdata/datasets/ps_1k/reference/terrain` read-only. The existing
`verify_terrain_service.sh` gate must pass before Mini Program acceptance.

## Run In DevTools

The checked-in DevTools project disables request-domain validation so the
local loopback HTTP service can be tested. This exception applies only to
local DevTools acceptance; deployed Mini Programs still require HTTPS.

The planar load page is a diagnostic route. In the AppService console, set the
local origin and relaunch:

```js
wx.setStorageSync(
  'terra.planarServiceOrigin',
  'http://127.0.0.1:18081'
)
wx.reLaunch({ url: '/pages/planar-load/index' })
```

The diagnostic page runs automatically and requires no camera interaction. A
passing run
shows:

```text
Planar data load passed
manifest 200 | root 10967 B | detail 9225 B | repeat stable
```

Use `Copy` to collect `terra.miniprogram.planar-load.v1` JSON. The report must
contain `passed: true`, `dataset.transform: planar`, the expected checksums,
and `scope.wasmDecode: false` plus `scope.planarRendering: false`.

## Interpretation

A pass establishes that the service can read the planar repository and that
the Mini Program can receive stable, intact root/detail records. It separates
network, domain, response-header, ArrayBuffer, and repository problems from
globe camera or WebGL interaction problems.

A failure report identifies the first broken contract, such as manifest
metadata, HTTP status, Content-Length, checksum, framing, or repeat stability.
Do not infer a codec or renderer defect until this probe passes.

After this probe passes, relaunch `/pages/planar/index` to validate Wasm decode,
fixed planar topology, texture delivery, height geometry, WebGL rendering, and
deterministic camera actions.
