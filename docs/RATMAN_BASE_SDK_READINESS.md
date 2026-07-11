# Ratman Base SDK Readiness Audit

## Purpose

This audit classifies the current `ratman/base` modules by CMake coverage, external dependencies, and SDK readiness. It identifies which non-UI modules must shed Qt and OpenGL behind focused tests.

## Evidence

Current CMake base targets are defined in `cmake/RatmanBaseTargets.cmake` and validated through `scripts/cmake_artifacts.tsv`. The source dependency scan covered these directories under `ratman/base/src/vic`:

- `math`, `xml`, `img`, `curlstream`, `fetcher`, `qxml`, `mpi`, `gl`, `persistent`.

Scan summary:

| Module | CMake target | Direct notable dependencies | SDK-readiness | Next action |
| --- | --- | --- | --- | --- |
| `math` | `vic_base_math` | SL, C/C++ only | High | Add focused numeric/minimizer tests before API cleanup. |
| `xml` | `vic_base_xml` | bundled TinyXML/STL | High | Add XML parse/save tests and keep as platform-neutral XML utility. |
| `img` | `vic_base_img` | SL; no direct OpenGL include in active target | Medium | CMake smoke now covers image storage/quadtree behavior; continue naming and rendering-assumption review before public SDK exposure. |
| `curlstream` | `vic_base_curlstream` | CURL, ZLIB | Medium | CMake smoke covers URL/local stream behavior; add network tests only if this adapter is retained. |
| `fetcher` | `vic_base_fetcher` | Qt Core `QThread`/`QMutex`, CURL | Low for core SDK | CMake smoke covers lifecycle/text decode; later replace Qt threading or keep behind IO adapter boundary. |
| `qxml` | `vic_base_qxml` | Qt Core, Qt XML | Low for core SDK | CMake smoke covers database adapter behavior; later replace with platform-neutral XML/config API or keep as Qt adapter. |
| `mpi` | `vic_base_mpi` | MPI | Adapter-only | CMake smoke covers single-process runtime; keep outside core SDK. |
| `persistent` | `vic_base_persistent` | Berkeley DB | Adapter-only | CMake smoke covers persistent map behavior; keep outside core SDK. |
| `gl` | `vic_base_gl` | OpenGL/GLU | Rendering-only | CMake smoke covers font metrics without GL context; keep with UI/rendering layer. |

Current smoke coverage: `terra_sdk_base_math_xml_smoke` links against `vic_base_math` and `vic_base_xml`, exercises the Scatter Search C API allocation/callback path, validates `scalar_functor` basics, `scalar_functor_solver` lifecycle semantics, bounded `scatter_search_minimizer` and `differential_evolution_minimizer` behavior, and Nelder-Mead minimizer header/single-step behavior, and validates XML traversal, typed/default/vector attribute conversion, node error reset, and parse-error reporting. `terra_sdk_base_img_smoke` links against `vic_base_img` and validates `gl_image` extents, linear storage, channel/alpha helpers, and deterministic quadtree magnify/blend output. `terra_sdk_base_curlstream_smoke` links against `vic_base_curlstream` and validates URL parsing, legacy base/relative URL composition, and local read/write stream round-tripping without network access. `terra_sdk_base_qxml_smoke` links against `vic_base_qxml` and validates Qt XML database querying, mutation, save/reload, and callback propagation. `terra_sdk_base_fetcher_smoke` links against `vic_base_fetcher` and validates fetcher lifecycle state, protocol classification, text decoding, result buffering, eviction, and clear behavior without network access. `terra_sdk_base_persistent_smoke` links against `vic_base_persistent` and validates Berkeley DB-backed map metadata, insertion, duplicate handling, ordered iteration, lookup, updates, clear behavior, persistent reopen, and temporary-file cleanup. `terra_sdk_base_mpi_smoke` links against `vic_base_mpi` and validates MPI initialization, rank/count metadata, processor naming, and finalization in single-process mode. `terra_sdk_base_gl_smoke` links against `vic_base_gl` and validates embedded font metadata, fixed/proportional string metrics, spacing, scaling, and bbox calculations without creating a GL context. The adjacent core-level `terra_sdk_geo_tilemap_smoke` links against `vic_core_geo_base` and validates platform-neutral TMS tilemap profile defaults, descriptions, and validation, `terra_sdk_geo_victms_smoke` validates VICTMS tile naming, TileMap description round-tripping, and TMS root/service/TileMap resource parsing, `terra_sdk_geo_srs_smoke` links against `vic_core_geo_srs` to validate SRS parsing, units, copy/reset behavior, invalid SRS handling, and WGS84 coordinate transformations, `terra_sdk_geo_builder_smoke` links against `vic_core_geo_builder` to validate path cleanup, quadtree naming, GDAL output driver selection, color remap identity, and identity reprojection behavior, and `terra_sdk_vfs_repository_smoke` links against `vic_core_vfs` to validate repository persistence plus local file/repository fetch behavior. `terra_sdk_cbdam_repository_smoke` links against `vic_core_cbdam_base` and validates grid diamond topology, simple polygon triangulation, `reference_counted_cache` lifecycle, `diamond_operator` rounding helpers and wavelet roundtrip, `color_rgb` arithmetic, `grid_diamond_state` flags/serialization, `delta_codec` root patch distribution, `null_compressor` patch serialization, `diamond_vertices` patch ray intersection, `ray` primitive intersections, `priority_diamond` refinement/coarsening ordering, planar/spherical/cylindrical coordinate transform contracts, CBDAM repository metadata write/read round-tripping for a planar coordinate transform, `raw_image` tiled storage/sampling, and `byte_array_accessor` patch payload layout. `terra_sdk_cbdam_geo_smoke` links against `vic_core_cbdam_geo` and validates external height/RGB sampler callbacks, color remapping, sample spacing, and map mosaic sampler selection/statistics/minimization behavior, empty tile handling, and overlapping tile priority. These tests are run by `scripts/build_cmake.sh` through `terra_sdk_cmake_smoke` and CTest.

The Ratman core smoke, `terra_sdk_ratman_core_smoke`, links against `vic_core_ratman` and validates string utilities plus planar camera-oriented position math without opening a viewer window or creating a GL context.

## Dependency Boundaries

Recommended boundaries for the open SDK direction:

- Core candidate: `math`, `xml`, selected `img` data structures after tests.
- IO adapters: `curlstream`, `fetcher`, `qxml`. These may remain available, but core algorithms should not require Qt or network threads.
- Optional execution/storage adapters: `mpi`, `persistent`. These should stay optional for builders/services.
- Rendering/UI support: `gl` and any Qt/OpenGL-dependent viewer code. These remain outside the platform-neutral SDK core.

## Migration Order

1. Keep all supported CMake targets and baseline checks green.
2. Extend tests for high-readiness modules and adapters: `math`, `xml`, selected `img`, offline `curlstream`, `qxml`, and offline `fetcher` behavior now have CMake smoke coverage; next add focused behavior tests for remaining core candidates and adapters.
3. Add adapter tests for `curlstream`, `qxml`, and `fetcher` before changing their threading/XML implementation.
4. Keep `mpi`, `persistent`, and `gl` as explicit non-core dependencies in CMake target names and docs.
5. Only after tests exist, split or replace Qt/OpenGL dependencies from non-UI targets in small commits with viewer/nav3d regression gates.

## Validation

For base-layer build parity changes:

```bash
cd terra-sdk
bash scripts/build_cmake.sh
bash scripts/build_cmake.sh
bash scripts/check_cmake_artifacts.sh
```

For changes touching Qt/OpenGL-adjacent base modules, also run:

```bash
cd terra-sdk
VIEWER_TIMEOUT_SECONDS=25 bash scripts/verify_viewer_1k_smoke.sh
NAV3D_TIMEOUT_SECONDS=45 bash scripts/verify_nav3d_1k_smoke.sh
```

For final review evidence during this migration slice, run:

```bash
cd terra-sdk
bash scripts/verify_baseline.sh
```

## Completion Criteria For Base Layer

The base layer is ready for the next SDK refactoring stage when:

- every active base module has reviewed CMake coverage or is explicitly retired;
- high-readiness modules have focused tests independent of viewer rendering;
- Qt/OpenGL dependencies are either removed from core candidates or documented as adapter/rendering modules;
- artifact parity and viewer/nav3d gates still pass after each split.
