# Terra SDK Architecture

## Current Layers

```text
viewer / nav3d / builders / Apache modules
                    |
             vic_ratman and VFS
                    |
      CBDAM base / CBDAM Geo / Geo libraries
                    |
          VIC base libraries and SL
```

SL is the shared C++ foundation. VIC base contains math, XML, image, IO,
OpenGL, MPI, and persistence support. Geo, VFS, and CBDAM form the domain
layer. Viewer is the algorithm regression client; nav3d is the product
integration client. Builders produce terrain/texture repositories, and Apache
modules expose them remotely.

## Supported CMake Targets

- Foundation: `sl`, `vic_base_*`.
- Domain: `vic_core_vfs`, `vic_core_geo_*`, `vic_core_cbdam_*`.
- Product framework: `vic_core_ratman`.
- Applications: `vic_app_cbdam_viewer`, `vic_app_ratman_nav3d`.
- Tools: `vic_app_cbdam_mpi_builder`,
  `vic_app_geo_raster_quadtree_builder`.
- Service: `vic_service_mod_victms`.

## Desired Dependency Direction

```text
Qt viewer/nav3d ------> desktop OpenGL adapter
mini-program ---------> WebGL/Wasm adapter
builders/services ----> storage and network adapters
                                |
                         Terra public SDK
                                |
                    platform-neutral core -> SL
```

The core must eventually build without Qt, OpenGL, CURL, MPI, Berkeley DB, or
Apache. Adapters depend inward; core code never depends outward.

## Evolution Boundaries

1. Freeze current behavior with headless tests and viewer/nav3d baselines.
2. Split CBDAM algorithm, repository/IO, scheduling, and rendering concerns.
3. Move camera, LOD/refinement, patch/tile selection, and format parsing into a
   platform-neutral target.
4. Define backend-neutral frame data before adding WebAssembly/WebGL.
5. Export versioned `Terra::*` targets only after public headers and dependency
   boundaries have consumer tests.

`terrain.data`, `terrain.root`, `terrain.xml`, and `victms.xml` are
compatibility contracts. Their builders, readers, viewer baseline, and service
checks remain green through every extraction.
