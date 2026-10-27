# Terra SDK Release Guide

The current package version is0.1.0, with C ABI47 and Worker protocol48.
The authoritative versions are in `CMakeLists.txt`,
`sdk/include/terra/c_api/terra.h` and `adapters/wasm/worker_protocol.js`.
Development replaces incompatible interfaces directly; callers must ship matching
JS, Worker and Wasm assets. This is a developer preview, not a declaration of
industrial navigation or mobile-device acceptance.

## Release surfaces

- `terra-sdk-<version>-native.tar.gz`: C++14 static libraries, C ABI, public
  headers, CMake package metadata, installed-consumer examples and licenses.
- `terra-sdk-<version>-miniprogram.tar.gz`: Wasm, CommonJS SDK and host modules,
  browser/Worker assets, TypeScript facade, manifests, documentation and licenses.

Native consumers link `Terra::core`, `Terra::codec`, `Terra::frame` or
`Terra::c_api`. Versioned C structures initialize `struct_size` and `api_version`
where present. Native exports must not reference desktop-only dependencies.
Terrain repositories and provider credentials must not enter either archive.

The CommonJS default entry is the Mini Program facade; browser consumers use
`adapters/browser/terra_viewer.js` or the generated browser bundle. The graph is
owned by `scripts/sdk_modules.js`. Mini Program staging excludes browser/Worker
modules. Every restage reconciles generated module directories with the current
graph, including removed modules; separately built Wasm and licenses are retained.
The public types are `sdk/js/api/terra_viewer.d.ts`.

Minification preserves public properties and explicit error identities. Internal
function names and stack-frame spelling are not public API. Source contracts run
again against the compressed package.512KiB is an advisory core-size reference,
not a release limit; measured size is reported in`release_manifest.json`.
Runtime resource limits are independent and remain enforced.

## Engineering verification

Use the repository-owned Docker environment:

```bash
bash scripts/build_docker_image.sh
bash scripts/verify_baseline.sh
bash scripts/verify_sdk_release.sh
```

The baseline covers core/native SDK, decoder golden data, services, builders,
desktop clients, Wasm/source/packaged contracts and benchmark contracts. The
release gate additionally checks real WebGL evidence, installed consumers,
reproducible archives, dependency/license manifests and the product site.
`SDK_RELEASE_SKIP_BUILD=1` skips only a previously completed root CMake build.
When these gates share an identical candidate, a recorded orchestration may reuse
already passed identical stages; preserve input hashes and every remaining stage.
A failed or modified stage must run again. Do not call packaging alone a release
pass. No preflight is used.

The Web evidence runner allows600 seconds for the complete suite by default
(`WEB_SDK_BROWSER_TIMEOUT_SECONDS`). This includes all scenarios and browser
startup/cleanup; each scenario retains its own acceptance deadline. The former
45-second suite timeout predates the navigation checks and cannot cover them.

For changed camera/rendering behavior also run:

```bash
bash scripts/verify_planar_web.sh
bash scripts/verify_globe.sh
```

The globe gate requires the external dataset via`GLOBE_DATA_DIR`. Optional live
Tianditu desktop checks require server-side credentials; never commit them. Missing
input is a recorded unmet check, not a synthetic success. Compilation must have
zero warnings. A command's exit status and the evidence's acceptance status must
both be interpreted according to that tool's contract.

## Continuous navigation regression

`tests/benchmarks/navigation/README.md` defines the two fixed Web cases and their
inputs: Tai'an global/near/global zoom and Beijing76.3-degree rotation. Collect
into a new output directory, then run the independent acceptance checker:

```bash
python3 scripts/benchmark_navigation.py --help
python3 scripts/check_navigation.py viewer_verify_output/<run>
```

Collection alone is not acceptance. Endpoints must meet current terrain/image
precision, coverage, idle ownership and the unchanged30-second deadline with a
250ms stable window. Only the declared Tai'an near endpoint may report the
pre-existing level17 source limit of1.3961891432px; it is not a1.25px target pass.
Global return and repeated/live/offline endpoint sets are compared by identity.

Live imagery adds`--live-imagery --visual`; use`check_navigation.py --live` and
inspect recorded frames separately. Report upstream failures even if a later
request or bounded recovery observation succeeds. Do not extend deadlines or
repeat until a favorable result. State samples cannot certify pixel continuity.
The last scoped baseline and its known motion limitations are in
`SDK_PRODUCTIZATION_PLAN.md`; they do not automatically validate a newer build.

## Outputs and local deployment

Builds and packages live under`workspace_old/`; verification evidence lives under
`viewer_verify_output/`. On the current workstation the latter is a persistent
bind mount to the data disk. Before producing outputs:

```bash
mountpoint -q viewer_verify_output
```

`package_sdk_release.sh` writes the two archives, checksums, release manifest and
SPDX inventory under`workspace_old/package/release/`. SPDX records the current
commit; after the final commit, refresh the package and verify those identities.
The same accepted JS/Worker/Wasm hashes must reach the deployed site.

The current manual service is`terra-sdk-web-local.service` on port18766, with
runtime files under`viewer_verify_output/workstation_web/`. Its start rebuilds
the site from the active worktree; C++ changes require rebuilding Wasm first.
Update once at the delivery milestone and verify the deployed assets with bounded
requests. Preserve the background service across session/SSH disconnects.
Server49 remains the existing data upstream; do not deploy there in this phase.

Every automated live check must close its pages, contexts, browser/runtime handles,
workers, temporary servers and connections on success, failure or interruption.
Verify test-owned producers stopped; keep only the user-requested manual service.
Do not monitor a live application endpoint after the check. Cleanup uncertainty
is a failed check, even if the rendered result looked correct.

## Git and CI

Ordinary Git uses author`dadream <285083020@qq.com>`. A reviewed squash commit
can enter main by fast-forward while retaining the original development branch
as history. The desktop oracle's baseline must remain an ancestor. Verify the
remote main has not advanced before pushing; never overwrite concurrent work.

`.github/workflows/sdk-ci.yml` runs the SDK release gate for main, the development
branch, pull requests and version tags. Only a matching version tag publishes
preview release assets. Updating main does not deploy services to49. Tagged
release notes and metadata must match the package; existing releases are not
replaced. See`PRODUCT_SITE_RELEASE.md` for the separate publication workflow.

## Product limits and redistribution

Current Web validation covers bounded fixed scenarios, not arbitrary long flights,
all GPUs or continuous30FPS. Coarse coverage and source-level seams can appear
while moving. Upstream outages may exceed the endpoint deadline. DevTools,
Android and iOS remain separate manual acceptance; retained platform modules
are not evidence of completed device validation.

Keep`LICENSE`, `NOTICE`, `spacelib/COPYING` and`ratman/LICENSE` in distributions.
Imported license conditions remain in force. Review those terms before
redistribution; packaging does not change the underlying permissions.
