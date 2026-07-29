# Mini Program CloudBase Manual Acceptance

## 1. Purpose

本文用于人工验收 CloudBase 环境中的 planar 1k、globe terrain 和天地图影像。
验收关注实际地形、纹理、LOD 和交互结果，不以服务启动成功代替可视化正确性。

## 2. Prerequisites

先完成自动门控和本地 Wasm 产物 staging：

```bash
bash scripts/verify_miniprogram_wasm.sh
bash scripts/stage_miniprogram_globe.sh
```

再运行云端服务验证：

```powershell
.\scripts\verify_cloudbase_services.ps1
```

使用微信开发者工具打开 `apps/miniprogram/`。真机或发布验收前，将
`terra-imagery` 的 HTTPS 域名加入小程序网络域名配置。

在开发者工具 Console 清除旧的本地服务覆盖：

```javascript
wx.removeStorageSync('terra.terrainServiceOrigin')
wx.removeStorageSync('terra.planarServiceOrigin')
wx.removeStorageSync('terra.tiandituToken')
wx.removeStorageSync('terra.imageryServiceOrigin')
wx.setStorageSync('terra.imageryProfile', 'tianditu-img-c')
```

测试 token 只存在于代理服务环境变量中，不应写入小程序 storage。

## 3. Planar 1k Acceptance

```javascript
wx.reLaunch({ url: '/pages/planar/index' })
```

等待状态显示 `PS 1k terrain ready`，然后逐项检查：

| Action | Expected result |
| --- | --- |
| Initial frame | terrain 可见；patches、records、draws、vertices 均非零 |
| `T` | 1k texture 正常覆盖地形，无空白或错位 |
| `H` | 高程着色可见，且与 texture 模式几何轮廓一致 |
| `Top` / `45` | 鸟瞰和 45 度视角可切换，无大范围跳变 |
| `+` / `-` | 连续缩放，地形保持可见 |
| Drag | 平移或旋转连续，无粘滞后突跳 |
| `R` | 恢复初始视角 |

最终状态不得为 warning，资源失败数应为 0。点击 `C` 复制报告，或在 Console
读取：

```javascript
getApp().globalData.planarReport
```

## 4. Globe Acceptance

```javascript
wx.reLaunch({ url: '/pages/globe/index' })
```

等待 globe 和影像加载完成，然后逐项检查：

| Action | Expected result |
| --- | --- |
| Initial frame | 初始目标接近北京 `116.41, 39.90`；patches 和 draws 非零 |
| Imagery | 状态显示 `tianditu-img-c`，影像连续，界面显示 `© 天地图` |
| `Move` + drag | 目标位置连续移动，地球无空洞或瞬间翻转 |
| `Look` + drag | 朝向连续变化，目标点不发生不可控跳变 |
| Repeated `+` | terrain LOD 和影像逐级刷新，不停留在模糊祖先纹理 |
| `-` | 连续缩小，地球保持完整 |
| `BJ` / `Top` | 可回到北京或切换俯视 |
| `45` / `N` | 视角拉平到 45 度、恢复朝北 |
| `R` | 恢复初始相机状态 |

允许加载中的短暂 ancestor imagery fallback；稳定后必须替换为当前层级纹理。
不得出现 terrain 空洞、长期模糊、`Terra status` 错误或持续资源失败。点击 `C`
复制报告，或在 Console 读取：

```javascript
getApp().globalData.globeReport
```

## 5. Network And Security Checks

在开发者工具 Network/Console 中确认：

- terrain 请求通过 `wx.cloud.callContainer` 访问 `terra-terrain-1k` 或
  `terra-terrain-globe`；
- imagery 只访问 `terra-imagery`，不直连 `tianditu.gov.cn`；
- 请求、日志、小程序 storage 和报告中均无天地图 token；
- Mini Program 不直接调用 `terra-testdata` PG Storage API。

CloudBase 控制台的“未配置 RLS，API 访问将被拒绝”是当前私有部署的预期状态，
不应为消除提示而开放 RLS。

## 6. Acceptance Record

每次验收至少保存 planar、globe 初始帧和 globe 放大后的截图，以及两个复制报告。
记录以下信息：

```text
Date:
DevTools version:
Base library:
Device/simulator:
Planar result: PASS/FAIL
Globe result: PASS/FAIL
Terrain/imagery failures:
Evidence path:
Notes:
```

公开 HTTPS imagery endpoint 仅用于当前验收环境。产品发布前仍需增加网关鉴权、
限流与配额，或改为 `wx.cloud.callContainer` 获取影像二进制。

## 7. Troubleshooting

- 仍请求 `127.0.0.1`：重新执行第 2 节的 storage 清理并 reLaunch。
- terrain cloud call 失败：检查环境 ID、服务名、服务权限和 `/readyz`。
- globe 影像空白：检查代理域名配置、代理服务和图片 Content-Type。
- 出现 `Retry`：先复制报告，再点击重试；持续失败视为验收失败。
- 逻辑桶页面看不到 `.data`：按 `STORAGE_SMOKE_TEST.md` 的物理 COS key/size
  和实际 patch 方法核验。
