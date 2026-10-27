# Keyed navigation terrain fixture

The current catalogue contains 2,231 entries / 2,485,525 bytes.
A bounded actual-Wasm sweep of 163 fixed global/corridor views added 397
responses (187 successes and 210 confirmed absences, 104,955 bytes). This
prepares the coarse request frontier independently of browser motion timing; it
is not rendering or performance acceptance. All earlier bytes are preserved.

The preceding catalogue contained 1,834 entries / 2,380,570 bytes. The model-clock
supplement adds one actual 76-byte confirmed-absence response exposed by the
existing Direct no-fault trajectory. The manifest and known root match the
previous capture; all prior bytes remain unchanged, and unknown keys still fail.

The state
observation supplement adds one actual successful detail response (2,725 bytes)
exposed by the existing Direct fault trajectory. All prior bytes are preserved;
manifest metadata and a known nonzero root were checked with bounded requests.
`capture.json` records those checks and the new body hash. The fixture identity
is `terrain-records.json`'s complete payload SHA-256; the collection history below
describes the earlier snapshots. Unknown keys still fail without an online fallback.

The prepared-candidate supplement adds four real successful responses (4,475
bytes) for cold selection of the oblique view before any mesh publication. All
earlier bytes are preserved. `capture.json` records the keys, hashes and bounded
request limits. The Wasm contract compares projected measurements and the imagery
cut before/after mesh production, including input-credit refusal and cancellation;
it does not claim that production joint admission or rendering latency is solved.

This is a bounded, offline capture of the existing `globe` terrain service,
used by the Web SDK's Beijing/Paris flight, Beijing oblique orbit and local
roaming scenarios. It is test input, not SDK package content or a deployment
payload. The concrete need for this larger fixture is a coherent CBDAM height
hierarchy: reusing one nonzero residual at unrelated deep keys creates steep
terrain that does not represent the service.

`terrain-records.bin` concatenates unchanged HTTP response bodies.
`terrain-records.json` maps `(kind, i, j, k)` to status, offset, length and
SHA-256. Kind 1 is a root and kind 2 a detail. The dataset uses patch dimension
64, cylindrical bounds `[-180,-90]..[180,90]`, radius 6,378,000 metres and height
scale 1/64 metre. Do not reinterpret residuals as absolute elevations.

The capture has 1,828 entries: eight roots, 1,525 successful details and 295
detail 404 bodies with the actual `error.code=patch_not_found` envelope.
Payload size is 2,373,294 bytes; SHA-256 is
`8437a9ce52dda3c5e32a1a67e88a19f9e6e6475d8f286740805824f858a8a252`.
Confirmed absence follows the SDK's inherited-height/zero-residual contract.
An uncaptured key is **not** confirmed absence and must fail the test.

`capture.json` records source routes, date, prefetch views and collection bounds.
The collection reused 531 records from the earlier service diagnosis, fetched
1,287 additional keys by advancing the current CBDAM/Wasm across 43 views, and
then fetched one key exposed by a real browser orbit. Prefetch traversal is not
rendering or convergence evidence. The live service does not publish a snapshot
revision; committed response hashes identify this fixed test input.

The eye/front supplement preserved every existing body and added six real
responses (two details and four confirmed absences). It sampled 279 prescribed
orbit/roam/near-eye views, independently requesting 30m CBDAM spacing under the
eye and 50m along the tangent viewing direction below 20km eye altitude. Queries
used admitted-region reuse. The six added keys, view coordinates and bounded
collection settings are recorded in `capture.json`. Prefetch sampling is not
evidence of rendered walking performance.

The working-set pricing supplement preserved every existing response and added
one confirmed absence exposed by the existing oblique browser orbit. Its exact
key, response hash and bounded single-request capture are recorded in
`capture.json`; no unknown-key fallback was added.

The input-credit supplement preserved all previous bytes and added two actual
confirmed-absence responses exposed by the same oblique orbit under shared input
admission. Each was fetched once with a ten-second deadline; keys, status, byte
counts and hashes are in `capture.json`. Unknown-key rejection is unchanged.

The harness loads the complete local payload before navigation, validates exact
key lookup and preserves status/body. Unknown requests are reported even when
the SDK could display a coarse ancestor. There is no network fallback or generic
detail record. `node tests/web_sdk/navigation_terrain_test.js` checks all record
hashes, root diversity, response identity, cancellation, absence and missing-key
rejection. The full gate reports used keys/misses; a new trajectory may require
explicitly capturing additional real records and updating these hashes.

Existing synthetic coverage, GPU capacity, repeated zoom and fixed memory replay
remain in `tests/web_sdk/harness.js`. Navigation starts a fresh viewer using this
fixture, the same 640x360 viewport/resource policy, level-17 synthetic geographic
imagery, 1.25px target and 30-second endpoint deadlines. These offline scenarios
do not establish real Tianditu download performance or mobile hardware acceptance.
