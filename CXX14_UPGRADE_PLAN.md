# Spacelib C++14 Upgrade Plan

## Goal

`spacelib` now has C++14 as its minimum C++ standard. This plan captures the remaining legacy compatibility code and defines a staged modernization path that preserves the public `sl` API, numeric behavior, serialized data formats, and downstream `ratman` / `terra-sdk-web` validation.

## Current Checkpoint

- Committed: `d34b583 build: require C++14 for spacelib`.
- Done: `float_cast.hpp` uses `std::lrint` / `std::lrintf` and no longer depends on old ISO C feature macros.
- Done: generated `src/sl/config/config.h` is no longer tracked and is ignored by `.gitignore`.
- Done: `std::unary_function` / `std::binary_function` inheritance was removed without keeping legacy typedef aliases.
- Done: `HAVE_NAMESPACE_STD` and `HAVE_ANSI_FOR_SCOPE` compatibility checks were removed because C++14 requires both behaviors.
- Baseline validation: Docker CMake build has no `warning:` lines, and CTest passes 25/25 tests.

## Findings

### Build And Configuration

- Done: `CMakeLists.txt` no longer probes for pre-standard namespace or for-scope behavior.
- `src/sl/config.hpp` still carries compatibility for restrict variants and thread feature gates.
- Done: `src/sl/stlext_unordered_containers.hpp` now aliases C++14 standard unordered containers directly, and TR1 unordered probing was removed from CMake configuration.

### Deprecated C++ Idioms

- Done: `std::unary_function` / `std::binary_function` inheritance was removed from `fixed_size_matrix.hpp`, `hash.hpp`, `interpolation.hpp`, `convex_hull.hpp`, and `smart_pointer.hpp`.
- Dynamic exception specifications `throw()` appear in `fsb_allocator.hpp`, `bounded_scalar.hpp`, `fixed_unit_real.hpp`, `interval.hpp`, and `any.hpp`.
- The testsuite still uses `std::random_shuffle`; it is valid in C++14 but should become deterministic `std::shuffle` before any later C++17 move.

### Custom Standard Library Replacements

- `src/sl/cstdint.hpp` and `src/sl/integer.hpp` implement custom fixed-width integer selection. Under C++14 this can likely become a thin alias layer over `<cstdint>`.
- `src/sl/smart_pointer.hpp` implements custom shared pointer types. Treat these as public API until downstream usage is audited.
- `src/sl/thread.hpp` / `src/sl/thread.cpp` already use `std::thread`, but are still gated by generated `SL_HAVE_THREADS` configuration.

### C APIs And Resource Management

- `utility.cpp` and `fixed_unit_real.hpp` use `sprintf`; replace with `snprintf` or `std::ostringstream` where formatting behavior can be preserved.
- `os_file-unix.cpp` defines large-file feature macros inside the source file. Move these to build definitions or prove they are unnecessary on supported Linux targets.
- `dense_array.hpp`, `gl_image.hpp`, `arithmetic_codec.cpp`, `plhaar.hpp`, and `wavelet_transform.hpp` contain hand-written `new[]` / `delete[]` ownership. Prefer `std::vector` or `std::unique_ptr<T[]>` in low-risk buffers.
- `memory_pool.hpp`, `fsb_allocator.hpp`, kd-tree node pools, and octree cell pools are performance-sensitive. Do not mix these with simple RAII cleanup.

## Upgrade Principles

- Clean build-time compatibility first, implementation internals second, performance-sensitive structures last.
- Keep `sl::` public names stable; replace internals before changing API shape.
- Every phase must keep the Docker CMake build warning-clean.
- Public-header or ABI-adjacent changes must run downstream `ratman` / `terra-sdk-web` gates.

## Phased Plan

### Phase 1: Build And Config Cleanup

- Done: removed `HAVE_NAMESPACE_STD`, `HAVE_ANSI_FOR_SCOPE`, and TR1 unordered container checks.
- Fix the unordered container wrapper to the C++14 standard library.
- Reduce `config.hpp` to the minimum platform/compiler compatibility still needed today.
- Acceptance: `spacelib` build/test pass with no warnings; downstream CMake build passes.

### Phase 2: Deprecated STL Idioms

- Remove `std::unary_function` / `std::binary_function` inheritance. Add explicit `argument_type`, `first_argument_type`, `second_argument_type`, or `result_type` aliases only if callers require them.
- Replace `throw()` with `noexcept` only where the function is confirmed not to throw.
- Replace testsuite `std::random_shuffle` with fixed-seed `std::shuffle`.
- Acceptance: testsuite passes 25/25 and test behavior remains stable.

### Phase 3: Standard Integer And Traits Layer

- Add `static_assert` checks proving `sl::int8_t`, `sl::uint32_t`, and related aliases match `<cstdint>` expectations.
- Replace implementation internals with `<cstdint>` aliases while keeping `sl::` names.
- Keep serialization and compression formats unchanged.
- Acceptance: serializer, compression, geometry, indexed, and downstream data-read smoke checks pass.

### Phase 4: Low-Risk RAII Replacements

- Replace local temporary buffers and clearly owned arrays with `std::vector` or `std::unique_ptr<T[]>`.
- Start with testsuite, benchmark, `utility.cpp`, and simple `arithmetic_codec.cpp` buffer ownership.
- Defer `dense_array` and `gl_image` storage changes until performance and ABI impact are reviewed.
- Acceptance: compression, external_array, and normal_compressor tests pass with no warning regressions.

### Phase 5: OS/File/Time Compatibility Layer

- Move large-file macros to CMake compile definitions or remove obsolete paths.
- Define the supported Linux/Windows boundary and remove SGI/GCC2-era branches.
- Normalize error handling in file and time wrappers.
- Acceptance: external_array, time, and thread tests pass; downstream terrain/texture builder validation passes.

### Phase 6: Performance-Sensitive Structures

- Review `memory_pool`, `fsb_allocator`, kd-tree pools, and octree pools separately.
- Replace allocators only when microbenchmarks show no regression.
- Keep rollback-friendly commits because these paths may affect CBDAM terrain/refinement hot loops.
- Acceptance: new microbenchmarks pass, and `ratman` viewer/nav3d smoke checks pass.

## Validation Commands

```bash
cd /home/holo/terra-sdk-anti/spacelib
docker run --rm --user 1000:1000 -v /home/holo/terra-sdk-anti:/wksp -w /wksp/spacelib qt-dev-env cmake -S . -B build/codex_upgrade -DSL_TEST=ON
docker run --rm --user 1000:1000 -v /home/holo/terra-sdk-anti:/wksp -w /wksp/spacelib qt-dev-env bash -lc 'cmake --build build/codex_upgrade -- -j4 > build/codex_upgrade/build.log 2>&1'
grep -n "warning:" build/codex_upgrade/build.log
docker run --rm --user 1000:1000 -v /home/holo/terra-sdk-anti:/wksp -w /wksp/spacelib/build/codex_upgrade qt-dev-env ctest --output-on-failure
```

Public-header or ABI-adjacent changes must additionally run:

```bash
cd /home/holo/terra-sdk-anti/terra-sdk-web
bash build/verify_cmake_migration.sh
```

## Commit Strategy

- Use one commit per phase or per tightly scoped header family.
- Commit messages should name the modernization target, for example `refactor: replace TR1 unordered container shim`.
- Each commit summary should include build, warning scan, and testsuite evidence.
