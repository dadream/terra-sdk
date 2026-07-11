# Mini Program Implementation Status

## Baseline

Branch `feature/miniprogram-sdk` uses an independent worktree based on
`e361b81`. The original `main` branch was pushed to `origin/main` before
implementation began.

## M0: Complete

- The implementation roadmap defines scope, contracts, milestones, and gates.
- `desktop_oracle_manifest.txt` freezes viewer/nav3d source trees and direct
  CMake target declarations.
- `check_desktop_oracle.sh` rejects committed, staged, unstaged, or untracked
  changes under those frozen paths.
- `verify_miniprogram_foundation.sh` provides the focused additive gate.

## M1: In Progress

Implemented locally:

- native Mini Program project and full-canvas WebGL probe;
- deterministic shader draw and framebuffer readback;
- checked-in 41-byte Wasm module exporting `add`;
- `WXWebAssembly` loader with expected result 42;
- modern/legacy system capability collection;
- optional credential-free HTTPS ArrayBuffer probe;
- host utility tests and operator documentation.

Still required before M1 can be marked complete:

- successful WeChat DevTools run and screenshot/report;
- successful Android and iOS runs and screenshot/reports;
- configured request-domain ArrayBuffer result;
- reviewed reference-device frame and memory thresholds.

## M2: In Progress

The first native characterization slice is implemented:

- checked-in globe metadata matching the desktop cylindrical dataset;
- a 157-line golden report for metadata, coordinate transforms, all canonical
  cylindrical grid points, eight root diamonds, and first child patch IDs;
- a dedicated CTest and focused Docker verification script;
- default integration into the complete baseline gate.

A dedicated planar metadata fixture, camera matrices, frustum results, deeper
LOD cuts, patch payload decode, and native-versus-Wasm parity remain for
subsequent M2/M3 slices.

## Verification Evidence

The implementation worktree passed:

```bash
bash scripts/verify_miniprogram_foundation.sh
bash scripts/verify_miniprogram_native_golden.sh
bash scripts/verify_baseline.sh
bash scripts/verify_globe.sh
```

The complete CMake build contained no `warning:` matches. The 1k baseline,
viewer globe fixed views, and nav3d globe capture passed. Globe viewer baseline
differences were 0.0 for fixed action captures except reset at approximately
1.188 with a maximum of 2.0; nav3d globe difference was 0.0.
