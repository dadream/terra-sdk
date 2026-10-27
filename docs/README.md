# Documentation

## Current References

- `ARCHITECTURE.md`: current layers, targets, and dependency direction.
- `LEGACY_CORE_ARCHITECTURE.md`: detailed applications, services, libraries,
  data flow, and extraction constraints.
- `BUILD_SYSTEM.md`: canonical Docker/CMake commands and artifact contract.
- `BASELINE_STATUS.md`: supported build surface and baseline evidence.
- `WORKSTATION_TEST_STORAGE.md`: data-disk test outputs, persistent workspace
  mount, local Web service prerequisite and remaining old-copy cleanup.
- `REPOSITORY_SCOPE.md`: repository ownership and generated path contract.
- `RATMAN_BASE_SDK_READINESS.md`: base-module dependency audit.
- `SDK_MINIPROGRAM_ROADMAP.md`: staged SDK and mini-program delivery plan.
- `SDK_RELEASE.md`: package surfaces, compatibility policy, release gate, and
  final manual acceptance handoff.
- `PRODUCT_SITE_RELEASE.md`: tag publishing, product-site build, temporary IP
  access, Lighthouse deployment, and bounded online verification.
- `SDK_PRODUCT_DEFINITION.md`: developer product positioning, SDK/service
  boundary, default-provider offer, reference applications, licensing, and
  product-release criteria.
- `SDK_PRODUCTIZATION_PLAN.md`: scoped Web navigation results, current product
  limits, next-step acceptance and main-integration review findings.
- `SDK_MEASUREMENT_PIPELINE.md`: measured terrain/imagery preparation waits,
  Native and host summary costs, and local joint admission work still required.
- `SDK_CANDIDATE_IMAGE_OWNERSHIP.md`: paid cached/in-flight image loans across
  UV pricing, request cancellation, exact-budget admission and retirement.
- `SDK_TEARDOWN_OWNERSHIP.md`: exception-safe disposal, independent ABI buffers,
  uncertain native receipts and Worker termination before producer refunds.
- `SDK_FUSED_MEASUREMENT_PLAN.md`: fixed-work evidence and the native measurement,
  compaction, input/host ownership boundary; not yet a runtime integration.
- `SDK_NATIVE_REGION_WORK.md`: production C++ resumable compaction, exact work
  credits, borrowed input, bounded output, and remaining runtime integration.
- `SDK_NATIVE_SURFACE_PROJECTION.md`: real CBDAM frozen/resident readers and
  funded count/fill/compaction for selected exact faces.
- `SDK_NATIVE_SURFACE_MODEL.md`: immutable native UV/geometry model, shallow
  bounds, funded lazy domains and whole-model measurement; runtime integration
  remains outstanding.
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

## CloudBase Deployment

- `cloudbase/STORAGE_SMOKE_TEST.md`: verified PG cloud-storage upload,
  metadata, download, SHA-256 evidence, and the verified Run mount contract.
- `cloudbase/DEPLOYMENT_ARCHITECTURE.md`: three-service CloudBase Run
  architecture, versioned terrain and imagery storage, and persistent cache.
- `cloudbase/IMAGERY_SERVICE.md`: unified PS 1k, Blue Marble, and Tianditu
  imagery HTTP contract, COS layout, deployment, and acceptance procedure.
- `cloudbase/MINIPROGRAM_ACCEPTANCE.md`: DevTools planar/globe manual
  acceptance, interaction, imagery refresh, evidence, and security checks.

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
