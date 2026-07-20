# Globe Visual Acceptance

## Prepare

From the repository root in WSL, verify and stage the current package:

```bash
bash scripts/verify_miniprogram_wasm.sh
bash scripts/stage_miniprogram_globe.sh
```

Open `apps/miniprogram/` in WeChat DevTools. Configure the HTTPS terrain origin
and an authorized frontend Tianditu credential in local storage, then relaunch:

```js
wx.setStorageSync('terra.terrainServiceOrigin', '<https terrain origin>')
wx.setStorageSync('terra.imageryProfile', 'tianditu-img-c')
wx.setStorageSync('terra.tiandituToken', '<frontend credential>')
wx.reLaunch({ url: '/pages/globe/index' })
```

Do not print or capture the credential. Confirm the status shows
`imagery tianditu-img-c` and the footer shows `© 天地图` before accepting imagery.

## DevTools Sequence

Use the toolbar instead of keyboard input. Wait for request counts to settle and
for `draws` to remain above zero after each action.

| Step | Action | Expected state and image |
| --- | --- | --- |
| 1 | `R` | World view, target `116.41, 39.90`, pitch `0`, heading `0`. |
| 2 | `BJ` | Beijing/China becomes the regional center; terrain and imagery remain visible. |
| 3 | `+`, then `-` | Scale changes in opposite directions without a blank frame or persistent holes. |
| 4 | `45` | Pitch becomes `-45`; relief is visible and imagery stays registered to the mesh. |
| 5 | Select `Look`, drag horizontally and vertically | Heading/pitch change while target coordinates stay fixed. |
| 6 | `N` | Heading returns to `0` while the current pitch and target remain unchanged. |
| 7 | `Top` | Pitch returns to `0`; target, heading, and distance remain unchanged. |
| 8 | Select `Move`, drag horizontally and vertically | Target longitude/latitude change while local heading/pitch stay fixed. |
| 9 | `R` | Exact initial world view and Beijing target are restored. |
| 10 | `C` | Copied report contains frame, camera, renderer, cache, and diagnostics state but no credential. |

A DevTools mouse drag represents one finger. Desktop pinch emulation is not
required for this deterministic pass; `+` and `-` cover the same SDK distance
path. Verify two-finger pinch later on a physical device.

## Pass Criteria

Accept the DevTools run when all of the following hold:

- `patches`, loaded records, and `draws` become nonzero and stay responsive.
- `BJ` actually centers China; it does not leave Africa/Greenwich centered.
- Target coordinates change only in `Move`; heading and pitch change only in
  `Look` or through their fixed commands.
- Oblique views show terrain relief without persistent cracks, detached tiles,
  inverted geometry, or imagery sliding across the terrain.
- Tianditu imagery is recognizable over China and `© 天地图` remains visible.
- `R` is repeatable and resource failures are zero after requests settle.

## Automated Companion

Run the browser baseline and open its offline report:

```bash
bash scripts/verify_web_sdk.sh
```

Review `viewer_verify_output/web_sdk/report.html`. Its nine captures verify the
real Wasm/WebGL camera and render path with compact deterministic fixtures. It
does not replace the DevTools Tianditu/China review or physical-device pinch,
GPU, memory, and request-domain acceptance.
