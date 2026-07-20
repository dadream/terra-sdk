# TerraViewer V1 Product API

`TerraViewer` 是小程序和 Web 共用的轻量地形可视化入口。V1 支持
Planar/Globe 地形与影像、确定性相机交互、最多 256 个 POI、一条最多
2048 点的实线路线，以及显式地表高程状态。它不包含 GIS 图层系统、
Tour、标签避让或任意 HTML。

## Create And Lifecycle

```js
const { TerraViewer } = require('./utils/terra_viewer')

const viewer = await TerraViewer.create({
  canvas,
  mode: 'globe',
  serviceOrigin,
  manifestPath: '/terra/v1/datasets/globe/manifest',
  imagery: {
    id: 'tianditu-img-c',
    tileScheme: 'global-geodetic',
    minimumLevel: 0,
    maximumLevel: 17,
    matrixLevelOffset: 1,
    attribution: '© 天地图',
    resolveTile(tile) { return resolveAuthorizedTile(tile) }
  },
  viewport: { width, height, devicePixelRatio }
})
```

窗口尺寸变化调用 `viewer.resize()`。页面进入后台时调用 `pause()`，恢复时
调用 `resume()`，卸载时调用 `destroy()`。销毁后不得继续调用实例。

## Camera And Input

`viewer.camera.getView()` 返回 `terra.view-state.v1`。`setView()` 会先完整
校验 target、range、heading 和 tilt，再一次性提交；公开 tilt 为正角度，
`0` 表示鸟瞰。`panBy`、带 anchor 的 `zoomBy` 和 `orbitBy` 均使用 CSS pixel。

微信 adapter 只需把 touch 转为以下输入：

```js
viewer.interaction.begin({ pointers: [{ id, x, y }], timeMs })
viewer.interaction.update({ pointers, timeMs })
viewer.interaction.end({ pointers: [], timeMs })
viewer.interaction.cancel()
```

新触摸、resize、后台切换和 touch cancel 都会清理动画、惯性及待提交帧。

## POI, Route And UI

`setPois()` 接受稳定字符串 ID、坐标、`absolute|surface` 高度模式、固定 icon
和 priority。`pickPoi({x,y})` 只返回可见 POI。监听 `featureclick` 后，应用按
`featureId` 获取业务数据，并用 WXML 或受控 `rich-text` 展示；SDK 不接收 HTML。

`setRoute()` 只维护一条实线。`getRouteView()` 返回推荐 ViewState，不修改相机。
`sampleSurface()` 返回 `unavailable|approximate|ready`、高度和 revision；
refinement 后会发出 `surfacechange`。

## Imagery And Diagnostics

`imagery.setSource()` 接收 source ID 和 `resolveTile(tile)`。token 由应用闭包
注入，不进入 state 或日志。V1 要求 `minimumLevel` 为 `0`；非零最小层级需要
一个 draw 组合多张底层瓦片，
不在轻量级渲染路径的支持范围内。`getState()` 提供 cache bytes、pending/failed、
fallback ratio、idle、frame 和 overlay 统计。常见失败来自参数越界、资源限制、
服务响应、WebGL context 或 native `terra_status`。公开调用抛出
`TerraViewerError`，应用只按稳定的 `code` 分支，不解析错误文本。

V1 错误码包括 `initialization_failed`、`invalid_view`、
`invalid_camera_change`、`invalid_interaction`、`invalid_imagery_source`、
`invalid_pois`、`invalid_route`、`invalid_coordinate`、
`invalid_screen_point`、`route_unavailable`、`invalid_listener`、
`invalid_viewport` 和 `camera_failed`。错误 message 已脱敏，仅用于诊断和用户
提示；未知底层失败统一保留在最接近的公开操作码下。

## Events

V1 事件为 `interactionstart`、`camerachange`、`interactionend`、
`camerasettle`、`animationcancel`、`featureclick`、`featureposition` 和
`surfacechange`。应用在 `camerasettle` 后自行持久化 ViewState。
