# Documentation

## Current References

- `ARCHITECTURE.md`: current layers, targets, and dependency direction.
- `LEGACY_CORE_ARCHITECTURE.md`: detailed applications, services, libraries,
  data flow, and extraction constraints.
- `BUILD_SYSTEM.md`: canonical Docker/CMake commands and artifact contract.
- `BASELINE_STATUS.md`: supported build surface and baseline evidence.
- `REPOSITORY_SCOPE.md`: repository ownership and generated path contract.
- `RATMAN_BASE_SDK_READINESS.md`: base-module dependency audit.
- `SDK_MINIPROGRAM_ROADMAP.md`: staged SDK and mini-program delivery plan.
- `SDK_RELEASE.md`: package surfaces, compatibility policy, release gate, and
  final manual acceptance handoff.
- `SDK_PRODUCTIZATION_PLAN.md`: lightweight SDK scope, budgets, camera
  interaction, ancestor imagery fallback, basic POI/single-route support, and
  Mini Program business UI boundaries.
- `miniprogram/WASM_SDK_V1.md`: C ABI, Emscripten package, memory, and parity contract.
- `miniprogram/SDK_PRODUCT_API.md`: TerraViewer V1 API, lifecycle, POI,
  route, surface status, interaction, and application UI boundary.
- `miniprogram/TERRAIN_SERVICE_V1.md`: versioned terrain HTTP delivery contract.
- `miniprogram/GLOBE_RUNTIME.md`: Mini Program globe runtime and operator flow.
- `miniprogram/WEB_SDK_EVIDENCE.md`: automated real-Wasm/WebGL browser evidence.
- `miniprogram/VALIDATION_GUIDE.md`: end-to-end terrain data checks, local
  service startup, and Mini Program planar/globe visual acceptance workflow.
- `miniprogram/CAPABILITY_PROBE.md`: final Mini Program environment acceptance.
- `GLOBE_VERIFICATION.md`: spherical terrain and Tianditu WMTS verification.

## Viewer Baseline

- `VIEWER_BASELINE_SPEC.md`: deterministic viewer verification contract.
- `viewer_baseline/PLAN.md`: implementation phases and acceptance criteria.
- `viewer_baseline/USAGE.md`: baseline creation, validation, and visual review.

## Policy

Keep active architecture, SDK boundaries, build instructions, and checked-in
verification flows here. Generated reports and logs belong in
`viewer_verify_output/`. Large datasets, deployment guides, and historical
migration reports stay outside this repository unless a concrete supported
target requires them.
