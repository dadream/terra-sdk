# Mini Program Device Evidence

This directory defines the untracked packet for final user acceptance after
M1, M6, and M7 engineering work is complete. Missing device evidence does not
block implementation progress, but production-release approval must keep the
acceptance pending until the user signs it off. Keep real reports and
screenshots under `local/`; `.gitignore` excludes that directory so a
credential, an AppID, or a device-specific setting cannot enter a commit.

## Prepare The Packet

Copy the tracked examples, replace every placeholder, and keep the resulting
files local:

```bash
mkdir -p testdata/miniprogram/evidence/local
cp testdata/miniprogram/evidence/manifest.example.json \
  testdata/miniprogram/evidence/local/manifest.json
cp testdata/miniprogram/evidence/thresholds.example.json \
  testdata/miniprogram/evidence/local/thresholds.json
```

The zero values in `thresholds.example.json` are deliberately invalid. Replace
them with reviewed Android and iOS p95 frame-time, peak-memory, and stable-run
limits before recording metrics. `tianditu_review.json` is required only for
M7; create it from `tianditu_review.example.json` after the application owner
has reviewed frontend authorization, the terrain request domain, imagery
domains, notices, attribution, and cache policy.

Use this fixed layout. Every `*.json` beside a screenshot is the raw report
copied with the `C` control after the scene is stable.

```text
local/
  manifest.json
  thresholds.json
  devtools/
    capabilities.json  probe.png
    blue_marble/{initial,zoom,tilt_45,yaw,reset}.json/.png
    tianditu/{initial,tilt_45}.json/.png
  android/ and ios/
    capabilities.json  probe.png  metrics.json
    blue_marble/{initial,zoom,tilt_45,yaw,reset}.json/.png
    blue_marble/{context_lost,context_restored,weak_network_failed,
                 weak_network_recovered,fallback}.json/.png
    tianditu/{initial,tilt_45,weak_network_failed,
              weak_network_recovered}.json/.png
  tianditu_review.json
```

For the fixed Blue Marble sequence, wait for terrain draws with no failed
resource count, capture `initial`, tap `+`, tap `45`, make one horizontal drag
for yaw, then tap `R`. Context and weak-network files must reflect real device
events and recovery after Retry; do not manufacture JSON. The fallback capture
uses the Blue Marble profile after the Tianditu run. M7 screenshots must visibly
show provider attribution and must not include storage settings or credentials.

## Validate

```bash
MINIPROGRAM_EVIDENCE_MILESTONES=M1 \
  bash scripts/verify_miniprogram_device_evidence.sh
MINIPROGRAM_EVIDENCE_MILESTONES=M6 \
  bash scripts/verify_miniprogram_device_evidence.sh
MINIPROGRAM_EVIDENCE_MILESTONES=M7 \
  bash scripts/verify_miniprogram_device_evidence.sh
```

For final acceptance, run all checks together with
`MINIPROGRAM_EVIDENCE_MILESTONES=M1,M6,M7`. M6 includes M1 checks; M7 includes
M1 and M6. The checker verifies schemas,
WebGL/Wasm/HTTPS results, action-state changes, nonblank PNGs, recovery states,
thresholds, and textual credential leaks. It writes the ignored
`local/device_evidence_summary.json`. The tool cannot inspect pixels for a
credential or judge imagery alignment, so reviewers must inspect those
screenshots before approving the production release.
