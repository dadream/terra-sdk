# Viewer Baseline Implementation Plan

## Goal

Build a repeatable verification baseline for `vic_cbdam_viewer` before SDK refactoring begins. The baseline must let engineers quickly detect suspicious behavior changes while separating the Qt/OpenGL viewer from platform-independent core algorithms.

This plan implements the requirements from `docs/VIEWER_BASELINE_SPEC.md`.
The implementation is complete; the phases are retained as an engineering
record and as acceptance criteria for future changes.

## Current State

- `scripts/verify_viewer_1k_smoke.sh` already provides a fast startup smoke check for the 1k PS dataset.
- `scripts/verify_viewer_1k.sh` remains the manual GUI validation entrypoint.
- `docs/VIEWER_BASELINE_SPEC.md` defines the verification baseline contract, including log normalization, state JSON, screenshots, and HTML comparison reporting.
- The viewer supports manual interaction and the implemented deterministic verification mode, including scripted camera actions, framebuffer capture, state export, and automatic exit.

## Milestones

### Phase 1: Baseline Inputs

Create the static inputs required by the interaction baseline.

Deliverables:

- `testdata/viewer_baseline/1k/actions.txt`
- `testdata/viewer_baseline/1k/log_contract.json`

Acceptance:

- `actions.txt` contains the standard action sequence: first capture, zoom, tilt, zoom out, rotate, statistics, reset, exit.
- `log_contract.json` defines required events, forbidden patterns, ignored patterns, and the allowed unknown-log threshold.
- Paths match the spec exactly.

### Phase 2: Minimal Viewer Verification Mode

Add the smallest deterministic verification loop to the viewer.

Public CLI:

- `--verify-script <file>`
- `--verify-output-dir <dir>`
- `--verify-exit`
- `--verify-window-size <WIDTHxHEIGHT>`
- `--verify-log-state`

Initial actions:

- `wait_frames N`
- `capture NAME`
- `exit`

Acceptance:

- Running the viewer with a verify script waits for rendered frames, writes `NAME.png` and `state_NAME.json`, then exits when requested.
- Invalid scripts, missing output directories that cannot be created, failed captures, or unknown actions return a non-zero exit code.
- Manual viewer behavior is unchanged when `--verify-script` is absent.

### Phase 3: Deterministic Viewer Actions

Extend verification mode to cover stable camera and shortcut behavior.

Actions:

- `zoom_in N`
- `zoom_out N`
- `tilt DEGREE`
- `rotate DEGREE`
- `key KEY`
- `reset`

Acceptance:

- Camera actions use internal viewer/camera control paths, not external mouse coordinates.
- `key f` changes `statistics_mode` and is observable in state JSON.
- `reset` returns the camera state close to the initial capture state.
- Each action emits structured verification events when `--verify-log-state` is enabled.

### Phase 4: Automation, Checks, And Report

Add the script layer that turns viewer verification mode into a CI-friendly command.

Deliverables:

- `scripts/verify_viewer_1k_interaction.sh`
- `scripts/check_viewer_captures.py`
- `scripts/render_viewer_baseline_report.py`

Acceptance:

- `verify_viewer_1k_interaction.sh` launches Docker with the 1k dataset, verify script, output directory, WSLg/X11 mount, and fixed window size.
- `check_viewer_captures.py` writes `normalized_log.json` and `summary.json`, validates `log_contract.json`, checks PNG presence, dimensions, non-blank content, meaningful action-to-action differences, reset closeness, and key state fields.
- `render_viewer_baseline_report.py` writes `viewer_verify_output/1k/report.html` with baseline/current/diff image comparison, state comparison, log contract results, and failure details.
- The script returns a CI-compatible exit code.

### Phase 5: Baseline Capture And Adoption

Freeze the first approved baseline and make it part of the SDK refactoring workflow.

Deliverables:

- Approved baseline PNG files.
- Approved `state_*.json` files.
- `baseline_summary.json`.
- Generated `viewer_verify_output/1k/report.html` for human review.

Acceptance:

- A human reviews `viewer_verify_output/1k/report.html` once and confirms the baseline matches current expected viewer behavior.
- Approved outputs are copied into `testdata/viewer_baseline/1k/`.
- SDK refactoring tasks use both:

```bash
scripts/verify_viewer_1k_smoke.sh
scripts/verify_viewer_1k_interaction.sh
```

## Implementation Tasks

1. Add baseline input files under `testdata/viewer_baseline/1k/`.
2. Extend viewer argument parsing for the verification CLI without changing existing manual invocation.
3. Add a verification runner inside the viewer that executes actions between rendered frames.
4. Add framebuffer capture and state JSON export for every `capture`.
5. Add structured verification log events and log-state output.
6. Add deterministic camera and shortcut actions.
7. Add the Docker automation script for the 1k interaction run.
8. Add log normalization, image/state checks, and summary generation.
9. Add HTML baseline comparison report generation.
10. Generate, review, and freeze the first baseline artifacts.

## Public Interfaces

Viewer CLI:

```text
--verify-script <file>
--verify-output-dir <dir>
--verify-exit
--verify-window-size <WIDTHxHEIGHT>
--verify-log-state
```

Action script:

```text
wait_frames N
capture NAME
zoom_in N
zoom_out N
tilt DEGREE
rotate DEGREE
key KEY
reset
exit
```

Run output:

```text
viewer_verify_output/1k/
  viewer.log
  normalized_log.json
  summary.json
  report.html
  *.png
  state_*.json
```

Baseline output:

```text
testdata/viewer_baseline/1k/
  actions.txt
  log_contract.json
  baseline_summary.json
  *.png
  state_*.json
```

## Validation

Per-phase validation:

- Phase 1: inspect `actions.txt` and `log_contract.json` against the spec.
- Phase 2: run a minimal script with `wait_frames`, `capture`, and `exit`; confirm PNG, state JSON, and clean exit.
- Phase 3: run the full action script; confirm state changes for camera actions, `key f`, and `reset`.
- Phase 4: run `scripts/verify_viewer_1k_interaction.sh`; confirm `summary.json` and `report.html` are generated.
- Phase 5: run smoke plus interaction validation before using the baseline for SDK changes.

Final validation commands:

```bash
scripts/verify_viewer_1k_smoke.sh
scripts/verify_viewer_1k_interaction.sh
```

Final pass criteria:

- Viewer exits with code 0.
- `normalized_log.json` satisfies `log_contract.json`.
- Every required PNG and state JSON exists.
- PNG files are `1280x720`, non-blank, and show expected action differences.
- Reset state is close to the initial state.
- `report.html` opens locally and shows baseline/current/diff comparisons.

## Risks

- Qt/OpenGL framebuffer capture may behave differently across GPU drivers; use tolerant visual checks rather than exact pixel equality.
- Camera tilt and rotation must be deterministic; avoid relying on desktop mouse coordinates for baseline actions.
- Current viewer logs contain noisy historical output; normalize logs before applying the contract.
- WSLg/X11 and Docker display setup can fail independently of viewer behavior; keep smoke and interaction scripts explicit about display setup.
- Baseline updates must be reviewed, because changing screenshots or state JSON can hide real SDK refactoring regressions.

## Deliverables

- `docs/viewer_baseline/PLAN.md`
- `testdata/viewer_baseline/1k/actions.txt`
- `testdata/viewer_baseline/1k/log_contract.json`
- `scripts/verify_viewer_1k_interaction.sh`
- `scripts/check_viewer_captures.py`
- `scripts/render_viewer_baseline_report.py`
- Viewer verification mode in the CBDAM viewer.
- Approved baseline PNG, state JSON, and summary files; generated HTML report.
