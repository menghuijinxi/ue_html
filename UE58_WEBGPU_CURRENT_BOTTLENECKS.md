# 当前 Web 性能瓶颈与可复用方案（2026-11-02）

2026-11-04 最新复核：绑定计划、TLV 共享和 GPUBuffer 上传页均未确认稳定 FPS 收益，不能继续仅凭 RHI 热点占比确定优先级。[帧调度与异步遮挡查询诊断](UE58_WEB_FRAME_SCHEDULING_DIAGNOSIS.md) 已对 Game 经 RHI owner 请求下一帧的串行路径做运行时对照；后续优先处理帧生产节奏与异步结果消费，再评估减少绘制/dispatch 的结构性改动。以下按时间保留各阶段证据，较早数值不是当前基线。

2026-11-04 GPUBuffer 实验：Lock/Unlock 上传页复用使创建量约减少 80%，同包 ABBA 平均 FPS +0.73%、RHI 墙钟减少约 0.19 ms/帧；尚未确认稳定帧率收益，保持默认关闭。见 [生命周期与验证边界](UE58_WEBGPU_BUFFER_LIFECYCLE.md)。

2026-11-04 更新：最新完整 mimalloc 包的逐帧、GPU 服务时间线和 Worker 栈复测见 [mimalloc 之后的优化空间](UE58_WEB_POST_MIMALLOC_OPPORTUNITIES.md)。当前固定视角约 76.6–76.9 FPS、1% Low 约 32.5，首次转向仍有 331 ms 长帧；绑定未命中准备、TLV、资源生命周期和唤醒排队的具体证据与验证顺序以新报告为准。下文保留历史版本结果。

桌面端补充实测见 [D3D12 并行绘制对照](UE58_NATIVE_PARALLEL_DRAW_BENCHMARK.md)：默认约 155 FPS，关闭 RHI 并行翻译后约 144 FPS，开启收益 7.84%；被测绘制录制、Mesh 准备及翻译一起关闭后仍约 145 FPS。原生 `.utrace` 确认翻译从工作线程收回 RHIThread。当前证据没有支持仅靠这些并行差异就能解释 Web 约 53 FPS；还需要降低串行路径成本。此测试保留其他任务并行，SM6 / TSR 与 Web SM5 / TAA 的差异见报告。

现有证据最支持：主要限制在 **RHI 线程每帧翻译绘制命令、准备资源绑定并调用浏览器 WebGPU API 的 CPU 工作**。阴影深度提交是其中最大的绘制来源。GPUScene 减少了实际提交数量，因此收益明显；其余候选大多没有继续减少这条路径的工作量。

本轮重新分析 11 月 1 日游戏关闭后的现有捕获，核对本地 UE、Diligent、Babylon、PlayCanvas 源码，并检索上游实现及规范。没有产生新的帧率 A/B，没有修改项目设置或渲染实现。

后续实施结果见 [整组绑定与阴影实测](UE58_WEBGPU_BINDING_GROUPS.md)：整组快路径四轮约 50.32 → 50.40 FPS，未获显著提升；新日志已确认 CSM 缓存运行值为 0，CSM 命令实际从 3928 合并到 1440。以下保留研究阶段的原始测量与待验证边界。

后续按用户要求临时关闭局部光的 [四轮定位](UE58_WEBGPU_LOCAL_LIGHTS.md) 得到 **52.77 → 82.74 FPS**，RHI **14.29 → 9.22 ms/帧**。局部光相关阴影 pass 消失，而 CSM 仍约 1439 draw/帧，确认局部光工作占明显成本，CSM 等剩余提交也需继续定位。

## 测量支持什么结论

原始测量和环境条件见 [无游戏干扰复测](UE58_WEBGPU_IDLE_RETEST.md)。当前资源表候选的正常四轮结果为 **51.51 FPS，约 19.41 ms/帧，RHI 工作约 14.65 ms/帧**。Game、Draw/Render、RHI 均已独立运行；三个线程的时间会重叠，不能相加。

| 当前每帧观察 | 数值 | 含义 |
| --- | ---: | --- |
| `drawIndexed` | 2988.45 | GPUScene 后仍有大量 CPU 发出的索引绘制 |
| `drawIndexedIndirect` | 86.00 | 已有间接绘制；不代表其余绘制全部由 GPU 驱动 |
| `setVertexBuffer` | 7966.88 | 顶点流绑定仍密集 |
| `setIndexBuffer` | 2232.11 | 网格切换仍有较多状态提交 |
| `setBindGroup` / `createBindGroup` | 1398.48 / 81.84 | 已有缓存，但绑定准备成本没有消失 |
| `submit` | 12.04 | 有多次提交；目前没有证据证明它是首要热点 |
| 3 个 GPU 采样帧的 pass 耗时合计 | 6.88 / 6.09 / 4.33 ms | 不含复制和间隙，不能等同完整 GPU 帧时间 |

API 数量来自独立插桩窗口的 188 个呈现帧，可能包含首尾边界误差；正常 FPS 来自无插桩四轮测量。CPU 采样中 `SetDrawBindings` 包含时间约 9.02 ms/帧，`CreateGroups` 约 5.34 ms/帧，顶点 buffer 的 C API 桥接约 3.51 ms/帧；这些时间有包含关系、受采样扰动影响，不能相加或直接从正常帧时间中扣除。其他 GPUScene 开启的捕获同样显示绘制绑定路径占较多 CPU 工作。

采样也能产生误导：当前资源表候选中，PSO hash 看起来有约 3.35 ms/帧 self，但其中一次样本间隔就达 665 ms；copy owner wrapper 的约 3.67 ms/帧全部来自一个 738 ms 样本间隔。其他捕获没有重复该现象。这可能包含调度或录制停顿，不能据此宣布 PSO hash 或单次 buffer copy 是稳定瓶颈。新分析保留并标记长间隔。

当前还缺同视角、同内外部渲染尺寸、同资源状态的 DX 逐 pass 捕获。桌面截图的 147 FPS 与网页测量尚不能作为严格性能比值；GPU 采样也不足以承诺最终可达到的帧率。

## 新确认的重点：阴影深度占约 65% 的绘制调用

以下汇总 direct/indirect draw 调用，不是三角形数，也不是 CPU 或 GPU 时间占比。

| Pass 标签 | draw/帧 | pass/帧 |
| --- | ---: | ---: |
| WholeSceneShadowmap | 1439.22 | 4.00 |
| ShadowDepthAtlas | 486.81 | 70.00 |
| WebCubeShadowFace | 84.00 | 6.00 |
| CachedShadowDepthMap | 31.00 | 3.00 |
| 阴影深度合计 | **2041.03** | |
| 所有绘制合计 | **3122.11** | |
| SceneDepthZ | 582.10 | 5.00 |
| SceneColor | 290.50 | 66.00 |

另外三个 GPUScene 开启的捕获得到相同方向：阴影深度占比 65.31%–65.43%。

`ShadowSetup.cpp:6188` 的 `AllocateCSMDepthTargets()` 使用 `WholeSceneShadowmap` 名称，因此最大的这项关联 UE 的 CSM 目标。当前标签没有灯光、级联、caster 和失效原因等身份，尚不能判断这些绘制是否多余。应继续检查各 pass 的静态/动态 caster、命令合并前后数量，以及缓存模式。

Web 点光阴影的六面路径确实不同于 DX 的分层输出路径，但这里的 WebCubeShadowFace 只有约 **2.69%** 绘制调用。只改善它不能解释或消除当前主要提交量。

## UE 自身有哪些机制

1. **缓存 MeshDrawCommand 和自动合批**。UE 的 retained mesh pipeline 缓存绘制描述，对相同 shader bindings 的命令进行 dynamic instancing；GPUScene 用 PrimitiveId 区分对象数据。这些机制已进入当前 Web 路径。下一步应复用 `r.MeshDrawCommands.LogDynamicInstancingStats` 及 `FInstanceCullingContext::SetupDrawCommands()` 的合并统计，查清阴影命令为何不能进一步合并。不能把“GPUScene 已开启”理解成所有网格都能合成一条 draw；材质、网格、lightmap、顶点数据和绑定不同都会限制合并。[UE Mesh Drawing Pipeline](https://dev.epicgames.com/documentation/en-us/unreal-engine/mesh-drawing-pipeline-in-unreal-engine)
2. **阴影缓存**。UE 有 Point/Spot 的 WholeScene shadow cache，也有非 VSM 的 CSM caching/scrolling 路径。当前源码 `ShadowSetup.cpp:126` 的 WholeScene 缓存默认 1；`:453` 的 `r.Shadow.CSMCaching` 实际初始化为 0，虽然其帮助文字写了 default。后者运行值未被现有捕获记录，不能只凭默认值断言项目状态。CSM 缓存实现在 `:4020`，会检查矩阵、尺寸、静态物体和滚动区域等条件。当前捕获已有 CachedShadowDepthMap，六面 Web 路径也复用了 UE 静态深度缓存；不能笼统地说所有阴影缓存都没接入。应先记录命中、失效和 caster 身份，再判断后端缺口。项目既有设置继续作为基准。[UE 阴影缓存条件](https://dev.epicgames.com/documentation/unreal-engine/movable-light-mobility-in-unreal-engine)
3. **D3D12 的状态脏标记及描述符缓存**。`D3D12StateCache.cpp:543` 在 VB 脏时提交，`:1515` 比较新旧顶点流；shader 资源也按脏状态提交。当前 Web 在 `SetDrawBindings():3906` 已比较 VB/offset，`:3927` 已比较 group/offset，因此再加同样的 encoder 去重不会自动带来突破。更大的差异是 Web 在知道整组能否复用前，仍执行绑定项遍历、版本和访问检查、描述符与动态 offset 组装、缓存比较。D3D12 原生描述符堆不能直接当浏览器 BindGroup 使用，需要在 Web RHI 适配这些生命周期。
4. **并行命令生成**。UE 已能把上游录制分散到任务线程；本项目验证了真实 task worker 执行。但当前 Web RHI 的实际浏览器编码仍在一个 owner worker。并行录制没有减少下游 API 数量，因此暂未降低帧时间。不能仅设置 `GRHISupportsParallelRHIExecute=true` 就得到正确的多线程 WebGPU 执行。

PSO 预缓存主要针对首次使用卡顿，RDG transient allocator 主要涉及内存生命周期；本次证据没有将其确定为稳态首要瓶颈。实例 HZB 最新四轮持平；传统 HZB 的结果消费仍存在障碍，尚不能宣称已解决遮挡剔除。

## 网上可直接参考的实现

| 实现 | 已有做法 | 对本项目的意义 |
| --- | --- | --- |
| Diligent WebGPU | 持久资源缓存；资源组未脏且动态偏移未变就跳过；只在组脏时创建 | 在绑定变更时更新结果，draw 消费准备好的组，减少整组重复准备 |
| Babylon WebGPU | draw/material 版本未变，直接返回整组缓存；fastBundle 可在获取绑定组前返回 | 缓存命中要尽早，避免每次先付完整解析成本 |
| PlayCanvas 2.23 | 对象矩阵持久 storage buffer、稳定槽位、脏范围上传，多 pass 共用 | 与 UE GPUScene 的方向一致；这部分收益不能在 GPUScene 开启后重复计算 |
| Figma C++/Wasm WebGPU | 编码多条 draw 后批量上传 uniforms；热点使用定制 C++/JS bindings | 大型 C++ Web 应用也需要控制桥接和资源准备成本，但我们的常量合并上传已存在 |

源码与实现说明：

- [Diligent CommitBindGroups](https://github.com/DiligentGraphics/DiligentCore/blob/f1a3a110e43337d46d691b3a55e911eb695499f9/Graphics/GraphicsEngineWebGPU/src/DeviceContextWebGPUImpl.cpp#L226)、[UpdateBindGroup](https://github.com/DiligentGraphics/DiligentCore/blob/f1a3a110e43337d46d691b3a55e911eb695499f9/Graphics/GraphicsEngineWebGPU/src/ShaderResourceCacheWebGPU.cpp#L519)。
- [Babylon 整组快速路径](https://github.com/BabylonJS/Babylon.js/blob/1b26881f8120797f5726b4aa23eaa16e62c479fe/packages/dev/core/src/Engines/WebGPU/webgpuCacheBindGroups.ts#L98)、[提前重放 Bundle](https://github.com/BabylonJS/Babylon.js/blob/1b26881f8120797f5726b4aa23eaa16e62c479fe/packages/dev/core/src/Engines/webgpuEngine.pure.ts#L3976)。当前 Web 的 `DrawIndexedBundle():3790` 先调用 `CreateGroups()` 才计算完整 key；旧实验没有跳过这一段。旧 Bundle 的约 1% 收益也来自 GPUScene 之前的包，不能当作上述结构的性能上限。
- [PlayCanvas PR #9614](https://github.com/playcanvas/engine/pull/9614)：作者 10K 静态箱体测试 CPU 14.37→8.31 ms，属于其 Chrome/Apple silicon 基准，不能换算成本项目预期收益。
- [Figma 的 C++ WebGPU 实践](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/)：确认 C++→Wasm→JS 与原生 Dawn 的差异，并说明批量 uniforms 和定制桥接；未将其二维应用的收益套用到 UE。

还找到一个 [Godot WebGPU 分支的 command stream 设计](https://github.com/Boulino/godotwebgpu/blob/webgpu-4.6.2/webgpu_notes/COMMAND_STREAM_RECORDER_PERF_OPTIM.md)：在 Wasm 内存中记录命令，再由 JS 批量消费，可作为缩减 Wasm→JS 次数的原型参考。该文档将核心架构列为后续计划，不能当作已交付的性能证明，其中估算也未在本项目验证。批量 JS 重放仍会调用浏览器 WebGPU，不能消除浏览器验证和 GPU 工作。

另外两项边界需要明确：

- 每次 WebGPU 调用不等于一次同步 GPU IPC。Chromium 使用 Dawn Wire 和共享内存传递序列化命令；优化目标应量到桥接、绑定准备和浏览器编码各自成本。[Chromium WebGPU 实现说明](https://chromium.googlesource.com/chromium/src/+/main/docs/security/research/graphics/webgpu_technical_report.md)
- 2026-10-30 的 [WebGPU 规范草案](https://gpuweb.github.io/gpuweb/) 中仍没有 `multiDraw*`。不能将原生 DX ExecuteIndirect 多命令提交直接视为当前稳定浏览器能力；现阶段可以使用 instancing、普通 indirect draw 和 render bundles。

## 后续优先级与通过条件

1. **绑定整组快速路径**：先记录各组 dirty 原因，将稳定结果保留在持久绑定对象中；分别跟踪资源身份、内容 generation、动态 offset 和访问验证。目标是稳定 draw 跳过整组组装/比较；缓存重算模式必须与快速路径结果一致。纹理引用变化、streaming、同帧多次 UB 更新、资源释放和页重用均应正确失效。
2. **CSM/ShadowDepthAtlas 的合批和缓存审计**：记录灯光、级联、cache mode、失效原因以及实例合并前后命令数；与同条件 DX 捕获对照。通过补齐引擎现有机制减少工作，先证明减少了哪些提交并保持画面，再测 FPS。
3. **稳定命令重放及桥接批处理原型**：稳定 draw 身份和绑定之后，让 Bundle 命中发生在昂贵准备之前；单独测批量桥接是否值得保留。JS 批量桥接与 Bundle 收益必须分别量化。

验收继续使用无游戏干扰的四轮交错测试，正常 FPS/RHI 时间与插桩分开；除了固定视角，还要覆盖移动、遮挡变化、材质与资源生命周期。当前结论足以确定实施方向，但不能预告优化幅度。

## 复现这次分析

```powershell
node tests/web-platform/analyze-web-bottlenecks.cjs --prefix=idle-20261101
```

输出为 [idle-20261101-bottlenecks.json](tests/web-platform/results/idle-20261101-bottlenecks.json)，保存输入 SHA256、四个捕获的逐 pass/API 汇总、选定函数采样与长间隔标记。它只分析现有结果，不运行浏览器，也不改变测量数据。
