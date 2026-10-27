# Cooperative imagery region compaction

This page records the accepted JS runtime component. The subsequent production
C++ primitive is described in [Native region work](SDK_NATIVE_REGION_WORK.md);
it has not yet replaced this runtime path. The later teardown work advances the
current Worker protocol to41 without changing these compaction rules.

This increment replaces the temporary work in `sdk/js/terrain/surface_regions`
with `region_compaction`. CBDAM, the eight-root imagery tree, TMS/WMTS adapters,
projection formulas, texel targets and presentation/admission rules are retained.
C ABI43 and Worker protocol40 are unchanged. It does not introduce per-triangle
Wasm calls; the existing native imagery planner still receives a compact snapshot.

## Algorithm and work boundary

The frozen pre-change definition is test-only at
`tests/js/reference/compact_regions_reference.js`. Production preserves its
first-member deduplication, stable group ordering, density enclosure, area
comparison and returned numeric regions.

- Numeric signatures replace formatted coordinate/matrix keys. Full numeric
  equality confirms every collision; unordered triangles, signed zero and NaN
  identity follow the former key's numeric behavior. No coordinate is quantized.
- One typed workspace contains indices, reusable hash generations, density/area
  summaries, sort storage, hull indices and a depth-bounded group frontier.
  It replaces group-sized JS maps, recursive slices and implicit sort storage.
- Bottom-up stable merging retains a cursor for every merge and copy. Scans,
  collision probes, hull pushes/pops and result production yield after64 bounded
  work units. This is not a hard deadline for allocation, GC or a whole SDK call.
- Four actual support points supply a lower bound on a candidate hull's area.
  A merge is skipped only when this bound exceeds covered area, the original
  tolerance and a conservative floating-point envelope. Large/nonfinite or
  uncertain cases take the original complete hull test. This prevents repeated
  hull construction for provably disconnected regions without filling holes.

For four points, one of the three pairs of triangles sharing the first point is
contained in their convex hull; the minimum pair area is a lower bound on the
complete hull. The rounding envelope scales with coordinate magnitude and the
square of group size, covering the complete shoelace accumulation as well as the
witness calculation. The original density and area acceptance tests still decide
all remaining merges.

## Ownership and lifecycle

`regionCompactionBytes` prices the entire ArrayBuffer before creation. Standalone
math helpers may supply their own workspace; actual SDK imagery preparation binds
`ImageryScratch` through `TerraAbi`.

Direct Wasm reserves the buffer through the existing imagery input budget. A
Worker first returns an input quote, then allocates only after its matching grant.
The input receipt accounts for actual bytes. Measurement work resumes through the
same iterator; completion/cancellation closes the buffer before native imagery
input production. Capacity refusal retains the existing display and follows the
existing cancellation/recovery policy rather than pinning an unfunded candidate.

ABI owns every registered scratch owner. Local execution teardown removes its
owner; Worker binds it after delayed ABI initialization. ABI termination cancels
registered preparation and releases scratch before dropping its budget. A late
borrower release checks buffer identity and cannot retire a successor allocation.

Adapter input/total imagery payload diagnostics include this JS ArrayBuffer along
with native input and packing payloads; the legacy `imagery-input-native` budget
name is an ownership lane, not a claim that every byte resides in Wasm memory.
Fixed control objects, allocator overhead, active input/output region objects,
other derived metadata, GC, Wasm capacity and process RSS are separate quantities.
This does not complete P1 memory ownership or end-to-end low-capacity publication.

## Evidence

Outputs use the persistent mount at
`viewer_verify_output/region_compaction_20261019/`. Early heap-sort and initial
area implementations remain as intermediate evidence; only `benchmark.json`
contains the final source fingerprint and fixed-work comparison.

The contract compares exact scalar outputs over uniform, hole, varying and
separated surfaces, duplicates, stable-order ties, signed zero and extreme
translations. Independent UV-area and node-local SSE checks protect coverage and
quality. It verifies scratch refusal, cancellation and reused storage. A counted
source-read fixture reproduces a220576-read scalar step; the cooperative maximum
is6592. Fourfold grid growth remains below quadratic work in the dyadic fixture.
These operation observations are not device frame/input-latency acceptance.

The real Wasm adapter contract checks one-byte-short admission, exact payload,
competing owners, Worker receipts, cancellation, late borrowers and ABI teardown.
Both source and compressed package run these contracts. Browser navigation must
show actual scratch allocations and zero live scratch at oblique convergence,
then zero test-owned resources/traffic after destruction.

Full baseline/release and local18766 verification are required before committing
runtime code. Final results are recorded in the evidence directory. Region
compaction is only part of the complete measurement/input boundary described in
`SDK_NATIVE_PROJECTION.md`; industrial latency, all derived metadata, constrained
joint publication, walking/device acceptance and the remaining P0–P4 work stay open.

The final19-step baseline rebuilt and passed16 core and32 SDK tests with no
compiler warnings. Source and compressed packages passed both new contracts;
the full release and348 browser checks passed. All nine execution/network/scene
combinations reached the original terrain and imagery targets, sampled no blank
or missing coverage, and released test resources/requests/timers to zero. Actual
scratch use was observed, with a maximum284736-byte buffer and zero at convergence.
The Wasm hash is unchanged. Preparation/settlement times vary in both directions;
the fixed-work improvement does not establish end-to-end latency improvement.
Local18766 deployment and final cleanup receipts are `deployment.json` and
`cleanup.json`; server49 is unchanged.
