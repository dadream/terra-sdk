# Native Behavior Golden

These fixtures freeze current CBDAM behavior before platform-neutral SDK
extraction. They are characterization evidence, not a new public data format.

- `globe_terrain.xml` mirrors the reviewed external globe metadata at desktop
  oracle commit `e361b81`.
- `native_behavior_v1.txt` records parsed metadata, cylindrical world
  transforms, all canonical cylindrical grid points, root diamond IDs, parent
  IDs, corners, and first child patch IDs.
- Floating values use classic locale, fixed six-decimal formatting, and
  near-zero normalization so the fixture is stable across supported native
  toolchains.

Run the checked comparison with:

```bash
bash scripts/verify_miniprogram_native_golden.sh
```

The test executable has a read-only dump mode for reviewed updates:

```bash
terra_sdk_cbdam_native_behavior_golden --dump globe_terrain.xml
```

Never update the fixture merely because a test failed. Review every changed
line against viewer/nav3d state and globe captures, document the intentional
semantic change, then run the focused, full baseline, and globe gates.
