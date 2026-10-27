# Mini Program Terrain Validation Guide

## 1. Purpose

本文档统一说明 Terra SDK 小程序地形链路的验证方法，覆盖：

1. planar 与 globe terrain 数据检查；
2. 本地 terrain service 启动与停止；
3. 小程序 planar 数据加载和可视化验收；
4. 小程序 globe 地形、交互和天地图影像验收。

自动化门控负责判断数据、CBDAM/SDK 算法、native/Wasm 和 WebGL 链路是否异常。微信开发者工具验收负责确认最终画面、交互、影像配准和天地图署名。两者互补，不能互相替代。

以下命令均在 WSL 中从仓库根目录执行：

```bash
cd /home/holo/terra-sdk-anti/terra-sdk-miniprogram
```

## 2. Prerequisites

首次验证或源码变更后构建 CMake 与 Wasm 产物：

```bash
bash scripts/build_cmake.sh
bash scripts/verify_miniprogram_wasm.sh
bash scripts/stage_miniprogram_globe.sh
```

`verify_miniprogram_wasm.sh` 检查 C API、native/Wasm parity、Wasm 可复现性和小程序运行时单元测试。`stage_miniprogram_globe.sh` 将生成的 Wasm 与 manifest 放入 `apps/miniprogram/`；这些生成文件不提交 Git。

本地服务使用 `qt-dev-env`，Wasm 测试使用 `terra-sdk-wasm:emscripten-3.1.5`。编译日志中出现 `warning:` 即门控失败。

## 3. Terrain Data Checks

### 3.1 Planar PS 1k

检查内置 PS 1k repository、HTTP contract、校验和和错误响应：

```bash
bash scripts/verify_terrain_service.sh
```

运行完整 Wasm/WebGL 固定动作验证：

```bash
bash scripts/verify_planar_web.sh
```

若本轮已经通过 Wasm 门控，可减少重复构建：

```bash
PLANAR_WEB_SKIP_WASM_GATE=1 bash scripts/verify_planar_web.sh
```

自动报告位于 `viewer_verify_output/planar_web/report.html`。报告应包含非空的纹理、鸟瞰、缩放、45 度高度着色和 reset 截图，并且 `summary.json` 为通过状态。

### 3.2 Globe SRTM

默认数据集为：

```text
/mnt/s/terra-data/globe/cbdam-srtm-v2-global-geodetic/
  global_srtm_tol2.xml
  global_srtm_tol2.root
  global_srtm_tol2.data
```

运行完整北京数据门控：

```bash
bash scripts/verify_globe_terrain_beijing.sh
```

也可显式覆盖位置和 basename：

```bash
GLOBE_DATA_DIR=/mnt/s/terra-data/globe/cbdam-srtm-v2-global-geodetic \
GLOBE_TERRAIN_NAME=global_srtm_tol2 \
  bash scripts/verify_globe_terrain_beijing.sh
```

该脚本执行以下检查：

- 完整遍历 Berkeley DB，区分合法叶节点 `DB_NOTFOUND` 与损坏页 `DB_PAGE_NOTFOUND`；
- 检查 root/detail 文件记录数和物理页大小；
- 在 `116,40` 读取两个父 root/detail 与北京 shared child detail；
- 对相同 payload 比较原 CBDAM 与 SDK 的解码、root refinement 和 shared-child lifting；
- 运行 native C API 与 Wasm parity；
- 启动临时 service，用实际数据连续缩放 10 次并确认合成、draw 和 LOD 提升；
- 检查编译 warning，并在结束时清理临时容器。

当前已验收数据基线为：

| Item | Expected result |
| --- | --- |
| Root repository | `12288` bytes，8 records，无游标错误 |
| Detail repository | `859361280` bytes，741992 records，无游标错误 |
| CBDAM/SDK comparison | decode、两侧 root refinement、shared child refinement 全部一致 |
| Native probe | 至少完整合成 `LOD 0-2` |
| Actual Wasm | 北京最大观测 `LOD 21`，最终仍有有效 draw |
| Texture selection | `LOD 1 -> 8` |

CBDAM repository 是自适应稀疏层级，不要求每个位置、每一级都存在 detail。最深缩放阶段的 `404` 可以表示正常叶节点；只有在数据库结构完整、父级回退保留 draw 且运行时无持续错误时才接受。早期层级缺失、`DB_PAGE_NOTFOUND`、空画面或 draw 归零均为失败。

机器可读证据位于：

```text
viewer_verify_output/globe_terrain_beijing/
  native_probe.json
  native_probe.log
  native_parity.log
  wasm_parity.log
  wasm_data.log
  build.log
```

## 4. Start Local Terrain Services

Planar 与 globe 使用不同端口，可以同时运行。启动脚本会替换同名 acceptance 容器，并在返回前执行一次 transport 或实际 Wasm integration 检查。

### 4.1 Planar Service

```bash
bash scripts/start_planar_acceptance_service.sh
```

- Origin: `http://127.0.0.1:18081`
- Manifest: `http://127.0.0.1:18081/terra/v1/datasets/ps-1k/manifest`
- Container: `terra_terrain_planar_acceptance`

### 4.2 Globe Service

确认 Wasm 包和 globe 数据门控通过后启动：

```bash
bash scripts/start_globe_acceptance_service.sh
```

- Origin: `http://127.0.0.1:18082`
- Manifest: `http://127.0.0.1:18082/terra/v1/datasets/globe/manifest`
- Container: `terra_terrain_globe_acceptance`

从 Windows 浏览器访问对应 manifest，确认微信开发者工具能够访问 WSL service。结束验收后停止容器：

```bash
docker rm -f terra_terrain_planar_acceptance
docker rm -f terra_terrain_globe_acceptance
```

本地 HTTP 仅用于关闭 request-domain 校验的微信开发者工具。真机和发布环境必须使用已备案、已加入小程序 request-domain allowlist 的 HTTPS origin。

## 5. Planar Mini Program Validation

在微信开发者工具中打开 `apps/miniprogram/`。先配置本地 origin：

```js
wx.setStorageSync('terra.planarServiceOrigin', 'http://127.0.0.1:18081')
```

### 5.1 Load-Only Diagnosis

当可视化页面无法 ready 时，先运行不依赖 Wasm 渲染的 transport probe：

```js
wx.reLaunch({ url: '/pages/planar-load/index' })
```

通过状态应显示 `Planar data load passed`，并确认 manifest、root、detail、Content-Length、FNV-1a 和重复读取稳定。此页面通过只证明数据服务和小程序 ArrayBuffer 链路正常。

### 5.2 Visual Acceptance

```js
wx.reLaunch({ url: '/pages/planar/index' })
```

ready 状态应接近：

```text
PS 1k terrain ready
patches 4 | records 2 | draws 4 | vertices 8580 | texture ready
```

使用页面工具栏执行：

| Action | Acceptance point |
| --- | --- |
| `Top` | 完整地形范围可见 |
| `-` / `+` | 缩放方向正确，无数据丢失 |
| `45` | 地形起伏和轮廓清晰 |
| `T` | 纹理与地形表面配准 |
| `H` | 高程颜色有稳定层次，不是单色平面 |
| `R` | 精确恢复初始 45 度纹理视图 |
| `C` | 复制不含凭据的 runtime report |

Planar 通过标准是计数符合预期、纹理与高度模式都非空、固定动作产生可见变化、reset 可重复。

## 6. Globe Mini Program Validation

启动 globe service 后，在开发者工具 AppService console 配置 terrain origin：

```js
wx.setStorageSync('terra.terrainServiceOrigin', 'http://127.0.0.1:18082')
```

本地 globe service 的 Blue Marble URL 仅是无凭据 metadata 占位符。验收中国区域影像时配置已授权的前端天地图凭据：

```js
wx.setStorageSync('terra.imageryProfile', 'tianditu-img-c')
wx.setStorageSync('terra.tiandituToken', '<authorized frontend credential>')
wx.reLaunch({ url: '/pages/globe/index' })
```

不得把 token 写入源码、文档、日志、截图或 copied report。service-only token 不得用于小程序前端。

等待 terrain 请求稳定且 `draws > 0`，然后使用工具栏验证：

| Action | Acceptance point |
| --- | --- |
| `R` | 恢复默认北京目标和初始相机 |
| `BJ` | 中国区域居中，地形与影像持续可见 |
| `+` / `-` | terrain 与 texture LOD 随距离更新，无持续空洞 |
| `45` | 倾斜视角显示地形起伏，影像不漂移 |
| `Look` + drag | 只改变 heading/pitch |
| `Move` + drag | 改变目标经纬度 |
| `N` / `Top` | 恢复 north-up / top-down |
| `C` | 复制不含 token 的 runtime report |

天地图模式必须显示 `imagery tianditu-img-c` 和 `© 天地图`。接受最终画面时应确认中国影像可识别、地形无持续裂缝或反转、缩放后纹理继续刷新、资源失败在请求稳定后不持续增长。

开发者工具鼠标拖动等价于单指。桌面环境使用 `+`/`-` 验证缩放即可；双指 pinch、真机 GPU/内存、弱网和 HTTPS 域名授权留到最终真机验收。

## 7. Recommended End-to-End Sequence

```bash
# 1. SDK/Wasm and compiler warning gate
bash scripts/verify_miniprogram_wasm.sh

# 2. Planar data/service and automated visual evidence
bash scripts/verify_terrain_service.sh
PLANAR_WEB_SKIP_WASM_GATE=1 bash scripts/verify_planar_web.sh

# 3. Full globe database, CBDAM/native/Wasm, and Beijing LOD gate
bash scripts/verify_globe_terrain_beijing.sh

# 4. Stage the DevTools package and start persistent local services
bash scripts/stage_miniprogram_globe.sh
bash scripts/start_planar_acceptance_service.sh
bash scripts/start_globe_acceptance_service.sh
```

随后依次完成人工验收：`/pages/planar-load/index`、`/pages/planar/index`、`/pages/globe/index`。自动门控失败时不要继续把问题归因于小程序交互；先根据对应日志修复数据、service、Wasm 或 renderer 链路。

## 8. Related References

- [PLANAR_LOAD_VALIDATION.md](PLANAR_LOAD_VALIDATION.md): planar transport probe 细节。
- [PLANAR_VISUAL_VALIDATION.md](PLANAR_VISUAL_VALIDATION.md): planar 固定动作与 HTML 报告。
- [GLOBE_VISUAL_ACCEPTANCE.md](GLOBE_VISUAL_ACCEPTANCE.md): globe DevTools 操作清单。
- [GLOBE_RUNTIME.md](GLOBE_RUNTIME.md): globe runtime、缓存、交互与天地图 profile。
- [TERRAIN_SERVICE_V1.md](TERRAIN_SERVICE_V1.md): terrain HTTP contract 与 HTTPS 部署边界。
