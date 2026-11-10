# Nanite WebGPU 接入记录

2026-11-10 GPU-only 实例已完成本项验收：实际 GPUScene 提供实例矩阵、距离策略、可见标记、LOD、HZB、光栅和运动数据，CPU 实例变换数组保持为空。两种设备各 29 项正常与强制每帧重建检查、各九项 GPU 实例流送和 29 项相位压力检查通过；同包距离、Spline/WPO、可编程材质、材质生命周期、合并开关速度、流送及五档页池预算合计 681 项、364,104 帧，GPU 错误为零。另通过 72 项 HZB kernel、3,096 项独立原生 HLSL 对照及 50 项错误拒绝。修复测试 writer 在 WorldTickStart 绑定旧代理、重建后被原生队列丢弃而造成全零的问题；改为在 CreateRenderState/SendRenderDynamicData 对当前代理提交，两种设备的强制重建采样帧 writer/render frame 一致，额外同步和源缓冲诊断默认关闭。页池重置观察改为同一渲染命令中先布置再请求，避免热缓存一帧回填导致漏记粗级状态；旧顺序控制本轮通过，不作为确定性失败。保留全零复现、失败定位、原始回读、完整构建/Cook/源码哈希和 16 张截图，证据为 `tests/web-platform/evidence/nanite-gpu-instances-20261110.json`。**skinning、assemblies、curves、displacement、其余材质/视图、完整关卡时间重建与性能继续开放，完成后才交付完整版本。**

2026-11-10 可编程距离兼容：代理保存真实 `NanitePixelProgrammableDistance`，每实例按原生包围盒中心、距离缩放及严格比较选择像素回退；回退仅停止遮罩/PDO，保留顶点变形与最终原材质。WPO 距离遵守 `r.Nanite.Culling.WPODisableDistance`，`r.Nanite.AllowProgrammableDistances` 使用通用控制变量接口读取，修复引用式变量不具备类型化存储而触发的断言。双设备各 33 项专项通过，精确等值边界、CPU ISM 和 Spline 组合均验证；同包各类材质、变形、速度、流送及页池预算共 518 项、197,987 帧，GPU 错误为零。60 项 HZB、3,096 项原生 HLSL 对照和 34 项错误拒绝检查通过，保持透视 1e-7、正交 1.2e-7 深度残差阈值。完整源码/构建/Cook 审计、原始回读、失败记录和截图见 `tests/web-platform/evidence/nanite-distance-20261110.json`；其余兼容与性能项仍依验收表继续。

2026-11-10 Villa 原生画面对照：三组实际相机/投影、Nanite 开/关/恢复与四个 AO 相位在两种 Web 原子配置全部通过，共 27,714 帧、312 项区域比较，GPU 错误为零。最差均值 3.6104/255、P95 16.3333/255，阈值仍为 <5/<18。原生捕获独立构建、校验模块 BuildId，实际使用 TSR，并核对投影抖动、材质 mip bias、2,062 个开启代理和完整资源清单。`-WebMaterialTestClock` 只固定材质表达式时间，保留世界时间和组件可见时间，避免全帧时间冻结污染纹理流送；最终 GPU 图像与 AO 相位绑定回读，每相位独立稳定后比较。完整证据和失败定位保存在 `tests/web-platform/evidence/nanite-full-scene-native-20261110.json`。本轮不关闭性能、变形、其余材质或多视图项；默认场景历史对照还需按同样的实际 AA/抖动规则复验。

2026-11-10 自动场景接入：`-WebNaniteScene` 启用正常静态网格代理的 Nanite 主画面和深度绘制，按真实材质 shader map/资源可用性注册，保留原 fallback 几何及阴影批次；`r.Nanite` 开关沿用原生代理重建并恢复常规绘制。默认页池为 1,024 根页、512 流送页，显式预算参数完整转交 UE。默认关卡新增的八个真实材质球使用 263 簇、4 页的 Cook 资源，并保留 16,128 三角形 fallback。

默认关卡两种原子配置的被动回读检查分别运行 4,332/4,275 帧，自动启用、关闭/重开、隐藏/恢复、相机和窗口尺寸共十六项检查通过，GPU 错误为零；测试没有手工注册资源、替换材质或清空 fallback。修复资产生成器未使用隔离 Shader 根目录、Nanite Auto 策略意外简化 fallback、启动参数遗漏，以及静态光照关闭时不通知 GBuffer 观察者的问题。未分配的原生 GBuffer D/E 在只读快照中记录为透明零。证据：`tests/web-platform/evidence/nanite-automatic-scene-20261110.json`。原生同视角画质/性能、高密度场景及其他未完成项仍按验收表继续推进。

更新：2026-11-09。已完成可见性 RDG、深度/HZB 消费、真实资产驻留页转码与几何解码，
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
RDG blackboard，后续阶段可复用同一份几何与可见性。继续加入显式固定参数
DefaultLit 的实际 GBuffer/场景颜色写入，并扩展显式基础色纹理及三角形 UV 梯度采样，
入口默认关闭；这仍不包含任意 UMaterial 图。
Web RHI 的资源释放已继续修正为原子引用计数/删除状态转换，覆盖 RDG 异步销毁与
RHI 删除队列之间的可复现竞态；具体复现及验收边界见后文。
材质阶段继续增加按绑定实例/材质槽的 GPU 瓦片压缩和间接绘制，替换逐实例全屏绘制。
现已扩展同一组件的多个显式材质槽，并用真实多材质 Nanite Cook 资源验证槽位归属。
继续加入跨实例显式材质合批，相同参数、纹理资源和 UV 变换共享瓦片列表与间接绘制。
这还不是完整 Nanite 支持，当前发布场景仍走既有网格路径。

## 启动管线兼容修复（2026-11-09，整包回归通过）

保留了原始 838 个启动失败（668 个计算、170 个图形）、运行时修复后 147 个失败、
以及 ShaderFormat v32 首次完整 Cook 后 52 个失败的日志与对应包/构建清单。
本轮不再接受“失败数减少”作为验收结果：完整回归要求 Nanite 开启及关闭时，
所有预缓存任务完成、实际执行超过 2,000 个异步请求，且拒绝、异步失败、GPU 错误均为零。
最新完整 Cook 已完成全部 1,959 个资源包，shader 编译错误为零；严格启动检查中
2,224 项异步请求全部完成、失败和拒绝均为零。完整浏览器回归运行 11,446 帧，
19 项剔除/光栅、5 项深度、26 项 GBuffer 与资源生命周期全部通过，GPU 错误为零。
Nanite 开启时 2,246 项、关闭时 2,224 项请求全部完成且零失败；
动态格式预缓存实际复用 11,123 次。

- 存储图像读写分析覆盖全部 shader，只有能证明无读取的资源才标记只写；真实读取继续保留。
  补齐合法的 tier 2 读写格式和 RGBA32Sint 映射，ShaderFormat 更新为 v32，旧 metadata 不复用。
- 补齐点/线拓扑、七种顶点格式，将 UE 稀疏逻辑流映射到 WebGPU 连续绑定槽。
  原生实际绘制验证覆盖 24 组直接/索引/稀疏流/渲染 bundle 组合与七种格式解码，
  8 个 bundle 创建、16 次复用，逐像素回读通过。
- 深度 Gather 在 WebGPU 使用全局点采样器。该操作仍返回四个原始深度 texel；
  depth24plus 和 depth32float 的边界、屏外坐标与分量顺序回读通过。
- 全局距离场页图集由 WebGPU 不支持读写的 R8 UNORM 改为 R32F，写入显式保留 8 位量化。
  4,096 个样本覆盖原位更新和回读，全部 256 个 R8 可表示级精确保留；
  任意输入与硬件 UNORM 转换最多相差一个量化级，页图集显存占用为原先四倍。
  这两个差异保留为整场景画质和内存评估项。
- 64 个次表面散射、2 个高度场、4 个物体距离场 shader 排列通过真实浏览器管线创建。
  显式导出额外尝试的体纹理原子覆盖排列失败，不计入通过数量；完整 Cook 按平台规则筛选并验收。

- 全量预编译恢复后，镜像组件重新注册会触发 UE 延迟创建代理；原来固定等四帧的
  回读可能早于新 PSO 完成。测试现等待预缓存完成后再观察四帧，保持两个实例的严格断言。
  复现中等待 4 帧、最多 11 个未完成请求，之后两个代理和几何均恢复。
- 另一个顺序问题是首次绘制先创建同步动态格式管线、随后全局预缓存才创建异步管线。
  格式变体改由同一 shader 的包装器共享完成结果，后续绘制采用已完成的预编译变体；
  未完成或失败的请求继续使用本地同步回退。shader 只保留弱引用，避免管线持有 shader
  形成循环引用。真实浏览器延迟 2 秒完成注入与编译失败注入均通过，验证同一 shader/格式
  先使用同步回退、成功后复用异步结果，失败时仅计入一个失败并继续正确绘制。

完整交付条件集中记录于 `UE58_NANITE_COMPLETION_TRACKER.md`。LOD 的投影函数已有独立验证，
场景接入仍在开发，不并入上述启动管线验证结论。

## 实例与场景捕获（2026-11-09）

CPU 实例数据现已接入 ISM/HISM：使用每实例世界变换、可见标志和真实 GPUScene 实例偏移，
支持增删实例、组件隐藏/恢复、重新注册和组件变换。零普通网格 fallback 的实际浏览器 fixture
覆盖 13 项操作，包含最多 50 个实例、镜像与非均匀缩放、大坐标和 HISM 重排；
独立原网格三角形参考继续核对覆盖、深度、实例归属和材质输入。
主视图及场景捕获遵守 HiddenPrimitives、ShowOnlyPrimitives 与 StaticMeshes/NaniteMeshes 标志。

另有十项实际 SceneCaptureComponent2D 检查，覆盖透视/正交、反向视图、隐藏/仅显示/空列表、
捕获组件重新注册及目标尺寸修改。回读直接检查 Nanite 深度已进入实际捕获场景深度附件。
本轮发现并修复：

- 无 owner 的测试组件必须保存 World 后使用 RegisterComponentWithWorld 重新注册。
- HDR 捕获目标可合法携带 SRGB 标志；Web RHI 与原生 D3D 保持一致，只在格式存在 sRGB
  变体时选择该变体。十种格式、两种标志、三种纹理视图共 60 项原生 GPU 回读通过，
  浮点格式保留线性值，RGBA8/BGRA8 的 sRGB 转换继续有效。
- 正交深度范围很大时，MakeFrustumPlane 的固定法线阈值会丢弃有效近/远平面。
  自定义剔除改为在双精度组合后的 LocalToClip 上直接提取六个齐次不等式，
  保留常量平面，并按非零法线最大分量缩放后传入 GPU。反向正交视图从错误保留
  40 个 cluster 修正为零，实际覆盖和深度均为空。

打包原子/无扩展配置的最新完整回归分别通过 15,550/15,151 帧，GPU 错误均为零；
两种配置的 13 项实例和十项捕获检查全部通过，延迟完成与编译失败注入也通过。
GPU-only 实例、完整距离/淡出策略、反射/平面捕获和立体视图尚未完成对应验收，
因此本轮不关闭“实例和视图”的完整交付条件。

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
  可见性阶段 ShaderFormat 缓存版本为 v30；驻留页阶段为 v31，当前存储访问修复为 v32。

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

### 固定参数 DefaultLit 的真实 GBuffer 接入

新增 `r.Nanite.WebResidentGBuffer`，默认 0，且依赖已有实验场景深度路径。
Renderer 在普通 Base Pass 后读取本帧保存的可见性和记录，以全屏三角形逐绑定
实例处理胜出像素；属性解析与上一阶段共用 `WebResolveMaterialInputs`。
局部法线经过实例矩阵的逆转置变为世界法线，支持镜像和非均匀缩放。
PS 调用 UE 原有 `EncodeGBuffer`，写实际 SceneColor 和 GBuffer A–E 六个附件。
使用只读深度、`equal` 比较、load 附件：前方普通网格、空像素和未绑定材质保持原值。
SceneColor 为乘以 `View.PreExposure` 的发光项，后续标准 deferred lighting 可继续消费。

当前仅支持经过核对的 legacy deferred 布局：10:10:10:2 法线、BGRA8 参数/基色/
自定义数据/预计算阴影，基色附件使用 sRGB；不支持 Substrate、MSAA、其他 GBuffer
格式及关闭静态光照的布局。没有 lightmap/间接光照项，AO=1、预计算阴影因子=1，
不写 velocity、stencil、shading mask。没有材质分桶，当前每个绑定实例一次全屏 draw，
不能据此估计完整场景性能。

`SetWebConstantMaterial` 是显式的 render-thread 绑定接口，绑定 component ID、
当前 Nanite runtime resource ID、单个相对材质槽和固定 BaseColor/Metallic/Specular/
Roughness/Emissive。拒绝非法 ID、槽位和非有限或越界参数；资源 ID 不匹配时跳过，
代理注销时删除绑定。它不会猜测或替换原 UMaterial 的内容，没有纹理、法线贴图、
材质图或自动 Cook 绑定支持。一般网格仍保留 fallback base pass，本轮测试使用
零 fallback 三角形的真实 Nanite fixture，避免混淆几何来源。

新增独立 `WebNaniteGBufferTest`，六个场景状态覆盖前方/后方/部分交叠普通网格、
两个实例不同材质、参数变化、镜像非均匀缩放、隐藏/重建、失效资源绑定和缺失槽位。
每帧真实写入前后采样场景颜色和五张 GBuffer，记录原始值；CPU 先独立验证页属性，
再核对逆转置法线、sRGB 编解码、材质参数量化和 pre-exposure 发光项。
不属于当前写入的采样点逐位保持，深度和可见性也逐位保持。shader 归档现为
12 个入口、6 个 section；Wasm 构建覆盖 Engine、Renderer 及新增测试模块。

全尺寸属性参考允许位置 `0.001`（小于资产的 `1/256` 量化单位）、法线 `2.5e-5`、
UV `8e-6` 和颜色 `1e-6` 的误差；原有 192×128 离屏检查保留更严格的容限。
GBuffer 法线允许一个 10 位码值的差异。硬件 sRGB 转换存在逼近误差，因此把
线性回读重新编码后要求落在同一个最近的 8 位 sRGB 码值内（差值不超过半码），
不要求与理想转换公式的线性浮点结果逐位相同。FloatRGBA 发光项相对容限为
`0.15%`，下限为一个最小半精度步长；未写入区域和所有深度检查仍要求逐位一致。
诊断快照拒绝空/错配视图，避免跨视图使用错误的曝光和属性数据。

最终 Edge `157.0.4341.42` / NVIDIA Lovelace 运行至第 4,324 帧；默认关闭启动至
第 13 帧。原有 19 组光栅/属性和 5 组场景深度回归通过，深度合并最大误差仍为零。
新增六组 GBuffer 每组采样 8,160 点，共 48,960 点；704 点正确写入，48,256 点
逐位保持，所有点的深度、可见性和曝光参数保持不变。11 项非法输入检查通过。

| GBuffer 状态 | 材质写入点 | 被普通网格遮挡 | 失效绑定/缺失槽位 |
| --- | ---: | ---: | ---: |
| 普通网格在前 | 131 | 98 | 0 |
| 普通网格在后并更新基色 | 229 | 0 | 0 |
| 部分交叠、镜像非均匀缩放 | 114 | 117 | 0 |
| 隐藏第一实例，第二实例资源 ID 失效 | 0 | 40 | 78 |
| 第一实例材质槽不存在 | 117 | 0 | 111 |
| 隐藏第二实例并更新发光/粗糙度 | 113 | 0 | 0 |

法线编码最大误差 `9.776e-4`，sRGB 最大误差 `0.260` 个码值，参数最大误差
`2.385e-8`，pre-exposure 发光最大误差 `1.444e-5`，均在上述容限内。
退出后连续 4 帧所有实验 pass 计数不变，默认关闭启动没有新增 GBuffer 调用。
无未捕获 GPU 错误、Fatal 或断言；开启/关闭配置仍各有既有 834 条 PSO 预缓存
失败日志。使用隔离增量 Wasm 链接与既有 Villa Cook 包，未重新 Cook 完整关卡。
画布截图确认已有 deferred lighting 消费输出，但不作为完整光照一致性或性能结论。

证据：`tests/web-platform/evidence/nanite-browser-gbuffer-20261108.json`，
同名 PNG 为真实 GBuffer 回读图，`-scene-2.png` / `-scene-6.png` 为实际运行画布截图。
完整默认灯光天空关卡、任意材质以及与原生同视角对照仍未验收。

## 显式基础色纹理与三角形 UV 梯度（2026-11-09）

在已有 DefaultLit 绑定上增加可选的常驻基础色纹理和 UV0 缩放/偏移。
接受带 ShaderResource 标志的单采样 RGBA8/BGRA8 二维纹理，按 RHI 的 sRGB
标志解释 RGB，忽略 alpha；绑定保留资源引用，替换或流送后的资源需要重新绑定。
不绑定纹理时使用白纹理，保留原固定参数结果。非法维度、整数格式、虚拟纹理、
非有限或绝对值大于 65,536 的 UV 参数被拒绝，失败不覆盖已有绑定。

`WebResolveMaterialInputsWithGradients` 复用 UE 原有 `CalculateTriangleBarycentrics`
的透视正确梯度，插值 UV0 及其屏幕偏导，再对梯度施加 UV 缩放。
GBuffer PS 使用 `SampleGrad` 和 wrap/trilinear sampler，将采样 RGB 乘以 BaseColor。
不依赖相邻像素的隐式 ddx/ddy，避免可见性边界处相邻线程属于不同三角形或实例。
原有属性诊断接口保持输出布局；没有消费者的梯度计算由 shader 编译器消除。

新增四组实际场景 GBuffer 验证：两种格式与色彩空间的纹理同时绑定、负 UV 平铺
和缩放、放大/缩小与 mip 尾部采样，以及替换纹理并清空另一实例的纹理绑定。
纹理是测试用的 128×128 BGRA8 sRGB 和 64×64 RGBA8 linear，分别上传 8/7 级
可区分的 mip；它们不代表已从 UMaterial 或完整 Cook 包自动取得纹理。
CPU 从实际驻留页解码三角形，用齐次坐标独立求 UV，通过同三角形的中心差分
计算屏幕梯度，再用 UV Jacobian 的最大奇异值求理想 mip LOD，执行 wrap、
双线性、三线性和色彩空间转换，核对 GBuffer。
[D3D 规范 §7.18.11](https://microsoft.github.io/DirectX-Specs/d3d/archive/D3D11_3_FunctionalSpec.htm)
允许纹理足迹变换的近似；本检查限定相对理想值最多 1/4 mip 的共同 LOD 偏移，
同一个偏移必须使 RGB 三个通道同时满足最多 2 个 8 位 sRGB 码值的过滤/转换误差。
这是本探针的验收上限，不代表跨 GPU 的统一精度保证。固定色仍保持原有半码容限，
深度、可见性以及未拥有的附件区域仍必须逐位不变。

UE 的 12 个 shader 入口编译、隔离 Wasm 增量编译/链接及浏览器回归全部通过。
最终 Edge `157.0.4341.42` / NVIDIA Lovelace 非 fallback 运行至第 12,914 帧。
保留 19 组光栅/属性和 5 组场景深度检查；GBuffer 扩展为 10 组，共 81,600
采样点，1,622 点正确写入，79,978 点逐位保持，深度/可见性/曝光均未改写。

| 新增状态 | GBuffer 写入点 | 纹理采样点 | 理想 mip 下界覆盖 | 最大所需 LOD 调整 |
| --- | ---: | ---: | --- | ---: |
| 两实例分别绑定 sRGB / linear | 229 | 229 | 0–4 | 0.13184 |
| 负 UV 平铺与放大 | 230 | 230 | 0–5 | 0.05664 |
| 32 倍缩小与 mip 尾部 | 229 | 229 | 3–7 | 0.09766 |
| 替换纹理，另一实例恢复固定参数 | 231 | 113 | 0–2 | 0.05859 |

801 个纹理点中，sRGB 336 点、linear 465 点，放大 304 点、缩小 497 点，
16 点钳制到最后一级 mip。最大所需共同 LOD 调整为 `0.131836`，调整后最大颜色
误差为 `1.994` 个码值。16 项非法输入检查通过；另有 14 项 CPU 参考反例，故意
移除/交换纹理、改错 UV 偏移或恢复错误的 UV 缩放，均被参考校验拒绝。
这些反例与 RHI 非法输入检查分别统计，不混称为运行时拒绝。

退出后连续 4 帧所有实验 pass 计数不变；默认关闭启动运行至第 12 帧，相关调用
全部为零。没有未捕获 GPU 错误、Fatal 或断言；开启/关闭配置仍各有既有 834 条
PSO 预缓存失败日志。首次测试暴露 CPU LOD 参考遗漏了足迹正交化及硬件近似，
修正参考后重新执行了完整浏览器流程，没有改动 shader 去适配错误参考。
本轮仍使用隔离增量链接和已有 Villa Cook 包，不是完整关卡重新 Cook 的验收。

证据：`tests/web-platform/evidence/nanite-browser-textures-20261109.json`；同名 PNG
为真实 GBuffer 回读图，`-scene-7.png` / `-scene-8.png` / `-scene-9.png` /
`-scene-10.png` 为纹理场景的实际光照画布。仍未接通自动 UMaterial/Cook 纹理绑定、
压缩纹理、其他材质属性贴图、材质分桶及完整 Nanite 关卡验收。

## GPU 材质瓦片与间接绘制（2026-11-09）

实验 GBuffer 路径从逐绑定实例的全屏三角形，改为 GPU 生成的 8×8 瓦片列表。
`GBufferTilesCS` 每组检查一个瓦片的全部像素，以保存的可见 cluster 记录确认实例，
从实际 Nanite 页读取相对材质槽，并要求可见性深度等于当前场景深度。
组内用共享原子标记是否占用，只有一个线程追加瓦片并递增间接绘制实例数。
组内所有线程均经过两次屏障，包括最后一行/列中位于视口外的线程。

列表容量等于完整瓦片网格，每组最多追加一次，因此不会超过容量；当前上限为
262,144 个瓦片。初始化参数为 `{6, 0, 0, 0}`，空列表维持零实例。
VS 从压缩列表取瓦片，每实例输出两个三角形，末行/列夹到实际视口边界；
`DrawPrimitiveIndirect` 直接消费 GPU 参数，运行时没有 CPU 回读或绘制计数同步。
RDG 跟踪 UAV→SRV/IndirectArgs 转换；GBuffer PS 仍核对像素实例/材质并使用
只读 equal 深度，保持此前的属性、纹理和附件语义。

`AddWebMaterialTilePass` 拒绝非法条目、材质槽、空/错误深度、错配视图、无效矩形
和超出上限的网格。失效资源绑定在分配列表之前跳过；缺失材质槽和完全遮挡的
有效绑定生成空列表。诊断委托只提供结果观察，不参与生产路径的成员筛选。

测试回读 GBuffer 前全分辨率的可见性/深度，并只省略 ID=0 的像素进行保存；
CPU 从页数据独立解码材质槽，重建每个绑定应拥有的完整瓦片集合。
逐项核对间接参数、成员、重复/遗漏/越界及未使用容量清零，再用原有回读验证
最终 GBuffer。新增完全遮挡和受限宽高比状态，保留全部固定参数和纹理场景。
受限宽高比由 UE 先渲染到 702×540 的原点视口，再贴到含黑边的画布，验证末端
不足 8 像素的实际材质绘制；另以 `(7,5)` 起点的子矩形直接执行瓦片筛选并核对
完整集合，验证非零原点和截断边界。这个子矩形检查不另行绘制 GBuffer。
浏览器同时拦截实际 `dispatchWorkgroups` / `drawIndirect`，验证没有退回全屏 draw。

受限宽高比还暴露并修正了 WebRHI 的 Canvas 后备缓冲区过渡：Canvas 的 RDG
默认 epilogue 会要求 `RTV→SRVMask`。仅对仍有效且标为 Presentable/RenderTargetable
的非 SRV 纹理允许这个停放状态，实际 shader 访问仍检查资源能力，不赋予采样权限。
原生专项包含状态进入/恢复、恢复 Present、拒绝部分 SRV/UAV/过期帧/实际 SRV
访问以及 clear 像素保持，共 8 项；通过独立入口运行，不依赖历史测试 shader 包。

本轮重新编译 Web shader、增量链接 Wasm 并打包，原生 uploader 的 12 个页输出及
21 项策略检查通过。完整浏览器流程的上传、驻留、场景生命周期、19 个剔除/光栅
状态、5 个场景深度状态和 12 个 GBuffer 状态全部通过。瓦片验证覆盖 6,081,480
个像素，12 个状态共生成 2,114 个瓦片，对应逐绑定全视口容量为 167,008；
完全遮挡状态的 14,515 个 Nanite 像素全部被排除，两份间接参数均为零实例。
702×540 场景生成 135 个瓦片，其中 10 个在截断边缘；692×533 子矩形也生成
135 个瓦片，其中 10 个在截断边缘。两者均逐项匹配独立 CPU 集合。

真实 GBuffer 共检查 95,744 个采样点：1,726 个应写入点通过属性核对，其余
94,018 个点保持不变；907 个纹理采样点及 14 项参考反例检查通过。
16 项材质输入和新增 8 项瓦片输入拒绝检查通过。浏览器观察到 19,360 次材质
间接绘制，全部材质 draw 均为 indirect；19,362 次瓦片 dispatch 中额外两次是
非零原点诊断。清理后继续观察 4 帧，各相关计数不再增长；默认关闭运行 11 帧，
全部实验路径计数为零。开启配置运行至 13,934 帧，未出现未捕获 GPU 错误、
Fatal 或断言；开启/关闭仍各有既有 834 条 PSO 预缓存失败日志。

证据：`tests/web-platform/evidence/nanite-browser-tiles-20261109.json`，包含本轮
源码/二进制/回读文件哈希、原生 Canvas 8 项检查，以及独立重放的瓦片/GBuffer
验证结果。同名 PNG 为 GBuffer 回读图，`-scene-7.png` 至 `-scene-12.png` 为
实际光照画布。仍使用已有 Villa Cook 包和隔离增量链接，未完成整关卡重新 Cook。

这是按显式实例/槽绑定的瓦片筛选，仍会对每个绑定扫描整个视口；尚未实现共享
材质表、多实例统一分桶、任意 UMaterial 或完整 Nanite shading bin 流程。
瓦片数量降低只能说明送入材质光栅的区域减少，不能据此断言整帧加速或性能达标。

## 多材质槽绑定与真实材质范围（2026-11-09）

`SetWebConstantMaterial` 现在按组件、运行时资源 ID 和材质槽保存绑定，同一资源的
槽位更新只替换该槽，保留其他槽。支持编码范围内的 0–63 槽；资源 ID 变化时清除
旧资源全部槽位，防止资源替换后误用旧材质。新增 `RemoveWebConstantMaterialSlot`
按资源 ID 移除单槽，拒绝过期 ID、越界槽和不存在的槽；非法材质输入不改变现有
绑定。原有整组件移除及代理注销仍释放全部材质与持有的纹理引用。

材质阶段为每个有效槽生成瓦片及间接绘制，PS 继续根据 Nanite 页内的真实相对材质
索引筛选像素。测试新增的多材质球体来自原始 MeshDescription，按 32 个 polygon
一组分配到 `0、7、31、63`，并设置 SectionInfoMap 映射，再交给原生 Nanite builder
和真实 Web Cook 资源序列化器；没有修改编码后的页字节。构建结果为 1 个根页、
15 个 cluster，8 个叶 cluster 均包含多个材质，6 个叶 cluster 使用材质范围表。
独立 CPU 解码将全部 960 个叶三角形的位置及材质槽与 Cook 前原始数据逐一匹配：
槽 0/7 各 256 个三角形，槽 31/63 各 224 个。此检查同时覆盖简化编码与范围表编码。

浏览器测试保留前 12 个场景，新增 7 个状态：两个实例各绑定四槽、只更新一槽、
分别移除一槽、拒绝非法输入并保留有效绑定、失效资源 ID、切回当前资源并重建另一
组件代理、移除全部绑定。两槽使用固定参数，另两槽分别使用 sRGB/linear 基础色
纹理。逐像素参考按页内槽位选择独立预期材质，同时核对每个槽的完整瓦片集合。
首次绑定之后不逐帧重绑，避免测试掩盖其他槽被覆盖或代理重建残留的问题。

新页的三角形重排使轮廓附近 float 重心插值与独立 double 解的最大位置差达到
约 `0.0013`，多材质夹具的位置误差上限设为 `1/512`（源位置精度 `1/256` 的一半），
原单材质场景仍保留 `0.001` 上限；多材质半径 50 球体的法线阈值按对应角度
设为 `1/25600`，UV 和顶点色阈值保持原值。材质参数
参考同时按当前后端的 float32 UNORM 半值舍入到偶数处理，解决 `Specular=0.3`
在 JavaScript `Math.round` 中产生相邻量化码的问题；参数仍须匹配对应量化码，
没有增加一个完整码值的容差。原始三角形及材质槽匹配仍为精确检查。
原纹理状态还暴露 LOD 搜索步长 `1/1024` 会跨过 mip 边界附近很窄的有效 RGB
量化区间；未找到解时细化到 `1/16384`，仍要求三通道共用同一个 LOD 偏移，
偏移不超过 `1/4` mip、sRGB 码误差不超过 2，原有 14 项错误参考拒绝检查保留。

复现新增夹具后，用两个原生 uploader 输出目录打包：

```powershell
./tests/web-platform/probe-nanite-multimaterial.ps1 -Engine D:/UE_5.8
./tests/web-platform/probe-nanite-uploader.ps1 -Engine D:/UE_5.8 -CookedAsset tests/web-platform/results/nanite-multimaterial -SkipBuild
node tests/web-platform/build-web-nanite-runtime.cjs
node tests/web-platform/package-web-nanite-runtime.cjs <原单材质Uploader目录> <多材质Uploader目录>
node tests/web-platform/verify-web-nanite-uploader.cjs
node tests/web-platform/collect-nanite-browser-evidence.cjs
```

前提仍为已配置的隔离构建宿主、匹配原生 uploader 构建记录、NODE_PATH 和本地
8765 服务；本机执行采用 CPU affinity 3。证据收集会重放原始网格/材质槽核对、
GBuffer 和瓦片核对，并审计两份夹具的源码、构建、Cook、转码及回读文件哈希。
本轮 Web shader 编译、Wasm 增量构建、多材质资产 Cook/重载、Edge 两组转码/几何
解码，以及多材质原生 uploader 的 12 个页输出、21 项策略检查全部通过。
最终浏览器运行至 22,994 帧，19 个 GBuffer 状态全部通过，具体新增结果为：

| 状态 | 有效绑定槽 | GBuffer 写入点 | 缺失/失效槽保留点 | 材质瓦片数 |
| --- | ---: | ---: | ---: | ---: |
| 双实例各四槽 | 8 | 123 | 0 | 304 |
| 仅更新第一实例槽 7 | 8 | 123 | 0 | 298 |
| 移除第一实例槽 31、第二实例槽 63 | 6 | 100 | 23 | 235 |
| 10 项非法更新/移除拒绝 | 6 | 100 | 23 | 235 |
| 第一实例切换到失效资源 ID | 3 | 50 | 73 | 112 |
| 第一实例仅重绑槽 63，第二实例重建代理 | 1 | 15 | 108 | 37 |
| 移除全部绑定 | 0 | 0 | 123 | 0 |

19 个状态共核对 9,710,280 个像素的完整瓦片归属、152,864 个 GBuffer 采样点：
2,238 个应写入点通过，150,626 个其他点保持原值；纹理检查覆盖 1,110 个采样点。
观察到 56,647 次材质 draw，全部为 indirect；瓦片 dispatch 为 56,649 次，额外两次
仍为非零原点诊断。清理后观察 4 帧所有实验计数不再增长；默认关闭运行 13 帧，
相关计数均为零。着色器审计保存每次创建的哈希并要求四份唯一代码，以允许资源
切换期间重建相同 shader module；本次运行共创建四次。未捕获 GPU 错误、Fatal
和断言为零，开启/关闭配置仍各有既有 834 条 PSO 预缓存失败日志。

证据：`tests/web-platform/evidence/nanite-browser-multimaterial-20261109.json`；同名
PNG 为 GBuffer 回读图，`-scene-13.png` / `-scene-14.png` / `-scene-15.png` /
`-scene-18.png` / `-scene-19.png` 为多材质及移除状态的实际光照画布。

此阶段仍由显式接口绑定参数与纹理，尚未从 UMaterial/组件材质自动生成绑定，
也未合并多实例材质分桶。现有 Villa Cook 资源仅作运行宿主，完整关卡验收仍待完成。

## 跨实例显式材质分桶（2026-11-09）

材质阶段按基础色、自发光、Metallic、Specular、Roughness、基础色纹理资源身份和
UV scale/bias 的精确值分桶。浮点零的符号统一处理，其他数值不做近似合并；纹理
资源身份不同即分开。每桶最多 64 个实例/槽成员，超过后另建同材质桶，限制 shader
逐像素成员查找的工作量。每帧从当前有效绑定重建，继续排除过期资源 ID。
分桶前保留逐实例的行列式和法线逆转置矩阵有限性检查，异常实例不会使同材质的
正常实例整桶被拒绝。

每桶上传成员的 cluster 范围、页范围、GPUScene 实例 ID、LocalToClip 和逆转置法线
矩阵，并由 RDG 复制各成员的 GPU 剔除状态。Tile CS 根据最终可见性、场景深度和
页内真实材质槽，只生成整个桶的占用瓦片并集；同一瓦片中的多个成员只输出一次。
一次间接绘制消费该并集。PS 按像素的可见 cluster 找到实际成员，使用该成员的
变换解码属性和 UV 梯度，再使用桶的公共参数及纹理写入 GBuffer。

浏览器新增状态 20–26：双实例四槽共享四份材质、八个绑定合为一个纹理材质桶、
单槽改纹理、单槽改 UV、单槽改 Roughness、恢复共享并去掉一槽、全部解绑。
合并状态使用两个相互重叠且变换不同的实例，覆盖镜像和非均匀缩放。CPU 参考从
显式绑定独立计算预期分桶，从完整 ID/深度回读和独立页解码计算每桶瓦片并集；
检查成员、间接参数、瓦片去重和无效尾部，同时继续逐点检查实际 GBuffer。
额外拒绝空成员、重复成员、非法实例、越界材质槽及超过 64 成员的诊断请求。
重叠后的后方实例被移除槽只有少量可见采样，解绑断言要求非零覆盖，并对每个未
绑定样本保持逐位不变检查；不沿用并排场景的最小采样数，材质数值容差保持原值。

最终 Web shader 编译、Wasm 增量构建、多材质 Cook/重载、浏览器转码和原生 uploader
检查通过；同一构建完整浏览器复跑至 31,334 帧，26 个 GBuffer 状态全部通过。
新增状态的实际回读为：

| 状态 | 成员数 | 材质桶/每帧间接绘制数 | 合并前瓦片总数 | 合并后瓦片数 | 写入采样点 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 双实例四槽共享四份材质 | 8 | 4 | 302 | 302 | 123 |
| 八个绑定共享同一纹理材质 | 8 | 1 | 253 | 122 | 101 |
| 其中一槽改纹理 | 8 | 2 | 256 | 149 | 100 |
| 另一槽改 UV | 8 | 3 | 262 | 177 | 101 |
| 再一槽改 Roughness | 8 | 4 | 260 | 197 | 101 |
| 恢复共享并移除后方实例一槽 | 7 | 1 | 235 | 120 | 94 |
| 全部解绑 | 0 | 0 | 0 | 0 | 0 |

26 个状态合计核对 13,339,080 个像素的完整瓦片归属、209,984 个 GBuffer 采样点，
其中 2,860 个应写入点及 1,656 个纹理采样点通过检查，其他点保持原值。
76,626 次材质 draw 全部为 indirect；76,628 次瓦片 dispatch 中额外两次为非零原点
诊断。清理后 4 帧计数不再增长；默认关闭配置运行 13 帧，实验路径计数全部为零。
最终通过运行无未捕获 GPU 错误、Fatal 或断言；开启/关闭配置仍分别保留既有
834 条 PSO 预缓存失败日志。创建 5 次材质 shader module，去重后为预期的 4 份代码。

证据：`tests/web-platform/evidence/nanite-browser-material-bins-20261109.json`；同名
PNG 为全部状态的 GBuffer 回读图，`-scene-21.png` / `-scene-24.png` / `-scene-25.png`
展示共享、拆分和解绑后的实际光照画布。复现沿用上一节命令，重新生成当前
hierarchy shader archive、多材质夹具和两份 uploader 证据后打包验证。

这是显式固定参数材质的有界合批，尚未自动读取 UMaterial/组件材质，未接入完整
Nanite shading bin 管线。每桶仍扫描整个视口，成员查找为有界线性循环；绘制次数
和重复瓦片减少不代表已经证明整帧加速。完整关卡验收、LOD/HZB 和页流送仍待完成。
本轮回归每桶最多 8 个成员，64 成员及更大规模拆桶的容量、性能验收尚未完成。

本轮一次浏览器复跑在场景剔除状态 11、尚未启用 GBuffer 时触发
`FRHIResource::MarkForDelete` 的 `DeletingBit` 断言，栈经过 RDG 异步销毁
`FRDGUniformBuffer`。根因未确认，不能归因于或宣称已修复材质分桶；失败运行
单独保存在 `tests/web-platform/evidence/nanite-browser-uniform-buffer-failure-20261109.json`，
包括运行时哈希、断言栈及原日志哈希。后续验收使用同一构建，未关闭断言、异步
销毁或改变线程参数；该轮未确认根因，后续定位与修复记录见下节。

## Web RHI 资源释放与删除队列竞态（2026-11-09）

上节失败栈指向 `FRHIResource::MarkForDelete`。检查旧实现后，能够确定复现以下
交错：资源已标记并在删除队列中，又被临时引用；RDG worker 释放最后一份引用时，
先执行 `fetch_sub` 将引用数降为零，尚未执行单独的 `MarkForDelete`。RHI 线程此时
可以从旧队列记录认领并销毁资源，随后 worker 再访问删除标记。原日志缺少资源
身份及完整线程交错，因此这证明了与断言吻合的代码缺陷，不能严格唯一归因到
那次历史崩溃中的具体 UniformBuffer。

Web 分支现在使用 CAS 将引用递减和最后引用的删除标记合为一次状态变更。
已标记的最后引用释放后，只读取局部结果，不再访问该资源；只有成功从未标记
转为标记的调用者负责入队。删除消费者也用 CAS 同时检查引用数和标记：存在活跃
引用时清除旧标记，引用为零时认领删除；并发变化会重试。否则只修释放一端，会
在消费者读取活跃引用、最后引用释放、消费者清除旧标记的顺序中漏掉再次入队。
删除认领位在 Web 的 `DO_CHECK=0` 配置中也生效。非 Web 分支保持原来的实现。
入队继续区分允许延长生命周期与普通资源；未关闭 RDG 异步销毁或改变线程调度。

`verify-rhi-resource-lifetime.cjs` 从参考引擎的真实源码提取 `FAtomicFlags`、
`AddRef/Release/GetRefCount`、删除标记及入队方法，替换的仅是测试原子包装器和
队列记录器。测试停在线程交错的指定位置，让另一线程执行删除，再恢复；对象
保持分配，仅观察逻辑删除认领，以便安全检测错误。它不复制另一套修复算法。
按 Wasm64 ABI、lowered 32 位线性内存与 pthread 构建四个版本：历史提交、Web
修复、Web 修复且 `DO_CHECK=0`、当前源码的非 Web 对照。

| 可控交错 | 历史/非 Web 对照 | Web 修复（两种检查配置） |
| --- | --- | --- |
| 末次释放归零后消费者先认领删除 | 后续标记访问触发断言 | 无后续资源访问 |
| 消费者读到活跃引用后发生末次释放 | 清除标记后漏入队 | CAS 重试并完成删除 |
| 消费者读到零后资源被重新引用 | 错误认领活跃资源 | CAS 重试并保留活跃资源 |

各版本还检查两种入队策略下的复用/再次释放，以及 8 线程、160,000 对竞争引用
增减，四个版本共 640,000 对。历史及非 Web 版本须准确暴露上述三个问题，两个
Web 版本须全部消除；这不是把旧版本的已知错误计作修复通过。`DO_CHECK=0`
版本关闭提取的生产方法内的检查，测试自身的断言仍保留。

因为 `Release` 是公共内联函数，本轮通过完整 UBT target 重编所有受头文件变更
影响的对象。隔离 Nanite 包用 `build-web-nanite-runtime.cjs --from-full-build`
导入完整 target 的已验证 JS/Wasm，审计源码、对象、响应文件和平台覆盖；未做从零
清空缓存重编。以后增量诊断重链接也会要求匹配当前 RHI 头文件及实现的完整构建
记录，避免混用新旧引用计数逻辑。

首次完整 target 构建完成 185 个编译任务、422 个对象的链接和 Wasm 验证。
依赖文件中包含 `RHIResources.h` 的 184 个对象均在该次成功编译任务中；随后
RHI 诊断、阴影占位纹理修复及测试几何覆盖修正分别触发 1 个编译任务及完整链接。证据同时保留首次
头文件重编与最终 target 构建记录，并要求二者使用完全相同的 RHI 资源协议源码。
新版完整运行时还暴露旧 Villa Cook 包缺少 VT/VSM、透明光照及相关全局着色器
排列的问题。补充工具读取原 Cook 的 frozen map 元数据，不加载外部 shader library
或创建 RHI 资源；逐项比较当前原生宿主 `ShouldCompilePermutation` 所需排列。
使用非编辑器标志，按类型对象排除另外打包的 13 个 Nanite 测试类型，保留 Renderer
中的生产可见性清理/解析类型。本次发现 59 类、395 个缺项，
其中包括 HZB froxel 和延迟光照 VSM 排列；按缺项所属 shader section 补编完整内容，
保留同一 section 原有入口。VT 显式名单另补齐宿主中 `UseVirtualTexturing=false`
时未选择的 22 类、71 个排列，包含 RVT copy；透明光照 section 保留批量、清理和
简单灯光入口；另补充受同一 VT 开关影响的 GPU feedback 压缩 3 类、6 个排列。
编译使用原生 UE 注册类型、编译环境、参数绑定检查及
`FGlobalShaderMap` 序列化，浏览器仍执行原有的全局着色器完整性检查。
补编期间的绑定检查还发现旧原生 Renderer DLL 缺少
`FCullPerPageDrawCommandsCs::WebInstanceCullingMetadata`。因此先按当前参考源码
重建隔离原生 Renderer；补充脚本校验该构建的源码、产物及安装目录未修改记录，
再断开旧宿主 DLL 的硬链接并复制新产物。没有忽略未绑定参数或修改安装版 Renderer。
原生 Renderer 重建 40 个任务通过。诊断补充归档 81 类、661 个排列、22 个
shader sections，转换与绑定检查均通过。归档的来源、缺失排列清单、编译日志、宿主
二进制和 shader 输入均进入证据审计，证据收集会逐项检查缺失排列均已补编。
但仅补全全局 shader 后，旧 Cook 的默认 `WorldGridMaterial` 仍缺少
`FWebTranslucentLightingInjectCS` 第 8 号排列。因此最终打包入口要求同一 Villa
工程的新 Cook 与 stage 审计，通过同一套配置重建全局和材质 shader map；历史
补充归档保留为缺项诊断证据，不拼入新包。新 Cook 已注册 13 个 Nanite 测试类型，
也不再用独立 hierarchy 归档覆盖共享 shader section，以保留其中的生产入口。
只有经过验证的 production transcode 独立归档继续追加。

重跑场景流程还修正了两个宿主问题：生成工程的 `UEShaderHost` 模块加载阶段改为
`PostConfigInit`，与宿主原工程一致，确保在 shader type 初始化前注册；WebGPU
场景的原生 D3D12 天空光采集改用准备好的工作区 Cook 宿主，取得新增 Nanite shader
源文件。仍保留天空光采集和工程的 VT/光照设置，不修改安装引擎。
原生天空光采集已通过；352 字节的 `WebSkyCaptures.bin` 与原 Villa Cook 完全一致，
SHA-256 为 `0f2bf861eb50b0b3e5be8bc96b16ae3c319caaf0ebc4a687e92fa9b3ff0c8a3c`。
完整 Web Cook 已通过：处理 1,959 个包，其中 1,928 个完成 Cook、31 个按平台跳过，
0 错误、14 警告，shader 失败记录为空。全局清单为 774 类、4,459 个排列；已逐项
核对 13 个 Nanite 测试类型与 2 个生产可见性类型。stage 去掉重复 shader metadata
后包含 5,163 个文件、3,320,708,311 字节（含下述运动模糊格式与材质精度修复）。打包要求该 Cook 的源码、宿主、资源、
shader 清单和 stage 审计全部一致，不再接受仅靠历史全局 shader 补充归档启动。
这些构建及 Cook 兼容修正不等于完成 VT/VSM 渲染或整场景 Nanite 验收。

新 Cook 通过 shader map 完整性检查后，还暴露普通阴影路径的占位纹理契约问题。
`ShadowDepthPass_OutDepthBufferArray` 在 Web shader 中仍保留原子缓冲绑定，而
`Dummy-OutDepthBuffer` 原来只有 ShaderResource/UAV 标志。诊断记录其格式为
R32_UINT、完整单层视图，但没有原子 mip 后备缓冲（`atomicMips=0`）。现仅在 Web
shader platform 为这份占位纹理补上 `AtomicCompatible`，继续使用 RHI 原有的
原子缓冲分配、同步和严格视图校验。RHI 错误信息也加入纹理名、格式、mip、层范围
和标志，便于定位后续契约错误；没有把不兼容纹理当成合法原子资源。

继续回归到正交视图时，`MotionBlur.VelocityFlatten` 使用 RGBA32F，而原 Web shader
声明固定为打包浮点格式，触发 `OutVelocityFlatTexture` 格式断言。现在只为
`MotionBlurVelocityFlatten.usf` 的 compute 排列启用已有的运行时 storage format
替换，按实际 UAV 格式创建并缓存管线；保持透视视图的打包浮点格式与正交视图的
RGBA32F。更新 shader map 缓存键，受影响编译任务取得 storage-format 编译参数，
避免沿用旧 metadata。`compile-web-motion-blur-shaders.ps1` 编译真实 UE 类型的
两个排列，并检查 WGSL 替换位置；浏览器以两种格式各创建一次 compute pipeline，
四个管线均通过。这一专项不替代下面的实际场景执行回归。

完整运行到 GBuffer 第 23 步时还发现测试取样边界：重叠后方球体的 63 号材质槽在
该帧只有 5 个 stride-8 样本，未达到原有 `count > 5` 标准；其全分辨率 6,420 个
Nanite 像素和 3 个材质桶的瓦片、间接参数检查全部通过。投影抖动会改变窄区域的
稀疏样本数。将后方测试球体横向偏移从 70 调至 90，仍保留局部重叠，增加可见槽位
的采样面积；保留原有像素数量门槛、逐像素误差与瓦片一致性检查。失败运行和原始
回读另行保存，证据收集会重验失败帧的完整瓦片，并记录缺少样本的具体材质槽。

随后第 24 步暴露材质插值的实际数值缺陷：原 shader 先把像素坐标归一化，再减 1，
屏幕中心附近发生浮点消减；细长投影三角形将误差放大，位置与独立双精度参考相差
约 0.00364 个源模型单位。`WebNaniteRaster.usf` 现先在像素空间减去视口中心，
再归一化，并用 `precise` 保留计算顺序；原有 UE 透视插值和梯度计算保持不变。
`verify-nanite-material-precision.cjs` 使用失败帧的真实可见性、矩阵、抖动与 Nanite
页，在浏览器分别执行旧 WGSL 与重新编译的生产 shader。旧输出与历史 GPU 回读
逐位一致并重现失败；新输出的 105 个有效样本全部满足原有容差，最大位置误差
降到约 0.000307。未关闭时间抖动，也未放宽位置、法线、UV 或颜色精度要求。

最终使用完整 target 运行时及更新后的 Villa Cook，在 NVIDIA Lovelace 硬件适配器上
完成浏览器回归：4 个 uploader、4 个驻留管理、5 个静态网格生命周期、19 个剔除/
光栅、5 个场景深度及 26 个 GBuffer 用例全部通过。包含原失败位置的第 24 步本轮
最大位置误差约 0.0000347；第 23 步每个绑定材质槽至少覆盖 8 个稀疏样本。
清理后观察 4 帧，计数停止增长；同一运行包关闭常驻入口后启动到第 11 帧，所有
Nanite 专项 dispatch/draw 计数为零。启用运行共观察 23,164 帧，专项未记录断言、
页面错误或未捕获 GPU 校验错误；Canvas 的 8 项过渡检查也通过。

启用与默认关闭两次启动各记录 **847 条管线创建失败日志**，完整内容保存在证据
中的 `startupPipelineFailures`，不计作专项通过的管线，也未被隐藏或改为成功。
所以本轮不代表普通场景所有管线已兼容、VT/VSM 渲染完成或整关卡 Nanite 验收通过。
仍需自动 UMaterial/组件材质绑定、任意材质图、法线贴图、lightmap/Substrate、
LOD/HZB 剔除、Compute 微三角形光栅与页流送。

最终证据：`tests/web-platform/evidence/nanite-browser-resource-lifetime-20261109.json`，
附 GBuffer 回读预览和 11 张实际场景画布截图。收集器逐项重验源码、编译、Cook、
打包与 GPU 回读哈希，同时保留历史失败、竞态对照和精度回放。

```powershell
node tests/web-platform/verify-rhi-resource-lifetime.cjs
node tests/web-platform/prepare-web-rhi-host.cjs D:/UE_5.8
./tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4
node tests/web-platform/build-web-nanite-runtime.cjs --from-full-build
./tests/web-platform/build-native-rendercore.ps1 -Engine D:/UE_5.8 -Module Renderer -MaxParallelActions 2 -HostProcessorAffinity 3 -CompilerVersion 14.44.35207
./tests/web-platform/compile-nanite-hierarchy.ps1 -Engine D:/UE_5.8
node tests/web-platform/verify-nanite-material-precision.cjs
./tests/web-platform/compile-web-motion-blur-shaders.ps1 -Engine D:/UE_5.8
./tests/web-platform/compile-web-shader-supplement.ps1 -Engine D:/UE_5.8
# 宿主 DLL 改变后，重新执行多材质夹具与对应 uploader 探针，更新审计。
./tests/web-platform/probe-nanite-multimaterial.ps1 -Engine D:/UE_5.8 -SkipBuild
./tests/web-platform/probe-nanite-uploader.ps1 -Engine D:/UE_5.8 -CookedAsset tests/web-platform/results/nanite-multimaterial -SkipBuild
$env:UE_ENGINE_ROOT = 'D:/UE_5.8/Engine'
# 使用 prepare-web-project.cjs 更新后的 PostConfigInit 工程描述。
./tests/web-platform/cook-web-engine.ps1 -Engine D:/UE_5.8 -Mode WebGPU-SM5 -Scene Project -Project tests/web-platform/build/projects/lumen-off-v59/TriplexHouseVilla.uproject -Map /Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla -UseProjectSettings -ReportId nanite-lifetime -HostProcessorAffinity 3 -SkipBuild -StopOnShaderError
node tests/web-platform/stage-web-engine.cjs --project=nanite-lifetime --desktop
node tests/web-platform/package-web-nanite-runtime.cjs <原单材质Uploader目录> <多材质Uploader目录>
node tests/web-platform/verify-web-nanite-uploader.cjs
node tests/web-platform/collect-nanite-browser-evidence.cjs
```

### 动态 UAV 格式的计算管线预缓存（2026-11-09）

继续追查前轮 847 条启动失败时，发现 `CanPrecacheShader` 对所有保留动态存储格式
源码的 shader 直接返回不支持。运行时虽能按 UAV 格式创建管线，但无法提前编译和
复用。现在计算预缓存为通过格式/资源限制检查的 shader 编译一个具体变体，并放进
原有的 `FormatVariants` 缓存。运动模糊 flatten 按 Renderer 的资源约定选择透视
flat velocity 的 R11G11B10 与 tile array 的 RGBA16F；其他可用组合使用反射格式。
异步回调完成的是具体变体；外层延迟包装对象保持无句柄，
因此后续 dispatch 仍会检查实际绑定资源，选择匹配格式或创建新的变体。

预缓存与首次运行共用格式替换、布局构造和管线创建实现，避免两条路径的 WGSL 与
绑定布局不一致。图形管线尚未接入该变体机制，继续保留原有准入限制；设备格式、
访问模式和资源数量限制也保持检查。预编译失败仍返回失败，不能被计作完成的可用
管线。浏览器额外记录计算管线拒绝原因，便于区分预检查拒绝与 WebGPU 编译失败。

最初只编译反射格式的版本通过全部 26 个 GBuffer 用例，但被新增复用检查拒绝：
9 个动态变体完成异步编译，实际复用为零。原因是动态 float4 的 RGBA32F 反射值
并不代表 Renderer 创建的纹理格式。保留该失败报告，修正为上述资源约定后重验；
不能用减少失败日志或完成编译来替代实际 dispatch 证据。

`observe-storage-precache.cjs` 在实际 GPU owner worker 中观测原生 WebGPU API，
跟踪 shader 格式、管线对象、同步/异步创建方式与直接/间接 dispatch，并将只差
存储格式的 WGSL 归为同一 shader。验证要求实际执行异步预编译产物，同时覆盖
运动模糊透视 `rg11b10ufloat` 与正交 `rgba32float` 的同源变体；RHI 复用计数作为
交叉证据。完整 Nanite 用例和默认关闭检查继续执行。

完整 Web target 与原生 RHI 重编译后，单/多材质 uploader 各 21 项策略检查和 12 页
回读、Canvas 8 项检查均通过；Cook 源码、宿主与 5,165 个产物哈希保持有效，使用
上一轮相同场景包。浏览器观察 29,507 帧，4 个 uploader、4 个驻留、5 个静态网格、
19 个剔除/光栅、5 个深度和 26 个 GBuffer 用例及清理检查全部通过，错误数组为空。
关闭 Nanite 常驻入口后的第 61 帧，专项 dispatch/draw 均为零。

两次启动的管线失败日志均从 **847 降至 838**，其中计算管线从 677 降至 668，
图形管线仍为 170；现有日志全部保留。这 9 个新增动态预编译变体中，本场景实际
命中 1 个，不能把其余 8 个计作已执行。独立 WebGPU 对象跟踪记录运动模糊透视
预编译管线 dispatch 29,417 次、同源正交 RGBA32F 运行时变体 81 次；RHI 在
第 29,490 帧的统计记录预编译变体绑定 29,402 次。统计采样点不同，保留原始数值。
普通场景启动也命中该预编译变体，异步编译失败计数为零。

`verify-storage-precache-failure.cjs` 随后对同一个运动模糊入口注入一次 WebGPU 异步
编译失败，真实 UE 预缓存任务正确返回失败，运行时重新同步创建相同格式管线并
执行，启动超过 60 帧且无 GPU 校验错误或断言。该检查验证失败后不会复用无效
句柄；注入次数与异步失败计数均为 1。

本轮证据：`tests/web-platform/evidence/nanite-browser-storage-precache-20261109.json`，
附原有类型的回读预览和 11 张实际画布截图。收集器同时校验成功路径、故障恢复、
占位格式零复用的历史失败，以及原生、完整构建、Cook 和 GPU 回读产物。

```powershell
node tests/web-platform/verify-web-nanite-uploader.cjs
node tests/web-platform/verify-storage-precache-failure.cjs
node tests/web-platform/collect-nanite-browser-evidence.cjs
```

这些结果补齐动态计算管线的一个预缓存入口，仍不代表剩余 668 个计算、170 个
图形请求可用，也不代表自动 UMaterial 绑定、LOD/HZB 或页流送完成。

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

## 常驻层级 LOD（2026-11-09）

常驻页层级剔除使用真实视图、视口高度和 `r.Nanite.MaxPixelsPerEdge` 选择
父子 cluster cut，支持透视和正交投影、相机相对矩阵、镜像和非均匀缩放。
投影函数与原生 HLSL、独立 CPU 几何推导比较的 3,255 个用例全部通过；
连续缩放的四档几何分别为 126、252、504、960 个三角形，闭合边检查通过。

完整 Villa Cook 后的浏览器回归运行 11,730 帧，零 GPU 错误。
新增 10 项实际场景测试覆盖远近、正交缩放、千万量级坐标、镜像、返回原视角
及像素误差调整，逐项比较 CPU 层级选择和独立可见性/深度参考。
启动管线开启时 2,246 项、关闭时 2,224 项全部完成且零失败；
延迟预缓存和失败注入均通过。证据为
`tests/web-platform/evidence/nanite-browser-lod-20261109.json`。

首次增量构建曾复用时间戳较旧的布局依赖对象，导致无效视图测试失败；
已重编译全部七个相关对象并保存失败构建、包和运行日志，采集器检查这些依赖。
本项仅覆盖常驻 root 页，流送页安装/替换时的 LOD 依赖继续归流送项验收。

## 核心 32 位原子兼容路径（2026-11-09）

RHI 根据实际获授设备特性公布只读能力，光栅自动选择 packed 原子或两阶段核心
32 位原子。兼容路径先完成所有实例的最大反向深度，再在最终深度上选择最大 ID，
保持 `uint2(ID, depthBits)` 的 8 字节可见性布局。RDG 将两阶段排序；不支持扩展
的设备不实例化 packed shader，也不请求其预缓存。

独立 GPU 测试使用不请求任何可选特性的设备，验证 8,199 个候选争用、深度相等、
无符号 ID、计算/片元混合、越界及缓冲区保护区，九组逐位回读全部通过。
完整浏览器回归实际移除设备申请中的原子扩展，自动选择兼容路径；
11,646 帧内上传、常驻、19 项剔除/光栅、5 项深度、26 项材质和 10 项 LOD
全部通过，零 GPU 错误。packed 路径同包复验 11,657 帧通过。
兼容路径每批绘制两次，是明确的光栅成本；其他设备特性和资源上限仍按实际 RHI 要求。

原生探针发现能力标记在渲染线程初始化时调用普通控制台更新会断言。
修复为在设备初始化/销毁同步边界同时发布控制台双份数据，再通过原生上传、
拓扑、顶点格式和画布回归；失败日志与对应源码/构建信息保留在验收证据中。
双路径证据为 `tests/web-platform/evidence/nanite-browser-scalar-packed-20261109.json`
和 `tests/web-platform/evidence/nanite-browser-scalar-fallback-20261109.json`。

## 常驻场景 HZB 与遮挡恢复（2026-11-09）

真实渲染帧已接入反向深度的最小值金字塔、前一帧遮挡判断和当前帧恢复。
第一轮保留历史中可见的 cluster，写入当前深度后再次检查之前被遮挡的候选；
最终可见性表合并两轮结果，避免不同压缩列表的 slot ID 混用。
当前实现会再次光栅第一轮保留的几何，这一额外成本仍需在完整场景中测量。
历史按视图、场景、视口和连续帧验证，摄像机切换时失效；设备释放时清空历史纹理。

12,005 个包围盒的独立 GPU/CPU 对照未出现错误遮挡，九级金字塔全部逐值一致。
实际 UE 编译的遮挡 kernel 通过十项测试，覆盖两轮恢复、保留第一轮结果、错误状态、
无效页/cluster、计数溢出和缓冲区保护区。真实场景九项检查也通过：移走遮挡物和
切换到背面视角时，第一轮的零可见 cluster 在当帧第二轮恢复为全部八个；
另覆盖目标移动、正交视图、重新遮挡、隐藏及十三项非法 API 输入检查。

首轮实际场景触发了深度纹理被误当作可过滤纹理的 WebGPU 绑定错误。
shader format v33 将纹理仅 Load 的访问分析扩展到所有 shader，并重新 Cook 完整 Villa；
depth24plus、depth32float 和 R32F 的真实 UE HZB shader 回读均零误差。
失败运行、包和构建记录保留供证据采集器核对。packed 与无扩展原子配置的整包回归
分别运行 13,309/13,341 帧，上传、常驻、光栅、深度、材质、LOD、HZB 和清理检查均通过，
GPU 错误为零；开启/关闭分别 2,248/2,226 项启动管线全部完成且零失败。
双路径证据为 `tests/web-platform/evidence/nanite-browser-hzb-packed-20261109.json`
和 `tests/web-platform/evidence/nanite-browser-hzb-fallback-20261109.json`。

## 常驻微三角形混合光栅（2026-11-10）

实际 Nanite 页解码后的三角形按屏幕跨度选择 VS/PS 或 Compute。
Compute 处理完整位于裁剪体内且不超过 8×8 像素的三角形，采用 16.8 定点覆盖规则；
裁剪、大三角形和亚像素舍入有歧义的三角形交给硬件光栅。
两条路径写入同一可见性缓冲，核心 32 位原子设备仍先完成所有实例的深度阶段，
再完成 ID 阶段。`r.Nanite.WebMicroRasterSpan=0` 可用于纯硬件对照。

重复帧测试捕获了顶点靠近半个定点单位时的舍入差异，原先最大深度误差为
2.45×10⁻⁶。保留失败帧和对应构建，修复使用保守投影误差范围选择硬件回退，
没有放宽深度和材质误差阈值。大视口或较大视口原点可能让该范围覆盖全部舍入
区间，从而使用纯硬件；完整场景验收必须测量此成本，不能据专项测试声称性能达标。

独立 GPU 对照覆盖 2,048 个三角形、512 条共享边和 8 项非法输入，
其中 1,079 个三角形使用 Compute，覆盖/ID 零差异，最大深度差 1.20×10⁻⁷。
完整 Villa Cook 后，packed 与核心原子配置分别运行 42,315/42,526 帧，
每种配置还执行 128 次 50 实例重复帧，覆盖 11 种投影抖动，
混合光栅与硬件光栅的最大深度差均为 5.59×10⁻⁹，GPU 错误为零。
开启/关闭启动管线分别为 packed 2,251/2,229 和核心原子 2,250/2,228，
全部完成且零失败；延迟预缓存和失败注入检查通过。
证据为 `tests/web-platform/evidence/nanite-browser-micro-packed-20261110.json`
和 `tests/web-platform/evidence/nanite-browser-micro-fallback-20261110.json`。

## 真实 UMaterial 与 GPUScene（2026-11-10）

新增 `FWebNaniteVertexFactory`，复用原生 Nanite 顶点属性、GPUScene、
解析导数和 BasePass 材质代码。组件注册时从 LOD section 保存真实材质代理与
LCI，BasePass 按实际材质和光照策略选择 Cook shader，并通过占用瓦片进行
间接绘制。像素归属检查同时验证实例、材质槽和场景深度，保留普通几何遮挡。
入口为 `r.Nanite.WebMaterialGraphs`；当前默认关闭，整关卡自动启用尚未验收。

原生 shader 中的静态 Uniform Buffer 由 RDG 绑定，直接绑定只用于 shader
独有槽。首轮浏览器发现重复绑定断言，修复后保留原失败日志与构建记录。
测试夹具的 Root 清理顺序也已修正；冷启动时等待 PSO 预缓存延迟创建的代理就绪，
使用有界超时，避免空场景被提前判定或永久等待。

完整 Web 构建及包含三种真实材质资产的 Villa Cook 通过。两种设备配置分别
运行 3,551/3,428 帧、执行 9,564/9,281 次真实材质间接绘制，均实际使用三种
材质 shader。十项检查覆盖 Unlit、DefaultLit、法线贴图、MID 颜色更新、
材质替换、旋转、隐藏、注销/恢复、运行时法线纹理替换和参数恢复；组件清理后
继续运行，GPU 错误为零。基础色误差不超过 0.260 个 sRGB 码值，法线夹角余弦
最大误差 0.00214（阈值 0.003）。夹具不提交 fallback 三角形。

`tests/web-platform/evidence/nanite-native-materials-20261110.json` 保存源码、
构建、Cook 和运行包校验信息；完整像素回读、WGSL 和运行日志以无损 gzip/base64
保存于同一文件。独立管线检查还验证了三个真实材质的 HLSL→WGSL 编译及管线创建。
该证据不关闭 lightmap、Substrate、全部材质排列和完整关卡画面对照验收。
同一运行包的现有完整回归运行 42,089 帧，GPU 错误及启动管线失败为零，
包含 128 次混合光栅重复帧、13 项实例和 10 项真实场景捕获。

## 原生速度与 stencil/shading mask（2026-11-10）

常驻刚性不透明路径在场景深度之后输出原生 shading mask 与速度缓冲。
速度直接调用 UE 的 CalculateNaniteVelocity，读取真实 GPUScene 上一帧变换；
静止物体保留原生零值语义，由时间重建处理相机运动。
材质 BasePass 消费生成的 shading mask。WebGPU 的 stencil reference 为每次绘制固定，
因此用七次有深度归属检查的绘制清除并写入 shadow、ray representation、
lighting channels 和 decal bits，保留普通几何及其他 stencil 位。
光照通道 0 按原生 stencil 约定反相存储，后续 CopyStencilToLightingChannels
读取实际 stencil 并输出原生光照/阴影标记纹理；不会向多视图数组追加无序遮罩。
七次 stencil 绘制的成本仍须纳入完整场景性能验收。

浏览器发现 stencil metadata 的 MaintainCompression transition 被拒绝，现仅为
真实深度/stencil 资源的 stencil plane 支持该标记，仍执行访问状态与 Begin/End
生命周期检查；非法 depth raw、UAV 和额外标记继续拒绝。原生 RHI 的 14 项检查通过。
着色器还修正了局部 Primitive.Flags 被 UE Uniform Buffer 预处理误展开的问题。

两种设备配置各完成九项真实帧回读：静止、实例运动、相机运动、旋转及镜像非均匀
缩放、同时运动、三种光照通道与标志更新、普通网格遮挡、正交投影、相机切换当帧。
速度 XYZ 通过独立矩阵重投影核对，XY 在原生 gamma/16 位量化界限加浮点误差内，
Z 最大误差 5.97×10⁻⁸。回读位于原生光照通道复制之后，也验证该消费者的最终结果。
两种配置分别运行 1,313/1,130 帧，GPU 错误为零；原有十项材质回归也重新通过。
证据为 tests/web-platform/evidence/nanite-native-composition-20261110.json，
同一文件无损保存两种配置的速度/遮罩、材质像素、WGSL 和日志。
同一包的完整回归运行 44,687 帧，GPU 错误为零；开启/关闭启动管线分别
2,252/2,230 项全部完成且零失败，包含 128 次重复帧和十项场景捕获。
本项不代表变形几何、流送页、完整关卡时间重建或画质/性能验收完成。

## 有界原生页流送（2026-11-10）

启动参数 `-WebNaniteStreamingPages=N` 与常驻根页预算一起启用有界流送池，
总字节数受实际 WebGPU storage binding 上限限制。复用原生 ReadbackManager、
异步 bulk IO、LRU、页依赖、相对编码转码、安装/卸载 fixup 和质量缩放。
Web 的可见叶节点使用标量原子提交原生格式请求，避免分歧控制流中的 subgroup
操作被 WGSL 校验拒绝；缺失细节由原生 STREAMING_LEAF 父簇继续覆盖。

所有裁剪、HZB、光栅、材质与速度/遮罩路径使用同一个流送页数量和 GPU 地址规则。
安装后上传页归属表，按活跃资源版本关联根页；外来/过期页在被读取之前拒绝。
流送模式仍是显式入口，不能据此视为完整关卡已自动启用。

专项资产包含 65,024 个输入三角形和 1,059 个簇：流送版 1 个根页加 11 个
流送页，另有同几何全常驻版及第二个流送资源。12 页预算迫使两个资源互相淘汰。
测试不提交 fallback 三角形，读取实际 GPU 请求、归属表、裁剪状态、深度和遮罩。
九项检查覆盖粗模首帧、全常驻对照、细节补齐、资源切换淘汰、热缓存重载、
资源版本更新、远距离 LOD、真实 HZB 和原生页池重置。注入一次 bulk IO 失败后，
原生重试一次成功；两种原子能力配置均通过，六组 964 像素的覆盖和深度零差异。
故意替换页归属表也会得到明确拒绝。

资源重建曾暴露 Web RHI 对 CreateNull 索引缓冲仍读取空 CPU 数组的断言。
已按原生语义保留零大小占位符，不分配 GPU 存储或访问数组；两个原生回归检查通过。
原始失败报告保留，设备丢失恢复仍需独立实现与验收，不能以页池重置代替。

证据：`tests/web-platform/evidence/nanite-native-streaming-20261110.json`。
专项两种配置分别运行 2,225/2,306 帧；同包完整回归分别运行 42,483/41,468 帧，
GPU 错误为零，开启/关闭启动管线各 2,254/2,232 项全部完成且零失败。
真实材质与速度/遮罩双配置复测通过；全部证据核对源码、完整链接、Cook 和包的哈希。

## 设备丢失后的运行时重建（2026-11-10，专项验收通过）

依据 WebGPU 的设备丢失语义，旧设备的资源不能继续复用。页面收到真实
`device.lost` 后终止旧引擎 Worker，替换已转移的 Canvas，重新请求适配器和设备，
从已校验的持久缓存重新加载引擎与 Cook 数据。最多自动重建两次；正常销毁
`destroyed` 不触发恢复，普通 GPU 校验错误仍然失败。

所有输入监听、尺寸观察器、DPI 计时器、帧调度端口、性能 HUD 和 RPC 都统一清理。
旧代次通知不能改变新运行时；原生预初始化失败也进入同一清理流程，修复了
连续 GPU 故障后页面报错但 Worker 和“恢复中”状态仍保留的问题。

相机检查点包含位置、旋转、FOV 与 Pawn/相机目标类型，重新加载后自动恢复。
应用可通过 `startWebEngineWorker` 的 `recovery.capture/restore` 保存和恢复动态状态；
捕获数据须可结构化克隆，恢复回调使用新运行时提供的 `rpc`。
这里重启 UE 世界，不是保留整个任意运行时世界的原地 RHI 重建。

专项使用隔离浏览器的 `Browser.crashGpuProcess` 触发真实 `unknown` 丢失。
默认浏览器设置下检查恢复和连续故障后的设备拒绝；重复故障诊断仅在独立测试
进程使用 `--disable-domain-blocking-for-3d-apis`，验证两次恢复和上限退出，
交付页面不需要该标志。对照包括旧子线程退出、真实页重新流送、相机、像素、
输入、缩放和 UI 清理。四组测试均通过，六次恢复各重新流送 1,059 个簇，
964 个采样像素的深度和遮罩差异均为零；每次 30 个旧 Worker 全部退出。
普通 Error 和同名 OperationError 的独立注入均正常失败并清理，未误触发自动恢复。
冷启动不使用恢复期限，后台恢复暂停超时计时；这两项及旧代次通知、恢复失败、
关闭页面、上限退出均通过生命周期检查。

同包完整回归分别运行 42,034 / 41,473 帧，GPU 错误为零；每种配置包含
128 次微三角形重复帧和十项真实多视图检查。开启/关闭的启动管线均全部完成且零失败。
证据归档为 `tests/web-platform/evidence/nanite-device-recovery-20261110.json`。
此前一次冷启动测试等待 180 秒超时未再次复现，已补完整启动诊断；原因尚未确认，
不能把增加诊断记录写作该超时已修复。

参考：[WebGPU 设备丢失](https://www.w3.org/TR/webgpu/#dom-gpudevice-lost)、
[Worker 终止](https://html.spec.whatwg.org/multipage/workers.html#terminate-a-worker)、
[Chromium GPU 故障注入](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-crashGpuProcess)。

## 有界页池压力验证（2026-11-10）

对真实流送球体分别设置 1、2、4、8、12 页预算，两个原子配置共运行
26,690 帧，90 个生命周期步骤和 60 组全常驻对照通过，GPU 错误为零。
预算小于完整细节依赖组时，原生父层级保持闭合；867 个内部采样点没有缺口，
964 个覆盖采样均一致，最大反向 Z 深度差为 0.000104845。
12 页预算下 1,059 个簇全部驻留，六类生命周期对照深度差均为零。
检查包含资产切换、资源重建、远近视角、HZB 返回和页池重置；这不替代完整关卡性能验收。
证据：`tests/web-platform/evidence/nanite-streaming-budget-20261110.json`。

## 材质单双面与反向剔除（2026-11-10）

光栅现从真实材质代理取得每个槽的有效性和单双面状态，同时组合实例镜像、
组件 ReverseCulling 和视图反向剔除。硬件片元和 Compute 微三角形使用同一语义；
不存在的材质槽不再参与可见性竞争。运行时更换材质后直接更新剔除状态。

独立 GPU 校验将 2,048 个三角形与固定功能的前面/背面/双面光栅对照，
7,715 个覆盖像素一致，其中 4,039 个由 Compute 处理，最大深度差为 1.19×10⁻⁷。
真实 Cook 的开放曲面分为单面与双面两个槽，两种原子配置的 44 项检查均通过，
分别运行 8,181 / 8,200 帧，GPU 错误为零。覆盖正反面、镜像、非均匀缩放、
组件反向剔除、正交投影和运行时材质替换，硬件/Compute 覆盖、材质槽及法线一致。

首次真实场景检查揭示资产生成器的三角形绕序与 UE 左手法线约定相反，
已修正开放曲面和流送球体的源三角形，未改动渲染器正面约定来迎合错误资产。
完整剔除/实例/多视图参考也加入独立背面判断；相机进入单面闭合球体时应为空。

重新 Cook 还复现了完全命中 shader-map 缓存时没有编译任务、因而没有清单的问题。
ShaderFormat 模块在引擎退出前补记录已加载类型；Cook 缺失清单时失败并保存报告。
新的 1,969 包 Cook 在零转换任务的情况下生成完整清单，严格打包检查通过。
同包两种配置完整回归分别通过 40,280 / 40,812 帧，GPU 错误为零。
开启/关闭的启动管线分别为 2,254/2,232 和 2,253/2,231 项，全部完成且零失败；
每种配置包含 128 次微三角形抖动帧和十项场景捕获。两种配置的九项流送专项
均通过，修正后的资产恢复到 1,058 个驻留簇；六组全常驻像素对照保持一致。
失败原因、修复后的 Cook、源码与构建哈希、独立 GPU 参考及场景回读归档于
`tests/web-platform/evidence/nanite-sidedness-20261110.json`。

## 尚未接通

CPU ISM/HISM 的实例距离剔除专项已完成（2026-11-10）。创建和运行时修改
保留组件的最小/最大距离，按原生包围盒中心及距离缩放做含边界的平方距离判定；
最大距离为零时取消范围。StartCullDistance 不被误用为最小绘制距离。
HISM 普通 CPU 树的查询返回 false，Web Nanite 直接保存组件范围，避免漏画策略。
真实 Cook 的球体和材质经正常组件路径自动加入，不修改 fallback 三角形。

两个原子配置各 17 项检查通过，分别运行 3,549/3,502 帧，GPU 错误为零；
覆盖端点、空范围、关闭范围、缩放、调试开关、相机移动、注销/恢复、镜像缩放、
HISM 重排、删除和清空。独立计算与实际实例、GPU 层级状态及光栅回读一致。
同包默认关卡各八项回归分别运行 4,427/4,300 帧。新增实例材质 Cook 标记；
Cook 显式 Engine 参数现传入子工具并在退出时恢复原环境，修复误找旧 H 盘的问题。
证据为 `tests/web-platform/evidence/nanite-instance-distance-20261110.json`。
GPU-only 实例及其余视图/淡出策略尚未关闭。

默认场景同视角画面对照已完成专项（2026-11-10）：原生 SM6 的八个真实
Nanite 代理及关闭后的 fallback，与两种 Web 原子配置使用相同实际投影矩阵。
UE 的 MaintainYFOV 规则使请求 75° 对应当前宽屏水平 FOV 91.30865°；验收现
直接读取渲染投影，原生采集也记录并校验矩阵。修正原生采集在渲染初始化前
读取尚未填写的 ProjectionNoAA，并在开始采集时清除上轮成功状态。
截图去除网页性能浮窗，原灯光、天空、材质及相机位置均保留。

两种配置分别运行 4,285/4,283 帧，八项正常组件生命周期检查继续通过。
整图及八个材质区域的 Nanite 开关差异保持原阈值，最差区域均值
4.5065/255、P95 17/255；同时记录 Web/原生绝对颜色差异，避免以差分消去
平台差异后声称像素完全一致。原失败、实际矩阵、原生代理数、全部回读、
源码/构建/Cook 哈希与四图对照归档于
`tests/web-platform/evidence/nanite-default-native-20261110.json`。
该专项不代表高密度完整关卡或完整性能验收完成。

- 已执行有界常驻页光栅、真实场景深度和真实 Unlit/DefaultLit 材质图，
  显式材质支持跨实例分桶；完整 Nanite Renderer 的其余材质排列、lightmap、Substrate、原生 shading bin、
  变形几何和完整场景时间重建仍待完成。
- Nanite 完整关卡 Cook/打包加载验收、完整实例／视图类型和可见性策略，
  以及混合光栅在高分辨率、高密度场景中的性能验收。
- 页流送的完整关卡验收；设备丢失重建和五档小预算压力已通过上述专项。
- 默认带灯光天空的关卡验收，以及高密度资产性能与原生同视角对比。

`bSupportsNanite`、`bSupportsUInt64ImageAtomics` 和 Wave 平台声明保持原值；
RHI 的实际 wave 能力已按获授设备特性与 subgroup 范围填写。
不能据本轮检查宣称通用 64 位原子、全部 Nanite permutations、真实 Nanite 场景
或硬件光追已受支持。本轮结果也不能用于估计完整 Nanite 的帧耗时。

当前专项包使用重新 Cook 的完整 Villa 资源，真实组件材质已自动绑定，但 Nanite
仍由专项入口启用。继续补齐其余材质和视图策略、页流送及完整场景验收。

WPO 专项已实现并验收（2026-11-10）：可编程 VS 使用真实 Cook 材质和原生
Nanite 顶点重建，PS 保留 mask/PDO 竞争；组件/距离策略与 Always Evaluate 分槽
处理。旋转后的世界位移盒完整变换到局部空间，无法界定的位移跳过视锥/HZB
剔除并保留全视口材质范围。原生 base pass 输出变形 XYZ 速度，刚性材质继续
使用原来的合成投影，避免改变深度舍入。实际页流送、重试、淘汰与恢复均使用
同一变形路径。两种设备合计 268 项、107,900 帧零 GPU 错误，另有 32 个 shader
排列、52 项 HZB kernel 和 12 项参考拒绝检查；证据为
`tests/web-platform/evidence/nanite-wpo-20261110.json`。

浏览器内容缓存遇到配额错误时，持有排他锁清理失败写入，再回收无使用租约的
旧版本和无完成标记的文件，最多重试一次；持续空间不足返回明确错误，后续请求
可以重试。六类 OPFS 故障和跨标签页租约保护通过。该修复没有证明早先未复现的
180 秒启动超时与配额问题具有相同原因。Spline 和其余变形、完整材质/视图策略、
整场景时间重建与性能继续按照完成清单验收。

Spline 专项已实现并验收（2026-11-10）：正常 USplineMeshComponent 代理使用原生七组打包参数，并复用 Nanite 数值样条位置、法线、层级包围盒、LOD 球和误差缩放函数。参数逐帧读取，支持三个前向轴、曲率、滚转、平滑插值、边界、偏移、负截面缩放、组件镜像、单/双面、反向剔除和运行时注销/恢复；真实 WPO、遮罩、PDO 及材质速度继续经过原生材质图。层级流送和 HZB 也在变形后的边界上执行。Web 采用原生数值样条函数，未声称与缓存纹理采样模式逐像素相同。

修复 Tint 不允许无穷常量作为包围盒累积器、显式 FVector4f 数组默认初始化编译失败，以及运行时 Spline 旋转纹理使用 WebGPU 不支持的 RGBA16 SNORM 格式导致断言的问题。旋转缓存改为 RGBA32F，并显式保留有符号 16 位归一化量化，纹理占用由每像素 8 字节增加为 16 字节。原生 Nanite 前后帧均使用当前样条形状，因此仅改变形状的编辑速度沿用原生限制；实例运动、相机运动与 WPO 前后帧速度分别验证。

两种设备配置各 38 项 Spline 检查、各九项变形流送、五档页池预算以及同包 WPO/可编程材质/材质生命周期/合并开关速度合成/刚性流送回归共 452 项、176,775 帧通过，GPU 错误为零。独立样条参考与原生 HLSL GPU 对照 3,096 项通过，最大位置差 4.93e-5、法线分量差 3.28e-7；60 项 HZB kernel 和 28 项参考拒绝检查通过。保留所有失败定位、原始回读、源码/原生 shader/Cook/构建哈希及 16 张截图于 tests/web-platform/evidence/nanite-spline-20261110.json。

同包 WPO 正交运动回归发现参考值未转换到 R32F，导致恰好两个量化级的差异被未量化双精度尾差误判。检查现同时记录原始双精度误差和格式对齐后的误差，保留透视 1e-7、正交 1.2e-7 的原有阈值，并新增三个量化级错误注入的拒绝检查。保存了修正前失败及完整回放结果，未将失败运行计入通过帧数。

本项只关闭上述 Spline 范围；skinning、assemblies、curves、displacement、其余材质/实例/视图、完整关卡时间重建与性能继续按完成表推进。
