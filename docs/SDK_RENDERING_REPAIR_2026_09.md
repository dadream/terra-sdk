# SDK rendering repair — 2026-09-10

后续缩放修复见 [2026-09-11 记录](SDK_ZOOM_REPAIR_2026_09_11.md)。本文记录的是前一轮实现；完整驻留叶导出和逐地形片影像选级已被后续修复替代。

本轮修复针对 feature/miniprogram-sdk 工作树（基础提交 5fc865950b5174e063c31305359f9f3638d29441）。
保留 SDK 独立的地形/影像 LOD、Wasm ABI、资源缓存和相机预览。
nav3d 是本地正确性参考；本轮不迁移其 Qt/OpenGL 客户端，也不要求两者共享同一套调度实现。

## 已实施的机制修复

| 问题 | 实施 |
| --- | --- |
| 右键连续操作只预览旧集合，等松手才推进需求 | 交互期间合并最新相机需求；最多一个待执行更新，间隔根据上次全量更新耗时约束在 120–500 ms；没有相机变化和资源进展时不空转。 |
| 旧视锥之外缺少可供预览的地形片段 | C API 导出已驻留完整叶切分的片段；额外根覆盖只用于启动过渡，不与目标地形反复叠画。 |
| 旋转导致包围盒放大、影像等级跳变；屏幕误差被截断后误报达标 | 缓存地形三角面的 UV 导数与空间分块，对可见投影求保守误差；使用旋转不变的谱范数。移除两个视口大小的截断，降级使用独立的滞回阈值。 |
| 每张影像子瓦片重复提交整块网格，依赖片元丢弃裁剪 | 缓存实际 UV 分区：内部三角形复用原索引，仅边界三角形裁切；排除三角地形区域之外的空纹理格。相机变化或纹理到达不自动重建相同分区。 |
| 新目标尚未就绪就撤掉已显示的细节 | 跟踪真正绑定的驻留纹理。新的粗目标未驻留时保留原有细纹理的局部呈现，完成后再替换；保留原有逐子节点提交能力。 |
| 页面、资源目标与当前画面的 ready 含义不一致 | 质量来自当前相机与实际绑定纹理；相机/计划/呈现版本一致、地形决策完成、覆盖和实际误差达标后才 ready。受预算约束时明确 limited。 |
| 小程序发布包依赖不完整 | 将新增 surface plan 及原先漏打包的 camera motion 模块纳入发布包，增加对打包后 viewer 的实际导入检查。 |

主要代码位于：
- apps/miniprogram/utils/terra_surface_plan.js
- apps/miniprogram/utils/terra_webgl_renderer.js
- apps/miniprogram/utils/terra_globe_runtime.js
- sdk/src/c_api/terra.cpp
- apps/site/demo/app.js

本轮没有提高默认纹理预算、放宽 1.25 像素目标，或修改地形/影像序列化格式与 ABI 版本。
分区 GPU 缓存另受 geometryCacheBytes 限制；超额时保留可用分区/粗覆盖，并记录限制。
保守投影误差是质量上界，不是对最终截图每个像素误差的逐点测量。

## 验证结果

- CMake 基线编译及 16/16 CTests 通过。
- 原生 SDK 门控 24/24 通过；C API 新增“不可见但已驻留叶片段仍导出”的回归。
- terrain service 门控通过。
- Wasm/原生一致性、相关 C API 回归、Wasm 可复现构建通过。
- 最终小程序 JavaScript 测试集全部通过；包括旋转稳定、分区面积覆盖、索引复用、细节保留、质量状态、持续交互和静止不空转。
- SDK 发布包、原生 C 消费者、SPDX 清单、站点打包检查通过。
- 编译日志无 warning:。
- Web SDK 使用仓库原有 Chromium runner 和 checker 通过：9 张场景捕获、返回视角比较、WebGL 上下文恢复。原图像阈值未放宽。
- 图像门控的旧夹具将同一小图贴到每个不同 LOD 瓦片，导致地理内容随 LOD 改变。现使用自包含 SVG 切片提供一致的地理内容；这只是测试影像，不影响产品影像来源。
- verify_sdk_release.sh 包装脚本在 Web 步骤因 WSL 无可发现的 Chromium 停止。该步骤用 Windows Node/Chrome 执行相同仓库 runner/checker，后续 package/site 两步单独补齐；不声称包装脚本本身完整退出 0。
- viewer/nav3d GUI smoke 均在创建窗口前因 WSL X11 :0 不可连接而失败，未获得桌面 GUI 回归通过证据。本轮相应原生组件已经编译，相关测试容器已清理。
- DevTools/Android/iOS 设备人工验收仍按仓库约定由所有者完成。

工程证据（忽略的生成目录）：
- viewer_verify_output/render_fix_cmake.log
- viewer_verify_output/render_fix_release.log
- viewer_verify_output/render_fix_js.log
- viewer_verify_output/render_fix_package.log
- viewer_verify_output/render_fix_site.log
- viewer_verify_output/web_sdk/summary.json
- viewer_verify_output/web_sdk/report.html
- viewer_verify_output/render_fix_services/summary.json
- viewer_verify_output/render_fix_live.json
- viewer_verify_output/render_fix_cleanup.json

## 线上右键交互验收

实际部署站点：http://49.233.185.96/demo/globe/?imagery=tianditu-img-c
使用真实地形与天地图数据，1200×900 浏览器窗口。
GPU：ANGLE / Intel Graphics / Direct3D11。
本次流程从 2026-09-10 14:07:08 UTC 到 14:09:04 UTC，限定总时长，结束后关闭测试页面与浏览器。
先前 SwiftShader 软件光栅化流程未在时限内收敛，记为失败；没有将其耗时作为硬件性能结论。

场景以北京为目标，近地视角 rangeMeters = radius + 100000；
右键合并拉平到约 74.6°、旋转到约 64.79°，然后返回同一俯视视角并再次设置相同视角。

| 场景 | 终态 | 实际绑定纹理的保守误差 px | 缺失/回退区域 | 资源状态 |
| --- | --- | ---: | --- | --- |
| 全球 | ready | 1.2480 | 0 / 0 | 静止，无待处理请求 |
| 北京俯视 | ready | 1.2499 | 0 / 0 | 静止，无待处理请求 |
| 右键拉平并旋转后 | limited | 2.6632 | 0 / 0 | 静止，无待处理请求 |
| 返回北京俯视 | ready | 1.2495 | 0 / 0 | 静止，无待处理请求 |
| 再次设置同一视角 | ready | 1.2495 | 0 / 0 | 新增纹理上传 0，新增分区构建 0 |

拖动过程中：24 次相机预览，5 次全量需求更新，在松手前已推进；覆盖完整且不报告 ready。
相机预览 CPU 路径平均约 0.22 ms，这不包含后续绘制和全量 LOD 更新，不能当作帧率。
新视角揭示新区域、改变投影尺度时仍会正常加载纹理。
返回原视角过程中也可能因地形切分和缓存变化产生必要更新；
“零重建”结论针对稳定后重复相同视角，不代表任意往返操作绝无资源变化。

验收无 JavaScript 异常、无非取消网络失败。抽查最终俯视及拉平截图，均有完整地形覆盖。
浏览器/运行时句柄已关闭，临时 profile 已移除，测试自动化进程与测试容器均为 0。
浏览器退出后，通过 SSH 控制面读取 Caddy 日志，72.3 秒观察窗口内该测试专用 User-Agent 的新增请求为 0。
没有用浏览器页面或应用端点做退出后轮询。

## 部署与回滚

只替换受影响的 edge 静态站点资源，未重启 terrain/imagery 或其他无关服务。
线上拉取的 bundle 与本地候选逐字节一致，站点与服务有界检查通过。

- 新站点：/srv/terra/sites/20260910-render-fix-badefb8fa68b
- 原站点：/srv/terra/sites/20260908013511（保留）
- bundle SHA-256：badefb8fa68b930784a23e6b50287ee5f6dd46eee0ff244e7465b8d0360fdd66
- Wasm SHA-256：6639518241c3bd45814792e5522968b22c93dce1a6549d85772d5981a04fbd7b
- Wasm：132941 bytes；最终小程序核心包：430107 bytes，小于 524288 bytes。
- 部署记录：viewer_verify_output/render_fix_deployment.json

部署过程保存了服务器原有环境文件，替换 TERRA_SITE_DIR 后仅执行 compose up -d --no-deps edge；
部署失败会恢复原配置并重建 edge。当前部署成功，未执行回滚。
后续回滚可将该字段恢复为上述原站点，再执行相同 edge 更新；不得覆盖其他环境字段。

## 仍然存在的限制

1. 74.6° 拉平场景达到 1.25 px 上界需要约 505 张目标纹理，当前目标预算为 214 张。
   此次有限预算下稳定质量为约 2.66 px。它已明确停在 limited，未无限请求或伪装 ready；
   本轮没有实现所有倾角、所有可视范围下都达到同一清晰度。
2. SDK 的 Wasm 地形更新仍在主线程。本次若干稳定场景最后一次全量更新约 157–355 ms，
   拖动采样中一次约 527 ms；其中 LOD/C API 更新占显著比例。
   本轮减少重复绘制并限制更新频率，没有消除全量更新的主线程阻塞，也不宣称已达到 nav3d 的整体性能。
   如下一步目标是持续拖动的严格帧时间，应在保留本轮覆盖/质量/缓存契约的前提下，
   对 LOD 计算和帧导出做可中断的时间预算或 Worker 隔离；不能继续靠延迟、降清晰度或扩大缓存掩盖长任务。
3. 不同影像等级的内容、色彩与上游数据质量仍由服务决定；当前没有做跨等级淡入或接缝颜色融合。
4. 本轮证明的是这些机制与所记录场景，不是对所有设备、数据集和任意视角的完备证明。

2026-09-10 首次部署时代码尚未提交；2026-09-11 的发布流程补齐 Git 提交与重新部署。
2026-09-11 再次执行非 GUI 基线的 11 个步骤并通过，覆盖编译、原生黄金样本、
SDK/Wasm、安装产物、服务与 1k 数据重建；4 项依赖 X11 的 GUI 步骤未执行。
按用户新要求，本仓库使用普通 WSL Git 提交，不执行 preflight。
后续发布关联的提交和资源哈希记录于站点 /assets/deployment.json；
首次部署记录保留在本文，后续部署记录位于 viewer_verify_output/render_fix_redeployment.json。
其他四个相邻基线仓库工作树保持干净；原有未跟踪 Testing/ 保留。
