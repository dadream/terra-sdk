# Native mesh residency diagnostic

This private Wasm target compiles the production C API translation unit with a
read-only paged inspection export. It is not a distributed SDK or a timing/heap
acceptance build. Build and keep all outputs on the test-data mount:

```bash
emcmake cmake -S tests/wasm/mesh_residency \
  -B viewer_verify_output/mesh_residency/build -DCMAKE_BUILD_TYPE=Release
cmake --build viewer_verify_output/mesh_residency/build --parallel 4

python3 tests/wasm/mesh_residency/run.py \
  --fixture-site viewer_verify_output/web_sdk/site \
  --wasm viewer_verify_output/mesh_residency/build/mesh_residency_diagnostic.wasm \
  --browser /absolute/path/to/chromium \
  --output viewer_verify_output/mesh_residency/replay-01
```

Run the build in the repository's Emscripten Docker environment. The fixture
site must come from `verify_web_sdk.sh`; it supplies the offline test data and
test-page helpers. Stale pages/helpers are rejected before creating output;
rebuild the site with `scripts/build_web_sdk_harness.js` after test code changes.
The driver builds current browser/Worker bundles, copies the
current harness, and verifies the private export before starting a local server.
Use a fresh output path for each intentional experiment; existing evidence is
never overwritten. Port18766 is rejected. The run is bounded to240seconds,
records input hashes and process/profile cleanup, and leaves the manual service
alone. Exit0 means collection completed, while `receipt.json.passed` remains
false: the intentional harness failure is not accepted by the release gate.

`probe.js` installs a private Worker method and instruments a copy of the Web
memory replay. It preserves the one warmup and two measured laps, takes an
ownership snapshot after each idle sample, and stops before later scenarios.
The intentional terminal diagnostic is not a passing release result.

Each row identifies immutable mesh/UV payload and the cache, current output,
presentation, prepared frame, replacement, and loan references. The temporary
inspection reference is excluded. Unclassified shared owners remain visible
in the total reference count; they must not be presumed leaked. Unique position
and UV bytes must reconcile exactly with `terra_mesh_payload_bytes`.

Compare corresponding views by spatial key and resource identity. Distinguish
cache-only residents from resources still held by production or presentation.
Inspection itself uses temporary memory and a Worker call, so use the original
production build and release gate for capacity/latency acceptance. The gate
audits accounted residency and exact idle refunds; it reports Wasm allocation
growth separately because transient cache history can differ across laps.
The amount of cache accumulated before the first sample can vary with earlier
asynchronous publications. Equal final displayed IDs within a run do not prove
equal intermediate publications or equal cache contents. A non-reproducing
diagnostic does not invalidate an earlier failed production replay.
