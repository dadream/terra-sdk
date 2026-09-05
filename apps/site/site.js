(function () {
  'use strict'

  const storageKey = 'terra.siteLanguage'
  const catalog = {
    'language.label': ['语言', 'Language'],
    'nav.primary': ['主导航', 'Primary navigation'],
    'nav.home': ['Terra SDK 首页', 'Terra SDK home'],
    'nav.features': ['功能', 'Features'],
    'nav.quickstart': ['快速开始', 'Quickstart'],
    'nav.services': ['服务', 'Services'],
    'nav.downloads': ['下载', 'Downloads'],
    'nav.license': ['协议', 'License'],
    'nav.globe': ['球面演示', 'Globe Demo'],
    'nav.planar': ['平面演示', 'Planar Demo'],
    'common.developerPreview': ['开发者预览版', 'Developer Preview'],
    'common.checksumPending': ['校验和随 Release 一同发布。', 'Checksum is published with the release.'],
    'common.footer': ['面向原生、Web 和微信小程序的轻量级地形可视化。', 'Lightweight terrain visualization for native, Web, and Mini Program hosts.'],

    'home.title': ['Terra SDK | 轻量级地形可视化', 'Terra SDK | Lightweight terrain visualization'],
    'home.description': ['Terra SDK 是面向原生、Web 和微信小程序的轻量级 C++14 与 WebAssembly 地形可视化运行时。', 'Terra SDK is a lightweight C++14 and WebAssembly terrain visualization runtime for native, Web, and WeChat Mini Program applications.'],
    'home.hero.frameTitle': ['Terra SDK 交互式地球', 'Interactive Terra SDK globe'],
    'home.hero.summary': ['紧凑的地形运行时，让同一套 CBDAM 核心从原生应用运行到 Web 与微信小程序。', 'A compact terrain runtime that carries one CBDAM core from native applications to the Web and WeChat Mini Programs.'],
    'home.hero.globe': ['体验球面地形', 'Explore globe'],
    'home.hero.planar': ['打开平面演示', 'Open planar demo'],
    'home.cap.eyebrow': ['一套运行时，三类终端', 'One runtime, three surfaces'],
    'home.cap.title': ['只在视口需要的位置呈现地形细节', 'Terrain detail where the viewport needs it'],
    'home.cap.body': ['CBDAM 细化、层级影像和确定性相机状态保持平台无关；应用只需提供渲染、传输和交互适配器。', 'CBDAM refinement, hierarchical imagery, and deterministic camera state remain platform-neutral. Applications supply only rendering, transport, and interaction adapters.'],
    'home.cap.planar.title': ['平面与球面', 'Planar and globe'],
    'home.cap.planar.body': ['使用同一套公开 Viewer 门面加载本地地形仓库与全球大地坐标数据集。', 'Use the same public viewer facade for local terrain repositories and global geodetic datasets.'],
    'home.cap.imagery.title': ['渐进式影像', 'Progressive imagery'],
    'home.cap.imagery.body': ['根节点优先覆盖和有界细化，让更清晰的瓦片到达前地表始终可见。', 'Root-first coverage and bounded refinement keep the surface visible while sharper tiles arrive.'],
    'home.cap.core.title': ['可移植核心', 'Portable core'],
    'home.cap.core.body': ['C++14 库与版本化 C ABI 不依赖 Qt、OpenGL、网络和操作系统。', 'C++14 libraries and a versioned C ABI avoid Qt, OpenGL, network, and operating-system dependencies.'],
    'home.cap.observe.title': ['可观测行为', 'Observable behavior'],
    'home.cap.observe.body': ['结构化相机、地形、纹理、缓存和帧状态，让集成问题可诊断。', 'Structured camera, terrain, texture, cache, and frame state make integration failures diagnosable.'],
    'home.packages.eyebrow': ['Release 产物', 'Release artifacts'],
    'home.packages.title': ['选择宿主，保持统一模型', 'Choose the host. Keep the model.'],
    'home.packages.native.kind': ['原生', 'Native'],
    'home.packages.native.title': ['C++14 与 C ABI', 'C++14 and C ABI'],
    'home.packages.native.body': ['包含静态核心、编解码、帧和 C API 库，以及 CMake 包元数据与可运行的 C/C++ 示例。', 'Static core, codec, frame, and C API libraries with CMake package metadata and working C/C++ examples.'],
    'home.packages.native.action': ['下载原生包', 'Download native package'],
    'home.packages.web.kind': ['跨端 UI', 'Portable UI'],
    'home.packages.web.title': ['Web 与小程序', 'Web and Mini Program'],
    'home.packages.web.body': ['包含 WebAssembly 核心、WebGL 渲染器、交互运行时、CommonJS 模块和 TypeScript 声明。', 'WebAssembly core, WebGL renderer, interaction runtime, CommonJS modules, and TypeScript declarations.'],
    'home.packages.web.action': ['下载 Web 包', 'Download Web package'],
    'home.workflow.eyebrow': ['集成路径', 'Integration path'],
    'home.workflow.title': ['从软件包到第一帧', 'From package to first frame'],
    'home.workflow.load': ['加载', 'Load'],
    'home.workflow.load.body': ['选择数据集清单和影像配置。', 'Choose a dataset manifest and an imagery profile.'],
    'home.workflow.create': ['创建', 'Create'],
    'home.workflow.create.body': ['实例化 ABI，并传入宿主 Canvas 与请求适配器。', 'Instantiate the ABI and pass the host canvas and request adapter.'],
    'home.workflow.control': ['控制', 'Control'],
    'home.workflow.control.body': ['使用相机、交互、POI、路线和生命周期 API。', 'Use camera, interaction, POI, route, and lifecycle APIs.'],
    'home.workflow.observe': ['观测', 'Observe'],
    'home.workflow.observe.body': ['通过结构化状态判断就绪，而不是猜测等待时间。', 'Gate readiness with structured state instead of timing guesses.'],
    'home.workflow.action': ['阅读快速开始 →', 'Read the quickstart →'],
    'home.services.eyebrow': ['评估基础设施', 'Evaluation infrastructure'],
    'home.services.title': ['公开地形与影像端点', 'Public terrain and imagery endpoints'],
    'home.services.body': ['托管的 1k 平面地形、全球地形、Blue Marble 与天地图代理可用于 SDK 评估。这些是参考服务，不提供生产 SLA。', 'The hosted 1k planar terrain, global terrain, Blue Marble, and Tianditu proxy endpoints are available for SDK evaluation. They are reference services, not a production SLA.'],
    'home.services.action': ['查看服务端点', 'View service endpoints'],
    'home.services.terrain': ['地形', 'Terrain'],
    'home.services.terrain.value': ['PS 1k + 全球大地坐标', 'PS 1k + global geodetic'],
    'home.services.imagery': ['影像', 'Imagery'],
    'home.services.imagery.value': ['PS 分块 + NASA Blue Marble', 'PS tiles + NASA Blue Marble'],
    'home.services.proxy': ['代理', 'Proxy'],
    'home.services.proxy.value': ['带版权标识的天地图影像瓦片', 'Tianditu image tiles with attribution'],
    'home.open.eyebrow': ['开源方向', 'Open source direction'],
    'home.open.title': ['采用之前，先检查软件包边界。', 'Inspect the package boundary before you adopt it.'],
    'home.open.body': ['Terra SDK 是多协议代码库。每个 Release 都包含上游声明、包清单、校验和与 SPDX 2.3 发布记录。', 'Terra SDK is a multi-license codebase. Every release includes upstream notices, package inventories, checksums, and an SPDX 2.3 release record.'],
    'home.open.get': ['获取 v0.1.0', 'Get v0.1.0'],
    'home.open.license': ['查看许可协议 →', 'Review licensing →'],

    'services.title': ['评估服务 | Terra SDK', 'Evaluation Services | Terra SDK'],
    'services.eyebrow': ['公开评估基础设施', 'Public evaluation infrastructure'],
    'services.heading': ['地形与影像服务', 'Terrain and imagery services'],
    'services.intro': ['使用这些端点即可评估 Terra SDK，无需自行部署数据仓库。服务为尽力而为的测试基础设施，不提供生产可用性或数据保留 SLA。', 'Use these endpoints to evaluate Terra SDK without provisioning a repository. The service is best-effort test infrastructure and has no production availability or retention SLA.'],
    'services.planar.kind': ['平面地形', 'Planar terrain'],
    'services.planar.body': ['CBDAM 地形仓库及配套分块影像。', 'CBDAM terrain repository and matching tiled imagery.'],
    'services.planar.action': ['打开平面演示 →', 'Open planar demo →'],
    'services.globe.kind': ['球面地形', 'Globe terrain'],
    'services.globe.title': ['全球大地坐标', 'Global geodetic'],
    'services.globe.body': ['由 SRTM 派生的 CBDAM 记录，用于全球地形评估。', 'SRTM-derived CBDAM records for global terrain evaluation.'],
    'services.globe.action': ['打开球面演示 →', 'Open globe demo →'],
    'services.open.kind': ['开放影像', 'Open imagery'],
    'services.blue.body': ['公开球面配置默认使用的全球影像。', 'Global imagery used as the default public globe profile.'],
    'services.attribution.blue': ['版权标识：影像：NASA Blue Marble。', 'Attribution: Imagery: NASA Blue Marble.'],
    'services.proxy.kind': ['代理影像', 'Proxied imagery'],
    'services.tianditu.body': ['服务端保护访问凭据并缓存成功瓦片。应用必须保留可见的天地图版权标识，并遵守服务商条款。', 'The server keeps its credential private and caches successful tiles. Applications must preserve the visible Tianditu attribution and comply with provider terms.'],
    'services.attribution.tianditu': ['版权标识：© 天地图。', 'Attribution: © 天地图.'],
    'services.tianditu.action': ['使用天地图打开球面演示 →', 'Open globe demo with Tianditu →'],
    'services.origins.title': ['备案期间的访问地址', 'Origins during filing'],
    'services.origins.body': ['备案完成前使用临时地址 http://49.233.185.96；域名解除拦截后使用 https://terra.tapirs.top。浏览器演示采用同源 URL，不会为临时 HTTP 访问降低 SDK 安全策略。', 'The temporary pre-filing origin is http://49.233.185.96. After the domain filing block is removed, use https://terra.tapirs.top. The browser demos use same-origin URLs, so no SDK security policy is weakened for temporary HTTP access.'],
    'services.use.title': ['合理使用', 'Responsible use'],
    'services.use.body': ['请勿批量下载公开测试数据、将端点作为 CDN 使用或嵌入服务商凭据。生产环境应部署独立的地形服务和影像策略。自动化测试结束时必须停止轮询并关闭浏览器上下文。', 'Do not bulk-download the public test datasets, use the endpoints as a CDN, or embed provider credentials. For production, deploy your own terrain service and imagery policy. Automated tests must stop all polling and close their browser contexts when validation completes.'],
    'services.footer': ['用于 SDK 评估的参考基础设施。', 'Reference infrastructure for SDK evaluation.'],

    'downloads.title': ['下载 | Terra SDK', 'Downloads | Terra SDK'],
    'downloads.heading': ['经过验证的 Release 软件包', 'Verified release packages'],
    'downloads.intro': ['完整通过原生、服务、Wasm、浏览器、打包与零警告门控后，产物会作为不可变的 GitHub Release 资产发布。', 'Downloads are published as immutable GitHub Release assets after the complete native, service, Wasm, browser, package, and warning gates pass.'],
    'downloads.native.kind': ['Linux 原生', 'Linux native'],
    'downloads.native.body': ['头文件、静态库、CMake 导出、示例、文档和许可声明。', 'Headers, static libraries, CMake exports, examples, documentation, and license notices.'],
    'downloads.archive': ['下载归档', 'Download archive'],
    'downloads.web.kind': ['Web 与小程序', 'Web and Mini Program'],
    'downloads.web.title': ['Wasm 与宿主运行时', 'Wasm and host runtime'],
    'downloads.web.body': ['Wasm 模块、浏览器/小程序运行时、WebGL 渲染器、声明、文档和许可声明。', 'Wasm module, browser/Mini Program runtime, WebGL renderer, declarations, documentation, and license notices.'],
    'downloads.metadata.title': ['Release 元数据', 'Release metadata'],
    'downloads.metadata.body': ['从同一 Release 下载 SHA256SUMS、release_manifest.json 和 terra-sdk-0.1.0.spdx.json。在文档化的小程序真机验收完成前，首个 Release 保持预发布状态。', 'Download SHA256SUMS, release_manifest.json, and terra-sdk-0.1.0.spdx.json from the same release. The first release remains a prerelease until the documented Mini Program device acceptance is signed off.'],
    'downloads.release': ['打开 GitHub Release', 'Open GitHub Release'],
    'downloads.guide': ['集成指南 →', 'Integration guide →'],
    'downloads.footer': ['带校验和与清单的确定性软件包。', 'Deterministic packages with checksums and inventories.'],

    'quickstart.title': ['快速开始 | Terra SDK', 'Quickstart | Terra SDK'],
    'quickstart.eyebrow': ['快速开始', 'Quickstart'],
    'quickstart.heading': ['集成经过验证的软件包边界', 'Integrate the verified package boundary'],
    'quickstart.intro': ['请从带 Tag 的归档开始，而不是复制源代码模块。Release 包含完整示例、CMake 元数据、运行时声明、校验和及许可声明。', 'Start from a tagged archive rather than copying source modules. The release contains complete examples, CMake metadata, runtime declarations, checksums, and notices.'],
    'quickstart.native.intro': ['解压原生归档，并让 CMake 指向其安装包目录。', 'Extract the native archive and point CMake at its installed package directory.'],
    'quickstart.native.body': ['稳定的 C 边界使用 Terra::c_api，仓库解码使用 Terra::codec。可运行的 C 与 C++ 消费端示例安装在 share/doc/TerraSdk/examples。', 'Use Terra::c_api for the stable C boundary or Terra::codec for repository decoding. Working C and C++ consumers are installed under share/doc/TerraSdk/examples.'],
    'quickstart.web.title': ['Web 与小程序', 'Web and Mini Program'],
    'quickstart.web.intro': ['跨端归档包含 wasm/terra_sdk.wasm、utils/ 中的 CommonJS 运行时模块和 terra_viewer.d.ts。宿主创建 Wasm 模块，提供 Canvas 与请求适配器，然后构造 TerraViewer。', 'The portable archive contains wasm/terra_sdk.wasm, CommonJS runtime modules in utils/, and terra_viewer.d.ts. The host creates the Wasm module, supplies a canvas and request adapter, then constructs TerraViewer.'],
    'quickstart.web.body': ['通过 viewer.interaction 绑定指针或触控事件；通过 viewer.camera 提供确定性控制；并将 viewer.resize、pause、resume 与 destroy 接入宿主生命周期。', 'Bind pointer or touch events through viewer.interaction, use viewer.camera for deterministic controls, and call viewer.resize, pause, resume, and destroy with the host lifecycle.'],
    'quickstart.verify.title': ['验证下载内容', 'Verify the download'],
    'quickstart.verify.body': ['release_manifest.json 提供 ABI 与包身份，SPDX JSON 清单提供 Release 校验和与许可上下文。', 'Read release_manifest.json for ABI and package identity and the SPDX JSON inventory for release checksums and licensing context.'],
    'quickstart.download': ['下载 v0.1.0', 'Download v0.1.0'],
    'quickstart.footer': ['以软件包为起点，通过可观测运行时状态完成集成。', 'Package-first integration with observable runtime state.'],

    'license.title': ['许可协议 | Terra SDK', 'Licensing | Terra SDK'],
    'license.eyebrow': ['许可协议', 'Licensing'],
    'license.heading': ['多协议代码库，每次 Release 均有明确记录', 'A multi-license codebase, documented per release'],
    'license.intro': ['Terra SDK 不以单一协议或全 MIT 发行。重新分发或商业使用前，请检查归档中随附的准确许可声明。', 'Terra SDK is not presented as a single-license or all-MIT distribution. Review the exact notices shipped in the archive before redistribution or commercial use.'],
    'license.files.title': ['权威文件', 'Authoritative files'],
    'license.files.body': ['代码仓库及两个 SDK 软件包都包含 LICENSE、NOTICE、spacelib/COPYING 和 ratman/LICENSE。适用条款由这些文件而非本摘要定义。', 'The repository and both SDK packages include LICENSE, NOTICE, spacelib/COPYING, and ratman/LICENSE. Those files, not this summary, define the applicable terms.'],
    'license.evidence.title': ['Release 证据', 'Release evidence'],
    'license.evidence.body': ['每个带 Tag 的 Release 都发布确定性归档校验和、release_manifest.json 与 SPDX 2.3 JSON 清单。SPDX 清单记录包身份和校验和；尚未形成组件级结论的位置会明确使用 NOASSERTION。', 'Each tagged release publishes deterministic archive checksums, release_manifest.json, and an SPDX 2.3 JSON inventory. The SPDX inventory records package identity and checksums; it intentionally uses NOASSERTION where a component-wide conclusion has not been established.'],
    'license.data.title': ['托管数据与影像', 'Hosted data and imagery'],
    'license.data.body': ['地形数据集和托管影像属于评估基础设施，不包含在 SDK 归档中。NASA Blue Marble 与天地图各自有来源和版权要求；使用天地图的应用必须显示 © 天地图，并遵守服务商当前条款。', 'Terrain datasets and hosted imagery are evaluation infrastructure and are not part of the SDK archives. NASA Blue Marble and Tianditu have their own source and attribution requirements. Applications using Tianditu must display © 天地图 and follow the provider\'s current terms.'],
    'license.warranty.title': ['无服务保证', 'No service warranty'],
    'license.warranty.body': ['公开端点与开发者预览软件包仅供工程评估，不承诺生产服务等级。安全、可用性、数据权利和服务商凭据由应用所有者负责。', 'The public endpoints and Developer Preview packages are supplied for engineering evaluation without a production service-level commitment. Security, availability, data rights, and provider credentials remain application-owner responsibilities.'],
    'license.footer': ['请检查每个归档中随附的许可声明。', 'Review the notices included in each archive.'],

    'demo.title.globe': ['Terra 球面演示', 'Terra globe Demo'],
    'demo.title.planar': ['Terra 平面演示', 'Terra planar Demo'],
    'demo.viewer.globe': ['Terra 球面地形查看器', 'Terra globe viewer'],
    'demo.viewer.planar': ['Terra 平面地形查看器', 'Terra planar viewer'],
    'demo.controls': ['地形控制', 'Terrain controls'],
    'demo.pointer': ['指针模式', 'Pointer mode'],
    'demo.pan': ['平移控制', 'Pan controls'],
    'demo.zoom': ['缩放控制', 'Zoom controls'],
    'demo.view': ['视角控制', 'View controls'],
    'demo.move': ['平移', 'Move'],
    'demo.look': ['视角', 'Look'],
    'demo.planar': ['平面 1k', 'Planar 1k'],
    'demo.top': ['俯视', 'Top'],
    'demo.globe': ['全球', 'Globe'],
    'demo.reset': ['复位', 'Reset'],
    'demo.debug': ['调试', 'Debug'],
    'demo.imagery': ['影像', 'Imagery'],
    'demo.tianditu': ['天地图', 'Tianditu'],
    'demo.pan.left': ['向左平移', 'Pan left'],
    'demo.pan.right': ['向右平移', 'Pan right'],
    'demo.pan.up': ['向上平移', 'Pan up'],
    'demo.pan.down': ['向下平移', 'Pan down'],
    'demo.zoom.in': ['放大', 'Zoom in'],
    'demo.zoom.out': ['缩小', 'Zoom out'],
    'demo.rotate.left': ['逆时针旋转', 'Rotate counterclockwise'],
    'demo.rotate.right': ['顺时针旋转', 'Rotate clockwise'],
    'demo.north': ['北向上', 'North up'],
    'demo.toggleDebug': ['切换诊断信息', 'Toggle diagnostics'],
    'demo.status.initializing': ['初始化中', 'Initializing'],
    'demo.status.loading': ['加载中', 'Loading'],
    'demo.status.ready': ['就绪', 'Ready'],
    'demo.status.failed': ['失败', 'Failed'],
    'demo.frame': ['帧', 'frame'],
    'demo.patches': ['地形块', 'patches'],
    'demo.draws': ['绘制', 'draws'],
    'demo.textures': ['纹理', 'textures'],
    'demo.debug.modeLabel': ['模式', 'mode'],
    'demo.debug.transport': ['传输', 'transport'],
    'demo.debug.target': ['目标', 'target'],
    'demo.debug.range': ['距离', 'range'],
    'demo.debug.tilt': ['倾角', 'tilt'],
    'demo.debug.heading': ['方位', 'heading'],
    'demo.debug.terrain': ['地形', 'terrain'],
    'demo.debug.records': ['记录', 'records'],
    'demo.debug.failed': ['失败', 'failed'],
    'demo.debug.requests': ['请求', 'requests'],
    'demo.debug.geometry': ['几何', 'geometry'],
    'demo.debug.expected': ['预期', 'expected'],
    'demo.debug.missing': ['缺失', 'missing'],
    'demo.debug.omitted': ['省略', 'omitted'],
    'demo.debug.coverage': ['覆盖', 'coverage'],
    'demo.debug.roots': ['根节点', 'roots'],
    'demo.debug.imageryTarget': ['影像目标', 'imagery target'],
    'demo.debug.resolved': ['当前', 'resolved'],
    'demo.debug.exact': ['精确', 'exact'],
    'demo.debug.cache': ['纹理缓存', 'texture cache'],
    'demo.debug.presentation': ['呈现', 'presentation'],
    'demo.debug.fallback': ['回退', 'fallback'],
    'demo.debug.loading': ['加载中', 'loading'],
    'demo.debug.direct': ['直接', 'direct'],
    'demo.debug.ipAdapter': ['同源 IP 适配器', 'same-origin IP adapter']
  }

  let language = normalizeLanguage(readStoredLanguage())

  function normalizeLanguage(value) {
    return value === 'en' ? 'en' : 'zh-CN'
  }

  function readStoredLanguage() {
    try {
      return window.localStorage.getItem(storageKey)
    } catch (_) {
      return null
    }
  }

  function storeLanguage(value) {
    try {
      window.localStorage.setItem(storageKey, value)
    } catch (_) {
      // A blocked storage API must not prevent language switching.
    }
  }

  function t(key) {
    const value = catalog[key]
    if (!value) return key
    return value[language === 'en' ? 1 : 0]
  }

  function applyTranslations(root) {
    root.querySelectorAll('[data-i18n]').forEach((element) => {
      element.textContent = t(element.dataset.i18n)
    })
    for (const attribute of ['title', 'aria-label', 'content']) {
      const dataName = `i18n${attribute.split('-').map((part) =>
        part.charAt(0).toUpperCase() + part.slice(1)).join('')}`
      root.querySelectorAll(`[data-i18n-${attribute}]`).forEach((element) => {
        element.setAttribute(attribute, t(element.dataset[dataName]))
      })
    }
    document.documentElement.lang = language
    document.querySelectorAll('[data-language]').forEach((button) => {
      button.setAttribute('aria-pressed',
        button.dataset.language === language ? 'true' : 'false')
    })
    document.querySelectorAll('.language-switcher').forEach((element) => {
      element.setAttribute('aria-label', t('language.label'))
    })
  }

  function languageSwitcher() {
    const group = document.createElement('div')
    group.className = 'language-switcher'
    group.setAttribute('role', 'group')
    for (const option of [['zh-CN', '中文'], ['en', 'EN']]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.language = option[0]
      button.textContent = option[1]
      button.addEventListener('click', () => setLanguage(option[0]))
      group.appendChild(button)
    }
    return group
  }

  function setLanguage(value, persist) {
    const next = normalizeLanguage(value)
    if (persist !== false) storeLanguage(next)
    const changed = next !== language
    language = next
    applyTranslations(document)
    if (changed) {
      window.dispatchEvent(new CustomEvent('terra-language-change', {
        detail: { language }
      }))
    }
  }

  function installSwitcher() {
    const target = document.querySelector('.site-header') ||
      document.querySelector('.viewer-tools')
    if (target && !target.querySelector('.language-switcher')) {
      target.appendChild(languageSwitcher())
    }
  }

  function assignRelease(release) {
    document.querySelectorAll('[data-release-version]').forEach((element) => {
      element.textContent = release.version
    })
    document.querySelectorAll('[data-release-url]').forEach((element) => {
      element.href = release.releaseUrl
    })
    document.querySelectorAll('[data-release-asset]').forEach((element) => {
      const kind = element.dataset.releaseAsset
      const filename = kind === 'native' ? release.native : release.miniprogram
      element.href = `${release.downloadRoot}/${filename}`
    })
    document.querySelectorAll('[data-checksum]').forEach((element) => {
      const checksum = element.dataset.checksum === 'native'
        ? release.nativeSha256 : release.miniprogramSha256
      element.textContent = checksum || t('common.checksumPending')
    })
  }

  function loadRelease() {
    if (!document.querySelector(
      '[data-release-version], [data-release-url], [data-release-asset]')) return
    fetch('/assets/release.json', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Release metadata HTTP ${response.status}`)
        }
        return response.json()
      })
      .then(assignRelease)
      .catch(() => {
        document.documentElement.dataset.releaseStatus = 'unavailable'
      })
  }

  window.TerraSiteI18n = {
    get language() { return language },
    setLanguage,
    t
  }

  installSwitcher()
  applyTranslations(document)
  loadRelease()
  window.addEventListener('storage', (event) => {
    if (event.key === storageKey) setLanguage(event.newValue, false)
  })
})()
