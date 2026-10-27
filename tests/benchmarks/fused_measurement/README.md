# Fused exact-face measurement experiment

This is an offline feasibility experiment, excluded from the SDK package.
It does not implement a production measurement task or replace the manual site.
See [the implementation plan](../../../docs/SDK_FUSED_MEASUREMENT_PLAN.md).
The executable now links the SDK's official triangle projection kernel; the old
test-local projection files are retained as historical prototype sources and
are not compiled. Frozen JS and numeric contracts remain the independent oracle.

Run from the active Linux worktree with Docker and the existing Wasm image:

```bash
bash scripts/benchmark_fused_measurement.sh
```

The script verifies the persistent `viewer_verify_output/` mount, mounts source
read-only, builds an independent Wasm with test-only exports, rejects compiler
warnings and runs Node. A new timestamped data-disk directory receives build
logs, `benchmark.json` and `benchmark.log`. Override `TERRA_FUSED_BENCH_OUTPUT`
only with a path below that existing workspace mount. It removes its own build
container on success, failure or interruption. It opens no network service.

`benchmark.js` compares selected exact-face projection, clipping, density,
compaction, real native imagery input/planning and the same JS plan readback.
Three mesh sizes, three surfaces, culling on/off and two capacity profiles give36
cases; two warmups and five alternating samples retain360 timing rows with phase
costs and quality/limitation reasons. Both profiles use the same source levels
and pixel target. Expanded capacity is tested independently of the default
profile, whose limited outputs must not be called precision convergence.
Frozen compaction cases,
node-local SSE, full native cuts, refusal and Wasm growth validate that work.
The native allocation registry and context must be empty after completion.

Geometry is already owned on both sides. Two-pass count/fill, scratch allocation
and freeing are timed; raw per-face results never return to JS in the fused
timed route. Output descriptors reference immutable input points and density,
then materialize at most256 full wire rows into one priced page. The native
input API still validates and copies those rows; this prototype does not assume
that a C wire structure can alias a C++ semantic object.

The thirteen frozen compaction cases include small inputs and a tiny-area hull
whose fan has more rows than its input. Thus a general output bound cannot be N.
The wire page uses min(3N,256) rows; it does not reserve256 rows for small inputs.

The prototype compares trusted finite fixture arrays with positive projected
depth and finite densities. It does not validate the W-to-zero/infinite-SSE
branches; those need independent production contracts. It is synchronous, has no
work-ID/source lifetime protocol or ledger grants, and does not cover block
selection, shallow bounds, CBDAM candidate sampling, transport, UV fitting or
device latency. These are required before runtime integration. Logical numeric
payload figures are not allocator, GC, Wasm-capacity or RSS limits. Existing
SDK/scene release gates cannot substitute for those missing contracts.
