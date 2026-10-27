# Fixed Beijing oblique control

This complements the Tai'an desktop/SDK scheduling oracle and joint-capacity
route. It freezes the larger Web demo view that previously needed more than
30 seconds on the live service:116.5623,40.74863; range9567m; heading14.5°;
tilt76.3°;1280×757 pixels; terrain/imagery error1.25px. The FOV deliberately
matches the demo's existing `30 * (3.14 / 180)` value, not a rounded replacement.

```bash
python3 scripts/benchmark_static_view.py \
  --wasm workspace_old/site/assets/terra_sdk.wasm \
  --tile viewer_verify_output/terrain_capacity_20261022/hardware/site/tile.png \
  --browser viewer_verify_output/vertical_scale_20261016/hardware_chrome155/chromium.sh \
  --output viewer_verify_output/static_view_NEW
```

The command generates an immutable site from the current SDK, then runs one
fresh Worker browser and one fresh Direct browser. Use `--repetitions 3` for
timing comparisons; order alternates between repetitions. `--backend worker`
or `direct` narrows a diagnostic. Port18766 is forbidden. The manual service is
not rebuilt, restarted or used. Evidence must be written to the mounted test
directory, and an existing output directory is never overwritten.

Both adapters fetch/compile the same Wasm inside the measured viewer creation.
`createdMs` separates startup from later convergence; the entire timed duration
still includes startup. DOM scripts and terrain fixtures load before timing.
The SDK uses real WebGL, production terrain/imagery scheduling, actual256px PNG
fetch/decode/upload, and its normal GPU visibility mechanism. Every external
image key receives the same local PNG under the nominal Tianditu grid. This
does not measure real imagery content, WAN latency or mobile performance.
Unknown terrain keys fail; there is no live fallback or fabricated404.

Default capacity is asserted as64MiB terrain selection and768MiB shared managed
ownership. To evaluate another capacity, pass `--terrain-mesh-bytes` and/or
`--managed-bytes`; these are the normal public instance options. They do not
relax precision, change the view or bypass allocation accounting. The report
keeps effective capacity, selected sets, Native cache bytes, ledger high-water,
capacity reductions and error. Cache residency can depend on history even when
the final spatial sets match. Ledger bytes are not total process/GPU-driver RAM.

The original convergence criterion remains30 seconds. The default60-second
observation preserves the state at that deadline and can collect a later
result; it does not extend acceptance. A ready result requires the current
camera, error targets, complete coverage, idle requests/terrain/partition/GPU
work and250ms of unchanged presented identity. Capacity/data-limited endpoints
do not pass. `postCreation` phase counters begin after viewer creation; the
last complete plan timestamp can belong to a later model than earlier plans.
It can also repeat a cached result. `firstCompleteForLastMeshMs` records the
first accepted complete current-camera plan after the last mesh publication
began; a plan supplied inside that publication may precede `lastMeshMs`.
Neither timestamp alone measures exclusive computation or a critical path.
RPC durations overlap with each other and with rendering; never sum them into
a critical-path explanation.

`comparison.json` records literal differences in terrain, internal imagery,
source targets and presented images. A timing run with different final sets is
not a like-for-like improvement. A comparison with accepted depth occlusion is
marked ineligible for the unoccluded set comparison. Intermediate publications,
cache occupancy and asynchronous ordering can still differ with identical final
sets. Use repeated runs and phase/CPU profiling before attributing latency.

Exit0 means collection and mandatory cleanup completed, including timeouts of
the convergence criterion. Read `settled`, `withinOriginalDeadline`, precision,
set differences and `receipt.json`; `sdkProductAccepted` always remains false.
Runtime/input/cleanup errors fail the command. Every sample closes its viewer,
producer, browser/profile and temporary server; frozen asset hashes are checked
again after collection. This benchmark does not replace Tai'an's independent
desktop reference, moving-camera tests, pixel validation or device acceptance.

## Optional imagery pipeline trace

Add `--trace-pipeline` to record request/body completion, decoder admission,
the actual `createImageBitmap` call and its observed result, upload admission,
GPU completion and first submitted use of each image. The `pipeline` report
also records actual upload batch contents, image/UV group preparation and
100ms queue samples. `worlds` records each display preparation's captured and
installed goal versions; `goals` distinguishes changed input rows from ordering
alone. World work records the remaining host deadline and exhausted entries;
`worldAdmission.scopedReady` counts queries admitted while the complete world
receipt is still stale, not distinct images or completed downloads. These fields
separate waiting for numerical preparation from network and decoder waits.
It installs observation wrappers after viewer creation;
startup work before installation is outside this trace. It adds no timers,
GPU queries, requests, ownership holds or retries, and restores all methods
before teardown. Each event collection has a4096-row cap; reject truncated
traces as incomplete evidence. The focused observer contract is:

```bash
node tests/benchmarks/static_view/pipeline_trace_test.js
```

`bitmapCalledMs..bitmapObservedMs` includes browser scheduling and delivery to
the main thread. It is not exclusive decoding CPU time. `work` aggregates
synchronous renderer/resource callback wall time by second. Per-image waits
overlap with one another and with these callbacks; do not add their sums to
explain elapsed scenario time. Rejected upload attempts are distinct from an
accepted upload and its GPU receipt. Superseded images can have no display
timestamp; compare the final spatial sets separately.

`demands` records immutable target changes after the actual requirement tree
has been built. Each request points to a demand version, with current-camera
fitted (bit1), provisional (bit2), or whole-mesh coverage proof (bit4) flags;
several meshes can contribute flags to one physical image. It also records
root, coverage, candidate and forecast roles. A preview can retain fitted rows,
and a fitted cut can still use loose measurements: neither label alone proves
that a request belongs to final precision. Target deltas have an additional
65,536-key total limit. Overflow invalidates the trace instead of silently
attributing requests to a stale version.

For a settled report, compare observed requests with the final spatial cut:

```bash
python3 tests/benchmarks/static_view/analyze_demand.py \
  viewer_verify_output/static_view_NEW/worker-1/report.json \
  --output viewer_verify_output/static_view_NEW/demand-analysis.json
```

This offline command refuses truncated or unsettled evidence and existing
output files. It distinguishes final targets, their ancestors, descendants
finer than the final cut, and other keys. Non-final requests can legitimately
provide intermediate coverage. `drawObserved` means submitted drawing intent,
not a confirmed GPU/display receipt; requests before observer installation
are outside the analysis. Compare final terrain, internal imagery and physical
image sets before interpreting request or duration differences.

`--decode-tasks 1` or `4` optionally caps the current browser decoder count
after creation for a controlled comparison. This is a benchmark-only internal
override, not a public SDK setting or added capacity. Reports record both the
configured and effective count; the override cannot exceed the configured
ceiling. Use fresh processes in alternating order with identical SDK assets,
view, precision, memory budgets and deadline. An improvement in one queue does
not by itself establish end-to-end improvement or product acceptance.
