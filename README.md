# Terra SDK

Terra SDK is the C++14 monorepo for the SL foundation library and the
Ratman/CBDAM terrain stack. It preserves the validated legacy behavior while
moving build ownership, tests, and future SDK boundaries into one repository.

## Repository Layout

- `spacelib/`: SL math, geometry, containers, codecs, and utilities.
- `ratman/base/`: shared VIC support libraries.
- `ratman/ratman/src/`: Geo, VFS, CBDAM, and Ratman libraries.
- `ratman/ratman/apps/`: viewer, nav3d, builders, and legacy tools.
- `ratman/apache_mod_*/`: Apache service modules.
- `cmake/`: current monorepo target and dependency definitions.
- `tests/`: CMake SDK smoke tests.

The imported source directories intentionally keep their original layout during
the first monorepo phase. Public includes remain `sl/...` and `vic/...`.

## Build

The canonical environment is the `qt-dev-env` Docker image managed by the
adjacent `terra-sdk-web` integration repository:

```bash
cd ../terra-sdk-web
bash build/build_cmake.sh
```

For a host with all dependencies installed:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --target terra_sdk_cmake_smoke --parallel
ctest --test-dir build --output-on-failure
```

All C++ targets require at least C++14. CMake disables compiler extensions;
the qmake path remains available during migration:

```bash
cd ../terra-sdk-web
bash build/build.sh
```

Run `bash build/verify_cmake_migration.sh` from `terra-sdk-web` before
merging build, target, viewer, builder, or service changes.

## Migration Status

The root CMake build includes SL directly and builds the current Ratman
libraries, viewer, nav3d, builders, `mod_victms`, and sixteen SDK smoke tests.
Qt/OpenGL and platform-independent CBDAM logic are not separated yet. See
`docs/ARCHITECTURE.md` and `docs/MONOREPO_MIGRATION.md`.

## Licensing

Imported components retain their original licenses and copyright notices. See
`LICENSE`, `spacelib/COPYING`, and `ratman/LICENSE`.
