# Mini Program Planar Visual Validation

## Purpose

The PS 1k planar path is the fast visual oracle for Mini Program SDK changes.
It avoids globe navigation ambiguity and validates the complete chain from the
terrain service through Wasm decode and fixed planar topology to textured
WebGL rendering. It is additive: the existing globe page and its behavior are
unchanged.

## Prepare The SDK And Service

From the repository root in WSL:

```bash
bash scripts/verify_miniprogram_wasm.sh
bash scripts/stage_miniprogram_globe.sh
bash scripts/start_planar_acceptance_service.sh
```

The service binds to `127.0.0.1:18081` and serves the checked-in PS 1k
manifest, root/detail records, and `ps_texture_1k.png`. The startup script
builds the service, replaces only its named acceptance container, and runs the
Mini Program transport integration check before returning.

## Validate In WeChat DevTools

Open `apps/miniprogram/`, then configure the DevTools-only loopback origin and
launch the planar page:

```js
wx.setStorageSync('terra.planarServiceOrigin', 'http://127.0.0.1:18081')
wx.reLaunch({ url: '/pages/planar/index' })
```

Request-domain checking must be disabled only for this local HTTP run.
Deployment and physical-device services still require an authorized HTTPS
origin. A ready frame must show:

```text
PS 1k terrain ready
patches 4 | records 2 | draws 4 | vertices 8580 | texture ready
```

Use the toolbar instead of mouse or keyboard gestures:

- `Top`: fixed bird view; the whole terrain footprint remains visible.
- `-` / `+`: deterministic zoom out/in; terrain size changes without data loss.
- `45`: fixed -45 degree view; relief and terrain silhouette are visible.
- `T`: PS 1k source texture; image alignment follows the terrain surface.
- `H`: elevation colors; the surface contains a blue/green/light height range,
  not one flat color.
- `R`: exact initial -45 degree textured view.
- `C`: copy the credential-free `terra.miniprogram.planar-runtime.v1` report.

A manual pass requires the expected counters, nonblank texture and height
views, visible changes after camera actions, and exact visual reset. The page
does not require touch interaction, so DevTools can cover the complete fixed
action sequence.

## Run Automated Web Evidence

Run the real Wasm module and renderer in a Chromium-compatible headless
browser:

```bash
bash scripts/verify_planar_web.sh
```

When the Wasm gate already passed in the same workspace, skip rebuilding it:

```bash
PLANAR_WEB_SKIP_WASM_GATE=1 bash scripts/verify_planar_web.sh
```

The script captures `initial_45_texture`, `bird_texture`,
`bird_zoom_texture`, `tilt_45_height`, and `reset_texture`. It rejects missing
or blank images, incorrect draw/state counters, insufficient height-color
variation, camera actions without image changes, and reset drift. Outputs are
written to:

```text
viewer_verify_output/planar_web/
  report.html
  report.json
  summary.json
  *.png
```

Open `report.html` for the fixed-action image strip and machine-readable state.
The browser must be Chromium-compatible; set `WEB_SDK_BROWSER_BIN` when it is
not discoverable from WSL.

## Evidence Boundary

A passing Web report establishes deterministic PS 1k transport, native/Wasm
frame parity, terrain decode, planar mesh topology, texture loading, height
variation, WebGL submission, and fixed camera behavior. It does not replace
globe-specific imagery alignment, touch behavior, HTTPS/request-domain
authorization, device performance, or Tianditu attribution acceptance.

DevTools and physical-device review remain the final user acceptance step and
do not block automated engineering progress. Use the load-only page first when
the visual page cannot reach ready state; it separates service/transport
failures from Wasm or renderer failures.
