# WebGPU 后端的 UE 引擎机制复用审查（2026-11-01）

GPUScene 接入后的下一轮，优先复用 **UE 共用资源表更新逻辑**，然后补齐 **并行绘制命令构建的前提**，再评估 **LocalVertexFactory 手动顶点读取**。三者分别对应当前绑定解析热点、CPU 工作并行度和大量顶点流绑定；目前只有 GPUScene 整体候选的帧率收益得到实测，不能给这些候选预报提升百分比。

审查基线：外围仓库 `a811df5`，引擎 `979705eea`，运行包 `villa-gpuscene-candidate`。核对了实际包内的 Web SM5 配置、现有 CPU/API 捕获，以及参考引擎与构建主机对应源码的 SHA。复核记录为 `tests/web-platform/results/web-engine-reuse-audit.json`。本轮为源码及既有捕获审查，没有新的帧率对照。

上一轮相同视角 ABBA 为 **12.052 → 19.896 FPS**；后台游戏按用户要求保持运行，存在 CPU/GPU 资源竞争。下述调用次数来自另外的插桩阶段，不与 ABBA 帧率混用。

| 顺序 | 尚未接入或只接入一部分的 UE 机制 | 当前证据 | 主要目标 |
| --- | --- | --- | --- |
| 1 | 共用 uniform buffer 资源表解析、脏标记、静态 uniform 应用 | Web 每次 draw 仍解析所有 shader 绑定；`CreateGroups` 是 RHI 热点 | 减少重复 CPU 工作 |
| 2 | 并行 MeshDrawCommand / RDG 命令录制，以及后续的并行 RHI 翻译 | 多项能力标志为 false；RHI 仍只有一个可变 context | 提高 CPU 并行度，分阶段实现 |
| 3 | LocalVertexFactory 手动顶点读取 | 实际包 `bSupportsManualVertexFetch=false`；约 8008 次 `setVertexBuffer`/帧 | 减少部分顶点流绑定，需权衡 shader 成本 |
| 4 | PSO 预缓存和异步预编译 | 三项 precache/file-cache/async 能力为 false | 减少首次遇到材质等场景的卡顿 |
| 5 | HZB 遮挡测试 | 平台能力 false，纹理结果回读接口不完整 | 评估减少可见绘制；收益需单独验证 |
| 6 | RDG transient allocator | RHI 返回默认空 allocator，使用 pooled 资源路径 | 排查显存占用，收益尚无资源账本支持 |

## 1. 资源表更新：有可以直接复用的 UE 公共实现

这不只是借鉴 DX12 的思路。DX12 和 Vulkan 都调用 [RHIUniformBufferUtilities.h:97](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/RHI/Internal/RHIUniformBufferUtilities.h:97) 的 `UE::RHI::Private::SetUniformBufferResourcesFromTables()`。它用 `ResourceTableBits & DirtyUniformBuffers` 筛选待更新的 UB，再枚举纹理、sampler、SRV、UAV 并交给后端 Binder。调用位置见 [D3D12Commands.cpp:1077](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/D3D12RHI/Private/D3D12Commands.cpp:1077)、[VulkanCommands.cpp:250](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/VulkanRHI/Private/VulkanCommands.cpp:250)。

静态 uniform 的槽位应用和校验也已有 [RHICoreShader.h:65](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/RHICore/Public/RHICoreShader.h:65) 的 `UE::RHICore::ApplyStaticUniformBuffers()`，两后端均使用。

Web 目前在自己的 `FWebGPUShaderData` 保存一份资源表，由 `ResolveUniform()`、`ResolveBinding()` 解析；[CreateGroups():2455](G:/UE_HTML/ue_html/tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp:2455) 每次遍历所有绑定，先解析当前资源，再判断 prepared entry 是否可复用。已经存在绑定组缓存和 encoder 状态去重，但命中缓存之前的解析开销仍会发生。

候选 RHI profile 约 6.20 秒，包含等待：`CreateGroups` 最大同名条目 self 318.14ms，`ResolveBinding` 88.32ms，`ResolveUniform` 69.97ms。这是采样开销证据，不是可直接相加后换算 FPS 的节省预测。

接入方向：将 shader 资源表及 static slots 接到 FRHIShader 的标准元数据，用 UE 公共 helper 处理资源表更新，WebGPU Binder 负责 slot 到 WGSL group/binding 的转换。UB、shader/PSO、静态绑定改变时标脏；将稳定的组描述保存起来，在 draw 时只处理失效部分及动态偏移。

还必须覆盖纹理流送导致的 TextureReference 替换、UB 更新、视图及访问状态变化、缓存淘汰和资源寿命。现有代码特意在缓存命中前重新解析，以捕捉未重新绑定 UB 的纹理替换；直接删掉这些检查会引入旧资源引用。UE helper 能替代公共解析与校验，WebGPU BindGroup 的生命周期仍需后端实现。

此前已拉取的大型 WebGPU 引擎也采用修改入口标脏、提交阶段只处理变化的方式，具体源码对照见 [大型实现调查](UE58_WEBGPU_IMPLEMENTATION_COMPARISON.md)。本轮进一步确认，可以优先复用 UE 自己的公共函数。

## 2. 并行绘制：已有三个主线程，仍未用满 UE 的并行路径

候选运行记录的 Game、Draw/Render、RHI 线程 ID 分别为 **2、14、1**，共享内存及引擎 Worker 已启用，另有 Task / auxiliary Worker。问题在于 [WebGPUDynamicRHI.cpp:473](G:/UE_HTML/ue_html/tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp:473) 仍声明：

```cpp
GRHISupportsRHIOnTaskThread = false;
GRHISupportsParallelRHIExecute = false;
GSupportsParallelRenderingTasksWithSeparateRHIThread = false;
GRHISupportsMultithreadedResources = false;
GRHISupportsMultithreadedShaderCreation = false;
```

这些标志确实挡住了引擎路径：

- [RHICommandList.cpp:1924](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/RHI/Private/RHICommandList.cpp:1924)：使用独立 RHI 线程时，第三项为 false 会关闭 latched parallel algorithms。
- [RHICommandList.cpp:1569](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/RHI/Private/RHICommandList.cpp:1569)：不支持 parallel RHI execute 时禁用并行翻译。
- [RenderGraphPrivate.cpp:616](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/RenderCore/Private/RenderGraphPrivate.cpp:616)：RDG 并行 setup / execute 还依赖多线程 shader 创建能力。
- [MeshDrawCommands.cpp:1686](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/Renderer/Private/MeshDrawCommands.cpp:1686)：已有引擎绘制任务拆分及并行 command list 路径，应复用这些调度逻辑。

应分两层接入。先让引擎在多个任务上安全构建 CPU 绘制命令；再研究多个 RHI context 并行翻译/编码。前者也需要检查资源及 shader/PSO 创建的线程约束，不能只修改能力标志。

当前 [RHIGetCommandContext():3088](G:/UE_HTML/ue_html/tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp:3088) 返回同一个 `this`，检查 owner 和唯一 Encoder；渲染 pass、绑定及可变状态都放在该对象上。因此并行 RHI 需要独立 context 状态、句柄访问及提交顺序设计。不能把相同对象交给多个 Worker 后直接宣称启用并行。

## 3. 手动顶点读取：GPUScene 接通后仍有独立缺口

实际 Cook 包的 SM5 能力为：GPUScene=true、vertex shader SRV=true，但 manual vertex fetch=false、typed buffer SRV=false。后两项与 GPUScene 的结构化数据读取不是同一项能力。

[LocalVertexFactory.cpp:601](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/Engine/Private/LocalVertexFactory.cpp:601) 已实现非编辑器构建在支持 manual fetch 时省去切线/法线、颜色、UV 等固定输入的路径；位置流仍保留，颜色还受具体数据条件影响。应接回该 vertex factory 逻辑，而不是另写一套网格提交。

候选包仍有约 **8008.5 次 setVertexBuffer/帧**，虽然已少于旧包的 11197.4 次，仍值得针对这条路径评估。接入需要补齐实际网格格式的读取与解码，包括打包切线、归一化颜色、半精度 UV，以及 stride、边界和默认资源；不能只提供少量 R32 类型就打开完整能力。还需检查每阶段 storage buffer 限额，重新 Cook 材质排列，并对比减少 CPU 绑定是否抵得过新增 shader 读取成本。只能预期减少部分流绑定，不能据调用次数承诺帧率。

## 4. PSO 预缓存：主要解决卡顿

[WebGPUDynamicRHI.cpp:478](G:/UE_HTML/ue_html/tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp:478) 关闭了 AsyncPipelinePrecompile、PSOPrecaching 和 PipelineFileCache，创建管线走同步 `wgpuDeviceCreateRenderPipeline` / `wgpuDeviceCreateComputePipeline`。

UE 上层运行期 PSO 缓存仍在使用，缺的是提前准备、异步完成及文件缓存能力。WebGPU 提供异步创建管线的 API，可考虑接到 UE 现有预缓存请求和完成状态；DX12 的原生管线缓存数据不能直接交给 WebGPU。参见 [WebGPU 规范](https://www.w3.org/TR/webgpu/#dom-gpudevice-createrenderpipelineasync)。应使用首次进入区域、转身及首次材质出现时的帧时间尖峰验证，不能当作固定视角持续低帧率的主要解释。

## 5. HZB 遮挡：平台关闭，但已有其他遮挡路径

实际包 HZB capability=false，但硬件遮挡查询已运行，候选插桩约 **380.4 次 beginOcclusionQuery/帧**，引擎记录有成功回读和零像素结果；GPUScene 实例剔除也已接入。

[SceneVisibility.cpp:124](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/Renderer/Private/SceneVisibility.cpp:124) 当前源码 `GHZBOcclusion=0`，项目 Config 未检出显式覆盖。[3228 行](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/Renderer/Private/SceneVisibility.cpp:3228) 同时检查平台支持和 cvar。因此只把平台能力改为 true，不会自动选择 HZB；现有诊断没有记录该 cvar 的运行值，应补测而非当作已知值。

接入障碍还包括 [FHZBOcclusionTester::MapResults():846](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/Renderer/Private/SceneOcclusion.cpp:846) 的纹理结果回读/Lock；Web 的 [RHIMapStagingSurface:104](G:/UE_HTML/ue_html/tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUUnsupportedRHI.h:104) 仍未实现。需要非阻塞回读和结果未就绪时的保守可见策略，然后再判断是否优于当前查询路径。项目画质设置应继续按用户配置保留。

## 6. RDG 临时资源：显存排查方向，需要区分池复用与堆别名

Web 未覆盖 `RHICreateTransientResourceAllocator()`，继承 [DynamicRHI.h:312](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/RHI/Public/DynamicRHI.h:312) 的空返回；[RenderGraphBuilder.cpp:1821](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/RenderCore/Private/RenderGraphBuilder.cpp:1821) 相应采用 pooled texture/buffer 路径。因此 **UE 的 RDG 资源池已有复用，native transient allocator 尚未接入**。

不能把 DX12 放置资源、显存堆别名实现直接移植到 WebGPU。可先沿用 UE 的生命周期和资源池管理，核对纹理/buffer 数量、峰值、可复用时机、缓存引用和延迟释放，再判断哪些额外分配属于 WebGPU 限制、哪些是后端保留过久。当前没有逐资源账本证明这一缺口解释了全部显存差距，也没有证据把它列为本关卡的首要 CPU 瓶颈。

## 已经复用的机制及必要适配

- **GPUScene、实例剔除、MeshDrawCommand 排序/缓存与动态实例化路径**：候选包已使用；整体实际绘制由约 6134.2 降至 3145.0 次/帧。
- **纹理流送**：候选记录 613 个 streamable 资源，resident/requested mips 均为 5728，maximum 7241；resident 约 460MiB，完整 mip 链约 2535MiB。它不是所有纹理全量常驻的状态。
- **阴影缓存**：Web 六面点光阴影仍调用 UE 阴影绘制和 CSMSceneExtension 缓存路径，不能说阴影缓存全部未启用。`WholeSceneShadowmap` 仍约 1439 次 draw/帧，但没有证明这些都可以跨帧缓存。
- **TaskGraph、独立 Draw/RHI 线程、RDG、资源池、运行期 PSO 缓存**：已经存在；需要核对具体被禁用的分支，不能整项重写。
- **点光六面绘制**：当前是 Web 的适配路径，桌面依赖的 geometry shader 等机制不能原样复制；WGSL 只定义 vertex、fragment、compute 三种阶段，见 [WGSL 规范](https://www.w3.org/TR/WGSL/#shader-stages)。可继续研究减少临时面纹理/复制，但它不是“未调用现成单通道接口”这样简单的问题。

GPU 粒子/排序、SkinningScene、虚拟纹理等还存在能力缺口。这些主要是功能覆盖，本次静态别墅捕获没有证据表明补齐它们会显著改善帧率；项目已关闭的 Lumen、虚拟阴影不作为本轮候选。

## 建议下一轮验证

先完成第 1 项的最小接入，保留现有绑定校验，对比正确性、流送后的纹理替换、`CreateGroups`/资源解析 self 时间、RHI 工作时间及无插桩帧率。第 2 项先验证并行 CPU 录制，独立测 Draw 与 RHI；第 3 项独立 Cook 并检查实际顶点流减少量和 GPU 成本。每项分别验证，保持相同项目设置、视角与测量环境，避免一次打开多项后失去归因依据。
