# Joint capacity diagnostic

This is the rendering/ownership layer after the independent Native and Wasm
scheduling benchmarks. It runs the public browser Worker, real WebGL, the
versioned offline Tai'an terrain pack and the nominal Tianditu geodetic grid.
One real 256px PNG supplies image decoding/upload cost. It does not measure
online imagery quality, network throughput or acceptance on mobile devices.

```bash
python3 scripts/benchmark_joint_capacity.py \
  --reference viewer_verify_output/imagery_target_20261022/final/oblique/report.json \
  --wasm workspace_old/site/assets/terra_sdk.wasm \
  --tile viewer_verify_output/terrain_capacity_20261022/hardware/site/tile.png \
  --browser viewer_verify_output/vertical_scale_20261016/hardware_chrome155/chromium.sh \
  --output viewer_verify_output/joint_capacity_NEW \
  --sdk-defaults --visibility renderer \
  --pose-count 10 --observation-seconds 30
```

Use an existing parent and a fresh output directory under the verified data
mount. The supplied Wasm must be the production build matching the current JS;
artifact hashes are recorded. Reference camera/configuration and the complete
v2 input subset in the v4 captured pack are checked before browser startup.
There is no fallback to a live terrain service. Port18766 is forbidden; the
manual service remains running. Browser/profile and temporary server cleanup
are mandatory even on failure/interruption.

The defaults are ten poses, 768MiB shared capacity, 64MiB terrain selection and
30 seconds per pose. `--sdk-defaults` omits public capacity overrides and checks
the effective SDK policy; explicit smaller profiles remain pressure tests.
The canonical nadir reference is also supported with `--pose-count 33`. Prefixes
preserve the original poses and progressive data discovery. Capacity evidence
applies to the measured route, viewport and precision, not every application.

Every pose records the final sets, native progressive-reference differences,
current camera matrix, precision, sampled bytes, ledger lifetime high-water,
owner/phase breakdown, pending work and five-second progress snapshots. The
progress element is hidden and receives only bounded summaries once a second;
full graphs are serialized after collection. Rendering megabytes of live
diagnostic text can otherwise dominate the measured browser scheduling time.
The original 30-second condition is reported independently from the observation
limit. Source-level-only completion is explicitly data-limited, never target
precision success. Missing coverage, terrain precision failure or pending
work cannot qualify as settled. A shorter route cannot qualify as complete.

`ownership.js` reads the declared eviction graph without allocating, evicting,
touching LRU or asking Native to reclaim. It computes disposable roots and
the dependent allocations released only when all their owners are released.
Unknown owners and rootless cycles remain charged. **The remaining bytes are
not a minimum-capacity proof**: async Native caches can still be included.

Only after all primary prefix samples finish, the diagnostic requests the
existing Native mesh cache refund. It independently counts unique XYZ and UV
payloads from presented descriptors, records actual refunds, frame/set
identity and quality. It does not force-release other owners or pause the
viewer; it does not assert pixel equality. This does not contaminate primary
trajectory occupancy, and the report preserves the pre-refund graph.

Exit0 means collection and cleanup completed, even if convergence timed out.
`receipt.passed` and `sdkProductAccepted` always remain false: use
`routePrefixCompleted`, `fullRouteCompleted`, `withinOriginalDeadline`,
per-pose `quality` and reference differences to assess the actual result.
These records do not replace the separate industrial acceptance gate.
Runtime failures retain the underlying error and terrain/Worker diagnostics;
a generic collection failure alone must not hide the producer that failed.

`--visibility renderer` preserves production GPU occlusion and is the default.
`--visibility all-visible` disables only the injected GPU visibility observer
through the existing viewer factory option, for comparison with the headless
oracle. Frustum/backface selection and terrain/imagery errors remain unchanged.
The option is recorded in `case.json`, `inputs.json` and `report.json`; it is not
a production optimization or a production-performance result.

After each timed observation, `visibility.js` copies the scene and current
observer evidence without requesting frames, queries, resets or reclamation.
The comparator reuses the SDK evidence validator and checks that the planner
acknowledged the same revision and hidden count. A hidden count alone, a stale
proof or an unrecorded historical snapshot cannot prove comparable input.

`reference-comparison.json` v2 keeps literal physical-image set differences,
then reports whether each comparison is meaningful. The frozen oracle has no
GPU depth occlusion. Exact image comparison requires an aligned settled camera,
matching frozen terrain and no accepted GPU occlusion; other rows are
`not-comparable`, never automatically passed or failed. Submitted images can
include coarse coverage behind other terrain, so they are not a pixel-visible
precision map. Even matching IDs do not prove visual correctness.
`receipt.rawImageSetsMatch` is literal equality; `imageryReferenceMatches` is
`null` if any row is not comparable. Historical files remain immutable and can
be reanalyzed with the standalone `compare_reference.js` CLI.

Run the small ownership negative contracts with:

```bash
node tests/benchmarks/joint_capacity_test.js
```

Add `--reclaim-idle` to audit the remaining Native imagery inputs/references,
decoded records, heights and mesh cache, followed by the synchronous eviction
closure. This happens only after all requested primary samples have settled.
It keeps the runtime active, the current cut and all declared ownership rules;
it does not pause the viewer or delete protected renderer resources.

The audit records actual per-owner receipts, two bounded passes, unchanged
frame/set identity, and real framebuffer bytes. A submitted readback frame
can still have its GPU/frame-clock receipt pending: allow up to two seconds
for that specific work to complete before requiring idle again. This does not
extend primary convergence deadlines. Two submissions before reclamation
check that the control image itself is stable. Native and synchronous stages
also record pixel differences; the final image must match byte for byte.

`fixedPoint` describes the two refund passes, not a mathematical minimum.
Readback can recreate the disposable `display-commands` cache between passes,
so a nonzero second synchronous refund need not indicate a leak. The full
snapshots keep that allocation visible. Actual retained bytes demonstrate a
sufficient residency for that settled cut under the current policy, including
navigation progress reserves. They do not prove the minimum capacity, the
capacity needed by other views, or the extra space required by a transition.

Any pixel/control/receipt failure remains a failed diagnostic with the partial
audit in `report.json`; it cannot be treated as a successful capacity proof.
