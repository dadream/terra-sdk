# Controlled continuous navigation

This diagnostic isolates production Web scheduling from live source variability.
It retains actual CBDAM terrain, the unified imagery pyramid and source adapter,
Worker/Direct execution, image decode, UV production, WebGL uploads and receipts.
It uses verified local terrain and one real256px PNG for every requested image.
It therefore does not measure Internet throughput, real image content quality,
pixel continuity, or mobile-device readiness.

The default `--case oblique` is `testdata/benchmarks/beijing-oblique-flight-v1.json`:
Beijing116.5623°,40.74863°, range9567m, tilt76.3°,1280×757 atDPR1,
FOV0.5233333333333333, terrain/imagery error1.25px. The public `camera.flyTo`
uses its direct path over8000ms, from heading14.5° to exactly158.5°. That path
uses the SDK's smoothstep interpolation. It is distinct from the demo's
constant-speed orbit, whose stop angle can depend on frame timing.

`--case zoom` selects `taian-rapid-zoom-v1.json`: Tai'an117.12350°,36.21228°,
heading/tilt0°,960×640,DPR1 and the existing reference ground248.363589m.
Public camera.setView advances logarithmic range over4000ms from25512000m to
570.521491m; after conditioning the near endpoint, a second4000ms leg returns
to global range. This crosses the intermediate texture scales continuously.
Each leg has124 declared logarithmic intervals, matching input discovery.
The display clock coalesces overdue inputs onto these fixed poses instead of
inventing different intermediate floating-point camera values on each run.
The global endpoint sets must equal the initial converged sets.

The near endpoint has a pre-existing source limit in the canonical static
reference: maximum physical source level17 reaches1.3961891432px, not1.25px.
Only that named endpoint may finish as `source-limited`, with exact current
terrain, complete idle coverage, no refinable measurements, level17 imagery
and error no worse than that reference. It is never reported as target-met.
All other endpoints must meet1.25px. This classification preserves the source
limit already accepted by the static33-point route, without changing SDK error.

Both endpoints must reach current-camera terrain and imagery precision, complete
coverage, no pending work/requests/GPU/ground demand, and250ms of unchanged
presented identity within30000ms. The preparation timer begins after viewer
creation, which is reported separately. A preparation timeout prevents motion;
a settlement timeout is retained as a failed endpoint, not a pass. No timeout
extension, decoder override or relaxed error is accepted by this collector.
The motion watchdog allows at most1000ms after its declared duration for the
animation's final callback; its actual duration is reported.

```bash
python3 scripts/benchmark_navigation.py \
  --wasm workspace_old/site/assets/terra_sdk.wasm \
  --tile viewer_verify_output/terrain_capacity_20261022/hardware/site/tile.png \
  --browser viewer_verify_output/vertical_scale_20261016/hardware_chrome155/chromium.sh \
  --output viewer_verify_output/navigation_new_run \
  --backend both --trace-pipeline
```

Use a new directory on the verified data mount. The default temporary port is
allocated automatically; the manual18766 service is excluded. Capacity can be
changed using `--managed-bytes`, `--terrain-mesh-bytes` and `--partition-bytes`;
the effective settings are checked and recorded. The current default imagery share
is256MiB: the live handoff retained about223MiB of GPU images and still needed
the bounded8MiB encoded input,8.5MiB producer and group destinations. The earlier
224MiB share suppressed late input overlap despite shared headroom;160MiB could
not hold the target handoff. The shared default remains768MiB. Keep smaller settings as
explicit pressure profiles, and increase inadequate capacity without changing
precision or deadlines.

Sparse cold coverage is a priority, not a mandatory root-to-leaf download chain.
An already downloaded finer image may skip a slow optional ancestor; its full
GPU/UV group must still pass ordinary admission. Missing/cancelled encoded input
does not qualify for this shortcut.

For a JS scheduling comparison, `--sdk-snapshot <archived-inputs.json>` loads
only the archived `sdk.js`, `terra_worker.js` and matching Wasm from its sibling
`site/`. Every asset must match its recorded hash and size; the supplied Wasm
must be identical. The report records snapshot provenance. It does not assume
the archive's commit ID alone describes any uncommitted code captured with it.

Each backend/repetition uses a new browser profile and runtime. Alternating the
backend order across repetitions reduces order bias. The declared path and
endpoints are fixed; event delivery, intermediate mesh publications and request
sets are still asynchronous. Compare converged endpoint sets before attributing
latency, and use repeated observations before claiming a general speedup.

`report.json` retains phase times, sampled mesh/imagery versions, queue counts,
Native preparation counters, capacity, endpoint spatial sets and diagnostics.
Optional pipeline traces use the same relative monotonic clock as phase times;
the absolute monotonic origin is also recorded. Trace truncation invalidates
complete event-count conclusions. Work counter sums overlap and are not an
exclusive critical path. Blank/missing counts describe sampled SDK state, not
an independent pixel correctness check.

The collector's exit0 means evidence and mandatory cleanup were collected,
including endpoint timeouts. Inspect `motionExecuted`, `settled`,
`withinOriginalDeadline`, per-phase status and `receipt.json`. Runtime, missing
input, changed snapshot or cleanup failures produce nonzero exit. Every outcome
closes its viewer/Worker, browser/profile and temporary server. A missing terrain
key is an infrastructure failure and is never synthesized as a service404.
Primary failure and cleanup errors are kept separately; retained resource owners
are recorded even after producers stop. `sdkProductAccepted` remains false.

Run the separate functional gate after collection:

```bash
python3 scripts/check_navigation.py viewer_verify_output/navigation_new_run
```

Its exit1 rejects timeouts, skipped legs, missing coverage, unapproved source
limits, precision/capacity failure, changed inputs, or incomplete cleanup.
It does not claim live-image or pixel acceptance. Preserve the raw reports on
failure instead of extending deadlines or repeating until a pass.

For a separate real-source check add `--live-imagery --visual` and use
`check_navigation.py --live <output>`. Terrain remains the same verified fixture;
only Tianditu images use the existing49 proxy. The bounded server records network
activity and closes all connections. Up to24 submitted-canvas PNGs retain phase,
view and hash for visual inspection. Readback adds work, so these observations
must not be included in offline timing comparisons. A successful state gate
does not automatically approve the PNGs or prove continuous pixel stability.
`--trace-pipeline` also records bounded planning cancellations and capacity
refusals, alongside producer job/reset counters; it creates no new requests.
Transport header times and body-credit wait counts distinguish remote latency
from local producer waits; observing fetch preserves its original promise.
Use one backend and `--repetitions 1` per live capture; repeat into independent
directories. The acquisition server has a180-second lifetime for the whole
capture, including browser startup, conditioning and cleanup.

Input acquisition is explicit and excluded from that gate. `capture.js` gathers
dense Native endpoint cuts and one available-input frontier. Dynamic terrain
handoffs may request additional keys; `--capture-terrain http://49.233.185.96`
runs a bounded acquisition server for the actual path, preserving validated
responses and verifying socket cleanup. It never silently enables network access
in offline replay. The zoom pack also preserves the keys from the first two
incomplete replay reports. Source/manifest, identities and cleanup are retained
under `viewer_verify_output/web_scope_20261026_zoom_inputs/` and the corresponding
`zoom_capture`, `zoom_acquisition` and `zoom_path_capture` directories.

Focused contracts:

```bash
node tests/benchmarks/navigation/acceptance_test.js
node tests/benchmarks/static_view/snapshot_test.js
python3 -B tests/benchmarks/navigation/check_test.py
```
