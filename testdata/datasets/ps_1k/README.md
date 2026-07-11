# PS 1k Verification Fixture

This directory contains the minimal dataset used by the automated builder,
viewer, and nav3d regression gates.

## Layout

- `source/ps_height_1k.png`: 1025 x 1025, 16-bit grayscale builder input.
- `source/ps_texture_1k.png`: 1024 x 1024 RGB builder input.
- `reference/terrain.*`: reviewed CBDAM terrain output.
- `reference/texture/`: reviewed VICTMS texture pyramid and metadata.

The source images rebuild the reference behavior through
`scripts/verify_builder_1k_rebuild.sh`. The reference outputs let viewer and
nav3d smoke tests run without rebuilding data first. These reviewed fixtures
were imported during repository consolidation and are now self-contained;
16k and deployment datasets are intentionally outside this repository.

## Core Checksums

```text
80229c93fb119e579fb440fe5bcd9cf7d8290681a80136840b938f7f1a6ebfea  source/ps_height_1k.png
d21cfd2a2105ca8d13d46bb9cab3cf5db6562d867f8a2161631511d52db794ae  source/ps_texture_1k.png
d47f85a5a906a00d9d9ff4fe02b288c687df4af40063eab8580bee6f83e88a3e  reference/terrain.data
d5cc9fbe554282ebcfd6d4f11e6f319a45e4e4bfdad45ecc386899db04f04a1e  reference/terrain.root
05ec8a6e27527a20ded254ea7f301b026dd829a19bff5966a83e7a977c97e1d3  reference/terrain.xml
ee637b26b8d1c3747783c5eba25c85c69fad31712247ce2845fdd407de733955  reference/texture/victms.xml
```

Verify them from the repository root:

```bash
sha256sum testdata/datasets/ps_1k/source/*.png \
  testdata/datasets/ps_1k/reference/terrain.* \
  testdata/datasets/ps_1k/reference/texture/victms.xml
```
