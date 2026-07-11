# SDK And Mini-Program Roadmap

## Goal

Deliver an open, versioned terrain SDK whose platform-neutral core can run as
WebAssembly and drive 3D terrain visualization in a mini-program. Viewer and
nav3d remain desktop regression clients, not SDK dependencies.

## Guardrails

- Start from tag `baseline-cmake-only-2026-07-11`.
- Preserve `terrain.data`, `terrain.root`, `terrain.xml`, and
  `victms.xml` compatibility.
- Keep each change small enough to compare against viewer captures and state.
- Do not combine algorithm extraction with bulk source moves or format changes.
- Every phase must pass `scripts/verify_baseline.sh` with zero warnings.

## Phase 1: Characterize The Core

Create headless golden tests for metadata parsing, coordinate transforms,
diamond topology, LOD/refinement decisions, patch selection, and texture tile
selection. Record deterministic inputs and outputs from the current code.

**Exit:** tests expose current behavior without Qt, GUI events, or framebuffer
assertions; the desktop baseline is unchanged.

## Phase 2: Establish SDK Boundaries

Introduce `Terra::core` for value types and algorithms, plus explicit
interfaces for terrain storage, texture sources, task scheduling, time, and
diagnostics. Move behavior behind these interfaces incrementally. Keep
OpenGL/Qt implementations as adapters used by viewer and nav3d.

**Exit:** `Terra::core` links only the allowed C++/SL dependencies, and a
dependency audit rejects Qt, OpenGL, CURL, MPI, Berkeley DB, and Apache.

## Phase 3: Define The Public SDK

Provide a small versioned C++ API and a stable C ABI suitable for foreign
runtimes. Add install/export rules, `TerraSdkConfig.cmake`, semantic version
policy, lifecycle/error contracts, and an in-memory sample client.

**Exit:** a consumer builds outside the source tree using only installed
headers/libraries and can load metadata, update a camera, and obtain selected
terrain/texture work.

## Phase 4: Separate Rendering Data

Replace direct core OpenGL calls with backend-neutral frame data: camera state,
visible patches, vertex/index payloads, texture requests, and render flags.
Implement a desktop OpenGL adapter first and compare it with the approved
viewer captures.

**Exit:** core frame decisions are headless-testable; viewer rendering remains
within visual tolerances; renderer ownership is outside `Terra::core`.

## Phase 5: WebAssembly And Mini-Program Adapter

Add an Emscripten CMake toolchain, bounded-memory asset pipeline, asynchronous
fetch/cache interfaces, and a JavaScript/TypeScript facade. Implement adapters
for the mini-program canvas/WebGL context, worker/task model, package assets,
network requests, and persistent cache. Avoid DOM/browser assumptions.

**Exit:** the demo loads the 1k fixture, supports reset, zoom, tilt, and rotate,
and reports frame time, memory, selected patches, and failed requests. Compare
its fixed-camera images and state against the desktop baseline.

## Phase 6: Open-Source Release

Audit licenses and third-party notices, publish reproducible source and
WebAssembly packages, add CI for native and WebAssembly consumers, document the
public API, and define support/versioning policy.

**Exit:** a clean checkout can build, test, package, and run both the desktop
oracle and mini-program demo from documented commands.

## Iteration Template

Each iteration states one boundary change, adds a headless assertion first,
implements the smallest extraction, runs focused tests, then runs the full
baseline. A failed image or log check is investigated before updating any
baseline; snapshots change only for reviewed intentional behavior.
