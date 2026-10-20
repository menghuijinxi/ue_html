# UE 5.8 场景在浏览器运行：方案调研与实施建议

当前方案筛选请查看 [免费浏览器方案专项调研](UE58_FREE_BROWSER_RESEARCH.md)，其范围为浏览器本地运行、无需购买商业 Web SDK。本文保留先前的全路线对比作为背景资料。

调研日期：2026-10-13，Asia/Hong_Kong。

目标：评估 `menghuijinxi/UnrealEngine-1` 的 `html` 分支，寻找让 UE 5.8 场景在网页运行的现成方案，重点判断浏览器本地执行的可行性、版本兼容和维护成本。

本文区分三类证据：实际读取的 Git 源码、官方/供应商文档、基于这些证据的工程判断。未编译引擎，未打包或运行用户场景，也未独立复现供应商的性能指标。

## 1. 建议

**如果这个 `html` 分支的目标是把 UE 真正编译到浏览器，优先验证 SimplyStream 的 UE 5.8 WebAssembly/WebGPU 引擎分支。它已经提供可获取的引擎和平台代码，但关键 WebGPU 模块是专有预编译对象，不是完全可自行维护的源码方案。** [S1][S2]

**如果首先需要可靠交付“打开网页就能进入现有 UE 场景”，优先考虑 Pixel Streaming。** UE 程序在本地工作站或云 GPU 上运行，浏览器通过 WebRTC 接收画面并回传输入；这条路线保留原有 UE 运行环境，但需要承担渲染服务器和网络成本。[S3][S4]

如果只是建筑、商品或展厅展示，可以使用 UE glTF 导出器加 Three.js 等网页渲染器。它适合资产展示，但不会自动运行原有 UE 蓝图和游戏逻辑。[S10][S11]

**暂不建议从 UE 4.27 HTML5 分支直接移植到 UE 5.8.3，作为第一实施路线。** 旧项目可以参考，但版本、渲染接口和平台构建系统差异意味着需要持续维护一个新平台，而不是增加一个打包选项。此处属于工程判断；旧方案的实际支持范围是 UE 4.27.2 / 4.24.3。[S9]

## 2. 你的分支实际情况

通过 Git 读取到：

| 检查项 | 结果 |
| --- | --- |
| 仓库 | `https://github.com/menghuijinxi/UnrealEngine-1.git` |
| 分支 | `html` |
| HEAD | `396c9f059903aed5fec78ecd3d437a40c6415368` |
| HEAD 提交日期 | 2026-09-22 |
| HEAD 提交说明 | `5.8.3 release` |
| `Engine/Build/Build.version` | **5.8.3** |
| 平台扩展目录 | 没有 HTML5 / SimplyStream 平台 |
| Runtime 目录 | 没有 WebGPURHI 模块 |
| 已有插件 | PixelStreaming、PixelStreaming2、GLTFExporter |

证据：对该提交执行 `git show` 和 `git ls-tree`，检查版本文件、平台目录、UnrealBuildTool 平台目录、Runtime 和插件目录。

全树文件名搜索确实找到了一些第三方库中的 `wasm`、`emscripten`、`webgpu` 文件，例如 SDL、HarfBuzz、IREE 的依赖。**这些文件不构成 UE 场景的网页打包平台。** `WebBrowser` 模块也不能据此当作 Web 导出支持。

所以这个分支当前只是 UE 5.8.3 的起点，还没有发现完整的浏览器打包链。

本地 `H:\ue_html` 调研开始时为空。为核对源码，创建了两个浅克隆并稀疏检出少量文件：

- `reference-engine`：你的 `html` 分支。
- `reference-simplystream`：SimplyStream 的 `5.8` 分支。

没有运行 `Setup.bat`，没有下载完整引擎依赖，没有修改引擎源文件，也没有产生或推送提交。

## 3. 路线对比

下表“成熟度”是本次调研判断，不是供应商认证。

| 路线 | UE 在哪里执行 | 对已有场景的复用 | 成熟度判断 | 主要代价 |
| --- | --- | --- | --- | --- |
| 官方 Pixel Streaming，自行部署 | 工作站 / 云 GPU | 高，保留 UE 运行时 | 优先交付路线 | GPU、带宽、会话调度和运维 |
| Arcware Cloud | 托管 GPU | 高 | 官方兼容表明确支持 UE 5.8 | 平台费用、部署区域、并发容量 |
| Eagle 3D Streaming | 托管 GPU | 高，但需匹配插件 | 有详细文档，存在 PSP2 消息通信限制 | 插件选择、平台费用 |
| SimplyStream WebGPU SDK | 用户浏览器 | 目标是保留 UE 运行时，项目需验证 | 原生路线首选试验对象 | 定制引擎、专有模块、版本绑定 |
| UnrealTwin 原生 UE 5.8 运行时 | 用户浏览器 | 供应商称可运行复杂 UE 系统 | 新候选，需逐项目评估 | 尚未核实可自行接入的完整 SDK |
| UE glTF 导出 + Three.js | 用户浏览器 | 复用资产，重写交互 | 资产展示路线可用 | 材质转换、画面差异、逻辑重写 |
| SpeculativeCoder HTML5 ES3 | 用户浏览器 | 基于 UE4 工程 | 旧版本参考方案 | 不直接支持 UE 5.8 |

证据来源：[S1] 至 [S11]。对于托管服务，“支持 UE 5.8”不意味着用户自定义引擎、插件和每项业务交互均已通过测试。

## 4. 原生浏览器执行：SimplyStream

### 为什么优先研究它

供应商提供 `SimplyStreamSDK/UnrealEngine` 的 `5.8` 分支，文档说明通过 Epic 的 GitHub 访问资格获取。浏览器端使用 WebAssembly 和 WebGPU；引擎新增 `SimplyStream` 目标平台。[S1][S2]

本次已实际拉取和检查，而不只阅读宣传页面：

| 检查项 | 本次结果 |
| --- | --- |
| HEAD | `21532881dd4ae4ccb5611bd7f9d8fe97e82c38d6` |
| 提交日期 | 2026-07-21 |
| 提交说明 | `SimplyStream 5.8 SDK: official UE 5.8 + WebGPU platform` |
| `Build.version` | **5.8.1** |
| 平台目录 | `Engine/Platforms/SimplyStream` |
| 构建工具 | `SimplyStreamToolChain.cs` |
| RHI / Shader 模块 | WebGPURHI、WebGPUShaderFormat |
| SDK 配置版本 | Emscripten `4.0.22` |
| 内存配置 | 默认 `Memory64_Emulated` |
| 着色器路径 | WebGPU SM5、WebGPU ES31 |
| 核心交付形式 | 树中含预编译模块对象；文档明确为专有模块 |

配置文件描述了 HLSL → DXC → SPIR-V → Tint → WGSL 的编译链。平台配置里已有 Nanite、Lumen 等能力开关；同时可见光线追踪、路径追踪能力关闭。**配置声明不是运行验证，不能据此承诺桌面 UE 的所有画面特性在浏览器可用。**

以上是对该 Git 提交中配置、构建脚本和文件树的直接观察。

### 对你的 5.8.3 分支意味着什么

你的分支是 **5.8.3**，供应商当前可拉取快照标识为 **5.8.1**。文档要求预编译 WebGPU 模块与对应引擎修订一致，不应混用不同引擎树。[S2]

因此，初次验证应使用供应商完整的对应引擎快照和一个独立小项目。不要先把其平台目录复制进你的 5.8.3 分支，就假设能构建。

需要弄清：

1. 是否已有准确匹配 UE 5.8.3 的模块包，或有受支持的升级方法。
2. 若必须修改 RHI、Shader 编译器或相关 UE 接口，能否获得源码或供应商重新编译支持。
3. 是否允许把构建产物部署在自己的域名、服务器或 CDN。
4. 运行时哪些资源服务是可选的，是否存在必须连接供应商后台的组件。
5. 能否明确列出目标浏览器、操作系统、GPU 和插件的支持范围。

供应商首页表示浏览器本地 WebGPU 渲染没有按分钟渲染费用，但这不能直接当作自建部署权、资源托管费和企业支持条款的结论。[S1]

### 打包和部署的关键点

这是新增平台目标，不是把 Windows 的 `.exe` / `.pak` 上传到网页就能执行。

供应商文档里的 UBT 示例只说明构建 `SimplyStream` 目标；完整产物仍须验证 Cook、Stage、Package 和部署流程。[S2]

平台默认开启多线程。Emscripten 的浏览器线程依赖 SharedArrayBuffer 和正确的 COOP / COEP 头，因此正式部署必须验证 HTTPS、跨源资源策略以及嵌入页面环境。[S12]

示意头配置：

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

这不是所有部署环境都可直接照抄的完整配置。跨域 CDN、iframe、身份认证和资源缓存需结合实际页面验证。

浏览器适配还需检查输入、音频启动、存档、资源加载和所有依赖原生平台 API 的插件。不能用一个供应商样例的成功替代真实场景验收。

## 5. 原生浏览器执行：UnrealTwin

UnrealTwin 在 **2026-10-08** 发布文章，称已将 UE 5.8 Game Animation Sample 编译到 WebAssembly/WebGPU，包含动画和物理等运行系统；文章同时说明现有项目仍需要底层适配。[S8]

需要区分它的两类产品方向：

- 建筑、数字孪生等静态环境：其页面描述 Gaussian Splatting 转换。
- 游戏、动画、物理和逻辑：新文章描述真正的 UE 原生浏览器运行时。

不能把静态场景转换服务等同于完整 UE 项目的网页打包服务。[S8]

**判断：作为第二原生候选跟进。** 本次未核实到可自行拉取、构建并部署任意 UE 5.8.3 项目的完整 SDK、版本兼容矩阵和维护机制。文章中的性能与启动指标未独立测试，不作为项目预算依据。

## 6. 交付路线：Pixel Streaming

### 官方自建

结构：

```text
UE 5.8 场景 -> Win64 / Linux 应用 -> GPU 渲染和视频编码
                                     |
                                  WebRTC
                                     |
                                   浏览器
                                     |
                            输入 / 自定义消息回传
```

浏览器无需执行完整 UE 引擎，UE 应用仍在服务器运行。支持网页端键盘、鼠标、触屏等输入，也可结合自定义网页 UI。[S3]

官方 PixelStreamingInfrastructure 仓库已经有 **UE5.8** 分支，并在版本表中标为 Current。应使用对应版本，不直接选 `master`。Epic 文档也明确要求按引擎版本匹配基础设施。[S4][S5]

你的 5.8.3 源码包含 PixelStreaming2，插件描述中的 `IsBetaVersion` 为 `false`。对于新建且自行部署的项目，建议先验证 Pixel Streaming 2；已有旧插件集成或托管平台则按其兼容要求选择。

正式部署还要处理 NAT 穿透、STUN / TURN、会话启动与回收、容量和监控。多名用户观看同一应用实例，不等于每人拥有独立视角与逻辑状态；独立交互会话通常需要独立应用实例或专门的多用户架构。具体 GPU 可承载数量必须用实际场景测量。[S3]

### 托管平台

| 平台 | 核实到的证据 | 建议 |
| --- | --- | --- |
| Arcware Cloud | 官方版本表明确将 UE 5.8 标为 Active / Latest | 托管方案优先试用对象 |
| Eagle 3D Streaming | 文档支持 UE 5.7 及更新版本的 PSP2；PSP1 支持 UE 5.1 及更新版本 | 重点测试网页与 UE 双向通信 |
| PureWeb | 有 UE5 云串流产品资料 | 本次未核实 UE 5.8.3 / PSP2 最新兼容表，列为备选 |

来源：[S6][S7][S13]。

**Eagle 的关键限制：** 其截至本次调研的文档表示，PSP2 支持基本串流，但不支持网页与 UE 的自定义消息通信；有这类需求时建议 PSP1。该限制是对 Eagle 集成的描述，不能推广成 Epic 的 Pixel Streaming 2 一律没有消息通信能力。[S7]

选托管平台时，用相同场景和相同网络验证画质、控制延迟、独立并发会话、双向业务消息和目标地区访问；先测再计算费用。

## 7. 资产展示路线与旧 HTML5 方案

### UE glTF + Three.js

UE 官方 glTF 导出器支持关卡、网格、材质和部分动画内容；Three.js 提供 GLTFLoader。[S10][S11]

适合商品、建筑、展厅、旋转查看、选中热点和简单配置器。

glTF 是场景数据格式，不是 UE 可执行格式。复杂 UE 材质需要转换或烘焙；网页交互需要重新实现，原有 UE 蓝图、物理和业务逻辑不会因导出 glTF 而自动运行。[S10]

### SpeculativeCoder / UnrealEngine HTML5

SpeculativeCoder 的项目实际支持 UE 4.27.2 + WebGL2，以及 UE 4.24.3 + WebGL1，使用 Emscripten 编译到 WebAssembly；移动端支持仍带实验性质。[S9]

可以参考平台初始化、打包、资源加载、输入和 WebSocket 集成方式。对你的 5.8.3 分支，它是移植参考，不是可直接安装的插件。

## 8. 建议的下一步

### 如果目标是开发 `html` 原生打包分支

1. 在独立项目中使用 SimplyStream 对应引擎快照，先验证基础场景。
2. 完成 Development 和 Shipping 的构建、Cook、打包和浏览器部署。
3. 确认没有服务器端 UE 渲染实例，浏览器实际加载并执行 WASM/WebGPU。
4. 依次加入蓝图交互、UMG、音频、碰撞/物理、骨骼动画和业务插件。
5. 再加入真实场景的复杂材质、Nanite、Lumen、地形和流送等依赖。
6. 解决 5.8.3 模块兼容与自建部署问题后，再决定是否合入 `html` 分支。

这里没有建议将生产项目回退到 5.8.1。旧快照仅用于独立可行性试验；用户生产项目的升级/回退另需验证。

### 如果目标是先把现有场景交付到网页

1. 用你现有 5.8.3 分支打包 Win64 / Linux，并启用合适的 Pixel Streaming 插件。
2. 用官方 UE5.8 基础设施完成局域网验证。
3. 用同一产物试验 Arcware 或其他托管服务。
4. 验证真实网络、网页业务消息、独立并发和持续运行成本。

### 首轮验收记录

| 指标 | 记录方式 |
| --- | --- |
| 构建能否重现 | 固定引擎提交、SDK、项目和完整日志 |
| 原生还是串流 | 原生记录 WASM/WebGPU 执行；串流记录服务器与 WebRTC 链路 |
| 首次进入场景 | 冷缓存 / 热缓存分别测量，记录网络与设备 |
| 性能 | 相同视角的帧时间、内存、显存和稳定性 |
| 功能 | 输入、音频、UMG、物理、动画、消息、存档逐项验证 |
| 浏览器 | 按目标平台分别测 Chrome / Edge、Firefox、Safari 和移动设备 |
| 部署 | 自有域名、CDN、iframe、跨源资源和断线恢复 |
| 成本 | 原生资源传输/支持费；串流 GPU、带宽、TURN 和并发 |

尚缺用户真实 `.uproject`、场景内容、插件清单、目标设备和并发目标，因此当前结论是路线筛选，不是该场景已经能运行的验证结果。

## 9. 来源

访问日期均为 2026-10-13；版本和产品限制可能继续变化。

- [S1] SimplyStream 官方产品与引擎入口：<https://simplystream.com/>
- [S2] SimplyStream 官方构建文档，重点看 “SimplyStream Engine SDK”：<https://simplystream.com/docs/build-guides>
- [S2-Git] 已实际读取的引擎分支：<https://github.com/SimplyStreamSDK/UnrealEngine/tree/5.8>
- [S3] Epic Pixel Streaming 概览：<https://dev.epicgames.com/documentation/unreal-engine/overview-of-pixel-streaming-in-unreal-engine?lang=en-US>
- [S4] Epic 官方服务器与前端仓库：<https://github.com/EpicGames/PixelStreamingInfrastructure>
- [S5] Epic Pixel Streaming 2 概览与版本匹配说明：<https://dev.epicgames.com/documentation/en-us/unreal-engine/pixel-streaming-2-overview-in-unreal-engine>
- [S6] Arcware 官方引擎支持矩阵，本次通过其公开 Markdown 文档核实：<https://docs.arcware.cloud/unreal-engine-setup/unreal-engine-version-support.md>
- [S7] Eagle 插件兼容表，页面注明更新日期 2026-10-01：<https://learn.eagle3dstreaming.com/wiki/plugin-compatibility>
- [S8] UnrealTwin 原生 UE 5.8 文章，发布日期 2026-10-08：<https://www.unrealtwin.com/blog/unreal-engine-5-8-running-natively-in-browser>
- [S8-Product] UnrealTwin 产品页：<https://www.unrealtwin.com/>
- [S9] SpeculativeCoder HTML5 ES3 项目及限制：<https://github.com/SpeculativeCoder/UnrealEngine-HTML5-ES3>
- [S10] Epic glTF 导出内容和材质限制：<https://dev.epicgames.com/documentation/en-us/unreal-engine/how-the-gltf-exporter-handles-unreal-engine-content>
- [S11] Three.js GLTFLoader：<https://threejs.org/docs/pages/GLTFLoader.html>
- [S12] Emscripten Pthreads 与 COOP/COEP 要求：<https://emscripten.org/docs/porting/pthreads>
- [S13] PureWeb UE5 产品资料，未用来断言 UE 5.8.3 兼容：<https://www.pureweb.com/news-updates/instantly-deliver-unparalleled-immersive-experiences-with-unreal-engine-5-and-pureweb/>
- [User-Git] 已实际读取的用户分支：<https://github.com/menghuijinxi/UnrealEngine-1/tree/html>

本地可复查的主要文件：

- `reference-engine/Engine/Build/Build.version`
- `reference-engine/Engine/Plugins/Media/PixelStreaming2/PixelStreaming2.uplugin`
- `reference-simplystream/Engine/Build/Build.version`
- `reference-simplystream/Engine/Platforms/SimplyStream/Config/DataDrivenPlatformInfo.ini`
- `reference-simplystream/Engine/Platforms/SimplyStream/Config/BaseSimplyStreamEngine.ini`
- `reference-simplystream/Engine/Platforms/SimplyStream/Config/SimplyStream_SDK.json`
- `reference-simplystream/Engine/Platforms/SimplyStream/Source/Runtime/WebGPURHI/WebGPURHI.Build.cs`
- `reference-simplystream/Engine/Platforms/SimplyStream/Source/Developer/WebGPUShaderFormat/WebGPUShaderFormat.Build.cs`
