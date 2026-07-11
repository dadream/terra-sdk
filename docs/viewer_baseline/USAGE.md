# CBDAM Viewer Baseline Usage Guide

## Purpose

This guide explains how to use the `vic_cbdam_viewer` baseline verification flow. The baseline is used before and during SDK refactoring to detect suspicious changes in viewer startup, rendering, camera actions, keyboard actions, logs, screenshots, and exported state.

Related documents:

- `docs/VIEWER_BASELINE_SPEC.md`: verification contract.
- `docs/viewer_baseline/PLAN.md`: implementation plan.

## Prerequisites

Run commands from the `terra-sdk/` repository root.

Required local state:

- Docker image `qt-dev-env` exists.
- `workspace_old/build/cmake/vic_cbdam_viewer` is built.
- 1k dataset exists under `testdata/datasets/ps_1k/reference/`.
- X11 or WSLg display forwarding is available.

Build the viewer if needed:

```bash
bash scripts/build_cmake.sh
```

## Baseline Layout

The approved 1k baseline lives in:

```text
testdata/viewer_baseline/1k/
```

Important files:

- `actions.txt`: deterministic viewer action sequence.
- `log_contract.json`: required log events, forbidden patterns, ignored log noise.
- `*.png`: approved baseline screenshots.
- `state_*.json`: approved viewer state snapshots.
- `baseline_summary.json`: approved validation summary.
The HTML report is generated from these reviewed artifacts and is not committed.

Runtime outputs are written to:

```text
viewer_verify_output/1k/
```

This output directory is ignored by git.

Useful runtime files include:

- `viewer.log`: raw viewer log captured from Docker.
- `viewer.exit`: viewer process exit code from the current run.
- `summary.json`: machine-readable validation result.
- `report.html`: visual comparison report with embedded images.

## Build Or Refresh A Baseline

1. Build the current viewer:

```bash
bash scripts/build_cmake.sh
```

2. Run interaction verification:

```bash
VIEWER_TIMEOUT_SECONDS=120 bash scripts/verify_viewer_1k_interaction.sh
```

3. Review the generated report:

```text
viewer_verify_output/1k/report.html
```

Open the HTML file in a browser and check:

- Summary is `PASS`.
- Log Contract has no missing required events and no forbidden hits.
- Capture Comparison shows valid baseline/current images.
- State Comparison differences are expected.
- Failure Details is empty or explains accepted differences.

4. If the new output is intentionally accepted as the baseline, copy artifacts:

```bash
cp viewer_verify_output/1k/initial_birdview.png testdata/viewer_baseline/1k/
cp viewer_verify_output/1k/birdview_zoom_in.png testdata/viewer_baseline/1k/
cp viewer_verify_output/1k/tilted_45.png testdata/viewer_baseline/1k/
cp viewer_verify_output/1k/tilted_zoom_out.png testdata/viewer_baseline/1k/
cp viewer_verify_output/1k/tilted_rotate.png testdata/viewer_baseline/1k/
cp viewer_verify_output/1k/statistics.png testdata/viewer_baseline/1k/
cp viewer_verify_output/1k/reset.png testdata/viewer_baseline/1k/
cp viewer_verify_output/1k/state_*.json testdata/viewer_baseline/1k/
cp viewer_verify_output/1k/summary.json testdata/viewer_baseline/1k/baseline_summary.json
```

Baseline refresh must be reviewed. Do not update screenshots or state files just to make a failing test pass.

## Run Verification

Fast startup smoke:

```bash
VIEWER_TIMEOUT_SECONDS=25 bash scripts/verify_viewer_1k_smoke.sh
```

Full interaction baseline verification:

```bash
VIEWER_TIMEOUT_SECONDS=120 bash scripts/verify_viewer_1k_interaction.sh
```

Useful overrides:

```bash
VIEWER_WINDOW_SIZE=1280x720 bash scripts/verify_viewer_1k_interaction.sh
OUTPUT_DIR=/tmp/viewer_verify bash scripts/verify_viewer_1k_interaction.sh
BASELINE_DIR=$PWD/testdata/viewer_baseline/1k bash scripts/verify_viewer_1k_interaction.sh
VIEWER_BIN=/wksp/build/cmake/vic_cbdam_viewer \
  OUTPUT_DIR=$PWD/viewer_verify_output/1k_cmake \
  bash scripts/verify_viewer_1k_interaction.sh
```

The interaction script checks:

- viewer process exits with code 0.
- `normalized_log.json` satisfies `log_contract.json`.
- all required PNG and `state_*.json` files exist.
- screenshots are `1280x720` and non-blank.
- zoom, tilt, rotate, and reset produce expected visual/state changes.
- `report.html` is generated.

`VIEWER_BIN` is the CMake executable path as seen inside Docker. Use a separate `OUTPUT_DIR` when comparing an experimental build with the approved baseline.

## Visual Review

Open the latest report:

```text
viewer_verify_output/1k/report.html
```

The report contains:

- Summary: pass/fail and check details.
- Log Contract Events: normalized events extracted from raw viewer logs.
- Capture sections: baseline, current, and diff image columns.
- State differences: JSON field differences for each capture.

Diff images are generated as:

```text
viewer_verify_output/1k/diff_*.png
```

Small differences can be normal across GPU or driver changes. Blank images, missing terrain, unexpected camera jumps, or large unexplained state changes should be treated as regressions.

## Action Script

The standard action sequence is:

```text
wait_frames 20
capture initial_birdview

zoom_in 8
wait_frames 10
capture birdview_zoom_in

tilt 45
wait_frames 10
capture tilted_45

zoom_out 5
wait_frames 10
capture tilted_zoom_out

rotate 30
wait_frames 10
capture tilted_rotate

key f
wait_frames 5
capture statistics

reset
wait_frames 10
capture reset

exit
```

Edit `testdata/viewer_baseline/1k/actions.txt` only when the intended baseline behavior changes. If actions change, refresh the baseline artifacts and document why in the commit message.

## Log Contract

`log_contract.json` defines:

- `required_events`: normalized events that must appear.
- `forbidden_patterns`: raw log patterns that fail verification.
- `ignored_patterns`: known noisy lines excluded from unknown-log counting.
- `allowed_unknown_lines`: tolerance for unclassified log lines.

If the viewer starts emitting useful new logs, add parser support in `scripts/check_viewer_captures.py` and update `log_contract.json` together.

## Troubleshooting

`cannot connect to X server`:

- Check `DISPLAY`.
- On WSLg, confirm `/mnt/wslg/.X11-unix` exists.

`qt-dev-env` not found:

- Build or load the Docker image before running verification.

Missing `vic_cbdam_viewer`:

- Run `bash scripts/build_cmake.sh`.

Interaction script times out:

- Increase `VIEWER_TIMEOUT_SECONDS`.
- Inspect `viewer_verify_output/1k/viewer.log`.

Log contract fails:

- Open `viewer_verify_output/1k/summary.json`.
- Check `missing_required_events`, `forbidden_hits`, and `unknown_line_count`.

Screenshot checks fail:

- Open `viewer_verify_output/1k/report.html`.
- Inspect current screenshots and diff images.
- Confirm the viewer window size matches `1280x720`.

## Commit Checklist

Before committing baseline or verification changes:

```bash
bash scripts/build_cmake.sh
VIEWER_TIMEOUT_SECONDS=25 bash scripts/verify_viewer_1k_smoke.sh
VIEWER_TIMEOUT_SECONDS=120 bash scripts/verify_viewer_1k_interaction.sh
bash -n scripts/verify_viewer_1k_interaction.sh
python3 -m py_compile scripts/check_viewer_captures.py scripts/render_viewer_baseline_report.py
```

Also inspect:

```text
viewer_verify_output/1k/report.html
```

Commit messages that update baseline artifacts must explain:

- why the old baseline changed;
- which screenshots, states, or log events changed;
- whether the difference is expected for SDK refactoring.
