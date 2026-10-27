# TerraViewer V1 Product API

## Custom terrain transport

`ViewerCreateOptions.request` accepts a `TerrainRequestOptions` object and returns
a `TerrainRequestTask`. Options include URL, GET method, optional `arraybuffer`
response type, timeout and required `maximumResponseBytes`. Binary response data
must be `ArrayBuffer` or `Uint8Array`. Bound actual bytes while receiving; do not
trust Content-Length alone. Oversized input is a nonretryable transport error.
A task's promise must settle after the physical producer exits even after `abort()`;
SDK consumer cancellation and shared GET ownership are handled separately.

Browser/Mini Program entries supply platform defaults. Browser receiving is
stream-bounded. WX/CloudBase currently validate binary size at completion before
SDK copies, and cannot enforce limits on platform-owned receive/JSON buffers.
Runtime `terrain.input` reports funded/available/minimum bytes and waiting inputs;
it is part of shared accounting, not a process-memory or native-heap measurement.

`TerraViewer` 是小程序和 Web 共用的轻量地形可视化入口。V1 支持
Planar/Globe 地形与影像、确定性相机交互、最多 256 个 POI、一条最多
2048 点的实线路线，以及显式地表高程状态。它不包含 GIS 图层系统、
Tour、标签避让或任意 HTML。

## Create And Lifecycle

```js
const { TerraViewer } = require('@terra/sdk')

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

`viewer.camera.getView()` 返回 `terra.view-state.v2`。`setView()` 会先完整
校验 target、range、heading 和 tilt，再一次性提交；公开 tilt 为正角度，
`0` 表示鸟瞰，最大 `89.5°`。两种模式的 `target.heightMeters` 都是真实目标高程，
`rangeMeters` 是眼点到目标点的距离，不含地球半径或目标高程；最小范围为 `0.1m`。
例如目标高程 `1600m`、`rangeMeters: 2`、`tiltDegrees: 88` 表示眼点位于该目标
约 `2m` 外，而不是离地球中心 `2m`；它不表示垂直离地 `2m`。
若当前网格的离地约束要求更大间距，运行时仍会增大 range。
高程是绝对值，不会隐式查询或贴地。
`flyTo/startOrbit/playRoute` 统一使用 `rangeMeters`，取消语义含混的
`heightAboveTargetMeters`；飞行诊断中的巡航值改为 `cruiseRangeMeters`。

相机在 double 精度下计算，近裁面不再只由远裁面的固定比值决定。globe 的
远裁面覆盖参考球面地平线及半径 `1%` 的保守高程范围；超出此范围的自定义
天体/数据需要后续可配置包络支持。默认显示网格离地约束降为 `2m`，只能反映
当前呈现的网格，不能保证未加载地形的碰撞安全。行人高度需要目标处真实高程和
足够细的数据需求管理；当前驻留查询不发起额外下载。

`panBy`、带 anchor 的 `zoomBy` 和 `orbitBy` 均使用 CSS pixel。

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
`sampleRenderedSurface()` 对当前显示三角形求交，返回 `unavailable|approximate`、
高度和显示 revision；没有局部覆盖时高度为 `null`。贴地 POI/路线使用这条链路，
refinement 后会发出 `surfacechange`。显示网格不能证明原始地形数据精度，因此不会返回 `ready`。
局部地形交接时，查询、贴地要素和 `surfacechange` 跟随实际提交的混合网格更新；
显示 revision 可以先于整帧 `terrainSelection.presentedSequence` 变化，两者不能互作完成凭证。

`await viewer.sampleTerrain([longitude, latitude])`（planar 为 `[x,y]`）读取 CBDAM
已重建的高程缓存，独立于显示网格、相机和 GPU。返回 `available|unavailable`、
`source: 'cbdam-cache'`、`heightMeters`、`level`、`dataLevel`、`sampleSpacingMeters`
和高程缓存 `revision`；没有覆盖时高度、层级和间距均为 `null`。
`level` 是 CBDAM 地形重建层级（不是影像四叉树层级），`dataLevel` 是真实数据层级；缺失细节的零残差细分不会提高
后者或缩小原始采样间距。高度使用 CBDAM 格点三角形插值，不是最近顶点。
间距是水平采样间距的保守值，不是垂直误差或最高可用数据精度保证。

查询不下载数据、不改变 LOD、不发布帧，也不锁住缓存。每个 runtime 最多允许
16 个待完成查询，超限、销毁或 Worker 被替换时以 `terrain_query_failed` 拒绝；
非法输入以 `invalid_coordinate` 拒绝（数据范围错误由 runtime 拒绝）。
这是驻留数据查询，不是按需 DEM 下载接口。飞行路径预取及行人相机对查询的
持续需求管理仍属后续工作。开发期已移除原 `sampleSurface()` 接口。

## Sky And Atmosphere

Globe 模式默认启用天空、大气边缘与距离雾。核心层使用 C++14 生成确定性的
天空查找纹理、太阳方向和雾参数；WebGL 只负责渲染，不依赖 Qt、QImage 或固定
管线 OpenGL。Planar 模式不创建大气资源。

```js
viewer.environment.setAtmosphere({
  enabled: true,
  sunAzimuthDegrees: 135,
  sunZenithDegrees: 35,
  turbidity: 2,
  exposure: 1
})
const atmosphere = viewer.environment.getAtmosphere()
```

参数越界或在 Planar 模式调用时抛出 `invalid_atmosphere_options`。

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
`invalid_viewport`、`invalid_atmosphere_options` 和 `camera_failed`。
错误 message 已脱敏，仅用于诊断和用户
提示；未知底层失败统一保留在最接近的公开操作码下。

## Events

V1 事件为 `interactionstart`、`camerachange`、`interactionend`、
`camerasettle`、`animationcancel`、`featureclick`、`featureposition` 和
`surfacechange`。应用在 `camerasettle` 后自行持久化 ViewState。

## Unified Texture Sources

内部纹理节点采用 CBDAM 八根四叉树（平面数据为单根），不使用外部 URL、
TileMatrix 或 TMS 行号作为节点身份。地形 fragment 的纹理锚点由几何层级确定；
切换图源不重建地形。当前只接入与该模型对齐的等经纬度图源，原始 Web Mercator
需先由数据服务重投影，不能仅通过改写 URL 接入。

Web 全局 API 为 `Terra.imagery.createTmsImagerySource` 和
`Terra.imagery.createWmtsImagerySource`；CommonJS 可从 `terra_viewer` 导入同名工厂。
两者返回可传给 `TerraViewer.create({imagery})` 或 `viewer.imagery.setSource()` 的对象。

```javascript
const source = Terra.imagery.createWmtsImagerySource({
  id: 'geodetic-imagery', url: 'https://example.invalid/imagery/wmts',
  layer: 'satellite', matrixSet: 'geographic',
  texture: {
    maximum_level: 17, matrix_level_offset: 1,
    origin: 'top-left', crs: 'EPSG:4326'
  }
});
viewer.imagery.setSource(source);
```

TMS 使用 `{z}/{x}/{y}` URL 模板；`origin: 'bottom-left'` 在请求边界翻转行号。
WMTS 的 `matrix_ids` 可指定外部字符串矩阵标识，缺省使用层级加
`matrix_level_offset`。适配层的资源行列始终按北向南用于 UV，图像无需复制或翻转。
默认全球图源为 2×1 根、256 像素瓦片。内部深度 d 对应此图源层级 d+1；源层级0
的两张图片可共享覆盖八个内部根。当粗图满足 SSE 时直接使用粗图，无需请求完整祖先链。

SDK C ABI 当前为8。开发阶段不保留旧 ABI，应用需同时更新 JS 包和 Wasm。

## Performance observation

```js
viewer.diagnostics.reset()
// Run an application camera trajectory through the public camera/interaction API.
const report = viewer.diagnostics.snapshot()
console.log(report.runtime.frameCoordinator.frame.p95Ms)
console.log(report.runtime.frameCoordinator.cameraToSubmit.p95Ms)
```

The exact snapshot uses a bounded 240-sample window plus lifetime counts and
maximums since reset. `queue` measures queued input/animation callbacks;
`cameraToSubmit` starts at the first camera revision waiting for submission.
`frame` includes animation, input, synchronous rendering and notification.
`continuousInterval` records intervals when the previous frame requested another
frame, including long stalls; idle periods and suspension are excluded.
Renderer submission is CPU/GL-call duration, not a GPU timer query. Native/Worker
update latency may contain asynchronous waits. Ordinary state snapshots cache
percentiles for up to 250ms; `windowEndingCount` identifies their sampled endpoint.

`report.renderer.allocationValidation` measures synchronous GL error checks for
new GPU resources. Failed allocations are not published to rendering caches.
The diagnostics schema is `terra.performance.v3`. The old combined
`submissionWait` is replaced directly by `renderer.drawSubmissionWait` and
`renderer.resourceSubmissionWait`. A submission that draws and uploads belongs
only to the first series; the second contains uploads without frame drawing.
Samples are recorded once after successful fence observation, including host
scheduling delay. They are completion latency, not GPU execution time or the
isolated cost of an image upload. Unfinished, cancelled and failed waits do not
become completed samples. WebGL1 has no asynchronous completion samples.

`getState().renderer.transition.gpuSubmission` reports the in-flight submission
and its upload-byte/object allowance. `kind` is `draw`, `resource`, or `null` when
idle. A pending draw submission can have zero upload bytes. Each series keeps
bounded samples, supports diagnostic reset and reports its own count/percentiles.
The demo shows these separately; a dash means no completed sample. No compatibility
aliases are provided for the replaced metric or diagnostics schema.
WebGL2 permits one submission in flight, including frames with no uploads. Camera
changes coalesce while it is pending. Completion-only callbacks leave an unchanged
canvas alone instead of starting an idle redraw loop. WebGL1 does not provide
the same GPU queue bound.
Ordinary frames do not wait for a GL error-query round trip. A submission receipt
means draw commands were issued with an active context, not that the GPU has
finished rendering. Context loss uses the context event and submission-time loss
checks. For explicit debugging, `viewer.debug.setRendering({webglErrors: true})`
enables a synchronous check after every frame; disable it before measuring
interactive performance. Texture-state visualization alone does not enable it.

On the globe Web demo, enable Debug to select a fixed flight, oblique-orbit or
zoom/roam test. Each manual run lasts eight seconds and can be cancelled; its JSON
report contains the viewport, sampled camera/coverage/error states and performance
summaries. The oblique test uses the current orbit camera, not a pedestrian-height
camera. Reports characterize a specific device, dataset, cache and network state;
they do not imply that the SDK already meets hardware performance targets.

`viewer.getState().terrainSelection` distinguishes the desired view revision from
the prepared and presented model's selection revisions. A completed model may be
used with a newer rendering camera while the next selection progresses. In that
case `renderer.quality.terrainSelectionCurrent` is false; geometry coverage can
still be complete. The renderer never rewinds the live camera to a model's old
selection camera. `presentedSequence` advances only after a GPU submission receipt.
`terrainSelection.demand.reason` is `planning` while a selected terrain frame
awaits its matching imagery price, `measurement` while unaffordable conservative
imagery bounds are being tightened, `capacity` when known demand cannot fit, or
`null` when refinement is eligible. `planningWaits` counts entries into planning
waits; `measurementWaits` counts entries into measurement waits, and
`pauses`/`resumptions` count overall refinement backpressure transitions.
`renderer.quality.refinableMeasurementCount` counts mesh measurements that can
still tighten whole-block bounds; it is not a missing-image count.
Eligibility is not download completion or a guarantee of final target precision.
For a complete current plan, eligibility also requires an owned imagery
continuation reservation. `renderer.textures.demandReservation` reports unspent
`bytes`, cumulative `grants`, `highWaterBytes` and protected `targets`. These are forecast credits,
separate from decoded/GPU residency; actual groups transfer them into their
production owners. Changing the view or pausing releases unused credit, while
active producers keep their own receipt lifetimes.
`renderer.transition.localReplacement` separately reports dependency-group preparation,
group count and locally submitted groups while that complete-frame receipt is pending.
Shared boundary changes commit together; independent ready regions can advance and
release their old GPU pins. Local retirement receipts also release eligible
native/Worker/host mesh ownership; tasks retaining a mesh keep their own hold
until they finish. The complete candidate still requires its full-frame receipt.

Navigation reports also include sampled `terrainPublicationCount` and
`terrainMeshChangeCount`, plus per-sample selection revisions and loaded records.
These counts are bounded sampling observations, not an exhaustive event log.
Web navigation acceptance requires model publication and mesh changes during motion as well as
nonblank coverage; `fullUpdate.count` alone does not prove GPU presentation.

`renderer.transition.handoff` reports the candidate sequence, phase, total age
and time waiting in the current phase. `geometry-capacity`, `partition-capacity`,
`partition-build` and `imagery-transition` identify different waits;
`gpu-submit` means eligible for submission, and `presented` requires a successful
GPU submission. It does not imply that terrain or imagery has met its SSE target.

`renderer.transition.partitions` exposes queued cell count, oldest queued age,
active task age and completed batches awaiting upload. The renderer performance
snapshot includes `partitionQueueWait` (renderer enqueue to dispatch) and
`partitionTask` (dispatch to completion/cancellation). Task time includes Worker
queueing, cooperative yields and message transfer; it is not CPU time. Both use
the same bounded percentile window as the other timing series. Navigation reports
sample these queues alongside the handoff phase.

Cache statistics distinguish resident `bytes` from `reservedBytes`/
`reservedEntries` owned by work in flight. `highWaterBytes` includes both and is
a cache-lifetime high-water mark. Navigation reports sample texture reservations,
combined resident/reserved capacity and model handoff waits. These are resource
accounting values, not total browser-process or graphics-driver memory usage.

`viewer.getState().resourceMemory` exposes a shared admission envelope for the
record cache, geometry GPU buffers, decoded imagery/GPU textures, GPU partitions
and partition output arrays. It reports `maximumBytes`, `bytes`, `highWaterBytes`,
`overBudgetBytes`, phase totals (`reservedBytes`, `residentBytes`, `retiredBytes`)
and per-owner phase amounts in `owners`. The renderer exposes the same ledger at
`renderer.transition.memory`; do not add these two views together. `resident`
means owned payload, not measured GPU residency. Pending partition CPU output is
also visible as `renderer.performance.partitionCpuBytes`.

Set `maximumResourceBytes` in the viewer creation options to choose that shared
managed-payload limit. It must be a positive safe integer; zero does not disable
admission. The default is 768 MiB for every initial viewport, with a 64 MiB
selected-terrain limit and a 160 MiB preferred imagery share. The workstation
globe demo uses these public defaults without a separate capacity override.
The Beijing 76.3-degree view needs about 36 MiB of selected terrain and 384 target
images; an orbit handoff exceeded 512 MiB. The smaller 32/512 MiB profile passed
the canonical Tai'an route but could not establish sufficient capacity for this
additional view. Increasing capacity does not close the live oblique 30-second
latency failure. The smaller profiles remain pressure evidence. See
[capacity evidence](../SDK_MEASUREMENT_PIPELINE.md) for scope and remaining work.

`maximumTextureRequests` defaults to 8 (integer values are clamped to 1..8),
independently of terrain requests and viewport size. On the browser adapter,
the encoded input window follows that concurrency: for 256px tiles, eight
requests allow at most 8 MiB of encoded/assembly input and an 8.5 MiB shared
input/decode pipeline. This is an on-demand ceiling inside the existing ledger,
not preallocated memory. Smaller explicit memory limits still impose real
backpressure. Decoding remains serial and GPU upload budgets are unchanged;
this option does not promise eight simultaneous HTTP connections or hardware
decoders. Platform image APIs retain their separately bounded pixel admission.

These are admission limits, not eager allocations
or a guarantee that every view and device can meet the requested precision.
The limits are fixed at creation. Resizing, changing a cache share or increasing
the record cache does not increase the total. Imagery may obtain a larger share
only through admission inside this envelope. Applications can select smaller
explicit limits at creation; insufficient capacity remains limited quality.

`resourceMemory.reclamation.providers` reports bounded per-provider counters
for attempts, returned bytes, empty receipts and failures. Requests continue
across providers between pressure events; a productive cache at the head cannot
permanently prevent old mesh, record or height caches from being inspected.
Counters describe actual receipts, not capacity available before a producer ends.

The low-level WebGL adapter consumes a caller-owned `resourceLedger` without
changing its limit. Configure that ledger at its owner; supplying both it and
`maximumResourceBytes` is rejected. Without an injected ledger the adapter owns a
64 MiB envelope, overridable by `maximumResourceBytes` at construction. Its
`setBudget()` changes local shares only. Pending work and retained display leases
remain charged even when the owner reduces the ledger limit; only completion or
safe retirement releases their ownership. The low-level ledger's explicit zero
(unlimited host/test policy) is not accepted by the public viewer option.

Partition producers receive a finite credit before allocating output. Cancelling
a job retains its charge until it settles. Retired cache entries held by uploads
remain charged after removal from lookup. Explicit native/Worker/host mesh payloads
and admitted production workspaces also share this ledger. Wasm heap capacity,
unmanaged metadata/scratch, browser networking, driver-internal copies, auxiliary
GL objects and platform overhead are outside it; this is not a whole-SDK memory
ceiling. Refer to `owners` for allocations actually included, rather than adding
process memory and managed payload totals together.

`viewer.getState().performance.workerMeasurementHistory` reports the latest
Worker projection-history snapshot, or `null` when unavailable. It contains
view/entry/region counts and `numericPayloadBytes`, `maximumNumericPayloadBytes`
and `highWaterNumericPayloadBytes`. The default history holds at most three
views and 5,505,024 bytes of estimated numeric payload. This excludes JavaScript
object overhead, active measurement work and transport/native copies; it is not
part of `resourceMemory`. History eviction affects reuse only, without changing
the active exact measurements or requested SSE. Projection metadata contains
UV bounds/hulls/regions and no terrain model or vertex arrays.
