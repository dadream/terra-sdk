# Native Behavior Golden

These fixtures freeze current CBDAM behavior before platform-neutral SDK
extraction. They are characterization evidence, not a new public data format.

- `globe_terrain.xml` mirrors the reviewed external globe metadata at desktop
  oracle commit `e361b81`; `planar_terrain.xml` mirrors the checked-in 1k
  reference metadata.
- `native_behavior_v1.txt` records parsed planar/cylindrical metadata and world
  transforms, all canonical cylindrical grid points, root diamond IDs, parent
  IDs, corners, first child patch IDs, and the viewer-equivalent globe camera
  sequence. Camera records include projection/view/PV matrices, clip planes,
  and fixed bounding-volume visibility results for initial, zoom, tilt, yaw,
  and reset states.
- `globe_patch_record.bin` is the 48-byte record for detail key
  `(-134217728, 134217728, 134217728)` extracted from the reviewed globe
  repository. It contains a 44-byte first patch and no second fragment.
- `patch_decode_v1.txt` freezes record framing plus decoded `64x64` residual
  dimensions, statistics, sample values, and raw/decoded FNV-1a hashes.
- Floating values use classic locale, fixed six-decimal formatting, and
  near-zero normalization; height scale factors use ten decimals to preserve
  the planar repository value.

Run the checked comparison with:

```bash
bash scripts/verify_miniprogram_native_golden.sh
```

The test executables have read-only dump modes for reviewed updates:

```bash
terra_sdk_cbdam_native_behavior_golden --dump globe_terrain.xml planar_terrain.xml
terra_sdk_cbdam_patch_decode_golden --dump globe_patch_record.bin
```

`terra_sdk_cbdam_patch_decode_golden --extract` is a fixture-maintenance mode
that copies one raw repository record by `(i, j, k)` key. Normal tests never
open Berkeley DB repositories and use only the checked-in binary fixture.

Never update the fixture merely because a test failed. Review every changed
line against viewer/nav3d state and globe captures, document the intentional
semantic change, then run the focused, full baseline, and globe gates.
