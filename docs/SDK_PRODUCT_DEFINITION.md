# Terra SDK Product Definition

## 1. Purpose And Positioning

Terra is a lightweight, cross-platform 3D terrain visualization product for
developers who need to load, navigate, and render planar or globe terrain in a
Web page, WeChat Mini Program, or native desktop integration.

It is not a standalone data file reader and is not a general GIS platform. A
working integration contains three explicit parts:

1. The Terra SDK runtime, which owns camera, terrain LOD, decoding, rendering,
   resource scheduling, and structured diagnostics.
2. A terrain provider that serves versioned CBDAM terrain records.
3. An imagery provider that serves licensed imagery and its attribution.

Terra supplies a default globe terrain provider and a Tianditu imagery proxy
for examples and supported starter integrations. Applications can replace both
providers with their own endpoints without changing SDK behavior.

## 2. Intended Users

| User | Need | Terra offer |
| --- | --- | --- |
| Application developer | Add a controllable 3D globe or local terrain view quickly | Web and Mini Program facade, default provider profile, and runnable examples |
| Data/service operator | Publish a CBDAM terrain dataset safely | Versioned terrain HTTP contract and CloudBase/Docker reference deployment |
| Product team | Evaluate terrain visualization before owning infrastructure | Hosted starter services, Web demo, Mini Program preview, and diagnostics |
| Enterprise integrator | Use private terrain, imagery, and credentials | Provider interfaces and a self-hosted deployment path |

The first product promise is a reliable visualization loop: open a dataset,
move the camera, progressively refine terrain and imagery, and receive clear
failure state. It is not terrain authoring, spatial analysis, editing, or a
full layer/style ecosystem.

## 3. Product Surfaces

### Terra SDK

The SDK is the reusable runtime. Its public surface consists of the C++14
package, versioned C ABI, reproducible Wasm artifact, JavaScript/WebGL facade,
and platform adapters. The supported responsibilities are:

- planar and globe terrain loading and CBDAM refinement;
- camera `ViewState`, pan, anchored zoom, orbit, tilt, reset, and interaction
  constraints;
- terrain and imagery request scheduling, cancellation, cache state, retries,
  and visible fallback behavior;
- coordinate projection, basic POI picking, and narrow route/surface APIs as
  defined in the productization plan;
- structured errors and status counters suitable for application diagnostics.

The SDK must not require an application to construct or understand CBDAM
diamond keys. Key calculation and patch request construction belong to the
SDK-owned terrain provider adapter. A normal application supplies a provider
profile or endpoint; only a provider implementer uses the versioned terrain
service contract.

### Terra Starter Service

The default hosted service is a companion service, not a hidden SDK
dependency. It provides:

- a versioned global terrain dataset for globe demonstrations;
- a versioned PS 1k planar dataset for fast visual verification;
- a Tianditu imagery proxy that keeps the upstream token on the server;
- HTTPS delivery, health checks, fixed API error semantics, and dataset
  versioning.

Terrain and imagery remain separate services. A terrain dataset ID is
immutable: changed data is published under a new ID/version, rather than
overwriting cached records. The SDK exposes source IDs and sanitized failures,
never service credentials.

The currently configured CloudBase resources are an acceptance and developer
test environment. They must not be described as a production SLA service until
availability, quota, domain, observability, incident response, and provider
rights have been approved.

### Reference Applications And Preview

Terra ships three integration references:

- a Web reference application for the fastest local and browser-based check;
- a WeChat Mini Program reference application for actual `WXWebAssembly`,
  canvas, HTTPS, and lifecycle integration;
- a small desktop SDK consumer for native package validation.

The Mini Program reference app can be released as a preview experience. It is
a product demonstration and acceptance aid, not an SDK test replacement.
`vic_cbdam_viewer` and `nav3d` remain desktop regression oracles, not public
SDK examples or supported SDK dependencies.

## 4. Data And Service Contract

All default providers use explicit, versioned configuration. A typical
application selects a profile conceptually equivalent to:

```js
{
  terrain: { provider: 'terra', datasetId: 'globe-v1' },
  imagery: { provider: 'tianditu-img-c' }
}
```

The profile resolves to the documented Terrain Service v1 API and imagery
proxy. It does not bake a CloudBase environment ID, a token, or an unversioned
URL into an application binary. Integrators may instead configure a private
terrain origin and a licensed imagery provider.

Service behavior is part of the product contract:

- manifests declare coordinate system, bounds, record framing, level range,
  texture descriptors, and schema version;
- terrain records carry length, checksum, ETag, and immutable cache metadata;
- service errors are machine-readable and do not disclose repository paths;
- imagery responses preserve required attribution and do not disclose upstream
  credentials;
- imagery caching, including the proposed long-lived COS cache, is enabled only
  when the imagery provider's written authorization permits proxying and that
  cache duration.

See [Terrain Service v1](miniprogram/TERRAIN_SERVICE_V1.md) and
[CloudBase Deployment Architecture](cloudbase/DEPLOYMENT_ARCHITECTURE.md) for
the implementation contract. The latter's one-year Tianditu cache is a target
configuration subject to provider authorization, not an unconditional public
service commitment.

## 5. Experience Scope

### Included In V1

- deterministic initial view and named camera commands such as Beijing, top,
  north, tilt, zoom, reset, and retry;
- touch and pointer gesture handling with bounded deltas, cancellation, camera
  settle state, and no accumulated out-of-range movement;
- progressive terrain refinement and ancestor imagery fallback while exact
  imagery is loading;
- basic POIs, one route, geographic projection, and application-owned detail
  panels;
- visible imagery attribution and actionable loading/error state.

### Deliberately Excluded

- terrain generation, upload, editing, analysis, or arbitrary repository
  conversion;
- general GeoJSON layers, styling language, vector tiles, offline packages, or
  a map authoring UI;
- application history, bookmarks, tours, business search, HTML injection, or
  business data fetching;
- guarantees for third-party imagery coverage, freshness, or licensing beyond
  the approved provider contract.

These exclusions keep Terra focused on rendering and interaction. Application
code owns POI detail content, WXML/HTML presentation, navigation, business
permissions, and data lifecycle.

## 6. Packaging, Documentation, And Release

Each release publishes two verified archives:

- `terra-sdk-<version>-native.tar.gz` with headers, static libraries, CMake
  package metadata, native examples, notices, and documentation;
- `terra-sdk-<version>-miniprogram.tar.gz` with the C ABI header, Wasm,
  runtime adapters, Mini Program example material, notices, and documentation.

The release page must link to:

- a Quick Start for the hosted default providers;
- Web, Mini Program, and desktop reference application guides;
- a provider configuration and self-hosting guide;
- the terrain HTTP contract, imagery attribution policy, and service status;
- compatibility matrix for SDK version, Wasm ABI, terrain schema, and sample
  application version;
- known limitations and the exact automated/manual acceptance evidence.

The Mini Program example must state that real-device use requires a valid AppID
and registered HTTPS request/image domains. It should display its imagery
attribution continuously and offer a safe retry path when a provider fails.

## 7. Licensing And Rights Boundary

Terra cannot presently be presented as an all-MIT SDK. The repository combines
imported SL and RATMAN/CBDAM code whose original terms remain in force; their
open-source option is GPL-compatible and their commercial/private-source path
requires authorization. This applies to derivative native and Wasm runtime
artifacts, not just source files.

| Deliverable | License position |
| --- | --- |
| Imported SL, RATMAN/CBDAM, and runtime artifacts derived from them | Preserve upstream terms, copyright notices, and redistribution obligations |
| New standalone documentation, deployment templates, JavaScript helpers, and examples | May use MIT only after confirming they are independent and carry no copied/linked restricted implementation |
| Entire Terra runtime under MIT | Not permitted without upstream commercial relicensing or an independently implemented replacement |
| Default datasets and Tianditu imagery | Governed by their data/provider terms, separately from SDK code licensing |

Before any public announcement, produce an SPDX inventory, keep `LICENSE` and
`NOTICE` in every release archive, review the Wasm license path, and obtain a
written decision on commercial relicensing or the long-term replacement plan.
This is a release gate, not wording to defer to a README footer.

## 8. Service Tiers And Support Boundary

| Tier | Intended use | Commitment |
| --- | --- | --- |
| Local/reference | SDK development and CI | Docker scripts and deterministic local fixtures |
| Starter service | Demo, preview, integration evaluation | Published limits; best effort until a formal SLA exists |
| Self-hosted | Production application with owned data or credentials | Reference deployment and contract support; operator owns availability |
| Managed/private future service | Enterprise production workloads | Private datasets, quotas, monitoring, support, and SLA only after separate product approval |

The starter service needs a public health/status endpoint, rate limits, abuse
controls, request/error/cache metrics, token redaction, and a published
deprecation period. A service outage must leave the SDK in an observable
recoverable state, not a blank canvas or an infinite retry loop.

## 9. Developer Journeys

### Quick Evaluation

1. Open the Web reference application or Mini Program preview.
2. Select globe or PS 1k terrain and verify pan, zoom, tilt, reset, terrain,
   imagery, attribution, and retry behavior.
3. Copy the minimal provider configuration into an application.

### Application Integration

1. Install the native or Mini Program SDK package.
2. Create `TerraViewer` with an initial `ViewState` and default provider
   profile.
3. Bind host lifecycle and input events, then display application-owned loading
   and detail UI from SDK events.
4. Run Web evidence plus Mini Program DevTools/device acceptance appropriate to
   the target platform.

### Private Deployment

1. Publish a new immutable terrain dataset version and validate it using the
   Terrain Service v1 checks.
2. Deploy terrain and imagery services independently using the reference
   Docker/CloudBase architecture.
3. Configure endpoint, imagery authorization, cache policy, and allowlisted
   HTTPS domains in the application.
4. Run contract, visual, and security acceptance before serving users.

## 10. Product Roadmap

### Phase A: Developer Preview

Freeze the provider configuration model, current public facade, dataset/schema
versioning, licensing statement, Quick Start, and the three reference
applications. Make all default service limitations explicit.

### Phase B: Public Beta

Operate the starter service with health reporting, limits, service metrics,
documented support channel, Web demo, and Mini Program preview. Stabilize the
interaction and imagery-convergence work defined in
`SDK_PRODUCTIZATION_PLAN.md`.

### Phase C: Production Readiness

Publish self-hosting automation, compatibility/deprecation policy, release
notes, security response process, and device acceptance matrix. Production
claims require repeated service-load and real-device evidence.

### Phase D: Commercial Option

Only after license rights and operational demand are clear, evaluate managed
private datasets, dedicated imagery proxying, usage quotas, support plans, and
SLA. Do not use a hosted test service as an implicit commercial promise.

## 11. Release And Success Criteria

A public SDK release requires:

- reproducible native and Wasm packages, no compiler warnings, C ABI/Wasm
  parity, and installed-consumer verification;
- the Terrain Service v1 contract and dataset byte-parity gates;
- planar and globe visual evidence, including terrain, imagery, interaction,
  retry, and attribution checks;
- documented manual DevTools, Android, and iOS acceptance ownership;
- review of license, data rights, secrets, HTTPS domains, and imagery cache
  policy;
- generated release archives containing the correct notices and samples.

Success is measured by a developer reaching a visible terrain scene with the
default profile quickly, then replacing that profile with a private provider
without changing camera or rendering code. The next planning input is the
implementation-level [SDK Productization Plan](SDK_PRODUCTIZATION_PLAN.md),
which must remain aligned with this product boundary.
