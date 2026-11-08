# Nanite WebGPU 接入记录

更新：2026-11-08。已完成可见性 RDG、深度/HZB 消费、真实资产驻留页转码与几何解码，
已增加显式 Web Cook 数据保留入口、Cook 资源序列化/重载，以及实际运行时 uploader
的 Web 转码调度适配与原生 Dawn RHI 验证。现已在浏览器线程版 UE 中完成
Cook 资源反序列化、生产 shader map 加载、实际 uploader 执行与 GPU 回读验证。
现已接通显式 Web 常驻 StreamingManager 的注册、层级安装及资源生命周期，
并继续接入静态网格初始化与 Deferred Renderer 的逐帧资源更新。
真实场景剔除输出现已增加固定不透明 VS/PS 消费接口，直接解码常驻 Nanite 页，
写入离屏打包可见性缓冲，并验证覆盖、深度和实例归属。
随后增加默认关闭的场景深度接入，复用原有深度导出 PS，将解析后的 Nanite
可见性与真实普通网格预深度合并；同时修正可见性 ID 的 8 位打包布局。
现已让光栅消费原有 8 字节可见 cluster 记录，填入当前 GPUScene 实例偏移，
并增加胜出像素的位置、法线、UV0、顶点色和相对材质槽解码；预深度输出保存于
RDG blackboard，后续阶段可复用同一份几何与可见性。这仍是材质输入准备，
尚未执行 UMaterial 图或写入 Nanite GBuffer。
这还不是完整 Nanite 支持，当前发布场景仍走既有网格路径。

## 已实现

- 在参考引擎 `NaniteWritePixel.ush` 增加
  `COMPILER_WEBGPU && WEB_NANITE_PACKED_VISIBILITY` 分支。
  只支持非调试的颜色可见性写入，每像素保持完整 32 位 ID 和 32 位深度位模式。
- 可见性目标使用每元素 8 字节的结构化缓冲区。
  写入期间为 `atomic<vec2<u32>>`，结束后可作为 `uint2` 只读结构化缓冲区消费。
  这不是 R64_UINT 纹理模拟，也没有把深度和 ID 拆成两个独立的原子竞争。
- 不读取正在原子写入的目标；`EarlyDepthTest` 保留深度钳制，略过可选的提前拒绝。
  最终可见性仍由整体原子最大值确定。
- 新增像素坐标、零宽度、缓冲区行容量检查；先除后乘，避免线性地址溢出。
- 原生与浏览器 RHI 仅在适配器提供时申请 `atomic-vec2u-min-max`。
  加载需要该扩展的着色器时检查设备特性，缺失则明确失败。
- 更新 Web ShaderFormat 缓存版本，接入本地 Cook 着色器覆盖审计。
  安装目录 `H:/UE_5.8` 未修改。
- Renderer 的 `FRasterParameters` 绑定打包原子缓冲与尺寸；Web 颜色可见性上下文
  分配 8 字节结构化缓冲，光栅阶段结束后解析成 `RG32_UINT` 纹理。
  主光栅和后续光栅分别插入解析，供中间 HZB 与最终深度/材质消费者使用。
- 新增矩形清理与解析 compute shader。清理只改指定矩形；解析保留 ID/深度全部位，
  缓冲不足一行的区域填零。纹理输出声明为只写，避免浏览器拒绝 RG32_UINT 的
  read-write 存储纹理访问。
- Web Nanite 编译使用 UE 已有的 `uint2` 型 `UlongType` 和打包函数，
  局部关闭 Vulkan 的通用 uint64 图像原子声明；`DEPTH_ONLY` 保留原来的独立分支。
  可见性阶段 ShaderFormat 缓存版本为 v30；当前驻留页阶段为 v31。

## 真实资产驻留页

新增 `WebNaniteAssetProbe`：在隔离宿主中复制
`/Engine/BasicShapes/Sphere.Sphere` 到 transient package，开启 Nanite、设置全驻留预算和
8 位位置精度，再调用 UE 自身的静态网格构建流程。原始资产不保存、不修改。
导出器检查 fixup magic、页边界、cluster 数和零外部依赖，输出磁盘页、安装表及
独立的原网格三角形参考数据。当前 fixture 是 1 个根页、15 个 cluster，
其中 8 个完整精度叶 cluster、960 个叶三角形；计入粗 LOD 共 1,842 个三角形，
页中含 431 个引用顶点。

实际执行链路为：

```text
UE StaticMesh / NaniteBuilder
  -> 根页去除 fixup 前缀，保留原始磁盘压缩数据
  -> NaniteTranscode.usf::TranscodePageToGPU（独立阶段）
  -> NaniteTranscode.usf::TranscodePageToGPU（引用顶点阶段）
  -> NaniteDataDecode.ush 的 GetCluster / DecodeTriangleIndices / DecodePosition
  -> GPU 回读逐三角形核对 + 叶三角形诊断绘制
```

2026-11-06 的数据是编辑器导出的全驻留测试数据。默认 Web Cook 仍剥离 Nanite；
2026-11-07 新增的显式数据保留模式见下一节，没有开启全局 Nanite。
页面中的球体采用诊断材质和展开后的三角形绘制，尚未使用 Nanite 光栅器、
cluster 层级剔除、原始 Lit 材质或默认示例关卡。

`NaniteTranscode.usf` 仅在 Web 分支移除屏障前的 lane 提前退出，以及引用数量为零的
提前退出；其他平台保留原实现。Web 调度必须保证工作组不大于设备最小 subgroup，
本测试使用 32 线程并检查 `subgroupMinSize >= 32`，不满足即拒绝。
尚未验证可变 subgroup 的其他 GPU。2026-11-07 已将这一限制接入 UE streaming uploader，
调度验证及剩余边界见后文。

固定版本 Tint 库提供 `allow_non_uniform_subgroup_operations`，其 CLI 尚未暴露。
新增 `tint_nanite.exe` 使用同版库，将原算法活跃 lane 前缀扫描和末尾不满 wave 的操作
保留为 WGSL `diagnostic(off, subgroup_uniformity)`。ShaderFormat 只对精确路径
`/Engine/Private/Nanite/NaniteTranscode.usf` 调用此工具；缺失时编译失败。
工作组屏障一致性校验仍启用，其他 shader 继续使用原转换流程。

| 驻留页验证 | 结果 |
| --- | --- |
| UE shader 编译 | 独立转码、引用转码、实际 UE 几何解码，共 3 个入口通过 |
| Chrome / Edge | 各 2 组：普通上传、256 字节视图偏移并拆分独立阶段批次；全部通过 |
| 原网格核对 | 每组完整核对 960 个叶三角形，按 1/256 单位量化，保留绕序和重复计数 |
| 引用阶段 | 431 个引用顶点；第二阶段补写 5,922 个非零差异字节，不能被省略 |
| 缓冲边界 | 输入和前后保护区未改变；额外工作组无越界写入 |
| 跨浏览器一致性 | 两浏览器、两批次方式的 32,768 字节 GPU 页完全一致 |
| 诊断出图 | 512×512 目标覆盖 104,388 像素；桌面与窄视口截图人工检查通过 |
| 转换器策略 | 5 项测试通过，包括拒绝非一致屏障、截断输入和缺失参数 |
| 回归 | 可见性/深度/HZB 各浏览器 16 组、原生 RHI 两模式各 7 项通过 |

Chrome `157.0.8103.39`、Edge `157.0.4341.42` 均在 NVIDIA/Ampere 硬件适配器上运行，
subgroup 最小/最大均为 32，没有附加实验特性开关。
窄视口截图仍来自桌面 GPU，不代表移动端支持或性能。
首次未限制 CPU 亲和性的浏览器运行报告 GPU 实例失效；沿用 affinity 3 后一键流程通过，
当前仅记录此宿主限制，未确定故障原因。未做性能测量。

结果与源文件哈希记录在
`tests/web-platform/evidence/nanite-asset-20261106.json`。
原始页、packet、WGSL、反射和截图在忽略目录 `tests/web-platform/results/nanite-asset`。

## 2026-11-07：Cook 数据保留与重载

`DoesTargetPlatformSupportNanite` 增加仅编辑器使用的 `-WebNaniteCookData` 分支，
要求目标 `IniPlatformName=Web` 且包含 `SF_WEBGPU_SM5`。这使原有静态网格构建和
`FResources::Serialize` 能保留真实 Nanite 数据，不改变运行时/Shader 平台准入。
普通 Web Cook、ES3.1 和 NullRHI 保持剥离。现有 Web 目标不剥离 fallback mesh。

正常 Cook 脚本 `cook-web-engine.ps1` 新增 `-NaniteCookData` 开关，仅接受 WebGPU-SM5，
将选择记入 Cook 报告并转发给 UE。开关不强制将普通资产转换为 Nanite，不把流送资产
改成全驻留，也不保证已有资产的所有特性可在 Web 运行。

本次验证使用原 `Sphere` 的 transient 副本，经 UE NaniteBuilder 构建后，调用真正的
`FResources::Serialize`，传入真实 Web Cook 目标、Cook 上下文和 editor-only 过滤。
随后反序列化并重新序列化，检查字节一致、根页不变及 cluster/层级数量。
浏览器使用**重载后的资源**导出页并执行原有 UE 转码和几何解码 shader。

| 检查 | 结果 |
| --- | --- |
| SM5 默认、ES3.1 带开关、NullRHI 带开关 | 均剥离；序列化 126 字节，0 根页数据/cluster/层级节点 |
| SM5 显式保留 | 序列化 20,306 字节；根页 19,916 字节；15 cluster、1 层级节点；往返字节一致 |
| 原生构建 | 宿主/ShaderFormat 25 个动作、隔离 RenderCore 8 个动作通过；安装目录输入哈希未变 |
| Tint 策略 | 5 项通过，保留非一致屏障拒绝检查 |
| Edge GPU 回读 | 普通上传与 256 字节偏移/分批上传均通过；每组完整核对 960 个叶三角形及绕序 |
| 引用转码和边界 | 引用阶段补写 5,922 字节；输入与保护区不变；零 GPU 校验错误 |

当前机器为 Edge `156.0.4314.58`、NVIDIA/Lovelace、非 fallback，subgroup min/max=32。
Chrome 未安装，本次没有 Chrome 复测；这不是前文 2026-11-06 的 Ampere/双浏览器环境。
此阶段只需要 subgroups，不使用打包可见性原子；通过不代表 Edge 156 能运行完整 Nanite 光栅器。
GPU 页 SHA-256 为 `81a72778b57a0bbdedb3e8d23eae40d43aef90fa81b02d7f0c73a2b141f22c95`。

新增独立 `.tools/ue58-nanite-cook-host`，同时注册 SM5/ES3.1，保留已存在的渲染宿主配置。
主机选择、完整日志、源码/资源/packet 哈希在 `tests/web-platform/evidence/nanite-cook-20261107.json`。
复现（按本机安装位置调整 `-Engine`）：

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
./tests/web-platform/probe-nanite-cook.ps1 -Engine D:/UE_5.8 -BrowserChannels msedge
# 已构建可加 -SkipBuild；默认 BrowserChannels 要求 Chrome 与 Edge 均通过。
node tests/web-platform/collect-nanite-cook-evidence.cjs <本次输出目录>/results.json
```

前提是现有 SM5 Cook host 和平台映射构建文件已准备。Tint 支持头可以离线预置到
`tests/web-platform/build/tint-nanite/support/src/utils/compiler.h`，仅 SHA-256 与固定版本
匹配时复用；下载与校验要求没有放宽。

此阶段验证的是 Cook **资源序列化**与重载后的 GPU 几何链路，尚未运行完整关卡 Cook、
打包加载或浏览器内 UE Nanite Renderer。下节继续接入运行时 uploader 的工作组约束
及 RHI 设备能力；层级 LOD/剔除、Nanite 光栅、原材质及缺页流送仍未完成。

## 2026-11-07：运行时页上传调度

参考引擎的 `NaniteStreamingPageUploader.cpp` 现在为 Web 桌面平台单独编译
`GROUP_SIZE=32` 的独立/引用两阶段转码 permutation。该入口不依赖完整 Nanite
或通用 wave 平台声明，ES3.1 不准入。运行时要求设备已启用 subgroups、最小宽度
至少 32、最大宽度不小于最小宽度；控制台覆盖只接受 0（自动）或 32，否则明确失败。
Web 的 32 是工作组大小，不是请求固定 wave 宽度，故最小 subgroup 为 64 的设备
不会被原生 wave precache 策略误排除；这类设备目前仅验证选择策略，未实机验证。

共享 WebGPURHI 初始化从适配器查询 subgroup 范围，并检查设备实际获授的
`Subgroups` 特性，再填写 `GRHISupportsWaveOperations` 与最小/最大 wave 宽度。
Web uploader 关闭 async compute，沿用原有独立阶段、依赖拓扑排序、引用阶段的
RDG 调度和参数绑定。`bSupportsNanite`、uint64 原子及通用 Wave 的 DDPI 声明未开启。

新增 `WebNaniteUploaderRHIProbe`，直接编译参考引擎 uploader 源码，只重命名两个
类和控制台变量前缀以便与安装版 Engine DLL 共存。测试使用真正的 GlobalShader
参数元数据、`Init` / `Add_GetRef` / `ResourceUploadTo`、RDG 和 WebGPURHI，
没有用手写绑定或测试 dispatch 代替 uploader。生成源码和参与构建的文件均记录哈希。
测试模块提前到 `PostConfigInit` 注册 shader，并在工作区暂存 Dawn host DLL。

| 检查 | 结果 |
| --- | --- |
| 工作组/平台策略 | 21 项通过；含无 subgroups、下限不足、非法覆盖、可变宽度及 SM5/ES3.1 permutation |
| UE RDG + 原生 Dawn | recorded/bypass 各 4 组，共 8 组通过，零 GPU 校验错误 |
| 普通与偏移上传 | 目标偏移 0 / 256 字节，各执行独立与引用两次 dispatch；保护区不变 |
| 依赖排序 | 两个真实根页添加合成依赖边，先提交子页；执行 3 次 dispatch，覆盖非零引用阶段 cluster 起点 |
| 缓冲生命周期 | 同一 RDG 图分两次上传执行 4 次 dispatch；跨图复用及空批次检查通过 |
| GPU 内容 | 共 12 份 32,768 字节页与浏览器 Cook 页转码结果逐字节一致 |
| Wasm64 编译 | 实际 Engine uploader 与 BrowserDynamicRHI 两个对象编译通过；未重新链接运行包 |
| Cook/浏览器回归 | 4 种 Cook 保留策略与 Edge 的 2 组页转码/几何解码通过，每组核对 960 个叶三角形 |

本次原生设备为 RTX 4090 / Dawn D3D12，subgroup min/max=32；浏览器报告
Edge `157.0.4341.42` / Lovelace，版本已不同于前节较早的 Cook 验证。页哈希仍为
`81a72778b57a0bbdedb3e8d23eae40d43aef90fa81b02d7f0c73a2b141f22c95`。
合成依赖只验证排序及调度，不等于验证真实跨页顶点引用或流送 fixup。
本次没有重复前一机器的 Chrome、可见性原子和深度/HZB 验收。

工作区 Engine 覆盖准备和链接前审计均纳入 uploader 源文件，安装目录未修改。
证据为 `tests/web-platform/evidence/nanite-uploader-20261107.json`；原生输出位于
`results/nanite-uploader`，独立 Wasm 编译输出位于 `results/nanite-uploader-wasm`。
复现时先运行前节 Cook 验证，再执行：

```powershell
./tests/web-platform/probe-nanite-uploader.ps1 -Engine D:/UE_5.8 -CookedAsset <Cook输出目录>/sm5-retained
$env:UE_ENGINE_ROOT='D:/UE_5.8/Engine'
node tests/web-platform/compile-web-nanite.cjs --uploader
node tests/web-platform/collect-nanite-uploader-evidence.cjs <Uploader输出目录>/verified.json <Cook输出目录>/results.json
```

Uploader 的 `-SkipBuild` 要求已有构建记录，且源码、生成源码和 DLL 哈希均一致。
Wasm 检查要求先准备线程版引擎的 UBT 响应文件。此阶段证据是原生 Dawn 上的
实际 uploader 加浏览器 shader 回归；后续浏览器 UE 执行见下一节。

## 2026-11-07：浏览器 UE 资源加载与实际页上传

新增显式 `WebNaniteUploaderTest` 诊断 RPC，浏览器从 UE 内容文件系统读取
20,306 字节的 `resources.cooked.bin`，使用真正的 `Nanite::FResources::Serialize`
反序列化，检查根页、页边界、fixup magic 和零流送依赖，再把压缩页交给 Engine
模块原有的 `FStreamingPageUploader`。没有重命名或复制浏览器中的 uploader 实现，
也没有由 JavaScript 手写转码 dispatch。

原生导出器新增生产类型 `FTranscodePageToGPU_CS` 的 global shader map section，
用 Web Cook 目标布局序列化两阶段 shader 及参数绑定。诊断打包器将此 section
合入已有 shader map，并将 Cook 资源放入项目 Content 路径。浏览器通过 UE 原有
global shader archive 加载、检查和实例化它，随后执行 RDG 上传及异步 GPU 回读。

| 浏览器检查 | 结果 |
| --- | --- |
| 普通根页上传 | 2 次实际 WebGPU dispatch，完整 GPU 页一致 |
| 256 字节目标偏移 | 2 次 dispatch，前后保护区不变 |
| 两根页的合成依赖排序 | 子页先提交，3 次 dispatch，两页均一致 |
| 同一 RDG 图重复上传 | 4 次 dispatch，两页均一致；随后执行空批次 |
| 汇总 | 4 组通过、6 份 32,768 字节页逐字节一致，零 GPU 校验错误 |
| shader 实际加载 | 两个 WGSL 入口均为 32 线程，代码哈希与此前独立 shader 验证一致 |
| 场景继续运行 | 测试后继续推进帧，结束时为第 108 帧；未进行画质或性能验收 |
| 原生回归 | recorded/bypass 共 8 组、21 项策略、12 份页均通过，并成功导出 Cook shader section |

设备为 Edge `157.0.4341.42`、NVIDIA/Lovelace、非 fallback，subgroup min/max=32。
6 份 GPU 页的 SHA-256 仍为
`81a72778b57a0bbdedb3e8d23eae40d43aef90fa81b02d7f0c73a2b141f22c95`。

本次重编译 uploader 所在 Engine unity、整个 WebGPURHI 模块和诊断入口，再用已有
线程版 UE 对象链接到独立目录。构建脚本会审计共享 RHI 头文件并一起重编译所有
相关对象，避免新旧资源布局混用；此问题曾在纹理初始化时触发访问断言。
普通构建脚本也在跳过宿主准备时刷新并审计 uploader 覆盖。
本次不是干净的全量 UBT 构建，安装引擎未修改。

测试使用现有 `villa-default-20261107` 的匹配 Cook 包。历史默认关卡包缺少当前
Renderer 要求的半透明光照 shader，不能与本次运行时直接组合。浏览器使用独立的
工作区持久配置目录，避免完整场景缓存超过临时上下文配额；没有放宽资源或 GPU 校验。
场景本身继续使用既有网格路径，Nanite fixture 仅验证页上传。

证据：`tests/web-platform/evidence/nanite-browser-uploader-20261107.json`。
复现需要前节已通过的 Cook 资源、匹配场景包、既有线程版 UBT 响应文件及对象：

```powershell
./tests/web-platform/probe-nanite-uploader.ps1 -Engine D:/UE_5.8 -CookedAsset <Cook输出目录>/sm5-retained
node tests/web-platform/build-web-nanite-runtime.cjs
node tests/web-platform/package-web-nanite-runtime.cjs <Uploader输出目录>
# 在另一终端运行 node tests/web-platform/serve.cjs，使用 localhost:8765。
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/verify-web-nanite-uploader.cjs
node tests/web-platform/collect-nanite-browser-evidence.cjs
```

本机验证沿用 CPU affinity 3。完整原生构建与浏览器日志、编译对象、链接输入、
Cook shader section、资源和 GPU 页哈希均有记录。尚未把 Nanite 静态网格组件接入
场景。当时尚未执行 StreamingManager；下节记录本轮常驻资源注册与层级安装，
完整流送生命周期仍未接通。

## 2026-11-07：Web 常驻 StreamingManager 与层级安装

在原 `FStreamingManager` 中增加显式 `ConfigureWebResidentResources` 和
`AddWebResidentResource` 入口，默认实例继续遵循原平台条件。常驻模式仅接受
Web SM5、实际 wave 下限至少 32 的设备；根页预算受实际非类型化 buffer 上限约束。
它从一页开始增长，使用原来的分配器、资源 ID 版本、根页 uploader、hierarchy fixup、
scatter upload 和安装／卸载通知，不创建 512 MB 默认流送池或缺页反馈缓冲。
不含根页、含流送页、重复注册、页池超预算或层级缓冲超设备上限的资源在分配前拒绝。

新增 `WebNaniteResourcesTest`，在浏览器 UE 的渲染线程里创建独立的两根页管理器。
输入仍是真正 Cook 后经 `FResources::Serialize` 重载的 Sphere。GPU 回读比较完整根页，
并把 Cook 原始层级按资源根页位置重定位后，与 GPU hierarchy 逐字节比较。管理器自身
仍使用原始 Engine 实现；JavaScript 仅发诊断 RPC、观察 dispatch 和检查回读。

| 浏览器生命周期检查 | 结果 |
| --- | --- |
| 首个资源安装 | 根页池 32,768 字节、层级池 256 字节；15 clusters、4 个层级引用正确 |
| 第二个资源触发扩容 | 根页池 65,536 字节、层级池 512 字节；已有页和层级完整保留 |
| 移除后复用槽位 | 根页索引 0、层级偏移 0 复用；资源 ID 从 0 更新为 131072；第二个资源保持不变 |
| 移除与取消 | 两个卸载通知、无新增安装通知、无活动资源，层级深度归零；待安装资源可取消 |
| 拒绝策略 | 零／越界池预算、初始化后重配置、含流送页资源、重复注册和资源超预算均拒绝 |
| GPU 回读 | 5 份根页与既有黄金数据逐字节一致；5 份有效层级切片各 240 字节全部一致 |
| 回归和运行状态 | 原 4 组 uploader、4 步生命周期全部通过，零 GPU 错误，测试结束为第 161 帧 |

设备仍为 Edge `157.0.4341.42`、NVIDIA/Lovelace、subgroup min/max=32。
生命周期四步实际转码 dispatch 数为 `2、2、2、0`，额外清零和 hierarchy scatter
使用正常 UE 全局 shader；没有把这些 dispatch 计入转码数量。

首次运行暴露了 pooled buffer 中未被 bitstream writer 覆盖的填充位及页尾旧内容，
完整页哈希因此不同。常驻模式现在只在安装前清零新根页，不清理已有资源；扩容保留旧页
和槽位复用同时检查这一边界。取消未安装资源也会扣除待上传 hierarchy 大小。

构建脚本刷新并审计 StreamingManager 的源文件与公共头，重编译所在 Engine unity，
加入生命周期诊断对象。新字段位于类末尾，保留已有字段偏移；此次仍是隔离增量诊断链接，
不是全量 UBT 重建。正常构建入口同样同步上述覆盖，安装引擎未修改。

证据：`tests/web-platform/evidence/nanite-browser-residency-20261107.json`。
复现沿用上一节的构建、打包和验证命令；验证器现在先执行原 4 组 uploader 回归，再执行
常驻管理器生命周期。此前 uploader 证据保留为历史记录。

上述阶段只把资源注册进独立的真实 StreamingManager。当时普通静态网格组件尚未自动注册，
场景也没有启用 Nanite Renderer。cluster 层级剔除、光栅、Lit 材质、实际流送页依赖、
缺页请求、淘汰与设备恢复仍待实现；没有全场景或性能验收结论。

## 2026-11-08：静态网格资源自动注册与逐帧更新

增加启动选项 `-WebNaniteResidentResources`，让全局 `GStreamingManager` 在 Web SM5
和实际 wave 能力满足条件时进入常驻模式。`-WebNaniteRootPages=N` 指定根页预算，
默认 1024 页（32 MB 上限，按需增长）；设备上限或预算不满足时保留关闭状态。
此选项仍要求包内有可用的 Nanite Cook 数据和转码 global shader section。
当前普通打包器尚未自动生成这一 section，诊断打包器负责合入。
Web 启动程序会重建 UE 命令行，本轮同时补齐这两个选项的解析与转发，并校验页预算。

`UStaticMesh::InitResources -> FStaticMeshRenderData::InitResources -> FResources::InitResources`
现在会自动注册符合条件的常驻资源，`ReleaseResources` 负责排队释放。注册仍是资产级，
多个组件共享同一份页和层级数据。Web 分支在渲染线程设置资源哈希，避免同一游戏线程
tick 内释放／重新初始化时，被先排队的释放命令清掉新哈希。

Deferred Renderer 在每帧维护常驻管理器，独立于完整 Nanite 光栅开关；更新在进入深度
预通道之前成对完成，覆盖仅深度输出的提前返回路径。当前没有 Nanite 光栅消费者，
因此此模式每帧消费并丢弃修改通知，避免卸载通知长期累积。

常驻模式保留根页压缩数据和 CPU 层级，以支持同一网格释放后重新上传和重定位。
这是额外 CPU 内存成本；本次没有实现设备丢失后的恢复。完整平台原有释放策略不变。

新增 `WebNaniteSceneTest`：把真实 Cook Sphere 资源放进一个 transient UStaticMesh，
以此前导出的 960 个原始三角形创建普通 fallback，并注册两个共享它的真实
StaticMeshComponent。测试只读取全局管理器的状态和 GPU 数据，不手动调用 Add、
BeginAsyncUpdate 或 EndAsyncUpdate。组件代理仍走普通网格绘制。

| 静态网格生命周期 | 结果 |
| --- | --- |
| 两组件共享网格并重复初始化 Nanite 资源 | 两个实际 scene proxy、一个资源 ID、两次转码 dispatch |
| 注销其中一个组件 | 一个 proxy，资源 ID 保持 0，无额外转码 |
| 注销全部组件并释放网格资源 | 零 proxy、全局管理器无资源、层级深度归零 |
| 同帧初始化／释放／再初始化 | 两个 proxy 恢复，资源 ID 更新为 262144，两次转码 dispatch |
| 再次完整释放 | 零 proxy、无活动资源、层级深度再次归零 |
| GPU 数据 | 3 次有效状态各核对 32,768 字节页和 240 字节层级，全部与黄金数据／重定位结果一致 |
| 汇总与清理 | 原有 8 项加新增 5 项全部通过；测试组件已销毁，清理后场景推进至第 201 帧 |
| 默认关闭回归 | 同一运行时关闭常驻选项后推进至第 10 帧；诊断入口拒绝启用、零转码 dispatch |

设备为 Edge `157.0.4341.42`、NVIDIA/Lovelace、subgroup min/max=32。
本次没有未捕获 GPU 错误、Fatal 或断言；但开启与关闭常驻选项的两次启动均有
**834 条 PSO 预缓存创建失败日志**。这些失败另行保存，不纳入“零未捕获 GPU 错误”
的表述，也没有据此宣称整个运行包渲染通过。后续完整 Cook／渲染验收仍须排查。

运行时构建的 fallback 明确填写存在标记及 UV 密度元数据，并保留顶点和索引 CPU 数据，
满足 UE 创建代理和重新初始化普通渲染资源的要求。这个测试条件不能推广为所有 Cook
网格都能在 CPU 数据释放后直接重新创建其 fallback 缓冲。

证据：`tests/web-platform/evidence/nanite-browser-scene-resources-20261108.json`。
沿用前节构建、打包和浏览器验证命令。隔离增量构建还会重编译 NaniteResources 所在
Engine unity 和 DeferredShadingRenderer 所在 Renderer unity；不是全量 UBT 构建。

下一步仍需完整关卡 Cook／加载验收，以及 GPU 层级剔除、Nanite 光栅和材质连接。
本次 transient 资产生命周期验证不能代替 `.uasset` 包加载或完整 Nanite 场景验收。

## 常驻资源的 GPU 层级遍历与视锥剔除（2026-11-08）

新增引擎入口 `AddWebResidentHierarchyCullPasses` 和 `WebNaniteHierarchy.usf`。
它直接读取常驻管理器的页池和已完成 fixup 的层级缓冲，复用 UE 的
`GetHierarchyNodeSlice`、`GetCluster` 解码，输出最细层静态三角形 cluster 的
`page << 8 | cluster` 引用。当前筛选 `FULL_LEAF`，尚未选择屏幕误差 LOD。

调用者传入一个资源、一个根节点及六个向内的 mesh-local 视锥平面；实例变换必须
预先合入平面，包括平面的常数项。每层使用独立的 compute dispatch，在两个有界
节点队列之间交替，由 RDG 建立写入／读取依赖。没有跨工作组等待循环。
shader 使用六个 storage buffer、一个 uniform buffer、64 线程工作组和 32 位原子。
目前每层按资源的最大节点数调度，还没有接间接 dispatch 或多实例批处理。

CPU 在添加 pass 前检查页／层级范围、根节点、有限平面值和容量，并拒绝带偏移或
缩短范围的 SRV；此入口只接收完整 byte-address 缓冲视图。当前限制为
65,536 个节点、64 层、1,048,576 个可见 cluster。GPU 检查节点／页／cluster
引用、缺页、assembly／skinning、输出队列和深度预算。输出包含计数及错误位；
未来的绘制消费者必须在任何错误位非零时拒绝使用整份输出，不能把溢出结果当作
完整可见集。当前没有光栅消费者。

浏览器诊断在私有管理器的首次上传、扩容到第二页、移除／复用槽位后，以及全局
管理器的真实静态网格初始化、共享组件注销、释放后重新初始化后运行此入口。
常规用例始终直接读取管理器缓冲。多层遍历、循环引用、深度不足、非法节点、
skinning 和队列溢出使用明确标注的合成层级；真实 Sphere 的层级仍只有一层。
独立 JavaScript 校验器从 GPU 页的 packed cluster 字段计算可见集合和三角形数，
逐项比较 GPU 返回的引用，并检查未使用输出仍保留清理值。

| 最终浏览器检查 | 结果 |
| --- | --- |
| 剔除执行与回读 | 62 组检查通过，实际执行 67 次层级剔除 dispatch |
| 全部可见 | 8 个叶 cluster，960 个三角形 |
| 部分视锥／旋转平面 | 分别为 5 cluster／600 三角形、6 cluster／721 三角形，与独立 CPU 结果一致 |
| 恰好接触边界 | 保留 1 个 cluster、121 个三角形 |
| 完全在外／第六个面排除 | 零 cluster、零三角形 |
| 合成二层遍历及故障 | 二层输出一致；深度不足、非法节点、循环、skinning、队列溢出返回预期错误位 |
| 输出容量不足 | 保持边界内写入，报告完整候选数和溢出位 |
| CPU 输入拒绝 | 8 个资源生命周期状态共 88 次检查，包含非有限平面值、范围越界及局部 SRV |
| 既有回归 | 原有 13 项转码、驻留和共享静态网格生命周期检查通过 |
| 默认关闭回归 | 同一运行包关闭常驻选项后正常推进，零转码及零剔除 dispatch |

设备为 Edge `157.0.4341.42`、NVIDIA/Lovelace，非 fallback adapter。
没有未捕获 GPU 错误、Fatal 或断言。开启和关闭选项的启动中，此前的
**834 条 PSO 预缓存创建失败**均仍存在，
不属于本次已修复范围。完整场景渲染与光照验收仍未完成。
证据：`tests/web-platform/evidence/nanite-browser-hierarchy-20261108.json`。

新增 shader section 与原转码 section 一并合入诊断包。宿主 shader 类型需在
`PostConfigInit` 注册；普通打包器尚未自动生成这个完整的 Nanite shader 集合。
构建器增加逐对象成功校验记录，后续对象编译失败时可复用已验证产物。
输入、对象和日志哈希不匹配时仍会重编译。

复现（沿用上一节的真实 Cook 资产和 native uploader 输出）：

```powershell
./tests/web-platform/compile-nanite-hierarchy.ps1 -Engine D:/UE_5.8
node tests/web-platform/build-web-nanite-runtime.cjs
node tests/web-platform/package-web-nanite-runtime.cjs tests/web-platform/results/nanite-uploader/20261107-184920
node tests/web-platform/verify-web-nanite-uploader.cjs
node tests/web-platform/collect-nanite-browser-evidence.cjs
```

浏览器验证仍使用既有 localhost:8765 服务、Playwright 的 `NODE_PATH` 和宿主
affinity 3 配置。此步骤不是完整 UBT 重建，也没有重新 Cook 整个关卡。

本小节完成时入口仍由诊断调用；真实场景实例／视图的接入见下一节。
屏幕误差 LOD、可见集到 Nanite VS/PS 光栅和材质路径，以及 HZB、流送和完整默认
关卡验收仍待完成。

## 真实场景代理与视图的剔除调度（2026-11-08）

新增 `NaniteWebScene`：普通静态网格代理在创建渲染资源时登记常驻 Nanite 资源，
销毁渲染资源时移除登记。登记表只在渲染线程访问；组件共享同一资产时仍分别具有
组件 ID、实例变换和剔除输出，页池继续由资产共享。每帧重新读取运行时资源 ID
和根页地址，避免释放后使用旧页号。未携带 Nanite 数据的普通网格不会登记。

Deferred Renderer 在完成常驻管理器更新后，以当前主视图发起剔除。通过场景匹配、
show flags、`IsShown` 和 main-pass 状态筛选代理，读取代理当前 `LocalToWorld`。
从相机投影矩阵提取包含近面的视锥，在 double 精度下把平面拉回网格局部空间，
再转为 shader 的 float 参数。负缩放和非均匀缩放不需要求逆或重新归一化。
输出按视图保存在 RDG blackboard 的 `FWebSceneCullViews` 中，后续光栅消费者可以
取得带组件身份的 cluster 列表及错误状态。

没有消费者时，RDG 会裁掉这段 GPU 工作；当前普通网格 fallback 不依赖这些输出。
新增回读观察器消费 Renderer 真实产出的缓冲，观察器没有自行登记代理、准备视锥
或发起剔除。验证器独立变换每个叶 cluster 包围盒的八个角点，在齐次裁剪空间
检查六个边界，核对可见引用、三角形数量及未使用输出的清理值。

当前范围为单根、全常驻、不使用 WPO／displacement 的普通不透明静态三角形网格。
ISMC/HISMC、Spline、masked、骨骼／assembly 以及 stereo／capture 视图未接入。
此路径尚未接入普通渲染的全部距离/HLOD/自定义可见性策略；当前验证使用标准相机
投影，不涵盖另行指定的远裁剪面。也没有加入 LOD、HZB 或 Nanite 光栅消费者。

复现仍沿用上一节的构建、打包、浏览器验证和证据归档命令；现有 shader 不需要
重新编译。新的浏览器用例移动实际组件和 CameraActor，覆盖相机转向、正交投影、
镜像／旋转／非均匀缩放、隐藏、注销、重新注册及资产释放后重新初始化。

| 真实场景状态 | 浏览器 GPU 结果 |
| --- | --- |
| 两组件共享网格 | 同一资源 ID，各自输出 8 cluster／960 三角形 |
| 移动第二个组件到视锥外 | 第一个保持 8／960，第二个为零 |
| 第二个组件旋转、镜像和非均匀缩放后部分相交 | 第一个保持 8／960，第二个 6／721；与八角点独立验证一致 |
| 相机转向 180 度 | 两个组件均为零 |
| 切换正交投影 | 使用相机实际矩阵，两个结果均通过独立验证 |
| 隐藏第一个组件 | 此运行时移除其 scene proxy；登记数和输出数降为 1 |
| 再注销第二个组件 | 登记数和输出数归零，没有剔除 dispatch |
| 恢复显示并重新注册 | 两组件恢复且继续共享原资源 ID |
| 注销全部并释放资产 | 零登记、零输出、零剔除 dispatch |
| 同一资产重新初始化和组件重新注册 | 两组件恢复，资源 ID 从 393216 更新为 524288，输出正确 |

新增 10 个场景状态、15 组实例 GPU 输出，与原有 62 组有界剔除检查及 13 项资源
回归一起验证。原测试期间没有观察器消费的场景剔除 pass 被 RDG 裁掉；新增观察器
消费阶段实际执行 15 次剔除 dispatch，整个测试合计 82 次。测试结束移除观察器、
销毁测试网格与 CameraActor，并恢复此前的 view target。

最终 Edge/NVIDIA Lovelace 验证推进至第 396 帧；默认关闭运行推进至第 12 帧，
零转码、零剔除 dispatch。两次启动均无未捕获 GPU 错误、Fatal 或断言；两次仍各有
既有 834 条 PSO 预缓存失败日志，完整场景渲染和光照验收尚未通过。

证据：`tests/web-platform/evidence/nanite-browser-scene-culling-20261108.json`。
仍是隔离增量 Wasm 构建及既有 Cook 包，不是全量 UBT／完整关卡 Cook 验收。

## 下游接入

新增 `Engine/Public/Rendering/NaniteWebRaster.h::AddWebResidentRasterPasses`，
接受实际 `FWebSceneCullView`、目标尺寸和矩形视口。它使用全局 VS/PS，
直接读取剔除产生的 cluster key 和状态，调用原有 `GetCluster`、
`DecodeTriangleIndices`、`DecodePosition`，不上传 CPU 解码的顶点。
PS 调用原有 `NaniteWritePixel.ush` 打包原子分支；每像素输出
`uint2(ID, reversed-Z depth bits)`。固定光栅为双面不透明三角形，
不执行材质、背面剔除、WPO 或位移。无效的剔除状态整项拒绝绘制。
场景代理注册进一步排除任何透明混合材质及 Pixel Depth Offset；
每次 draw 明确设置矩形 scissor，结束时解除，避免继承其他 pass 的裁剪状态。

每项提交 `128` 个三角形、`MaxVisibleClusters` 个实例，GPU 退化多余顶点；
当前合计最多 `65,536` 个可见 slot，目标最多 `16,777,216` 像素。
这仍是有界固定 draw，没有 indirect draw 或微三角形 Compute 光栅优化。
CPU 先用 double 合成实例到裁剪空间的矩阵，再转为 float 上传。
每像素 ID 现在调用 UE 原有 `PackVisPixelX`，即
`((entryBase + visibleSlot + 1) << 8) | triangle`，
返回的 `ClusterBases` 与原剔除输出共同解释 ID。后续“可见记录与材质输入”阶段
补充了非扩展 `VisibleClustersSWHW` 布局；完整 GBuffer 所需的材质分桶、
primitive/material 绑定和 view 表仍未齐备。

浏览器验证通过现有场景观察者调用这个 Engine 接口并回读离屏缓冲。
主场景仍绘制 fallback mesh。测试包括透视、正交、镜像和非均匀缩放、
偏移视口、视锥裁剪、相机反转、组件隐藏/注销、资源重建、前后实例遮挡、
同深度 ID 排序、近裁剪面穿越、五种剔除错误位及单独的计数溢出。
独立 CPU 参考图从 Cook 前导出的原三角形生成，按记录的 8 位位置精度量化，
执行齐次六平面裁剪，并按本次 Windows/Edge D3D12 光栅的
[8 位亚像素坐标](https://learn.microsoft.com/en-us/windows/win32/direct3d12/constants)
量化屏幕顶点，再计算重心深度。逐像素比较覆盖、反向深度和实例，检查 ID 的 cluster/triangle
范围与视口外清零。覆盖差异只允许在 `0.02` 像素宽的边界带内，数量不得超过
参考覆盖的 `1%`（最少允许 4 像素）；内部深度误差上限为 `3e-5`。
每个非空结果必须有超过 `25%` 的覆盖像素参与内部深度和实例检查。
此参考图采用上述后端精度约定，尚未在其他浏览器后端验证。

着色器导出器使用同一 Engine 全局 shader 类型，新增 VS/PS 所在的第二个
shader-map section，打包时按真实 section 数合并。编译与证据审计包含新增
源码、完整 shader 快照、宿主 DLL、WGSL、Wasm、打包产物与 GPU 回读。

本轮浏览器回归覆盖 19 个场景/错误状态、33 次 VS/PS draw、6 项 CPU 输入拒绝；
连同已有 62 组层级检查，共观察到 100 次层级剔除 dispatch。默认关闭运行没有
转码、剔除或新增光栅调用。仍存在启用和关闭配置共有的 834 条既有 PSO
预缓存失败日志，完整场景光照验收仍未通过。
最终 Edge/NVIDIA Lovelace 运行推进至第 659 帧，默认关闭运行至第 12 帧，
无未捕获 GPU 错误、Fatal 或断言。19 组回读共覆盖 24,524 个像素，
覆盖差异为零；23,592 个内部像素完成深度与实例检查，最大深度误差
`4.363e-6`。仍使用隔离增量 Wasm 链接和既有 Cook 包，未做全量 UBT/关卡 Cook 验收。
证据：`tests/web-platform/evidence/nanite-browser-opaque-raster-20261108.json`，
同名 PNG 为离屏 GPU 可见性回读图。

### 场景深度接入

新增默认关闭的 `r.Nanite.WebResidentSceneDepth`。显式 Web 常驻模式下开启后，
Deferred Renderer 在普通网格预深度和速度 pass 后、scene depth resolve/HZB 前，
读取同一 RDG 图上的场景剔除结果，执行固定不透明光栅和 RG32_UINT 解析，
再调用 UE 原有 `NaniteExportGBuffer.usf::EmitSceneDepthPS`。该全局着色器关闭
速度、shading mask 和蒙皮 permutation，只依赖可见性纹理与矩形视口；
不需要尚未建立的生产材质表。Depth attachment 使用 load 和 reversed-Z
`greater-equal`，保留更近的普通网格深度，不修改 stencil。

接入原有消费者时修正了前一阶段的 ID 布局：此前自定义路径将三角形上限的
7 位与可见性像素的 8 位混用，独立回读虽通过，但原有 `UnpackVisPixel`
会错误解释 ID。现在 VS 调用同文件的 `PackVisPixelX`，CPU 回读按 8 位解释，
并直接通过原有 PS 做 GPU 集成验证；此前离屏证据保留为历史记录。

`NaniteWebDepth` 提供解析、depth export 和诊断快照接口。尺寸不匹配、
未产生的目标、空/越界视口、多重采样及错误纹理格式直接拒绝。
快照在真实 depth attachment 合并前后各采样一次，通过 RDG 的读写依赖保证顺序。
测试观察者只消费真实 Renderer 输出，不重新提交或替代深度导出。
五个场景状态覆盖普通网格在前/在后/部分交叠、隐藏 Nanite、隐藏普通网格；
Nanite fixture 保留真实资源和场景代理，但将 fallback section 的三角形数置零，
以确保新增深度来自 Nanite 页光栅。仅关闭组件 depth-pass 标记不足以隔离：
UE 的 `ShouldRenderInDepthPass()` 对 main-pass 网格仍返回 true。
普通遮挡物使用不带 Nanite 数据的常规静态网格，实际参与 UE 预深度 pass。

最终 Edge/NVIDIA Lovelace 回归通过，推进至第 1,429 帧；默认关闭运行至第 10 帧。
原有 19 组光栅检查和新增 5 组场景深度检查全部通过。每组在真实视口按 4 像素
步长采样 32,400 点，合计 162,000 点，合并结果与 `max(普通深度, Nanite深度)`
完全一致，最大误差为零；空可见性保留原深度位模式。

| 深度场景 | Nanite 覆盖采样点 | 普通网格胜出 | Nanite 胜出 |
| --- | ---: | ---: | ---: |
| 普通网格在前 | 453 | 390 | 63 |
| 普通网格在后 | 452 | 0 | 452 |
| 部分交叠 | 453 | 314 | 139 |
| 隐藏 Nanite | 0 | 原有 940 点保持不变 | 0 |
| 隐藏普通网格 | 454 | 合并前全部为零 | 454 |

五项非法深度输入被拒绝。恢复开关后连续 4 帧没有新增光栅、剔除或深度导出。
无未捕获 GPU 错误、Fatal 或断言；启用和关闭运行仍各有既有 834 条 PSO
预缓存失败日志。验证包含实际全局 shader-map 导出、增量 Wasm 链接和浏览器执行；
未重新 Cook 完整关卡。证据：
`tests/web-platform/evidence/nanite-browser-scene-depth-20261108.json`，
同名 PNG 展示普通预深度、Nanite 可见性深度及合并后的真实 scene depth。

开启此实验路径仍保留 fallback base-pass shading，几何差异可能造成材质和深度
不一致；尚不能作为完整关卡发布配置。后续已补齐非扩展可见 cluster 记录，仍需材质绑定、
Nanite GBuffer、速度/stencil 标记、LOD 与流送，再进行完整关卡画面对照。

### 可见记录与材质输入

`NaniteWebRaster` 在剔除与光栅之间增加 `PackVisibleCS`，调用 UE 原有
`PackVisibleCluster` 输出 8 字节记录。VS 改用原有 `GetVisibleCluster`，
不再单独从剔除 key 解释 page/cluster。记录使用硬件光栅标记、当前单视图的
view ID 0、`FPrimitiveSceneInfo::GetInstanceSceneDataOffset()` 提供的 GPUScene
实例偏移；每帧重新获取，避免组件重建后继续使用旧偏移。只接受单实例代理。
汇总表仍按 entry 容量预留，错误剔除状态、计数溢出及未使用 slot 均保持零。

特别区分两种页引用：层级 key 的 cluster 位宽为 8，而无流送池时原有
`PackPoolClusterRef` 的根页 cluster 位宽为 6。记录打包直接复用 UE 函数，
CPU 按原始位布局逐字段核对，包括跨 32 位边界的实例 ID 与已重定位的页号。
shader 明确关闭 assembly/voxel/curve permutation，并检查记录必须为非扩展布局；
这不是通用 12 字节扩展记录支持。

新增 `AddWebMaterialInputResolvePasses`，对每个有效可见性 ID 调用原有
`DecodeTriangleIndices`、`DecodePosition`、`GetRawAttributeData<3>`、
`CalculateTriangleBarycentrics` 和 `GetRelativeMaterialIndex`。输出为局部位置、
归一化局部法线、UV0、顶点色、GPUScene 实例 ID 和相对材质槽，使用透视正确插值。
这是有界诊断接口，按指定步长采样，最多 1,048,576 点，每点 64 字节；
未被调用时不执行属性解析。它没有 UMaterial 参数求值、世界空间切线基、纹理采样、
解析导数输出或 GBuffer 写入。当前真实球体 fixture 只有一个材质槽，不能据此
宣称多材质范围及任意材质图均已验收。

预深度阶段将原始可见性缓冲、可见记录、entry bases、视口和解析纹理保存到
`FWebSceneRasterViews`，其对象与资源均归本帧 RDG 管理。五组真实场景深度测试
检查它与正在导出的纹理、视图及视口一致；此处只建立复用接口，没有启用
后续 GBuffer pass。普通 fallback base pass 仍然存在。

浏览器回归新增逐字段记录检查，以及独立 CPU GPU 页属性解码：逐位读取索引、
位置、八面体法线、UV 压缩值、颜色及材质槽，再用双精度齐次方程求解重心坐标，
与 GPU 回读比较。原有来自非 Nanite 源网格的覆盖/深度参考继续保留，避免把
GPU 页解码本身当作几何正确性的唯一依据。测试沿用 19 个状态，包括透视/正交、
镜像和非均匀缩放、遮挡、同深度胜者、近裁剪面、隐藏/重建及六类剔除失败。
新增 2 项实例 ID 拒绝及 7 项材质输入接口拒绝检查。着色器归档现为 9 个入口、
5 个 section；新增两个 compute shader 使用实际 Engine 类型导出。

最终 Edge `157.0.4341.42` / NVIDIA Lovelace 回归通过：19 个状态共核对
134 条有效可见记录、1,569 个有效属性采样点和 24,081 个清零采样点，
记录生成与属性解析各执行 33 次 dispatch。局部位置最大误差 `2.301e-4`，
法线分量 `4.708e-6`、UV 分量 `1.092e-6`、颜色分量 `2.385e-7`；
相应容限为 `3e-4`、`1e-5`、`4e-6`、`1e-6`。相机进入网格的状态允许
整个采样视口被覆盖。五组实际深度合并的 162,000 点仍为零误差，
退出实验模式后连续 4 帧没有新增路径调用，默认关闭运行推进到第 12 帧。
无未捕获 GPU 错误、Fatal 或断言；启用与关闭配置仍各有既有 834 条 PSO
预缓存失败日志。仍是隔离增量 Wasm 链接与既有 Cook 包，非完整关卡验收。

证据保存至 `tests/web-platform/evidence/nanite-browser-material-inputs-20261108.json`，
同名 PNG 展示局部法线、UV0 和实例归属，属于属性回读可视化而非最终材质画面。

当前保留 UE 纹理消费者，用解析纹理作为桥接：

```text
RDG 矩形清理
  -> Nanite 可见性缓冲写入（8 字节/像素）
  -> ResolveCS（RG32_UINT，8 字节/像素）
  -> HZB.usf / NaniteExportGBuffer.usf
```

深度验证编译 UE 原有 `NaniteExportGBuffer.usf::EmitSceneDepthPS`，
关闭速度和 shading mask 输出；通过反向深度 `greater-equal` 比较保留更近的场景深度，
无效 cluster ID 与视口外像素 discard。HZB 验证编译原有
`HZB.usf::HZBBuildCS` 的 RG32_UINT 可见性、furthest、单 mip permutation，
使用 UE 原始视口映射参数，对场景深度和 Nanite 深度逐像素取近值再做 2x2 归约。
深度导出现已在浏览器 UE Renderer 的真实 scene depth 上执行并回读；
HZB 的该专项仍为导出 packet 验证。这尚未覆盖速度、shading mask、多 mip、
材质重建与完整 GBuffer。

Web 路径将重叠 HW/SW 光栅调度改为有序执行；目前仅接矩形视口清理，
尚不支持多矩形列表、外部深度和 debug 可见性。对应检查会拒绝这些上下文。
相对一份原生可见性纹理，桥接额外使用每像素 8 字节，并在每个可见性光栅阶段后
执行全尺寸解析。尚未测量完整资产下的显存和帧耗时。

## 编译约定

固定 Tint 的 SPIR-V reader 不能接收通用 Int64，当前采用受限编译原语：

1. HLSL 声明保留前缀 `WebNaniteAtomicMax_` 的 `RWStructuredBuffer<uint>`。
2. 通过无返回值的 `InterlockedCompareStore(target, ID, depthBits)` 传递两项输入。
   这只是中间表示，不能执行其标量语义。使用带副作用的指令，避免普通 store
   在 DXC 优化时被合并或删掉。
3. DXC/SPIR-V/Tint 产生丢弃返回值的 `atomicCompareExchangeWeak`。
4. `WebGPUNaniteAtomics.h` 按 token 和结构解析这一受限形式，将目标转换成独立的
   `array<atomic<vec2<u32>>>` 类型，将每次调用转换为
   `atomicStoreMax(target, vec2<u32>(ID, depthBits))`。
5. 更新最终资源步长为 8，移除中间标量格式，再由 `tint_info` 验证 WGSL、
   资源反射与 UE 参数绑定，然后才生成 Web shader packet。

转换器拒绝普通读写、分量写入、其他原子操作、消费 compare 返回值、指针逃逸、
资源类型或反射数量不符。未知形式直接编译失败。
共享旧结构类型的普通资源不变。该约定只供 Web 原语使用，不能当作通用 HLSL 原子转换。
更换 DXC/Tint 后必须重跑连续写入与资源布局测试。

## 验证结果

设备：NVIDIA GeForce RTX 3070，原生 Dawn D3D12；浏览器报告 NVIDIA/Ampere、非 fallback。
Chrome `157.0.8103.39`，Edge `157.0.4341.42`，均无附加实验开关。

| 验证层 | 本轮结果 |
| --- | --- |
| UE shader 编译 | 原有 CS/VS/PS、只读消费，以及矩形清理、解析、实际深度导出和 HZB，共 8 个入口 |
| 编译器防误用 | 9 项拒绝检查通过，共享类型及普通着色器保持不变 |
| 优化语义 | CS/PS 同线程先写胜者、再写较弱值；两次写入均保留为整体原子操作 |
| Chrome 与 Edge | 各 16 组 GPU 回读通过，零未捕获 GPU 错误 |
| UE 原生 RHI | recorded/bypass 两种模式各 7 项通过；同一 RDG 图执行上传、局部清理、打包原子写入、解析、提取，逐位回读通过 |
| Wasm64 Renderer | `NaniteCullRaster.cpp` 线程配置编译通过；未重新链接、打包完整场景 |
| 原生 Renderer | 隔离模块 40 个编译/链接任务通过，安装目录审计通过；尚未进行新 Renderer DLL 的整引擎加载验收 |
| ShaderCompileWorker | program 版本模块构建通过；本轮着色器验证使用 host 的直接编译路径 |
| 已有顶点取数回归 | 重新编译后 8 组格式 GPU 回读通过 |

浏览器用例包含 8,199 个候选值争用、无符号 ID 同深度排序、深度优先级、
深度钳制、片元与计算的两种提交顺序、非零缓冲区视图偏移、短视图、越界坐标、
零宽度和极端宽度。每组检查前后保护区、输入未被改写，以及随后只读消费的逐字结果。
其中单独的混合胜者用例确保片元和计算阶段都能贡献最终像素。

新增 6 组逐位回读覆盖偶数/奇数尺寸、偏移视口、短缓冲填零、局部清理保留邻居、
主/后续写入与重复解析；分别检查清理后的纹理、最终 ID/深度、实际深度导出和 HZB。
HZB 用点采样布局，不要求额外的 `float32-filterable` 设备特性。

首阶段证据：`tests/web-platform/evidence/nanite-ue-visibility-20261106.json`。
本阶段证据：`tests/web-platform/evidence/nanite-ue-consumers-20261106.json`。
原始 WGSL、packet、反射、日志在忽略目录 `tests/web-platform/results/nanite-ue-*`。
宿主使用 CPU affinity 3；一次未限制亲和性的运行在进入 commandlet 前发生
CoreUObject 访问异常，改用该宿主配置后完整流程通过，未将其认定为 Nanite shader 错误。

## 复现

前提：既有隔离 Cook host、固定 Dawn/Tint、DXC、Web 平台配置已准备，
Chrome/Edge 和 Playwright 可用。

```powershell
cd H:/ue_html
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
./tests/web-platform/probe-nanite-ue.ps1
```

默认构建宿主与 Worker 模块，审计并准备覆盖，编译实际 UE shader，
运行原生 RHI 和两种浏览器。已构建时可加 `-SkipBuild`。
仅重跑浏览器可执行 `node tests/web-platform/verify-web-nanite-visibility.cjs`。
浏览器验证自建临时 localhost 服务，结束后释放。

另外执行 C++ 构建检查：

```powershell
./tests/web-platform/build-native-rendercore.ps1 -Module Renderer -MaxParallelActions 1 -HostProcessorAffinity 3
node tests/web-platform/compile-web-nanite.cjs
```

Wasm 检查依赖已生成的 `UEWebEngineThreads` UBT 响应文件，只更新工作区内的
Renderer 覆盖，将独立对象和依赖输出写到 `results/nanite-wasm`，不链接或替换运行包。

真实资产驻留页验证：

```powershell
./tests/web-platform/probe-nanite-asset.ps1
```

默认构建专用 Tint 工具、宿主模块和 Worker 模块，检查转换器策略，审计 shader 覆盖，
导出真实资产并运行两种浏览器。已构建时可加 `-SkipBuild`。
宿主与浏览器统一使用 affinity 3，退出时恢复调用进程配置。
工具使用固定 Dawn 库；发行包缺少的共享头由 CMake 按固定版本下载并检查 SHA-256。
`node tests/web-platform/collect-nanite-asset-evidence.cjs` 汇总结果前会校验源文件哈希，
并要求上述可见性回归结果存在且通过。

## 尚未接通

- 已执行有界常驻页光栅与真实场景深度导出，但完整 Nanite Renderer 的
  材质、GBuffer、速度和 stencil/shading mask 消费尚未接通。
  HZB 专项仍使用导出的 UE shader packet，尚未做真实 Nanite HZB 剔除。
- Nanite 完整关卡 Cook/打包加载验收、完整实例／视图类型和可见性策略、cluster 层级 LOD 与 HZB 剔除、
  VS/PS 光栅和 Compute 微三角形光栅的完整接入。
- 页流送、缺页请求、淘汰与依赖 fixup、冷/热缓存及设备恢复。
- 默认带灯光天空的关卡验收，以及高密度资产性能与原生同视角对比。
- 不具备新原子特性的设备兼容路径。

`bSupportsNanite`、`bSupportsUInt64ImageAtomics` 和 Wave 平台声明保持原值；
RHI 的实际 wave 能力已按获授设备特性与 subgroup 范围填写。
不能据本轮检查宣称通用 64 位原子、全部 Nanite permutations、真实 Nanite 场景
或硬件光追已受支持。本轮结果也不能用于估计完整 Nanite 的帧耗时。

下一阶段将已验证的浏览器静态网格常驻资源路径接入完整 Cook 包，
继续补齐材质分桶、GPUScene/material/view 绑定和材质/GBuffer，统一 Nanite 深度与材质的
几何来源，再推进 LOD、Compute 微三角形光栅与页流送。
