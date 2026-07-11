# Repository Scope

## Objective

`terra-sdk` is the only repository required for SL/Ratman/CBDAM development,
builds, tests, and regression verification. Scripts must not discover or mount
adjacent source repositories.

## Included

- SL, VIC base, Geo, VFS, CBDAM, Ratman, supported apps, builders, and service
  source.
- Root CMake target graph and headless SDK smoke tests.
- Canonical Docker environment and complete baseline gate.
- Minimal 1k source/reference data, viewer captures/state/log contract, and
  nav3d runtime configuration.
- Active architecture, baseline, SDK-readiness, and usage documentation.

Historical application source without a CMake target remains source reference
only. It is not a supported artifact.

## Excluded

- Large datasets and generated dataset variants.
- Production deployment payloads and unrelated Web services.
- Generated build trees, logs, reports, staged installs, and runtime state.
- Future mini-program implementation until its roadmap phase begins.

Add excluded content only for a concrete target or test, with an ownership
location, size justification, and regression command.

## Path Contract

Docker scripts use:

- `/workspace`: this repository, source, scripts, and test data.
- `/wksp`: ignored `workspace_old/` build and install state.

The CMake build tree is `/wksp/build/cmake`. Runtime evidence is written to
`viewer_verify_output/`. Neither location is committed.
