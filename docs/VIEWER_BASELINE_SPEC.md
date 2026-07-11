# Viewer Verification Baseline Specification

## 1. Purpose

本 spec 定义 `vic_cbdam_viewer` 在 SDK 化改造前需要建立的验证基线。目标不是证明 viewer 完全无缺陷，而是冻结当前可接受行为，形成一套快速、自动化、可重复的回归机制，用于判断后续 UI/渲染系统与平台无关核心算法拆分过程中是否引入可疑回归。

验证基线应回答同一个问题：在相同数据、相同视角、相同渲染参数下，当前实现与改造前 viewer 行为是否保持一致或在可接受容差内。

## 2. Scope

基线覆盖 1k PS Terrain & Texture 数据集的自动化验证，并保留 16k 数据集作为人工或慢速增强验证。

包含范围：

- viewer 启动链路：容器、X11/WSLg、OpenGL、terrain、texture。
- 固定视角渲染：默认鸟瞰、缩放、倾斜、旋转、reset。
- 基础交互行为：快捷键、相机控制、正常退出。
- 状态观测：camera、渲染开关、渲染统计、数据连接状态。
- 截图观测：关键阶段 framebuffer 截图。

不包含范围：

- 逐像素完全一致验证。
- 完整 UI 自动化测试。
- SDK 公共 API 兼容性测试。
- 所有 16k 场景的自动化视觉回归。

## 3. Baseline Artifacts

验证基线由以下产物组成：

- 日志基线：启动、数据加载、texture 连接、OpenGL 初始化、更新线程启动。
- 状态基线：每个关键动作后的 viewer state JSON。
- 截图基线：每个关键动作后的 PNG 截图。
- 动作脚本：描述固定的 viewer 验证动作序列。
- 验证摘要：一次运行的通过/失败结果、失败原因、输出路径。
- 日志契约：从原始日志中提取有效事件，过滤无效调试输出和环境噪声。
- 可视化报告：用于人工审查 baseline 与本次测试结果差异的 HTML 报告。

建议目录：

```text
testdata/viewer_baseline/1k/
  actions.txt
  log_contract.json
  initial_birdview.png
  birdview_zoom_in.png
  tilted_45.png
  tilted_zoom_out.png
  tilted_rotate.png
  statistics.png
  reset.png
  state_initial_birdview.json
  state_birdview_zoom_in.json
  state_tilted_45.json
  state_tilted_zoom_out.json
  state_tilted_rotate.json
  state_statistics.json
  state_reset.json
  baseline_summary.json
```

HTML reports are generated run artifacts and are not stored in the baseline.

运行输出建议写入非基线目录：

```text
viewer_verify_output/1k/
```

## 4. Log Baseline

当前 viewer 输出中混合了有效业务日志、调试日志、帮助文本和环境噪声。日志基线必须先规范有效日志，再用于自动化验证。

日志产物分为三类：

- `viewer.log`：保留原始 stdout/stderr，便于排查问题。
- `normalized_log.json`：由脚本解析出的结构化有效事件。
- `log_contract.json`：baseline 中维护的必需事件、禁止事件和可忽略模式。

有效日志事件应覆盖：

- `process_started`：viewer 进程启动，对应 `starting program`。
- `terrain_connected`：terrain fetcher 和 terrain model 连接成功。
- `terrain_mode_detected`：识别为 `planar` 或 spherical。
- `update_thread_started`：更新线程启动，对应 `update_started`。
- `texture_layer_connected`：指定 texture layer 连接成功。
- `opengl_initialized`：OpenGL 初始化完成，对应 `initialize GL`。
- `initial_camera_set`：初始相机位置已设置，对应 `set position ...`。
- `verify_action_started` / `verify_action_finished`：验证模式下 action 执行状态。
- `capture_written`：截图和 state JSON 写入成功。
- `process_exited`：验证完成并正常退出。

禁止日志模式应覆盖：

- `cannot connect to texture layer`
- `unable to load elevation`
- `unable to connect fetcher`
- `failed to load terrain model`
- `This system has no OpenGL support`
- `Segmentation fault`
- `Aborted`
- `unknown verify action`

可忽略日志包括帮助文本、历史调试输出、非 fatal 的渲染统计打印，以及 Docker/WSL 环境噪声。自动化脚本不应直接对整份原始日志做字符串快照，而应从原始日志生成 `normalized_log.json` 后再与 `log_contract.json` 比对。

## 5. Viewer Verification Mode

viewer 需要新增一个确定性的验证模式。该模式由命令行启用，不影响默认手动 viewer 行为。

新增参数：

```text
--verify-script <file>
--verify-output-dir <dir>
--verify-exit
--verify-window-size <WIDTHxHEIGHT>
--verify-log-state
```

参数含义：

- `--verify-script <file>`：启用验证模式，并从指定文本文件读取 action 序列。未提供该参数时 viewer 保持原有手动行为。
- `--verify-output-dir <dir>`：指定 PNG、state JSON、`summary.json`、`normalized_log.json` 和 HTML 报告的输出目录。目录不存在时由验证模式创建；创建失败应使 viewer 返回非零退出码。
- `--verify-exit`：action 执行完成后自动退出 viewer。未启用时，验证动作完成后保留窗口，便于人工观察。
- `--verify-window-size <WIDTHxHEIGHT>`：设置验证窗口尺寸，例如 `1280x720`。该尺寸同时作为截图检查的预期尺寸。
- `--verify-log-state`：在每个 action 前后输出结构化状态日志，用于生成 `normalized_log.json` 和定位失败阶段。

示例：

```bash
vic_cbdam_viewer \
  --elevation /workspace/testdata/datasets/ps_1k/reference/terrain \
  --verify-script /wksp/testdata/viewer_baseline/1k/actions.txt \
  --verify-output-dir /wksp/viewer_verify_output/1k \
  --verify-exit \
  --verify-window-size 1280x720 \
  /workspace/testdata/datasets/ps_1k/reference/texture/victms.xml
```

验证模式要求：

- action 在渲染帧之间执行，避免抓取未稳定画面。
- `capture` 使用 OpenGL framebuffer 截图，而不是依赖桌面截图工具。
- 每次 `capture` 同时输出 PNG 与 state JSON。
- `--verify-exit` 启用时，action 执行完成后 viewer 自动退出。
- 缺失脚本、无法创建输出目录、截图失败、未知 action 均应返回非零退出码。

## 6. Action Script

第一版 action 脚本采用简单文本格式，每行一个动作。空行和 `#` 注释忽略。

标准 1k 基线动作：

```text
wait_frames 20
capture initial_birdview

zoom_in 8
wait_frames 10
capture birdview_zoom_in

tilt 45
wait_frames 10
capture tilted_45

zoom_out 5
wait_frames 10
capture tilted_zoom_out

rotate 30
wait_frames 10
capture tilted_rotate

key f
wait_frames 5
capture statistics

reset
wait_frames 10
capture reset

exit
```

动作语义：

- `wait_frames N`：等待 N 次 `paintGL` 完成。
- `capture NAME`：保存 `NAME.png` 和 `state_NAME.json`。
- `zoom_in N` / `zoom_out N`：执行确定性的相机距离变化。
- `tilt DEGREE`：设置固定倾斜角，第一版以 45 度为主。
- `rotate DEGREE`：相对当前视角旋转固定角度。
- `key KEY`：触发已有快捷键逻辑，如 `f`、`n`、`c`、`b`。
- `reset`：调用现有初始视角逻辑。
- `exit`：结束验证流程。

验证模式中的 `tilt` 和 `rotate` 应优先通过内部相机控制接口实现，不以外部鼠标坐标模拟作为主路径。

## 7. State JSON

每个 capture 必须导出一个 state JSON。第一版字段如下，暂时无法稳定获取的字段可以省略，但必须在 `summary.json` 中列出。

```json
{
  "capture": "initial_birdview",
  "frame": 20,
  "width": 1280,
  "height": 720,
  "camera_position": [0.0, 0.0, 0.0],
  "pixel_tolerance": 2.0,
  "statistics_mode": 0,
  "wireframe_enabled": false,
  "color_enabled": true,
  "patch_color_enabled": false,
  "draw_bounding_volumes_enabled": false,
  "shading_enabled": true,
  "adaptive_tolerance_enabled": true,
  "terrain_connected": true,
  "planar": true,
  "rendered_triangles": 0,
  "mean_fps": 0.0
}
```

状态字段用于判断截图差异背后的原因。例如 reset 后 camera 应接近初始状态；`key f` 后 `statistics_mode` 应变化。

## 8. Automation Scripts

新增快速交互验证脚本：

```text
scripts/verify_viewer_1k_interaction.sh
```

职责：

- 清理本次运行输出目录。
- 启动 Docker viewer，挂载 WSLg/X11。
- 使用 1k 数据集和标准 action script。
- 等待 viewer 自动退出。
- 收集 `viewer.log`、PNG、JSON、`summary.json`。
- 调用截图检查脚本。
- 返回可用于 CI 的退出码。

新增截图检查脚本：

```text
scripts/check_viewer_captures.py
```

检查项：

- 所有必需 PNG/JSON 存在。
- PNG 尺寸等于 `1280x720`。
- PNG 不是纯色或空白图。
- 关键相邻截图存在显著差异。
- reset 截图与初始截图接近，但不要求逐像素一致。
- state JSON 中关键字段符合预期。

新增 HTML 报告生成脚本：

```text
scripts/render_viewer_baseline_report.py
```

职责：

- 读取 baseline 目录和本次运行输出目录。
- 生成单文件 HTML 报告，便于用户人工审查。
- 展示每个 capture 的 baseline 图、本次测试图、差异图、state 摘要和检查结果。
- 展示日志契约结果，包括必需事件、禁止事件、忽略事件统计。
- 报告中只引用相对路径资源，便于直接打开本地 HTML 文件。

HTML 报告模板应包含：

- Summary：整体通过/失败、运行时间、数据集、viewer 命令、commit 信息。
- Log Contract：有效事件列表、缺失事件、禁止事件命中、被忽略日志数量。
- Capture Comparison：按 action 顺序展示 baseline、current、diff 三列。
- State Comparison：展示 camera、渲染开关、统计字段的 baseline/current 差异。
- Failure Details：失败断言、相关日志片段、对应截图链接。

报告输出路径：

```text
viewer_verify_output/1k/report.html
```

## 9. Pass Criteria

一次 1k interaction 验证通过必须满足：

- viewer 退出码为 0。
- `normalized_log.json` 满足 `log_contract.json`：
  - 必需事件全部出现。
  - 禁止日志模式没有命中。
  - 未识别日志没有超过允许阈值。
- 所有标准 capture 都生成 PNG 与 JSON。
- 所有 PNG 非空白。
- 缩放、倾斜、旋转截图相对前一阶段有可检测差异。
- reset 后 camera state 接近初始 state。
- 渲染统计没有出现明显异常，例如持续 0 三角形且画面无地形。
- `report.html` 生成成功，并能展示 baseline 与本次测试结果对比。

## 10. Baseline Update Policy

基线不是随意更新的普通测试快照。只有以下情况允许更新：

- 有意改变 viewer 渲染行为。
- 有意改变相机默认参数或交互语义。
- 数据集或 texture 资源发生确认过的变化。
- 容差策略经评审调整。

更新基线时必须在提交说明中写明：

- 为什么旧基线不再适用。
- 哪些截图或 state 发生变化。
- 哪些有效日志事件或日志契约发生变化。
- 差异是否符合预期。
- 是否影响 SDK 核心算法等价性判断。

## 11. Relationship to SDK Refactoring

本验证基线是 SDK 化改造前的第一道保护网。

SDK 改造过程中，每个关键步骤应至少运行：

```bash
scripts/verify_viewer_1k_smoke.sh
scripts/verify_viewer_1k_interaction.sh
```

当核心算法从 viewer 中抽离后，应继续补充不依赖 Qt/OpenGL 的 SDK 级测试，包括：

- terrain metadata 加载。
- 坐标转换。
- LOD/refinement 决策。
- patch/tile selection。
- texture layer 解析。

viewer baseline 用于验证端到端行为，SDK 测试用于验证核心算法等价性。两者互补，不能互相替代。
