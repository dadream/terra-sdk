# Globe Tour Web Verification

## Purpose

This harness validates the SDK camera-motion and globe-rendering interfaces
with the Suzhou POI bicycle tour. It uses local data services only; CloudBase
is not part of the request path.

```text
browser -> local Web proxy -> local globe terrain service
                           -> local imagery service -> Blue Marble files
                                                    -> Tianditu cache/upstream
```

The checked-in fixture contains WGS84 POIs and route geometry. Regeneration
requires an Amap Web Service key, but no Amap or Tianditu credential is stored
in source control.

## Start Manual Verification

From the repository root:

```bash
export TIANDITU_TOKEN='<server token>'
bash scripts/start_globe_tour_web.sh
```

Open `http://127.0.0.1:18766/`. The launcher starts three host-network Docker
containers for terrain, imagery, and the Web app. Press `Ctrl+C` when finished;
the launcher removes all three containers.

For the complete local Blue Marble pyramid, start with:

```bash
GLOBE_TOUR_IMAGERY_PROFILE=blue-marble \
  bash scripts/start_globe_tour_web.sh
```

The bare Web URL redirects to the profile selected at startup. Blue Marble
shows `Imagery: NASA Blue Marble`; Tianditu shows `© 天地图`.

Verify the following sequence:

1. The globe, terrain, selected imagery, route, four POIs, and matching
   attribution load.
2. `全览` frames every POI and the full route.
3. `上一步` and `下一步` fly smoothly between POIs without camera jumps.
4. `顺时针` and `逆时针` orbit the selected POI; `停止` ends the motion.
5. `沿路线` follows the route to the next POI; `暂停` and `继续路线` preserve
   progress.
6. Pointer drag keeps continuous imagery, terrain, POIs, and route
   overlays visible. A short close-range drag must remain in the local area;
   wheel zoom remains usable after scripted camera motion.
7. Repeatedly zoom out from the textured Suzhou view until the whole globe is
   visible. Selected imagery must remain visible while exact low-resolution
   tiles load; the globe must not switch to the solid fallback color. Zooming
   back in must restore exact imagery without a camera jump.
8. Use `Globe` from a distant local view. The camera must ascend and flatten,
   cruise across the globe, then descend to Beijing instead of translating at
   low altitude. The debug panel must expose `surface current/previous` and
   `pending geometry` during LOD transitions.

## Automated Evidence

Use the complete local Blue Marble pyramid for the deterministic baseline:

```bash
GLOBE_TOUR_IMAGERY_PROFILE=blue-marble \
  bash scripts/verify_globe_tour_web.sh
```

Use the default Tianditu profile for the online integration check:

```bash
export TIANDITU_TOKEN='<server token>'
bash scripts/verify_globe_tour_web.sh
```

The finite desktop and mobile checks validate attribution, POIs, route,
fly-to, orbit, pause/resume, completion, terrain requests, drag-time texture
retention, repeated local wheel zoom, and city-to-global zoom. The global
transition check reaches approximately `2.5R` and requires complete root
coverage before refinement, zero missing texture bindings, and a settled
root-to-leaf presentation cut. Parent textures remain visible until each
required child group is complete. Drag and zoom checks require textured,
nonblank framebuffers. Evidence is written to
`viewer_verify_output/globe_tour_web_verify/`. Automated verification uses
dedicated containers and ports, so it does not replace a running manual
session. The script always closes Chromium
and removes its containers, including failure and interruption paths.

## Refresh Tour Data

```bash
AMAP_WEB_SERVICE_KEY='<web service key>' \
  node scripts/generate_suzhou_tour_fixture.js
node tests/miniprogram/suzhou_tour_fixture_test.js
```

Review POI identity, route order, coordinate conversion, and summary metrics
before accepting a regenerated `testdata/tours/suzhou-gardens-bicycle.v1.json`.
