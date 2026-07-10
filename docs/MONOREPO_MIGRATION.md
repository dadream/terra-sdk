# Monorepo Migration

## Imported Baseline

The monorepo was initialized on 2026-07-11 from these synchronized source
commits:

- spacelib: `357a7b8a0311bddf08eb942118a3843638aac20d`
- ratman: `865fd78deb3a8938dbddf53f4d7e0f4858c13a0d`

Both commits remain ancestors of `main`; the import was not squashed. Imported
trees were verified by matching Git tree object hashes. The colliding source
tags were retained as:

- `spacelib/baseline-2026-07-10`
- `ratman/baseline-2026-07-10`

## Migration Invariants

- Preserve public `sl/...` and `vic/...` include paths.
- Preserve current artifact names and repository/TMS formats.
- Require C++14 for CMake and qmake builds.
- Keep qmake usable until all active targets have reviewed CMake parity.
- Keep generated files outside the source tree.
- Introduce no compiler warnings.

## Phases

### Phase 1: Physical Monorepo

Import both histories under their existing directories and establish repository
metadata. No source API or namespace changes are allowed.

### Phase 2: Integrated Build

Move the validated CMake target graph and sixteen SDK tests into the monorepo.
Build SL with `add_subdirectory` instead of an externally supplied archive.
Keep Docker and the qmake build in the adjacent integration repository.

### Phase 3: Component Ownership

Move central source lists into component-level `CMakeLists.txt` files one
target at a time. Do not move physical source directories in the same commit.

### Phase 4: Directory Organization

After target ownership is stable, move components toward `libs/`, `apps/`,
`tools/`, and `services/`. Update CMake and qmake together and preserve
public include paths without forwarding headers.

### Phase 5: SDK Boundaries And Release

Extract platform-neutral CBDAM/Geo targets, add install exports and an external
consumer test, then retire qmake only after the full regression gate passes.

## Validation

The authoritative gate remains:

```bash
cd ../terra-sdk-web
bash build/verify_cmake_migration.sh
```

It covers CMake and qmake builds, artifact and install parity, sixteen SDK
smoke tests, builders, viewer interaction, nav3d, and the current CMake service
module. Review the complete build log for zero `warning:` matches.
