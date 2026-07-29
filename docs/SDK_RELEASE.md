# Terra SDK Release Guide

## Release Surfaces

Terra SDK `0.1.x` publishes two generated archives:

- `terra-sdk-<version>-native.tar.gz`: C++14 static libraries, C ABI library,
  public headers, CMake package metadata, examples, documentation, and licenses.
- `terra-sdk-<version>-miniprogram.tar.gz`: C ABI header, Wasm module,
  Mini Program runtime adapters, package manifest, documentation, and licenses.

The native CMake targets are `Terra::core`, `Terra::codec`, `Terra::frame`,
and `Terra::c_api`. The C ABI is versioned by `TERRA_C_API_VERSION`; callers
must initialize every versioned structure's `struct_size` and `api_version`
where present. Wasm exports the same ABI. JavaScript and Mini Program modules
are CommonJS and require the checked-in loader.

## Build And Verify

From a clean checkout with Docker, Node.js 20 or newer, a
Chromium-compatible browser, and the
canonical images available:

```bash
bash scripts/build_docker_image.sh
bash scripts/verify_sdk_release.sh
```

The gate builds and tests the monorepo, validates the installed SDK consumer,
checks the terrain HTTP contract, proves native/Wasm parity and reproducibility,
runs Mini Program host tests, records real Wasm/WebGL browser evidence, creates
both archives twice, compares their hashes, extracts the native archive, and
builds/runs the C++ and C examples against that extracted package.

Outputs are written to `workspace_old/package/release/`. Browser evidence is
written to `viewer_verify_output/web_sdk/report.html`. Build and package logs
must contain no `warning:` match.

## Compatibility Policy

- C++ requires C++14. Patch releases keep installed target names and documented
  API behavior source-compatible when practical.
- C ABI version 1 uses caller-owned buffers and size-tagged structures. New
  fields may be appended without changing the ABI version; incompatible layout
  or semantic changes require a new ABI version.
- Terrain service schema and media types are version 1. Unknown schema or ABI
  versions are rejected instead of guessed.
- Desktop viewer/nav3d adoption is separate from the SDK package. Their frozen
  baseline and globe gates remain the behavioral oracle during extraction.

## Errors And Resource Ownership

C calls return `terra_status`. Read context-specific details with
`terra_get_last_error`; never parse error text as a stable API. Memory returned
by `terra_alloc` must be released with `terra_free`. The application owns input
buffers, network cancellation, WebGL objects, credentials, and retry policy.
Context methods are not documented as thread-safe; serialize access per
`terra_context`.

## Cache And Network Policy

The runtime bounds terrain, decoded geometry, texture, and GPU caches and
cancels stale requests. Immutable terrain records use checksum and HTTP cache
metadata. Tianditu is optional and application-owned: credentials stay in local
runtime configuration, logs and reports redact query values, and persistent
proxying or caching is disabled until the application owner reviews current
provider terms. Offline synthetic/Blue Marble-compatible fixtures remain the
deterministic automated path.

## Support Boundary

Supported engineering evidence covers the pinned Docker toolchains, Linux
native package, Wasm, WebGL 1 browser harness, terrain service contract, and
the checked-in Mini Program adapter. Report issues with SDK version, platform,
failing command, sanitized log, and generated `summary.json`; never attach
tokens or signed URLs.

## Final User Acceptance

Engineering completion does not wait for Mini Program hardware evidence. At
the end of the task, the repository owner manually validates DevTools, one
supported Android device, and one supported iOS device using
`testdata/miniprogram/evidence/README.md`, then runs:

```bash
bash scripts/verify_miniprogram_device_evidence.sh \
  testdata/miniprogram/evidence/local
```

Until that sign-off is supplied, the SDK may be marked engineering-complete,
but production Mini Program release approval remains pending.
