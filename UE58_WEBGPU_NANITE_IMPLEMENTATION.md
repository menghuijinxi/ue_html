# Nanite WebGPU 接入记录

更新：2026-11-08。已完成可见性 RDG、深度/HZB 消费、真实资产驻留页转码与几何解码，
已增加显式 Web Cook 数据保留入口、Cook 资源序列化/重载，以及实际运行时 uploader
的 Web 转码调度适配与原生 Dawn RHI 验证。现已在浏览器线程版 UE 中完成
Cook 资源反序列化、生产 shader map 加载、实际 uploader 执行与 GPU 回读验证。
现已接通显式 Web 常驻 StreamingManager 的注册、层级安装及资源生命周期，
并继续接入静态网格初始化与 Deferred Renderer 的逐帧资源更新。
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

## 下游接入

当前保留 UE 纹理消费者，先用解析纹理作为桥接：

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
这尚未覆盖速度、shading mask、多 mip、材质重建与完整 GBuffer。

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

- 已加入 RDG 分配、清理、解析及消费者入口，但完整 Nanite Renderer 还未
  在真实场景中执行。当前深度/HZB GPU 验证使用导出的 UE shader packet。
- Nanite 完整关卡 Cook/打包加载验收、cluster 层级 LOD 与剔除、
  VS/PS 光栅和 Compute 微三角形光栅的完整接入。
- 页流送、缺页请求、淘汰与依赖 fixup、冷/热缓存及设备恢复。
- 默认带灯光天空的关卡验收，以及高密度资产性能与原生同视角对比。
- 不具备新原子特性的设备兼容路径。

`bSupportsNanite`、`bSupportsUInt64ImageAtomics` 和 Wave 平台声明保持原值；
RHI 的实际 wave 能力已按获授设备特性与 subgroup 范围填写。
不能据本轮检查宣称通用 64 位原子、全部 Nanite permutations、真实 Nanite 场景
或硬件光追已受支持。本轮结果也不能用于估计完整 Nanite 的帧耗时。

下一阶段将已验证的浏览器静态网格常驻资源路径接入完整 Cook 包，
推进 cluster 层级剔除和固定不透明材质的 Nanite VS/PS 路径，再扩展材质与流送。
