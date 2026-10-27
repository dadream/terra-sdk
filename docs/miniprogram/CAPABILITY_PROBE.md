# Mini Program Capability Probe

## Purpose

The M1 probe validates the runtime assumptions required before CBDAM extraction:
native WebGL canvas access, framebuffer readback, `WXWebAssembly` package
loading, and HTTPS ArrayBuffer requests. It does not render terrain and does not
modify viewer or nav3d.

## Local Gate

From the Mini Program worktree:

```bash
bash scripts/verify_miniprogram_foundation.sh
```

This verifies the frozen desktop oracle, required package files, reviewed Wasm
bytes, and Mini Program source contracts. When Node.js is available it also
runs JavaScript syntax checks and the host-side utility test.

## DevTools Run

Open `apps/miniprogram/` as a Mini Program project. The default
`touristappid` is suitable for simulator inspection. Use a locally authorized
application configuration for preview and real-device testing; never commit
the AppID, credentials, or `project.private.config.json`.

A successful frame displays a colored triangle and reports `WebGL pass` and
`Wasm pass`. Use the copy command to collect the JSON report. The Wasm result
must equal 42 and `webgl.framebuffer.varyingSamples` must be greater than zero.

## Network Probe

Set a credential-free HTTPS endpoint in DevTools local storage without editing
tracked source:

```js
wx.setStorageSync('terra.arrayBufferProbeUrl', 'https://approved.example/probe.bin')
```

The endpoint must be approved for the application and return a small binary
fixture. Do not use Tianditu tokens or signed URLs. A configured run passes only
when the response is 2xx and contains a nonempty ArrayBuffer.

## Final Mini Program Acceptance

Use the fixed local evidence packet described in
`testdata/miniprogram/evidence/README.md`. Capture `capabilities.json` and a
PNG probe screenshot from DevTools, one supported Android device, and one
supported iOS device. The ArrayBuffer probe must use an approved domain and
pass on every recorded environment; a skipped result is not M1 evidence.

This packet is collected at the end of the SDK implementation task. It is not a
per-iteration development blocker. Review WebGL version, maximum texture and
renderbuffer sizes, extensions, DPR, framebuffer variation, Wasm result,
network result, and visual output. Freeze reviewed Android/iOS frame, memory,
and stability limits in the local `thresholds.json`; do not infer production
limits from the simulator or the automated Web gate.

Run the automated structural check after collecting evidence:

```bash
MINIPROGRAM_EVIDENCE_MILESTONES=M1 \
  bash scripts/verify_miniprogram_device_evidence.sh
```
