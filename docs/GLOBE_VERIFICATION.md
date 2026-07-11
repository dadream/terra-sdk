# Globe Terrain Verification

## Purpose

This gate freezes spherical terrain behavior before extracting the
platform-neutral SDK and mini-program renderer. It verifies that viewer and
nav3d can load EPSG:4326 globe terrain, render global-geodetic imagery, and
produce repeatable camera and framebuffer evidence.

Local Blue Marble imagery is the deterministic regression baseline. Tianditu
is an explicit online extension because credentials, network policy, and
service availability are not deterministic.

## Dataset Contract

The scripts use `GLOBE_DATA_DIR=/mnt/s/terra-data/globe` by default:

```text
terrain.data
terrain.root
terrain.xml
blue-marble-global-geodetic/victms.xml
blue-marble-global-geodetic/00..07/
```

`terrain.xml` must describe `EPSG:4326` terrain with a spherical or cylindrical
coordinate transform. The current data uses a 6,378,000 m radius. Scripts
mount this external directory read-only at `/globe`; large data is not copied
into Git.

Override the location when necessary:

```bash
GLOBE_DATA_DIR=/path/to/globe bash scripts/verify_globe.sh
```

## Offline Gate

Build once, then run the aggregate globe gate:

```bash
bash scripts/build_cmake.sh
bash scripts/verify_globe.sh
```

The gate builds and runs `terra_sdk_geo_tilemap_smoke`, followed by:

```bash
bash scripts/verify_viewer_globe.sh
bash scripts/verify_nav3d_globe.sh
```

Viewer captures fixed bird view, zoom, 45-degree tilt, zoom out, yaw rotation,
statistics, and reset. Every state must report `planar=false`, connected
terrain, and rendered triangles. Reset must restore the initial camera.

Nav3d loads `testdata/nav3d/globe/local_blue_marble.xml`, waits for renderer
initialization, captures the OpenGL viewport, and exits. Its log must report
the spherical projection, terrain and texture readiness, update thread,
renderer, and capture. Window chrome makes the viewport smaller than the
requested outer window, so validation requires at least 1000x600. Both
offline captures must match their reviewed baselines with a default sampled
mean absolute pixel difference no greater than 2.0.

Outputs:

```text
viewer_verify_output/globe/viewer_blue-marble/
  initial_birdview.png
  tilted_45.png
  state_*.json
  diff_*.png
  summary.json
  viewer.log
  report.html

viewer_verify_output/globe/nav3d_blue-marble/
  nav3d_globe.png
  nav3d.log
  summary.json
```

Open `viewer_blue-marble/report.html` for embedded baseline/current/diff
images. A valid first frame shows a complete textured Earth. The tilted frame
must show a continuous curved horizon. The nav3d capture should show China and
surrounding terrain with satellite imagery.

## Tianditu Satellite Layer

The supported Tianditu profile is:

```text
https://t{s}.tianditu.gov.cn/img_c/wmts
layer=img
style=default
format=tiles
matrix_set=c
matrix_range=1..18
internal_level_range=0..17
subdomains=8
```

Viewer and nav3d are native clients, so their online verification requires a
server-side/service-request Tianditu key. A browser-only key is rejected by the
service with permission-type error `301012`; do not make the native fetcher
impersonate a browser to bypass that restriction. Browser and mini-program keys
belong in their corresponding frontend network adapters.

Never store a token in XML, source, logs, or shell history. Export it:

```bash
read -rsp 'Tianditu token: ' TIANDITU_TOKEN
echo
export TIANDITU_TOKEN
GLOBE_TEXTURE_MODE=tianditu bash scripts/verify_viewer_globe.sh
GLOBE_TEXTURE_MODE=tianditu bash scripts/verify_nav3d_globe.sh
```

Enable both online checks in the aggregate gate with:

```bash
VERIFY_TIANDITU=1 bash scripts/verify_globe.sh
```

Online validation requires `wmts_source_connected`,
`wmts_tile_decoded`, nonblank top and bottom capture regions, and no fetch
warning. HTTP 4xx/5xx, CloudWAF responses, missing credentials, or token
leakage fail the online check without invalidating the offline globe baseline.

Nav3d uses `testdata/nav3d/globe/tianditu.xml`. Viewer options are:

| Option | Meaning |
| --- | --- |
| `--wmts-url` | KVP endpoint; `{s}` selects a subdomain |
| `--wmts-layer` | Service layer identifier |
| `--wmts-style` | Style, normally `default` |
| `--wmts-format` | Format value, normally `tiles` |
| `--wmts-matrix-set` | Matrix set, `c` for geographic imagery |
| `--wmts-level-offset` | WMTS matrix minus internal level |
| `--wmts-max-level` | Highest internal level; Tianditu `c` uses `17` |
| `--wmts-subdomains` | Number of `{s}` values starting at zero |
| `--wmts-token-parameter` | Query name, normally `tk` |
| `--wmts-token-env` | Environment variable containing the token |

Nav3d `<wmts>` uses the equivalent `matrix_level_offset`, `max_level`,
`subdomains`, `token_parameter`, and `token_env` attributes.

## Mapping Contract

`vic::geo::base::wmts_global_geodetic_source` is C++14-only and has no Qt,
OpenGL, CURL, or application dependency. For an internal tile at level `L`:

- WMTS matrix is `L + matrix_level_offset`; Tianditu uses offset 1.
- Tianditu advertises matrices 1-18, corresponding to internal levels 0-17.
- Column is the internal west-to-east column.
- WMTS row is `2^L - 1 - tms_row`; WMTS rows begin at the north.
- Level zero contains two 180x180-degree tiles.

`terra_sdk_geo_tilemap_smoke` freezes level-zero mapping, north/south row
conversion, subdomain selection, token omission, and the exact Tianditu KVP
URL contract.

## Baseline Policy

Reviewed assets live in `testdata/viewer_baseline/globe/`. Do not update them
for a failed run. An update requires both offline scripts to pass, full-size
report review, documented intentional state changes, and a green 1k baseline.

This gate supplements `scripts/verify_baseline.sh`; it does not replace the
1k, builder, service, installation, or compiler-warning gates.
