# Controlled imagery pipeline

Run `node tests/benchmarks/imagery_pipeline/benchmark.js` for the comparison,
or `node tests/benchmarks/imagery_pipeline_test.js` for the regression contract.
The scripts print bounded JSON/results and do not contact any service. Redirect
results to a fresh directory under the verified `viewer_verify_output` mount
when retaining milestone evidence.

This isolates the production `EncodedTextureStore`, request scheduler, cache,
group admission and resource ledger. The fixed target contains 384 distinct
geodetic tiles. Headers, body reads, bitmap decoding and GPU receipts use a
single virtual clock; the fixture deliberately does not simulate terrain LOD,
UV production, browser decoding speed, physical GPU cost or HTTP connection
limits. Its milliseconds are **not end-to-end product acceptance results**.

The comparison changes request slots and input envelopes independently, using
the same 20ms header, 120ms body, 8ms decode, 16ms resource-turn and 16ms GPU
receipt delays. Input bodies contain a fixed 16KiB payload; the decoder reports
256px pixels. Production admission still reserves its complete worst-case body
and assembly envelope before the first read. Optional `inputEnvelopes` is a
benchmark-only counterfactual override, not a new SDK option.

The regression must show that affordable configured concurrency is usable,
that increasing request slots alone does not replace sufficient input capacity,
and that the paired window reduces waiting. GPU-delay coverage holds completion
receipts while decoding continues only within funded workspace. Every target
must be fetched and uploaded exactly once; failures, retained bitmaps, active
bodies or nonzero teardown credit fail. All timer work has finite step/time
bounds, and the original global clocks are restored on failure.

`tests/js/encoded_input_stages_test.js` complements this benchmark with actual
shared-credit refusal, configured-window growth waking a blocked body without
an unrelated refund, concurrency reduction, and source-change receipts. The
full encoded-store contracts cover GPU ownership, context recovery, malformed
input, cancellation and smaller explicit capacity ceilings.
