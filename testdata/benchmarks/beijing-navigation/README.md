# Beijing continuous-navigation inputs

This pack supplements the keyed navigation fixture for the fixed high-tilt
flight in `../beijing-oblique-flight-v1.json`. It does not replace the fixed-view
Beijing pack or the Tai'an desktop-reference chain.

Acquisition on2026-10-24 used the current Native SDK terrain core at145 headings,
14.5° through158.5° inclusive, with the exact declared viewport, FOV, target,
range and terrain error. A second bounded pass fetched the union of3351
available refinement keys. This is input discovery, not a desktop performance
sample, rendered trajectory, or joint-memory capacity measurement.

The existing49 service manifest and a known root were verified before capture.
The2643 HTTP requests transferred389610 bytes; capture ended with zero active
requests/sockets and a closed Native process. The pack includes156 encoded200
responses (204406 bytes, including the prior two Beijing records), and2487
actual validated404 responses. Missing keys were never fabricated as404.

Base fixture SHA-256:
`c124b0501b8006fbcd094b025f9d3e25a3ea4cc6e2a959fe31d2c5d7d5020815`.
Supplement identity:
`90c92ab145def3540b00962b3fd67cb62bc0c74a8a87f7abfa58b5094febe949`.
The service has no atomic dataset revision; stored hashes identify these frozen
bytes. Browser replay verifies the pack and remains strictly offline. It still
fails if any trajectory requests an uncaptured key; the dense discovery is not
a mathematical completeness proof for every possible camera or publication order.

Acquisition evidence, binary/source hashes and per-pose result hashes are in
`viewer_verify_output/controlled_navigation_capture_20261024/report.json`.
Use `tests/benchmarks/navigation/capture.js` only for explicit bounded acquisition,
never as a live fallback in the benchmark.
