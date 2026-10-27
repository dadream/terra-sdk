# Terra WebAssembly SDK v1

## Shared boundary quote (ABI43, pending integration)

The current loader requires ABI43. `terra_mesh_replacement_work_bytes` now takes
the same sorted predecessor ID array as `terra_begin_mesh_replacement`. Immutable
meshes shared by both cuts contribute one boundary workspace and two output
memberships. The count-only ABI is removed; rebuild Wasm and its JavaScript host
together. The Worker message format is unchanged by this correction. This is a
capacity-accounting change, not a change to target precision or the seam proof.

## Private candidate boundary planning (ABI41 / Worker40, 2026-10-16)

Native boundary work may begin before generation or after a candidate is fully
generated and still unpublished. It remains forbidden during partial generation
and requires its own scratch credit. Commit waits until boundary work ends.
This supports the Worker runtime's late local-group admission without regenerating
or retransferring surviving mesh payload. Update Wasm and host together; ABI40
is rejected. Current candidate scheduling and release limitations are recorded in
`../SDK_PRODUCTIZATION_PLAN.md` and `../SDK_RELEASE.md`. The 512 KiB package
reference remains advisory; runtime resource limits and quality gates are unchanged.

## Imagery output ownership (ABI39 / Worker38, 2026-10-15)

The current Wasm/Worker contract adds output allocation quotes and actual output
ownership receipts. Native immutable snapshots and the bounded decoding scratch
buffer acquire shared-ledger credit before allocation. The replaced draw getter
converts at most 256 rows per call, using no complete intermediate ABI array.
Unchanged snapshots reuse JavaScript output; cancellation returns scratch credit
only, and reset/termination return resident credit on actual release.

`imageryOutput` reports this owner independently from `imageryInput` and
`imageryReferences`; all are subsets of total native imagery residency. Tree,
queue and JavaScript metadata are not yet fully budgeted. This is a prerequisite
for successor geometry/imagery joint admission, not its completion. Package
512 KiB remains advisory. Evidence lives under
`viewer_verify_output/imagery_output_credit_20261015/`.

## Reclaimable imagery indices (ABI38 / Worker37)

`terra_reclaim_imagery_references(context, needed_bytes, maximum_visits, restart,
released_bytes, pending)` scans across both sessions, with a maximum of 64
reference/node visits per call. It frees only stale or consumed index caches;
active and queued refinement inputs remain pinned. Returned released bytes describe actual
destruction. Pending permits another slice; intervening planning safely resets
the scan. Measured children remain reusable; reclamation does not repeat pending work.

Worker37 adds a control-lane `trim-imagery-references` message and mandatory
monotonic `imageryReferenceRevision` ownership replies. Reclamation does not
advance that revision; planning and nonempty admission updates do. Empty
admission notifications preserve the scan cursor and revision. The shared ledger can
therefore suppress unchanged no-op scans and retry after new eligibility.
Runtime `imageryReferenceReclamation` reports scans, slices, released bytes and
passes interrupted by planning changes. Existing index production grants still
apply after eviction. Native C/C++ callers explicitly invoke reclamation;
attached Web/Worker ledgers request it on pressure.

## Region-index production grants (ABI 37 / Worker 36)

`terra_step_imagery` takes `maximum_reference_work_bytes` before its completion
pointer. A zero grant advances work that needs no new index capacity. When an
allocation cannot fit, `terra_imagery_reference_work_bytes(context, session)`
returns its full new-buffer size; the old buffer remains owned until reserve
completes. `terra_imagery_reference_payload_bytes(context)` reports actual index
capacity across both sessions, as a subset of total native imagery bytes.
Invalid session quotes return UINT32_MAX.

Wasm obtains credit before each allocation-bearing step. Worker36 adds
`referenceWork`/`referenceGrant` and mandatory `imageryReferenceBytes` receipts.
Only the matching task may use a grant; cancellation intent does not release
live tree indices. Continuations retire obsolete indices with spare priority credits.
The shared ledger owner is `imagery-reference-native`; input and reference
owners are disjoint. The preferred64KiB batch is optional: the exact quoted
minimum remains sufficient to progress.

This contract covers region-index vectors, not all tree/queue/output metadata,
Wasm heap capacity or JS objects. Synchronous native C/C++ convenience planning
is caller-managed; use begin/step for explicit reference-budget control.

## Imagery input production grants (ABI 36 / Worker 35)

`terra_imagery_input_work_bytes(surface_count, region_count, hull_point_count)`
quotes native converted input capacity without allocating. Counts are the sum of
each surface's copied ranges, including duplication; UINT32_MAX is an
unrepresentable quote. `terra_plan_imagery` and `terra_begin_imagery` require
`maximum_input_work_bytes` as their last argument. This is additional production
credit while the previous input remains live. Insufficient credit returns
RESOURCE_LIMIT before conversion or mutation. The input payload counter reports
current arrays across both sessions; trees, queues and outputs are separate.

The Wasm planner reserves that quote plus its C packing buffers through the
attached shared ledger before allocation. Scratch survives cooperative yields and
is freed on cancellation/failure. Replacing/resetting/closing input reports actual
residency; it is not refunded merely because a task is no longer desired. Native
callers and unattached low-level ABI instances supply their own resource policy.

Worker35 introduces task-specific input quotes and grants. A grant RPC continues
until its packing transaction finishes, even when the caller does not request
streaming. Progress, cancellation, errors and late replies carry
`imageryInputBytes`; those receipts include live Wasm packing scratch. Stale grants
are refused, and producer termination is the final release receipt. Runtime
`imageryInputCapacity` waits on resource, camera or source changes after refusal.
An actual input deficit also triggers existing CBDAM coarsening/publication
recovery. It must not await refinement of the measurement that needs this input;
old display ownership survives until a complete replacement is submitted.
The input ledger excludes tree/queue/output/JS metadata, so it is not a complete
planner memory limit. ABI36 rejects older contracts; quality_v4 is unchanged.

`terra_stage_imagery_input` declares the full shape/grant without replacing the
old cut. Append each surface and batches of up to256 regions/hull points, then
commit only when every declared element is present. The session owns all staged
arrays; its input counter includes them. Cancel discards staging only; history
reset occurs at commit. Wasm uses this path with reusable scratch below64KiB,
avoiding a second full packed copy alongside the converted input. Both native
entry styles share validation and conversion. Commit's tree-reference setup
remains synchronous; only conversion batches are bounded here.

Verification includes actual Wasm replacement with room for old+new input and
only64KiB of packing scratch, partial-input cancellation, delayed history reset,
stale grants/refusals and producer termination. Final native/desktop/distribution
gates, Web282/282 and planar26/26 pass with zero compiler warnings. All six
imagery endpoints reach1.25px without sampled blanks or missing regions; oblique
terrain target/latency and full planner metadata budgeting remain unfinished.

## Native imagery ownership observation (ABI 35 / Worker 34)

`terra_imagery_payload_bytes(context)` reports the requested allocation bytes
owned by all live imagery sessions. It includes session state, transferred input
capacity, tree/queue/work containers, immutable native outputs and the C draw
conversion capacity. Allocations retain their original owner through moves,
reset and retained snapshots. Reading the counter does not scan the tree or
allocate memory. It is not Wasm linear-memory capacity or total process memory.
Allocator overhead, fixed account bootstrap blocks, opaque callback captures,
external packing scratch and JS metadata/copies are excluded.

`TerraAbi.imageryPayloadBytes()` reads the counter. Worker 34 reports
`imageryBytes` on progress, completion, cancellation and error replies; the client
accepts valid ownership even for a retired RPC. It clears the counter only after
actual producer termination or a native release receipt. Runtime performance
snapshots expose `nativeImageryBytes` separately from the resource ledger.
ABI 35 and Worker 34 reject older contracts; quality_v4 remains 56 bytes.

This is ownership telemetry, not a memory grant or an enforced workspace limit.
Preallocation grants, remaining metadata ownership, successor imagery pricing
and joint geometry/image admission still need implementation. No runtime budget,
precision target or deadline is raised. Package size 512 KiB remains advisory.

## Immutable imagery output (ABI 34)

`terra_imagery_quality_v4` replaces v3. Its 56-byte layout retains the first
48 bytes and adds a session-local `uint64_t draw_revision` at offset48. The
revision identifies immutable draw content; quality and completion flags still
update on every step. Read quality first, and fetch draws only when that revision
changes. Reset never reuses a published revision within the same session. Session
IDs are separate namespaces. New input, source mapping and session replacement
invalidate adapted-output caches. ABI34 rejects older binaries; no v3 quality
export remains. Worker protocol33 is unchanged.

Native cuts hold shared immutable draw arrays, including stable empty/root
coverage during rebuilding. Retained arrays outlive their controller. The C
adapter converts only new arrays; the Wasm adapter reuses bound rows and derived
metrics. Changing capacity diagnostics copies rows instead of mutating a retained
plan. Worker partition fits cache one completed price by immutable input identity
and admission options, while preserving fresh native quality fields. Cancellation
cannot publish a partial price. These caches do not make input conversion,
changed-output construction or the direct synchronous path fully time-bounded.

## Independent imagery planning sessions (ABI 33)

Every native imagery operation takes a context-local `session_id` obtained from
`terra_open_imagery`; `terra_close_imagery` releases its tree and outputs. There
are two slots (`TERRA_IMAGERY_SESSION_LIMIT`): one for the displayed cut and one
for a speculative successor. Each owns its persistent refinement/coarsening
history, input normalization, admission epoch, output and quality. The eight-root
model and source-adapter rules are common. Terrain/image payloads are not copied.
Session IDs are never reused during a context's lifetime. Successful manifest
replacement and context destruction close all sessions; reset clears only the
named session. Stale operations fail without modifying caller outputs or another
session. These are interleavable tasks, not a thread-safety guarantee.

`TerraAbi.createImageryPlanner()` returns an explicit owner with `plan`,
`createTask`, `accept`, `reset` and `destroy`. It holds its own source mapping and
continuation input. Existing direct/Worker display methods delegate to a lazy
primary owner; there is no context-global native planning path. Starting a task
cancels only the previous task of that owner. Completion/cancellation releases
packing scratch. Successful manifest replacement and ABI destruction cancel all
owned tasks; failed manifest validation preserves them. Close is idempotent in
the Wasm owner, while the native API rejects a stale ID. Close explicit planners
when finished. A third live session is refused rather than replacing either one.

This removes the mutable-state collision between displayed and candidate plans.
The session count is not a byte budget: input/tree/measurement metadata still
needs complete ledger ownership before runtime speculative pricing is enabled.
Candidate pricing, joint geometry/image admission and result reuse remain open.

## Prepared surface reads (ABI 32)

`terra_get_prepared_mesh_positions` and `terra_get_prepared_mesh_uv` read exact
Float32 relative positions and UVs from the current prepared candidate, including
mixed old/new groups and partially produced resources. Both accept at most
`TERRA_MESH_SAMPLE_LIMIT` (1024) vertices. Unproduced positions use the immutable
height input captured during preparation; resident positions use their actual
payload. Neither call materializes native mesh arrays, publishes a frame, nor
mutates the imagery planner. An invalid call leaves output untouched. Empty
ranges accept null output. Discard, replacement, deselection and completed
materialization reject affected reads; background camera/height work does not.
Lookup scans descriptors, so this work-count limit is not a wall-time guarantee.

The Wasm adapter's `createPreparedSurfaceTask(planId, draw, maximumBytes)` yields
between slices and refreshes memory views after each native call. It requires
`preparedSurfaceBytes(draw)` credit for one shared native XYZ/UV slice plus both
JS output arrays. It releases native scratch on completion, cancellation and
failure, and rejects invalidation even after its final sampling yield. The
caller retains output credit until releasing the result. Indices, derived
measurement metadata and any Worker transfer copies require separate ownership;
this task does not reserve those or enter persistent surface caches.

This enables exact pre-production imagery measurement. Isolated imagery sessions
are available in ABI33, but prepared pricing is not yet connected to runtime
successor-cut selection. The current runtime continues to admit its completed
current-cut imagery demand. Joint successor selection, end-to-end future
height/UV/measurement credit and industrial latency acceptance remain open.

## Terrain transport and encoded input ownership

The platform entry supplies the request adapter. Custom adapters receive
`{url, method: 'GET', responseType, timeout, maximumResponseBytes}` and return
`{promise, abort}`. Binary responses must contain an `ArrayBuffer` or `Uint8Array`.
The promise must settle only when the underlying producer actually exits,
including cancellation; consumer cancellation is managed separately by the SDK.
Enforce the byte limit during receiving, not solely from Content-Length. Browser
transport provides this contract with a bounded readable-body consumer. Native
WX/CloudBase adapters reject oversized results before further copies but cannot
currently bound their platforms' opaque receive buffers.

Root/detail encoded envelopes are `(D+1)^2*16+4096` / `D^2*16+4096`, where D is the
manifest patch dimension; metadata input is at most 1 MiB. Rendering reserves
one three-copy root input lane in the shared resource ledger before imagery starts.
Further concurrency requires real credit. Cached data keeps its cache lease and
funds two copies. Transport/submission completion returns the credit; destroying
or cancelling the consumer alone does not. Worker and direct ABI validate input
before copying, and native submission checks the same encoded envelope. Only
successful current submissions populate the encoded cache. These limits do not
unify the separate native decoded/reconstructed pools or bound process RSS.

## Purpose

The v1 package exposes the platform-neutral Terra core, CBDAM decoder, camera,
LOD selection, and common patch topology to a WeChat Mini Program. It does not
contain Qt, OpenGL, VIC VFS, Berkeley DB, HTTP, Promise, image decode, DOM, or
browser-generated Emscripten glue.

TypeScript owns manifest JSON/schema/SRS validation, request scheduling,
retries, cancellation, cache, credentials, and imagery. It maps validated
numeric manifest fields into the C ABI. Wasm validates those values again,
selects patches, decodes terrain records, and emits deterministic frame data.

## Independent height queries

`viewer.queryTerrain([longitude, latitude], {sampleSpacingMeters: 30})` loads
CBDAM height dependencies independently of the visible cut. The returned status is
`ready`, `limited` or `unavailable`; `dataLevel` and `sampleSpacingMeters` describe
source sampling, while `level` describes reconstruction topology. Confirmed absent
details continue with zero residual and inherited source precision. Vertical
accuracy is unknown (`verticalAccuracyMeters: null`). `sampleTerrain` remains a
resident-only read. The query supports AbortSignal, source/level and payload
limits, and a timeout that starts cancellation. Its promise settles after owned
network/Worker producers exit. Rendering and queries share terrain GET concurrency
and cache; cancelling one query does not cancel another owner's shared download.

Completed target regions are cached under independent shared-ledger ownership.
Nearby calls can return `cacheHit: true` with zero reconstruction and network work.
A region is used only within its exact CBDAM triangle and cylinder face, and only
when it satisfies the requested geometric spacing or level ceiling. Source data
spacing still determines ready/limited; finer demands rebuild as necessary.
Regions are reclaimable (maximum 32 / 2 MiB) and are cleared on dataset/service
origin replacement and destroy. They are not rendered meshes or a guarantee of
walking clearance. `terrainQueries.regions` reports bytes, entries and cache hits.

## Near-camera terrain demands

Globe runtimes automatically request CBDAM terrain under the actual eye and along
its tangent viewing direction. `terrainNavigation` configures `enabled` (true),
`sampleSpacingMeters` (30), `lookAheadMeters` (50) and `activationHeightMeters`
(20,000 metres of absolute eye altitude). The front sample is prefetch, not a
swept collision test. Planar runtimes do not activate this globe policy.

Only one automatic query is owned at a time, with the eye first. Nearby motion
retains useful reconstruction; a large jump cancels old work and waits for its
cleanup receipt. Late results are resampled at current coordinates from admitted
regions, never copied as a height at a different position. Far views, pause,
Worker replacement and destroy cancel demand. Existing query transport, caches
and shared resource budgets also govern automatic requests.

An enabled globe navigation policy funds one reusable default query workspace
before rendering/detail production starts. Its quote includes native query
capacity, both input slots, Worker/host copies and region export (3,068,984 bytes
for patch dimension 64). These bytes are reserved inside `maximumResourceBytes`;
they do not enlarge the total. Completed/cancelled queries return credit only
after producer receipts, so later default queries do not compete with resident
imagery for the same workspace. Far views and pause retain the reserve; source
replacement and destroy retire it. Planar or disabled navigation has no mandatory
reserve. Explicit larger queries must admit their extra bytes and refund them
when finished. A total too small to fund the reserve still reports query capacity
failure; neither data availability nor a successful high-precision result is
promised by resource admission.

`terrainQueries.progressRequiredBytes` is the default quote, `progressBytes` is
the funded pool including an active loan, and `progressAvailableBytes` is its
unused part. `ownedBytes` is the active query's loan, not an additional allocation
to sum with the pool. Global ownership remains in `resourceMemory`.

`viewer.camera.getTerrainState()` exposes independent eye/front status, source
sample spacing, limitations and unknown vertical accuracy. Failed requests park;
`viewer.camera.retryTerrain()` retries explicitly. Capacity release wakes a
capacity-limited demand; no idle polling is needed. A new geographic demand or
resume also allows a fresh attempt.

Query arrival and camera correction use separate background steps. Diagnostics
`cameraGround.appliedDemandRevision` identifies the demand revision consumed by
the last constraint; `cameraGround.demand` always reports current query state.
A ready query alone does not acknowledge that its height constrained the camera.

Clearance uses the higher of available query and rendered heights. It raises the
target elevation while retaining range, heading and tilt; it does not lengthen
the orbit range at grazing angles. If neither height exists, the reference
sphere is only a provisional floor and diagnostics report terrain height as null.
`minimumTerrainClearanceMeters` defaults to 2. This is clearance relative to
available CBDAM/rendered terrain, not a vertical-accuracy guarantee, complete
collision avoidance or a first-person walking controller.

## Eye views and sampled walking

`camera.setView` also accepts `{schema: 'terra.eye-view.v1', mode: 'globe',
position: {longitudeDegrees, latitudeDegrees, heightMeters}, headingDegrees,
pitchDegrees}`. Position is the actual eye. Pitch is positive above the local
horizon (-89.5..89.5 degrees). Looking does not orbit or translate that position.
`getView` returns the selected view schema; narrow it before accessing `target`
or `position`. `panBy`, `orbitBy` and pointer drag look around in eye mode. Orbit
zoom/tilt and orbit motions require an orbit view. Use `setView` to switch models;
animated interpolation requires matching models. Eye near clipping is 0.1m.

In an eye view, `await camera.walkBy({forwardMeters: 5, rightMeters: 0,
speedMetersPerSecond: 1.4, eyeHeightMeters: 2})` follows sampled CBDAM terrain.
Distance is limited to 100m per command and speed to 20m/s. Eye height must meet
the runtime clearance floor. Steps use at most 50ms of movement time. Missing
regions park movement until the budgeted query completes; waiting time is not
converted to a later jump. Valid source-limited terrain may be followed and is
reported as limited, with vertical accuracy unknown. Failure leaves the last
position intact. `stopWalking`, another view, pause, Worker recovery and destroy
cancel movement, retaining query ownership until its actual cleanup receipt.
`getWalkState()` and the `walkstate` event expose progress and terrain waits.

This is sampled ground following, including descent, not a swept body collision
test or vertical-accuracy guarantee. Continuous collision, steep-slope policy,
near-depth artifacts and physical-device walking performance remain separate
acceptance requirements. The demo's debug controls enter ground view at its
current target, walk 5m, stop, and restore the preceding orbit view.

## Near-ground depth precision

The WebGL adapter selects logarithmic fragment depth when the perspective
far/near ratio exceeds 32768, keeping the same camera, clipping planes and LOD
measurement. Terrain and route/point overlays share the encoding. Conservative
visibility queries convert their depth bounds too. Ordinary views use a separate
shader without fragment-depth writes; no extra terrain pass is introduced.

WebGL2 or WebGL1 `EXT_frag_depth` plus highp fragment support is required. The
explicit highp eye-depth varying avoids WebGL1's mediump built-in fragment W.
`getState().renderer.depth` reports `mode`, `supported`, `nearMeters`, `farMeters`
and `limitedReason` (`fragment-depth-unavailable` when ordinary depth must be
used for a wide view). This is separate from imagery screen-error readiness.
Logarithmic encoding improves depth ordering but does not improve the source
terrain's elevation accuracy or replace collision checks. GPU cost and real
walking image quality still require device-level validation.

## Build And Verify

Run from the repository root on the current Linux workstation:

```bash
bash scripts/build_wasm.sh
bash scripts/verify_miniprogram_wasm.sh
```

The portable release compiles and links with `-O3` plus LTO, retaining strict
floating-point semantics without SIMD or threading requirements. Core package
size is measured against an advisory 512 KiB reference; runtime resource budgets
and numerical/navigation verification remain independent requirements.

C ABI31 adds a resumable native height-production boundary. Native callers set
`terra_set_height_work_limit(bytes, maximum_builds)` before an update operation.
`WORK_PENDING` retains its selected camera, topology, immutable record inputs and
dependency cursor; output remains untouched. `terra_height_work_bytes` prices the
next root/refinement including codec scratch and shared-input copies. A zero quote
can require another bounded metadata slice. Retry the same operation after funding,
or explicitly call `terra_discard_terrain_work` before replacing the selection.
Discard retains already cached payload; `terra_height_payload_bytes` reports its
actual ownership. Native `CAPACITY_PENDING` drops the work cursor, allowing a
new/coarsening selection after demand or ownership changes; cached payload stays
charged. It is not an ordinary continuation or a reason for a busy retry. A finite build limit caps each dependency scan at64
entries. A single codec operation and final metadata work have no wall-time bound.

Direct Wasm and Worker adapters fund one root/refinement at a time through the
shared ledger. Await managed `prepareMeshFrame` and `advanceTerrain`. Each Worker
continuation carries its work ID and byte grant; every reply reports actual height
bytes. Cancellation retains issued credit until the reply or producer termination.
`terra_trim_height_cache` releases idle cache entries while preserving the selected
cut and immutable prepared readers. After one reclamation attempt, refused height
work discards its cursor and lets runtime coarsen; a refused recovery parks until
real capacity/input changes. Shared deficits lower the CBDAM working cut from its
actual selected mesh footprint, including current unfunded imagery groups after
reclamation. The root floor is preserved, and a new affordable view restores the
preferred allowance. Partial parents quote only their present outputs.

The current Worker protocol is v33, paired with C ABI34. Decoded record production
requires pre-funded output credit and reports actual residency in every Worker
reply. Await `loadManifest` and `submitRecord`: resource pressure can defer them.
Queued submissions can be cancelled before posting; issued output remains funded
until its receipt or confirmed producer termination. Manifest reset alone may
transfer settled decoded-record credit: native reset frees that payload before
producing the new zero input. This avoids requiring two generations to fit at
once; issued RPC credit is never reused, and old ownership stays charged until
its actual receipt. Manifest/imagery identity is published only on success.
Worker scheduling retirement is not a rollback transaction. Indices, metadata and
some native scratch are not yet all in the shared ledger. Mesh production uses
`terra_step_mesh_frame` instead of the old monolithic export. Keep the same
whole-candidate byte credit across steps until completion/discard; a call scans
at most64 descriptors and produces at most one fragment. The current frame is
unchanged until completion. Worker progress replies requeue production and retain
credit, allowing other work between turns. Direct Wasm uses the same cancellable
task. Completed cache allocations remain charged after cancellation until freed.
Group/proof changes are rejected after production begins. Individual fragment
generation, admission and final metadata are not wall-clock deadlines.

Imagery input packing
is a persistent task with refreshed memory views after yields and explicit
scratch release on cancellation. Native projection normalization consumes bounded
priority work. During initialization the rebuilding flag may accompany an empty
draw set; retain prior imagery demand. A later step can reject infeasible source
capacity after begin accepted the input. Old binaries and Worker pairs are rejected.
The cooperative budget does not preempt individual synchronous Native calls.

Imagery admission prices
each complete resident mesh group in one bounded Worker batch. Missing retired
models use retained host geometry; cancellation awaits the final producer receipt.
Neither path produces UV arrays before complete-group resource admission.
An unfinished older-camera projection can adopt a quiet latest revision after
160ms. This happens once per unfinished chain; intermittent small input and
same-view terrain publication cannot repeatedly restart its replacement. Major
view changes retain immediate supersession. `workerImageryPlanning` exposes the
observed revision, age, stage and quiet-rebase count for profiling.
`terra_camera_v3` keeps
the 40-byte layout and replaces the reserved word with an explicit orbit/eye
model; eye distance is zero and the globe target/height is the eye position.
The v2 camera type and size export are removed. Projection measurements cross the Worker
boundary as transferable Float64 region buffers and small per-mesh metadata.
The host reconstructs the same exact projection inputs; source meshes and cached
Worker measurements retain ownership. Partial and completed snapshots use the
same layout, and older Worker/host pairs are rejected. Worker geometry now borrows
immutable Native payloads through balanced acquire/release calls instead of
retaining duplicate arrays. Host upload/recovery positions remain independent. UV transfer additions carry their
own identity, are reused across meshes and are borrowed before asynchronous
admission. GPU position and UV buffers share one cache budget; publication waits
for their actual GPU receipt. No old protocol/layout fallback is provided.
Prepared terrain holds immutable height sample references. Native advancement may
continue during UV pricing and resource admission without invalidating the plan;
changed samples copy only when shared, and retired sample bytes remain in the
existing height budget. Late publication cannot replace a newer model's cache
entry. The runtime allows one bounded topology lookahead during preparation,
coalesces cameras, and waits for the active advance on completion or cancellation.
The renderer checks the shared/local lower bound before UV pricing and as each
mesh cost becomes known. Native/host/GPU destinations, retained inputs and both
UV output copies participate; unpriced UV cells count as zero only for refusal.
Feasibility reserves no output and evicts no synchronous cache victim. Native
reclamation must acknowledge real refunds before a retry. Refusal selects a
boundary-proven local group; final production still acquires exact credit.
Diagnostics expose preparation attempts, early refusals and priced meshes/cells;
this does not establish bounded whole-candidate pricing or application acceptance.
Prepared terrain reuses an existing immutable geometry's UV model and partition
cost cache when available. Its renderer cache entry stays retained until the
cost task completes, including cancellation acknowledgements after eviction.
One batch prices the remaining meshes without a host round trip to start each
mesh. Worker and direct-Wasm batches share a 64-step/4ms cooperative slice and
own only the active row's input. Resident models reuse their cost cache; missing
models use Native UV sampling. A single reservation covers the largest row's
scratch, including index bootstrap. Completed scalar costs stream to admission;
refusal cancels the batch and waits for its receipt before refunding scratch or
selecting a smaller complete replacement group. Known costs survive this retry.
Pausing explicitly cancels preparation. Callback errors also wait for producer
acknowledgement; outstanding work cannot be refunded early. Worker v23 is rejected,
and the replaced single-mesh preparation RPC is removed. Imagery-only partition
operations and the Native per-mesh sampling primitive remain separate.
Partition output production and GPU submission also have separate bounded lanes.
While one upload awaits its receipt, CPU work may prepare one further window using
the existing upload byte/object limits and admitted workspace. Independent ready
mesh jobs share one submission fence. Inputs remain charged through completion or
cancellation; only complete world/mesh footprints can publish. No extra memory
pool or GPU queue is introduced, and C ABI22/Worker v24 remain unchanged.
Textured terrain production now requests Native boundary groups before whole-cut
UV pricing when new geometry exceeds the existing upload byte/object window.
Among groups that fit, coarsening has priority, followed by smaller outputs. A batch of
whole groups becomes the exact mixed Native cut before its complete imagery and
resource admission. An indivisible group may progress alone only if no group fits; boundary workspace
refusal retains the complete path, and failed local trials restore Native target
selection before whole-cut pricing. Small candidates retain atomic membership.
The geometry window does not bound total UV work or guarantee publication latency.
Unchanged displayed meshes can borrow a resident source-UV ancestor's indices,
or their original strip, while the existing WebGL2 centroid/highp shader clips
the frozen imagery cells. The complete immutable UV hull proves new-camera
coverage; old visible cells are not a coverage certificate. New meshes, WebGL1
and cells beyond the source-UV precision bound retain priced geometric clipping.
Borrowed parent buffers remain protected through the handoff and subsequent
displayed descendants. Submitted surface queries retain the clipped cell domain.
This avoids new UV allocation at the cost of potentially drawing extra triangles
until dedicated child partitions replace the temporary superset.
Completing the last geometry upload also wakes same-frame coverage-to-target
publication. Background preparation checks draw sets and coverage mode, while
the display clock alone publishes them; frame identity alone cannot express
this transition. An unchanged target does not schedule repeated redraws.
Managed imagery separates steady residency from a bounded replacement peak.
Final target planning retains root fallback and one serial workspace within the
configured image budget. Complete sibling groups may temporarily borrow the
replacement allowance from the existing shared ledger; the total limit stays
unchanged. Every destination, input and prepared UV output is still admitted
before I/O, and old display ownership lasts through its receipt. Explicit entry
limits constrain the peak; idle excess yields after handoff. Capacity diagnostics
report this ceiling separately from actual borrowed bytes and actual refusal.
Repeated region vectors use a resource ID and transmitted revision. Metadata and
complete snapshot membership are still sent; only changed numeric payloads need
transfer and reconstruction. Cache membership is pruned to the producer's frame
owners plus its emitted snapshot, and source reset, idle cancellation and destruction clear
references. Late cancelled replies update transport state without publishing a view.
Unknown, skipped or stale references reject the Worker rather than reuse old data.
This reduces structured-clone work; it does not relax imagery precision,
resource admission, or the outstanding industrial navigation acceptance gates.

The build uses `docker/Dockerfile.wasm`, Emscripten 3.1.5, and
`adapters/wasm/CMakePresets.json`. The verifier builds both native and Wasm
implementations, compares reports byte for byte, performs two clean Wasm builds
and compares SHA-256, tests the Mini Program loader, rejects compiler warnings,
and enforces a default 1 MiB Wasm limit. It also runs the Mini Program globe
protocol, WebGL resource, and runtime failure-recovery tests before staging
these facade files.

The generated package is:

```text
workspace_old/package/miniprogram/
  include/terra/c_api/terra.h
  package.json                     # @terra/sdk entry and declarations
  sdk/js/{api,core,camera,imagery,interaction,math,terrain}/
  adapters/wasm/                    # ABI, loader, worker and host runtime
  adapters/webgl/                   # renderer and composed public viewer
  adapters/miniprogram/             # input and CloudBase transport
  wasm/terra_sdk.wasm
  wasm/terra_sdk_wasm_manifest.json
```

Generated binaries and reports remain outside Git. To rebuild the Docker image,
set `TERRA_SDK_WASM_REBUILD=1`. `TERRA_SDK_WASM_BASE_IMAGE` may select an
explicit registry image; the default uses the Docker daemon's configured
registry and a pinned Ubuntu digest.

## ABI Contract

The installed target is `Terra::c_api`; the C-compatible header is
`terra/c_api/terra.h`. ABI 34 uses opaque `terra_context` handles, fixed-width
integers, versioned structures with `struct_size`, explicit status values, and
caller-owned buffers. No exception crosses the ABI.

Typical call order:

```text
terra_create
terra_load_terrain_manifest
terra_set_viewport / terra_set_globe_target / terra_set_camera
terra_update
terra_get_requests / terra_get_frame / terra_get_frame_patches
terra_get_index_buffer / terra_get_mesh_resources
terra_get_mesh_position_view / terra_get_mesh_texture_view
terra_submit_record / terra_fail_record / terra_retry_record
terra_get_stats / terra_get_last_error
terra_destroy
```

`terra_get_*` list functions first return the required element count when called
with a null/zero-capacity buffer. `terra_alloc` and `terra_free` are provided for
copying typed data through Wasm memory. Structure-size query functions let host
code reject an incompatible layout before writing fields.

`terra_set_globe_target` sets the cylindrical surface point under the camera in
longitude/latitude degrees. It is separate from `terra_set_camera`: target
coordinates move across the globe, while camera yaw and tilt change local
heading and pitch around that point. The default target is `(0, 0)`.

`terra_submit_record` accepts exact terrain-service record bytes with an
explicit root/detail kind and validates a current or recently issued request
before decoding. A bounded history of 1,024 distinct requests admits late
responses after the current frame frontier changes; dataset reset clears the
history. Unrequested keys remain rejected, and decoded records retain their
existing byte budget.
`terra_fail_record` marks an unavailable detail as a dataset leaf. Subsequent
updates retain its parent patch for visual coverage and stop requesting that
detail. The host still owns bounded transport retries; an explicit user retry
calls `terra_retry_record`, which clears the unavailable state so the next
update requests the record again.
Record kind is mandatory; use `terra_submit_record` and `terra_fail_record`.
The old patch wrappers and the mixed terrain/imagery manifest are removed.
This development release requires ABI 34; older binaries are rejected.

`terra_advance_terrain` advances bounded CBDAM selection, height preparation and
the request frontier without publishing render buffers. Its output uses the
104-byte `terra_update_state_v2` layout with the current publication sequence and
prepared model revision; memory counters are not populated. `terra_get_update_state` still
describes the published candidate (with current owned-memory accounting). Model
progress is not a presentation receipt. The candidate's mesh IDs, positions, UVs,
frame and receipt sequence remain valid while the model advances. Only
`terra_update_step` publishes another frame. ABI 14 replaces `mesh_revision` with
`model_revision` at the same offset: visible topology, fragment height content
and coverage dependencies change it, without constructing mesh buffers. The
published state retains the revision used to generate its candidate. Repeated
unchanged model work does not advance the revision. The host publishes after
complete presentation, or after freezing an obsolete candidate and retaining the
actual mixed display. The current ABI requires model advancement in
both the Worker and direct Wasm paths.

### Incremental extension (API version 2)

The terrain scheduler uses `terra_update_step` with
count/time limits, topology capacity and native mesh capacity. Its budget/state layouts are 32/104
bytes; query their sizes before use. Persistent refinement and coarsening sets
retain unfinished work. A capacity prediction chooses one feasible LOD threshold
for the whole view, including coarsening hysteresis. State reports requested and
feasible thresholds, topology count, decoded/height/mesh bytes, and work remaining.
ABI 14's budget field at offset 28 is `maximum_mesh_bytes`; zero selects 64 MiB.
State offset 40 reports the limit used for that publication/model. Admission
counts unique native position/UV allocations across cache, current candidate,
mixed display and construction. On status 9 (`TERRA_STATUS_CAPACITY_PENDING`),
published arrays, descriptors and receipt sequence stay valid. The request
frontier may advance. Retry after demand, ownership or capacity changes; the
Web runtime reports `terrain-memory` and parks rather than spinning.

`terra_get_mesh_resources` returns 112-byte `terra_mesh_resource_v3` descriptors
with separate immutable position (`resource_id`) and UV (`texture_resource_id`)
identities. The uint64 UV identity occupies offset 16; the draw range starts at
offset 24. IDs are scoped to a terrain context; a new Worker generation cannot
reuse the previous source's resources. Regular certified layouts share bit-exact
UV arrays across terrain heights; planar and nonregular layouts remain independent. Position/UV views are local to each resource; `first_vertex` gives the
cumulative logical offset for statistics and consumer-side reconstruction, not
an offset into those local views. Copy each new position resource and each missing UV identity once when crossing to the
rendering host; Worker jobs borrow the native resource. The former native
concatenated position/UV buffers and separate draw query are removed in ABI 14.
After its complete cut reaches the GPU, acknowledge the current sequence with
`terra_present_frame` (16-byte receipt). The previous presented cut remains
referenced until then, except when a local retention receipt replaces that owner
with the exact mixed display under ABI 14. `terra_acquire_mesh_resource` pins an
already materialized resource independently of display ownership; each successful
acquire must balance one `terra_release_mesh_resource`. Cache trimming cannot free
borrowed payloads, and manifest reset rejects outstanding loans. Context destruction
ends all loans. Native pointers remain stable while borrowed, but Wasm memory growth
detaches old JS views: adapter getters rebind to the new buffer, and cooperative
jobs reacquire views after yielding. Never transfer the native memory buffer.
The Web host allows
one candidate and discards obsolete camera/source results before adoption.

`terra_retain_meshes(context, receipt, resource_ids, count)` replaces the display
owner with exactly the resources submitted by a local replacement. The 16-byte
receipt names the current candidate sequence. IDs must be positive and strictly
increasing, and belong to the candidate or the previous display. Validation and
allocation finish before any ownership changes. An invalid batch changes no
ownership; a valid empty batch releases the display. Mixed old/new resources
survive later candidate replacement. This neither acknowledges the complete
candidate nor publishes another. The runtime can supersede a complete candidate
when background selection has produced a newer coherent model. It freezes new
promotions, drains a receipt for the actual display, discards the old candidate,
then publishes its successor. Existing submissions finish under their current
GPU ownership; rendering can continue from the retained display. Failed or
invalidated receipts do not authorize replacement.
Idle cache residency is independent of display ownership and does not permit
re-admission by retention. Releasing an owner allows later eviction, without
guaranteeing immediate heap shrinkage. The Wasm adapter deduplicates and sorts
IDs from submitted draw descriptors. Native selects the corresponding shared
resources into a temporary vector before swapping ownership.

The host's portable `MeshReceipts` serializes local and complete receipts for
one Worker/ABI owner. While one local RPC is pending, newer submitted resource
sets coalesce into one pending snapshot. The complete receipt follows local
retentions. Worker and host CPU owners change only after successful native
acknowledgement. Reset invalidates old asynchronous completions. Each ongoing
immutable imagery/partition job keeps its own resources until completion; a new
partition request for a retired Worker mesh returns no result so the renderer
can prepare from its own resident geometry. Renderer GPU/CPU idle caches retain
their existing limits.

`state.terrainSelection.retiredMeshCount` and `retiredMeshArrayBytes` report
cumulative local host retirement (position/UV array bytes). These are ownership
diagnostics, not total memory freed, current allocation or all-owner admission.

`terra_plan_imagery` selects a shared spatial cut across all visible surfaces.
Its options/surface/region/hull/draw/quality layouts are 32/48/40/16/32/48 bytes.
It admits texture and draw counts before subdivision and reports a globally
feasible error separately from the requested error. The host additionally counts
clipped partition bytes before requests; pressure coarsens the whole cut. Source
changes call `terra_reset_imagery` and invalidate pending jobs.

Web applications supply `wasmUrl` and `workerUrl`. The Worker owns Wasm, terrain
updates, surface measurement, imagery selection, and partition preparation.
Worker protocol v23 returns descriptors before producing mesh payload. The host
reserves Native production, its own upload/recovery copy and renderer destinations
before authorizing materialization; `step` returns an adopted `MeshFrames` candidate.
Worker loans add no payload charge. Background jobs hold those loans after frame
retirement, so Native payload accounting includes them until the final release.
The host copy and GPU buffers retain independent lifetimes and receipts. Native,
host and GPU mesh allocations, decoded records and reconstructed height payload
participate in the shared ledger. Native record/height pools retain safety ceilings. Neither ledger is total process memory.
The UI previews camera matrices, uploads admitted GPU buffers within a shared
frame deadline, and acknowledges presentation. Hosts without Worker support use
the same C API in yielding slices; they do not gain background execution. The
standalone Wasm clock is a monotonic f64 host import, so no Wasm BigInt integration
is required. Serialized terrain/imagery formats and v1 exports are unchanged.

The distribution contains `terra_worker.js` for `workerUrl`. Mini Program apps
stage only their dependency graph with the `miniprogram` argument to
`scripts/stage_sdk_js.js`. `miniprogram_files.json` records those exact modules;
the core byte measurement covers that graph and Wasm, while the release manifest
also reports the standalone Worker and complete multi-platform payload sizes.
As of 2026-10-12, 512 KiB is an advisory package-size reference, not a release
limit. Runtime memory budgets remain independent.

Browser hosts can set `fetchTextures: true` for abortable fetch/bitmap decoding,
or provide a `(url, options) => Promise<Response>` adapter. SDK URL validation
precedes that adapter; the product demo uses it to route permitted loopback URLs
through its same-origin HTTP proxy. For fixed-size browser globe sources, both
fetch/bitmap and Canvas image loading share complete image/UV admission and
GPU-only residency. Image pixels remain owned through the upload receipt, then
the SDK releases their CPU source. Context restoration reloads the actual
displayed cut through normal source scheduling, including displayed tiles no
longer in the current plan. The Canvas image fallback admits at most two
decoded inputs; fetch retains its bounded encoded window and decoder lane.
These are SDK-owned payload budgets, not browser decoder/cache or process-memory
measurements. Arbitrary planar images and the Mini Program default adapter
retain their existing image recovery contract.

## Patch Topology

For the current `patch_dim=64` globe, the shared triangular topology contains:

- 2,145 addressable vertices;
- 4,096 non-degenerate triangles;
- 4,413 stitched `uint16_t` triangle-strip indices;
- FNV-1a32 `3331821334` over little-endian index bytes.

The index generator traverses each triangular lattice row as a continuous strip,
with three degenerate connector indices between rows. It preserves the desktop
CBDAM triangle set, diagonals and winding without depending on SL's general
greedy stripifier. Triangle traversal order and index hashes are not a stable
application contract; consumers read the buffer and draw counts from the SDK.
Native and Wasm produce identical compact indices.

Terrain exterior faces are clockwise in both planar and cylindrical coordinates.
The WebGL adapter uses `frontFace(CW)` and back-face culling for terrain, including
indexed and interpolated UV partitions. Atmosphere and overlays do not inherit
that raster state. Custom renderer fixtures must follow the same mesh contract;
the SDK does not provide double-sided terrain or an underground interior view.
Texture cell boundaries are clipped geometrically before upload; the terrain
fragment shader has no legacy cell-discard path.

## Memory And Host Loader

The module starts at 16 MiB, may grow, and is capped at 256 MiB. Filesystem and
thread support are disabled. Its only imports are:

```text
env.emscripten_notify_memory_growth
wasi_snapshot_preview1.proc_exit
```

`adapters/wasm/terra_wasm.js` instantiates the module through
`WXWebAssembly`. It compares `memory.buffer` after every exported call and
recreates `DataView` and `Uint8Array` whenever growth replaces the buffer. Host
code must request views again instead of retaining old typed arrays.

## Frozen Parity

The M5 fixture uses radius 6,378,000 m, `1280x720`, threshold `0.005`, and the
checked-in real globe detail record. Both native and Wasm produce 28 initial
patch decisions/requests, the same first and last patch IDs and priorities, the
same camera position, the frozen index buffer, 27 requests after one successful
patch, and 4,096 decoded residual values. The package manifest records binary
size, hash, imports, memory limits, index evidence, and parity status.

## Unified imagery model (ABI 4)

The terrain manifest is `terra_terrain_manifest_v3` (72 bytes). It contains no
imagery source configuration. Mesh `texture` fields contain `terra_texture_node_v3`
(16 bytes): internal depth, root, flattened north-first row and column. They are
not TMS/WMTS addresses. Globe depth zero is four columns by two rows; planar
is one root over the dataset bounds. Even CBDAM geometry level G anchors at
texture depth G/2. Odd G uses its fragment's even parent at floor(G/2).

The C++ model/adapter lives in `terra/imagery/{model,adapter}.hpp`. The Web
`ImageryAdapter` binds nodes to source resources and UV subrectangles. A normal
2-by-1 geodetic source has source level = internal depth + 1. Its two level-zero
images can each cover four roots; an SSE-safe root binding uses those shared
images directly. Planning never downloads intermediate levels merely because
an internal parent exists.

Size queries are mandatory. `terra_imagery_options_v4` is 48 bytes, queried by
`terra_sizeof_imagery_options_v4`. Its added fields describe source root columns,
root rows, maximum source level, and a zero reserved word. Options and returned
quality carry API version 4; unchanged surface/region/draw/quality layouts keep
their v3 names and sizes of 48/168/32/48 bytes. ABI 3 modules are rejected.
The adapter binds internal nodes to opaque resource keys before admission, so
both the native topology budget and Web quality count actual deduplicated images.

Exact measurements retain visible projective triangles. They merge only if a
lower density bound proves the merged upper bound is within 1.25 times every
contributing triangle's density and the convex hull adds no uncovered UV area.
There is no fixed 64-region envelope cap. Each texture cell clips the triangle
before evaluating error. For projected coordinates X/W and Y/W, the derivative
numerator N is affine; its norm is convex. At fixed W, an upper convex envelope
of vertex norms needs at most two vertices. Maximising that pair's linear norm
bound divided by W squared, including its interior extremum, preserves depth
correlation. C++ and Web use the same bound; zero-area boundary contacts do not
create demand. Cheap box bounds can admit safe coarse coverage immediately;
when they report a precision limit, exact measurements verify the limit.

The retained native tree, bounded refine/coarsen queues, source resource cache,
and presentation cuts have separate lifetimes. Large scale/orientation/footprint
changes retire obsolete camera measurement jobs while retaining meshes and
resources. Terrain samples projected in both camera matrices supply scale,
motion and newly visible coverage hints; unavailable projections fall back to
orbit/footprint hints. These classify work, not precision. Exact measurements
are cached for up to three views and 32,768 regions, filtered by live immutable
resource IDs. Continuations transfer changes to measurements and the renderer
merges them only in the same view. Historical splits only break error-priority
ties; newly urgent regions can obtain capacity from lower-error regions.

Global fallback keeps only the source level-zero matrix resident (two images
for the 2-by-1 geodetic source, shared by the eight internal roots). Higher levels
follow visible demand, without permanently pinning a whole extra global level.
Current display and transition references still hold their images until the
replacement receipt; unused cached history can yield under memory pressure.
Image/UV production still requires joint byte admission before I/O.

Direct target requests are the default. Only missing targets and useful coverage
are downloaded, not every ancestor. At most four visible siblings sharing an
immediate source parent form a publication group, independent of skipped levels.
The group waits for GPU images and geometry partitions; a failed member keeps
its ancestor fallback without blocking all successful siblings. Coarsening is
accepted independently per cell using current-view error. Mixed oblique views
can therefore coarsen distant cells while retaining or refining near detail.
A frame receipt is sent only after successful GPU terrain submission. Resident
ancestors, image pins and the existing fades preserve coverage during handover.

### ABI 3 workstation verification

Verified on the Linux workstation on 2026-10-10: CMake/core build, Native SDK
consumer, viewer/nav3d/builder/service baselines, Native/Wasm parity, all packaged
JS contracts, native C/C++ release examples, and product-site packaging. The Web
harness passed 115 checks in 139.5 seconds (the 120-second outer run timed out
mid-replay; the completed run used a 240-second total limit, with unchanged
per-scenario limits). Sixteen repeated camera/viewport cases held Wasm memory
at 30,015,488 bytes. Build logs contain no compiler warnings.

Local service `terra-sdk-web-local.service` on port 18766 was rebuilt with ABI 3.
A bounded test used its Tianditu proxy backed by the existing 49 data service:
76.3-degree tilt at 116.56230/40.74863, two rapid ascents, reversal, and pan.
Latest-view demand took over in 139/229 ms after ascent, with convergence in
1,065/1,107 ms and 0.987 px maximum resolved error at the global view. The pan
sample contained 154 frames, with no zero-draw, missing-texture, uncovered or
blank-pixel frames. All test browsers and temporary servers were closed.

Near-ground oblique precision remains capacity-limited: this run finished with
134 target slots, 8..12 source levels and a conservative 28.33 px maximum error,
zero pending image requests and zero missing coverage. `limited` explicitly
reports that boundary; it is not evidence of achieving the 1.25 px target at
that view. This change separates node/resource identities and improves local
error bounds; it does not increase the mobile/Web memory budget or guarantee
arbitrarily fine imagery under that budget. Desktop runtime migration and
non-geodetic source reprojection remain separate work.

### ABI 4 workstation verification

Verified on 2026-10-10 with the unchanged CBDAM and eight-root texture model:

- Full baseline: 16 foundation tests, 27 SDK tests, native golden/consumer,
  builders and services. Viewer/nav3d startup and viewer interaction passed
  using the existing Xvfb wrapper after the workstation's default X11 display
  rejected the first desktop launch. No compiler warnings were present.
- Native/Wasm parity, 20 imagery view/budget cases, all JS contracts and minified
  package checks passed. Tests cover physical root sharing, skipped image
  levels, sibling publication, local projective bounds, zero-area contacts,
  measurement deltas, cache reuse and distant-relief measurement cost.
- The release gate's browser stage initially exposed unnecessary exact scans
  of fully visible distant relief. Keeping the existing shallow-depth block
  bound resolved that regression. The resumed Web gate passed all 115 checks
  in 163.3 seconds with unchanged per-scenario limits. Sixteen camera/viewport
  replays held Wasm memory at 71,237,632 bytes. Final Wasm packaging, native
  C/C++ package consumers and product-site packaging passed afterwards.
- Local `terra-sdk-web-local.service` remains enabled with user lingering on
  port 18766. Its deployed 173,809-byte Wasm matches the verified package SHA-256
  `dfe79a36c6742a315f74bfbb5ac46012d338d10b4871a238dcc1377de15262a3`.

The bounded deployed Tianditu test used the existing 49 upstream at
116.56230/40.74863, 76.3-degree tilt and 14.5-degree heading. Two rapid ascents
published latest-view coverage in 137/331 ms and converged in 1,439/1,159 ms.
Both global views reached 0.987 px with no remaining transitions. Rapid reversal
recovered. All 144 pan frames retained nonzero rendering and complete coverage;
29 sampled pixel frames contained no blank frame. The ending view had no pending
image requests, no missing textures and no active transition.

The oblique ending view still reports a real texture-budget limit: 1.896 px
maximum conservative resolved error against a 1.25 px goal. The historical ABI 3
run at this scenario reported 28.33 px; the tighter bound changes the diagnostic
as well as the admitted cut, so this ratio is not a measured visual-quality
speedup. Resource limits are not raised to hide unmet precision. Preserving
local triangle bounds also costs more memory on complex synthetic relief than
the former fixed envelope count: the repeated fixture stabilised at about
67.94 MiB, compared with its historical 28.63 MiB, while the deployed Tianditu
scenario remained at 16 MiB. Active measurement storage still depends on mesh
complexity; the three-view/32,768-region limit applies to the history cache.

Evidence is under `viewer_verify_output/imagery_{baseline,desktop,web}_repair.log`,
`imagery_release_completion.log`, `web_sdk/report.html` and
`imagery_repair_deployed/result.html.acceptance.json`. Test browsers, profiles,
temporary servers and display containers were closed; the manual service is
retained. No application or data service was deployed to server 49.

ABI 6 adds `terra_sample_terrain` and `terra_terrain_sample_v1` (64 bytes).
The query reads the finest resident CBDAM height fragment at dataset coordinates
without a render frame, cache pins, network requests or terrain advancement.
Unavailable coverage is an ordinary result; real-data level and horizontal
sample spacing remain unchanged through zero-residual synthesis. Height revision
identifies the cache state, independently of published frame sequence. Worker
queries use the normal bounded-work queue and do not outrank model receipts.

ABI 7 replaces the camera record with `terra_camera_v2` (40 bytes): distance is
eye-to-target range for both transforms, and `target_height_metres` is a double
at offset 32. ViewState v2 uses `heightMeters` for globe and planar targets. No
old camera layout or globe-centre-distance adapter is retained. Native and
immediate JavaScript camera snapshots share the same clipping policy; camera
height participates in Worker view revision and projection invalidation.

### Prepared native mesh transaction (ABI 14)

`terra_prepare_mesh_frame` returns metadata and costs without position/UV arrays.
`terra_get_prepared_mesh_resources` reads descriptors by independent plan ID;
`terra_materialize_mesh_frame` generates only after explicit additional-byte
credit and native-cap admission. Success publishes the frozen frame atomically.
`terra_discard_mesh_plan` cancels an unmaterialized plan without altering display.
Changing the CBDAM model or height inputs invalidates old production plans.
The synchronous native update APIs use the same transaction internally. Both
Worker and direct Wasm reserve native and JS payload together before production.
The native sublimit remains in addition to shared admission; this is not yet
local-group production or a total SDK memory limit. Worker protocol v9 is
required, with no earlier protocol path.

### Boundary planning before mesh production (ABI 14 / Worker v9)

`terra_mesh_replacement_work_bytes` reports conservative planning scratch for a
prepared native plan and a count of old non-coverage resource IDs. Reserve this
amount before `terra_begin_mesh_replacement`; old IDs must be sorted, unique and
owned by the native presented cut. `terra_step_mesh_replacement` samples at most
four triangle boundaries per call and processes bounded event batches. Once
complete, `terra_get_mesh_replacement` returns 12-byte `{group, after, resource_id}`
records. `terra_end_mesh_replacement` releases scratch without consuming the mesh
plan; ending work is required before materialization. Discard/reset also frees it.

The shared ledger owns `terrain-boundary-work` credit until the task ends (or its
Worker terminates). No new full position/UV arrays or publication is needed to
compute these dependencies. The renderer binds the proof only to the exact old
and new non-coverage cuts in the same Worker generation. Missing or stale proof
cannot authorize partial promotion. The complete mesh algorithm is a test oracle,
not a second production implementation.

This is not yet group-wise mesh generation or a process memory cap.
An exactly unchanged cut within one native context is proven by equality of its
complete immutable non-coverage ID sets, without edge scanning or boundary work
credit. Any changed ID retains the full native dependency proof, including its
unchanged neighbours.
The event heap is built/consumed in batches. Equal-coordinate comparisons and
final grouping remain indivisible;
container allowances measure explicit work, not allocator/process RSS.

### Shared native production credit (ABI 14 / Worker v9)

`terra_mesh_payload_bytes` returns unique live native position/UV allocations,
including idle cache and overlapping candidate/display owners. It is available
before publication and after failed materialization. `terra_trim_mesh_cache`
accepts a desired total byte count and releases only cache-exclusive resources;
prepared, displayed and otherwise held meshes cannot be victims. Query actual
bytes afterwards; the desired count is not a guaranteed release amount.

Managed direct Wasm and Worker clients reserve new native arrays together with
required JS copies. Native allocation credit stays charged until completion or
confirmed owner destruction. Worker success/error replies include `nativeBytes`;
malformed or uncredited growth terminates that Worker before refund. Partial
generation failure retains credit for surviving allocations. Direct Wasm observes
mutations synchronously and closes an invalid owner before refunding. Native's
64 MiB default sublimit remains; shared budgets are not raised by this change.
The new `mesh-native` owner measures payload, not the Wasm heap. Metadata, heights,
indices and allocator overhead still require separate accounting. Full candidate
production remains; this increment does not establish progress for every budget.

### Local group production (ABI 15 / Worker v10)

`terra_end_mesh_replacement` now retains the completed compact member proof
while releasing boundary scratch. `terra_select_mesh_groups(context, plan_id,
groups, count, output_plan)` selects sorted unique complete group IDs from that
proof. It creates descriptors only: selected groups use target meshes and all
others keep presented meshes. Repeated trials select against the original
target; expired cached arrays may be regenerated under fresh production credit.
Invalid/stale groups cannot publish content, and a selected plan cannot start a
second boundary transaction. Model and height revisions must remain valid.

The last 32-bit field of `terra_update_state_v2` (offset 100, size still 104) is
`pending_mesh_group_count`; JS exposes `pendingMeshGroups`. A nonzero value also
clears `frame.decisions_complete`. After its presentation receipt the runtime
continues remaining work. `model_revision` identifies the desired model, so
actual immutable mesh ID sets also participate in renderer reuse, Worker
measurement/planning identities and imagery-result validation.

Both direct Wasm and Worker try the full target first, then whole safe groups
when native or shared payload admission fails. Original native/Worker/host
production credit and receipt ownership apply to the complete mixed candidate.
Unselected arrays are neither produced nor copied. Unchanged regions receive
per-resource identity proofs. Boundary scratch still covers the complete cut;
GPU/partition outputs and untracked derived models are not part of this one
production transaction. Very tight budgets can therefore retain coverage while
waiting even when one group's mesh arrays alone would fit.

### Persistent boundary continuation (ABI 16 / Worker v10)

`terra_reuse_mesh_replacement(context, plan_id, before_ids, count, reused)` checks
whether the last complete proof still applies to the prepared target and exact
submitted non-coverage cut. Model and height revisions must match. Each original
group must contain its complete old side or complete target side; a partial
mixture, missing region or extra resource is a miss. Invalid/unowned inputs are
errors. On a hit `terra_get_mesh_replacement` reads the rebased sealed proof;
finished groups become per-resource identities. On a miss callers use the normal
credited boundary task. Worker protocol remains v10 because prepared proofs and
group selection already have that protocol's wire contract.

The native context retains one compact target/proof history with weak array
references, and restores target IDs after cancellation or idle-cache reclamation.
Coverage aliases restore one native allocation per ID. It does not retain the
boundary sweep workspace or unselected arrays. A partial publication can therefore
continue the same target without another complete sweep or its scratch credit.
Changed targets still require planning; metadata/rebase allocations are not yet
included in the shared payload ledger. This is not a total process-memory or
first-sweep latency guarantee.


### Resumable first boundary sweep

The ABI 16 / Worker v10 interfaces remain unchanged. The step budget now counts
individual edge insertion, endpoint application, active-edge comparison/join,
output member, and constant-size phase transitions. Equal-coordinate endpoint
sets may yield without comparing an incomplete interval. Final grouping also
resumes across calls; partial members cannot be read or taken. Union by rank
bounds each disjoint-set lookup logarithmically, as do the event heap operations.
The C++ frame module exposes `last_step_operations()` for deterministic checks.

Input sampling still handles up to four bounded-size patches per C step. Boundary
sampling visits only the three edges, preserving full-mesh Float32 arithmetic,
height indexing, and edge order. Setup validates sorted ownership using binary
search rather than repeated complete display scans. Begin/end allocation,
metadata validation, proof rebasing, and allocator/host scheduling are not covered
by a hard elapsed-time deadline. The first sweep still reserves complete-cut
workspace; this change does not replace local dependencies or downstream output
admission.


### Joint partition output admission (ABI 16 / Worker v11)

Worker v11 adds `partition-plan`: a cancellable, resumable cost-only request
against immutable mesh content. It returns exact per-cell output payload sizes;
it does not allocate output position/UV/index arrays. The host admits CPU output
and its GPU destination in one ledger transaction before sending `partition` with
that exact credit. Host and Worker must both use v11; the C ABI remains 16.

Admission selects an affordable prefix of at most eight same-priority cells and
keeps the suffix queued. The producer no longer rejects an individually affordable
cell solely because it exceeds one third of the local partition cache. The overall
imagery planning policy and all capacity/precision limits remain unchanged.
Each result must match its admitted cell identity and byte count. Proven empty
intersections complete without waiting for a GPU upload batch.

GPU staging consumes previously reserved destination credit. Allocation failure
returns that credit to the same job for retry; cancellation cannot refund an
active producer or submitted upload before its completion/rollback receipt.
Unavailable capacity parks demand until its admission revision changes.

This closes the UV-partition producer/upload transaction only. Native group
production still needs admission covering necessary GPU geometry, UV outputs and
derived models before materialization. Cost-planning metadata, cached clipping
topology and other untracked temporary allocations remain outside this payload
transaction; it is not a process-memory or driver-residency guarantee.


### Base geometry admission before mesh production (ABI 16 / Worker v11)

The runtime now supplies `reserveMeshOutputs(packet, producerBytes)` through its
renderer contract. Before native materialization, direct Wasm and the Worker
client jointly reserve new native/Worker/host mesh payload and the exact base GPU
position/UV destinations. This is a host-side ownership change; neither the C ABI
nor Worker wire protocol changes. Headless mesh owners have no GPU destinations.

The batch checks both the geometry-cache limit and the shared ledger, selects all
victims before eviction, and borrows reused GPU entries until the renderer pins
them. Existing pending uploads must finish before their entries can be reused.
If the complete target does not fit, the existing complete-boundary-group planner
tries a mixed candidate under the same joint admission. An inseparable group that
cannot fit retains the previous display and waits for a capacity change.

A successful candidate transfers destination reservations to its upload queue.
Uploads consume these reservations without a second admission. Retryable GL
allocation failure keeps the reservation with its queued input. Discard, failed
copy/transfer, Worker replacement and context loss release unclaimed destinations;
active CPU production retains its own credit until its completion/rollback reply.
A claimed upload owns its destination independently of the closed candidate batch.

This covers base geometry only. UV partition output has its own prior joint
CPU/GPU admission, but its cost planning still follows mesh generation. UV,
derived-model and temporary/metadata costs must still enter complete terrain-group
admission before this can guarantee end-to-end progress. Index/auxiliary GL
allocations and physical driver residency are also outside this payload contract.

Target restoration also resolves a live materialized ID through the native
registry before using persistent history's weak descriptor. Trying several
replacement groups can expire an older descriptor while its regenerated ID is
still displayed. Restoring another object for that ID would duplicate payload
and invalidate ownership; the later-group continuation contract now covers this
case in direct Wasm and the real Worker under the same quota.

Imagery refinement now holds its immutable terrain cut until that planning epoch
finishes, matching the existing coarsening ownership rule. Continuous terrain
publication cannot keep replacing a partially measured target. The next epoch
adopts new meshes, and major projection/source changes still invalidate obsolete
work. Completed results keep their original mesh/view identity so a stale
snapshot cannot claim current-view precision.

### Prepared terrain/UV output admission (ABI 17 / Worker v12)

Worker v12 adds `prepared-partition-plan` for a current native mesh plan and one
of its selected resources. The request carries a credited scratch bound and
returns exact clipped-output costs; it does not produce terrain positions or
publish a frame. Cancellation uses the existing partition acknowledgement path.
Old Worker/host protocol pairs are rejected.

The runtime renderer contract now includes `prepareMeshOutputs(packet)`. A returned
plan exposes `admit(packet, producerBytes)`: it prices the fixed imagery footprints
and returns a funded output transaction covering native/JS mesh payload, base GPU
geometry and CPU/GPU partition destinations together, or null on capacity refusal.
The final successful cost check and reservation run without an intervening async
yield; `MeshFrames` consumes the returned credit instead of requesting it again.
Pending native refunds require their actual acknowledgement before rechecking.
Reused parts stay borrowed through the terrain receipt. Claimed work keeps its
credit until its own completion, even after the enclosing plan is cancelled.

Before asynchronous pricing, the plan funds the maximum of its known complete
successor cost and the adapter's `meshPartitionWorkspaceBytes(rows)` quote.
These are sequential uses of the same allocation, not simultaneous charges.
`createMeshPartitionPlanTask(planId, rows, onRows, credit)` borrows that funded
scratch; it must finish or acknowledge cancellation before the plan returns
the loan. Completed UV prices grow the owned envelope before pricing continues.
Unknown UV costs remain a lower bound and may still cause capacity refusal.
The final geometry/UV admission transfers the same credit through the ledger.
The plan retains reusable geometry during pricing; cancellation retires free
credit immediately while running scratch remains charged until its receipt.
Custom pricing adapters must provide a workspace quote; no uncredited fallback
is supplied. This changes the renderer contract, not the Native/Worker ABI.

Production WebGL does not include an independent JavaScript imagery selector.
Textured standalone renderers must receive a prepared imagery plan, a synchronous
`planImagery` provider, or explicit Worker-planning previews. Non-textured geometry
can render without an imagery provider. The SDK facade supplies the unified native
planner on both supported runtime paths; the demo does not implement selection.


### Actual terrain mutation reporting (ABI 18 / Worker v13)

`terra_update_state_v2.topology_change_count` occupies the former reserved word
at byte 60. It reports splits/coarsenings in that call, including unpublished
dependency work; priority-only and height-only preparation report zero. The JS
adapter exposes `topologyChangeCount`. Runtime charges a cumulative allowance
across background calls instead of treating every call as a full topology batch.
The state size remains 104 bytes; all consumers must use ABI 18 and Worker v13.
Prior bundles are rejected, rather than assigned an assumed zero change count.

### Capacity recovery (ABI 19 / Worker v14)

`terra_update_budget_v2` is 40 bytes. The `coarsening_only` uint32 at offset 32
accepts zero or one; trailing bytes are alignment padding. Zero runs normal
selection. One permits only bounded threshold/capacity coarsening and priority
updates, retaining refinement demand for a later normal update. Change and
priority limits still apply. Recovery does not publish or release display meshes.

A publication capacity refusal schedules this mode until coarsening/priority
work completes, then retries production only if the model changed. No-change
recovery parks until capacity or input changes. Completion rechecks any capacity
notification coalesced while the Worker was busy. This permits an enlarged frustum
to shrink an oversized candidate without adding refinement dependencies. The
normal pending-publication refinement allowance stays closed during recovery.

Worker v14 includes the refused model revision in admission metadata. New
hosts reject older Wasm/Worker pairs; there is no old-layout compatibility path.
The view-rebase scheduling hint now belongs to the Worker adapter, sharing
projection math with surface measurement but excluded from the Mini Program
direct-runtime dependency graph.

### Imagery demand publication (ABI 20)

`terra_imagery_quality_v3.limit_flags` adds bit 64, `rebuilding`. The 48-byte
record layout is unchanged. This flag identifies temporary root coverage while
the persistent cut is remeasured or bounded coarsening restores capacity. It
implies planning-in-progress (bit 32), but not every incomplete cut is rebuilding.
Consumers must preserve existing demand and continue `terra_step_imagery` while
bit 64 is set. These roots must not replace texture requests or start partition
production. Once it clears, useful partial refinement can be published before
planning completes; finalized budget-limited coarsening must also be published.

The Worker maintains the continuation signature and private incomplete plan while
returning pending. This prevents a cached completed plan from incorrectly ending
the new snapshot. Worker v14 is unchanged; its wire result remains pending or a
usable plan. The loader requires ABI 20 rather than interpreting older binaries
as always producing usable demand. The synchronous planner already returns only
a completed cut. Source changes, cancellation and mesh ownership retain their
existing lifecycle rules; this flag adds no whole-view quality barrier.


### Source geometry partition capability (ABI 20 / Worker v17)

Worker v17 includes `cell.sourceUv` in prepared/resident UV cost and production
requests, and the maximum `sourceUvScale` in imagery partition fitting. A true
cell flag selects
original triangle indices; position/UV output arrays are empty. False uses
geometrically clipped output for platforms without centroid fragment UV support.
The flag is selected by the renderer capability, not the external imagery source.
Host and Worker must use the same version; there is no v16 compatibility path.
Both forms retain the existing output-credit, cancellation and transfer ownership
rules. GPU object charges count only nonempty position/UV/index buffers.

The source-UV path requires WebGL2 centroid interpolation and highp precision.
Its scale bound is `2^19 / tile_size` (16 normalized Float32 steps per texel).
Cells beyond this bound still use their requested imagery level with clipped
geometry and directly interpolated cell UV. The GPU partition carries the actual
cell mode so the shader uses the same representation admitted by the producer.
