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

SL is the shared C++ foundation. Ratman base contains math, XML, image, IO,
threading, OpenGL, MPI, and persistence support. The domain layer contains Geo,
VFS, and CBDAM. Viewer is the primary algorithm regression client; nav3d is the
product integration client. Builders produce terrain and texture repositories,
and Apache modules expose those repositories remotely.

## Current CMake Targets

- Foundation: `sl`, `vic_base_*`.
- Domain: `vic_core_vfs`, `vic_core_geo_*`, `vic_core_cbdam_*`.
- Product framework: `vic_core_ratman`.
- Applications: `vic_app_cbdam_viewer`, `vic_app_ratman_nav3d`.
- Tools: `vic_app_cbdam_mpi_builder`,
  `vic_app_geo_raster_quadtree_builder`.
- Service: `vic_service_mod_victms`.

The target names preserve current artifact names. `Terra::sl` is the first
in-tree namespaced target.

## Target Dependency Direction

```text
apps(Qt) ----------> ratman_qt ------> render_gl
tools --------------> GDAL/MPI adapters
services -----------> HTTP/storage adapters
                              |
cbdam_core -> geo_core -> base_core -> sl
```

Core targets must eventually build without Qt, OpenGL, CURL, MPI, Berkeley DB,
or Apache. Adapters and applications may depend inward; core code must not
depend outward.

## Evolution Boundaries

1. Keep the imported source layout and behavior stable while CMake and qmake
   build from the monorepo.
2. Move each component's CMake source list next to that component.
3. Split `vic_cbdam_base` into algorithm, repository/IO, runtime/threading,
   OpenGL renderer, and Qt input adapters.
4. Keep `fetcher`, `qxml`, `gl`, `mpi`, and `persistent` explicit
   adapter or rendering components.
5. Export installable `Terra::*` targets only after their dependency boundary
   and public headers are tested.

Repository formats `terrain.data`, `terrain.root`, `terrain.xml`, and
`victms.xml` are compatibility contracts. Their readers, builders, viewer
baseline, and service checks must remain green through every split.
