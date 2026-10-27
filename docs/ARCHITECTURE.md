# Terra SDK Architecture

This document describes the current implementation. Historical per-patch notes
and retired ABI descriptions are not the architecture contract. The current
C ABI is47 (`sdk/include/terra/c_api/terra.h`), and the Worker protocol is
`terra.worker.v48` (`adapters/wasm/worker_protocol.js`). Unsupported pairs fail
validation; development does not preserve old interfaces.

## Repository and dependency boundaries

| Layer | Location | Responsibility |
| --- | --- | --- |
| C++14 SDK | `sdk/include/terra`, `sdk/src` | CBDAM, decoding, camera, geometry, imagery model, measurements, C ABI |
| Portable JavaScript | `sdk/js` | Public facade, interaction, resource accounting, terrain/imagery coordination |
| Execution adapters | `adapters/wasm` | Direct-Wasm, Worker transport, production and measurement lifetimes |
| Rendering adapter | `adapters/webgl` | GPU resources, partitions, display plans, coverage and submissions |
| Host adapters | `adapters/browser`, `adapters/miniprogram` | Fetch/WX, canvas image loading, task turns and platform composition |
| Applications | `apps/site`, `apps/miniprogram` | Consumers of the SDK; UI and business state |
| Services | `services/terrain`, `deploy` | Repository-backed data delivery and provider proxies |
| Desktop reference | `ratman`, `spacelib` | Preserved viewer/nav3d/builders and source provenance |

`Terra::core`, `Terra::codec`, `Terra::frame` and `Terra::c_api` are the installed
native targets. The core/codec are standalone; frame uses core/codec and the C
adapter uses those SDK libraries. Their exported graph must not import desktop
Qt, OpenGL, GDAL, MPI, Berkeley DB, CURL or Apache dependencies. Services and the
preserved desktop graph may use the corresponding legacy libraries.

Portable JavaScript depends only on portable modules. Browser and Mini Program
entries compose the runtime with host callbacks; neither host is imported by the
other. The Worker bundle contains calculation and transport without a renderer
or UI runtime. `scripts/sdk_modules.js` builds the explicit dependency graphs;
`tests/js/sdk_structure_test.js` verifies isolated loading and packaged consumers.
Generated module directories are reconciled to the current graph on restaging.

## Fixed terrain and imagery models

CBDAM is the only terrain model. The SDK decodes the existing repository format
and uses persistent refinement/coarsening queues with bounded mutation and work
windows. Camera projection and the configured error determine demand. Capacity,
missing records and unavailable source detail are reported separately from
precision. A temporary production refusal does not become a lower quality target.

The internal global texture model is a4×2 root grid with four children per node.
CBDAM fragments have deterministic texture anchors; geometry and source-image
identities are not interchangeable. A planar CBDAM fixture uses the corresponding
single-root model. `sdk/src/imagery` owns topology and the native adapter;
`sdk/js/imagery/terra_imagery_adapter.js` maps source levels, origins, matrix IDs
and UV transforms at the host boundary. Multiple internal nodes can share an
external resource. GPU/source ownership remains independent of node identity.

Global sources must expose an aligned geodetic grid. TMS/WMTS names describe
external addressing, not a different internal tree. Mercator/reprojected sources
require an explicit adapter or upstream conversion; they are not accepted merely
because they use a supported URL schema. Parent resource calculation is shared by
request planning and image resolution.

## Update and publication flow

1. Public camera/input changes update the current view and invalidate demand.
   Display callbacks and background model/resource work use separate clocks in
   `sdk/js/runtime/frame_coordinator.js`.
2. The persistent native controller advances model work and produces a candidate
   mesh cut. Immutable position/UV identities support reuse across publications.
3. `mesh_candidate_production.js` prices boundary-safe replacement groups and
   required image/partition outputs before producing a private candidate.
   Direct and Worker adapters use this same transaction.
4. `imagery_preparation.js` performs conservative bounds, native image planning,
   exact projected-error measurement and UV pricing. A usable global coverage
   cut can precede whole-view exact normalization. Partial work must retain valid
   demand; temporary root-only initialization is not a replacement target.
5. The image scheduler resolves source resources, prioritizes coverage and admits
   complete replacement groups. Encoded browser input can download ahead of UV/GPU
   preparation, within the same request cap and explicit byte reservations.
6. The renderer stages funded geometry, textures and partitions, then publishes a
   coherent display plan. Outgoing owners remain alive through actual submission
   receipts; selection progress alone cannot release the visible display.

Camera revisions invalidate incompatible work, not every reusable measurement or
completed input. The planar path retains its streaming order; global measurement
may prioritize central meshes without reordering canonical native input.

## Image coverage and request ownership

A cold image branch can use sparse intermediate coverage, currently every three
source levels, rather than downloading every ancestor. Resident detail or a fully
funded downloaded finer image may skip missing optional parents. Optional prefetch
has one adopter per URL; other logical tiles use their own ordinarily funded
requests. Cancellation must not release encoded bytes while their reader is alive.

Temporary resident ancestors and cached descendants can cover changing terrain.
Their visible intersections bound drawing work. They are not final precision
proofs and must stop producing metadata when no longer submitted. The final
image cut still follows current-camera error and source-level limits.

`RequestScheduler` owns queued and active requests. It registers an active slot
before invoking a producer, so reentrant enqueue/pause/cancel observes that slot.
A cancelled producer retains its slot until its promise settles. Dependency-waiting
requests do not occupy a producer slot or poll an unchanged refusal.

## Resource ownership and cleanup

`ResourceLedger` tracks explicitly managed payloads; it is not a measurement of
browser RSS, Wasm heap reservation or GPU-driver memory. An allocation must have
credit before production. Transfers move existing ownership; shared immutable
payloads are not charged as independent copies. Bounds and safety ceilings are
not upfront allocations or evidence that target precision was reached.

The default Web envelope is768MiB shared, with64MiB preferred terrain mesh
selection,128MiB retained geometry and256MiB preferred imagery. Partition limits
depend on viewport. Complete outgoing/incoming overlap, encoded input, decode
workspace and upload destinations must fit their actual local/shared credits.
Explicit smaller profiles remain pressure tests. Source descriptors determine
image costs; a fixed image count cannot substitute for byte accounting.

Cancellation, source changes, context loss and destruction close independent
owners. Native results retain credits until disposal receipts. Failed native
free/delete is not retried as if it had succeeded; uncertain Worker ownership is
refunded only after confirmed termination. CPU preparation and GPU submission
are separate, and GPU resources retire after their completion receipts.

Further ownership contracts are documented in `SDK_TEARDOWN_OWNERSHIP.md`,
`SDK_CANDIDATE_IMAGE_OWNERSHIP.md`, `SDK_NATIVE_MEASUREMENT_API.md`,
`SDK_CANONICAL_IMAGERY_INPUT.md` and the corresponding executable contracts.
Dated observations in topic documents describe their recorded implementation;
current headers, dependency graphs and this overview define the current surface.

## Public application boundary

`sdk/js/api/terra_viewer.js` and its TypeScript declaration define the facade:
creation/destruction, camera orbit/eye views, interactions, imagery selection,
POIs/routes, screen projection and terrain queries. Host entries supply request,
worker/task and texture implementations. The Web demo owns controls, labels and
provider configuration, not terrain topology, image scheduling or GPU ownership.

The SDK distinguishes rendered-surface sampling from independent CBDAM height
queries. Data spacing is not vertical accuracy. Walking and terrain-clearance
features expose pending/limited states instead of inventing missing heights.
These APIs do not imply complete mobile or industrial hiking acceptance.

## Build and validation boundaries

The root CMake graph owns SDK, services, builders and retained desktop targets.
C++14 is required; compiler extensions are disabled. Repository formats
`terrain.data`, `terrain.root`, `terrain.xml` and `victms.xml` stay unchanged.
The desktop oracle remains based on commit`e361b81`; squash integration must
retain it as an ancestor and preserve its recorded files.

See `BUILD_SYSTEM.md` and `SDK_RELEASE.md` for canonical commands. SDK source,
compressed modules, installed native consumers, real Wasm/Worker, actual WebGL,
small-budget transitions, and cancellation/teardown all require applicable checks.
A source contract alone is not a browser or product-performance guarantee.

The scoped Web navigation evidence and remaining limitations are recorded in
`SDK_PRODUCTIZATION_PLAN.md`. Rapid motion can still expose coarse coverage and
source-level seams. A bounded endpoint-convergence pass does not establish
continuous pixel uniformity, no flicker,30FPS or arbitrary flight/walking support.
