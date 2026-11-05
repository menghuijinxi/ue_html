# 编辑器流畅而 Web 首次编译停帧：案例与 UE 源码核对

2026-11-05。调查对象为本工作区 UE 5.8、WebGPU v70 运行期异步实验及用户观察到的编辑器体验。本轮研读公开一手资料和本地源码，没有重新测编辑器会话，也没有修改运行时或默认开关。

## 关键结论

上轮证明“对相同 HLSL，浏览器和原生 DXC 的单次计算成本接近”，没有证明“转动镜头时编辑器也在执行同一批 DXC”。编译耗时、调用时机、当前帧是否等待，是三个不同问题。

本地桌面 D3D12 RHI 消费的是已编译字节码；当前 Web RHI 消费的是 Cook 生成的 WGSL。在 UE 材质 ShaderMap 看来，Web shader 已经完成，但浏览器仍可能在创建管线时执行 Tint HLSL 生成、DXC 和驱动创建。因此，编辑器用于处理“UE shader 还没编译好”的异步与回退机制，并没有自然覆盖浏览器中后移的 DXC 工作。

| 阶段 | 桌面 D3D12 | 当前 WebGPU |
| --- | --- | --- |
| UE shader 编译产物 | DXIL 字节码，来自 Cook、DDC 或编辑器编译 | WGSL 和运行时元数据 |
| RHI 创建 shader | 从现有字节码初始化对象 | 调用 `createShaderModule` 接收 WGSL |
| 首次新管线所需工作 | PSO 创建；可命中会话对象、引擎/驱动缓存 | 还可能执行 WGSL → HLSL → DXIL，再创建 PSO |
| UE 材质 ShaderMap 未完成 | 有 DDC 查询、异步编译和 fallback | Cook 资源通常已被 UE 判为完成，浏览器 DXC 不会令它自动变回未完成 |
| 首次使用的普通异步 PSO 未完成 | 使用点存在等待 | 实验路径在命令列表翻译前等依赖；仍在帧的关键路径上 |

这解释了为什么单次编译一样慢，体感却可以差很多。用户那个编辑器会话究竟由哪些缓存命中、是否触发源码编译、是否创建新的驱动 PSO，仍需其时间线确认，不能由这张源码对照表断言。

## 网上可复核的案例

### WebGPU 首帧冻结及修复

[three-gpu-pathtracer #889](https://github.com/gkjohnson/three-gpu-pathtracer/issues/889)，2026-10-11：报告者在 Windows 11 / RTX 4080 / Chrome 154 上报告，冷缓存时最长帧 1.46–1.48 秒，异步准备并跳过尚未完成的 dispatch 后为 152–157ms；首个样本仍约需 1.58 秒。该数据由报告者测得，本机未复现。它体现的是减少编译对呈现的阻塞，并未把编译本身缩短到一帧内。

[修复 PR #893](https://github.com/gkjohnson/three-gpu-pathtracer/pull/893) 于 2026-10-28 合并：先绑定最终使用的 buffer，再异步创建内核，任务让出执行直到就绪。PR 另报告 M1 Max 的改善，也明确还有同步初始化造成的停顿。针对占位资源编译可能生成不同 WGSL，准备结果未必被真实首次绘制使用。

[three.js PR #34816](https://github.com/mrdoob/three.js/pull/34816)，2026-10-14 合并：此前 `compileAsync` 逐管线等待，改为最多 16 个并发，并在约 8ms 工作后等待浏览器下一次呈现机会。作者的 i9-13900K 场景从约 12.8 秒降到 1.5 秒。它是该场景的准备批次结果，不能作为本项目提升比例；单纯把同步 API 改成 async，也不等于任务已并行或持续有帧呈现。

### UE5 仍存在首次使用停顿

[Epic 的 PSO 文档](https://dev.epicgames.com/documentation/en-us/unreal-engine/pso-precaching-for-unreal-engine)在 Insights 示例中仍展示一次 117ms 的 PSO miss 卡顿；这相当于该单帧约 8.5 FPS，不是整段平均 FPS。UE5 并未获得“首次未完成管线也能立即正确绘制”的能力。

同页列出编译期间延迟组件代理、使用默认材质或继续使用并等待的选择，并建议加载画面等待未完成请求。它说明“流畅”可能来自工作已提前完成，也可能来自明确的可见性/材质取舍。

## UE4 到 UE5 的演进

[UE4.27 Shader Development](https://dev.epicgames.com/documentation/en-us/unreal-engine/shader-development?application_version=4.27)已记载：无缓存 ShaderMap 的材质异步提交编译，在完成后应用结果，实际编译由 ShaderCompileWorker 辅助进程执行。异步源码编译并非 UE5 新增。旧 API 的首次驱动编译仍可能在绘制时发生。

[UE5.1 发布说明](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5.1-release-notes?application_version=5.1)记录两条独立改进：编辑器 ODSC 默认开启，只编译实际需要的 shader，减少编辑阶段的总工作；DX12 开始在组件加载时更早准备 PSO。说明同样指出，刚加载就必须绘制、或传送后突然需要大量新材质，仍可能赶不及。ODSC 不等于已经准备完原生 PSO。

[Epic PSO 系统作者的技术文章](https://www.unrealengine.com/tech-blog/game-engines-and-shader-stuttering-unreal-engines-solution-to-the-problem)，2025-02-04：将 UE5.2 描述为自动 PSO precaching 的引入阶段，此前主要依赖采集后随包分发的 PSO 列表。文章以 Fortnite 为例，说明加载期、流送时的准备和驱动缓存共同避免首次使用停顿。这与 5.1 已有早期 DX12 改进并不矛盾；不能把“5.2 引入完整系统”理解为此前没有异步编译。

因此，UE5 体感改善可以有真实技术背景，但不能将用户的编辑器体验直接归因于打包游戏的自动 PSO precaching。下面的本地源码还有明确的编辑器排除条件。

## 本地 UE 5.8 的实际路径

以下行号对应引擎提交 `d5e91d5140667d6058ae34dd0532d89c817dd606`，路径均相对 `reference-engine/Engine/`。

| 源码位置 | 核对内容 | 对本问题的意义 |
| --- | --- | --- |
| `Config/BaseEngine.ini:2176` | worker 和异步 shader 编译开启；低优先级 worker、保留 CPU；完成结果处理目标预算 `.01` 秒 | 避免全部编译/结果应用挤在前台；预算是目标值，不是硬实时保证 |
| `Source/Runtime/Engine/Private/ShaderCompiler/ShaderCompilerJobCache.cpp:77` | `r.ShaderCompiler.JobCacheDDC=true`；缺省采用按需 shader job 缓存 | 当前不能简化成“所有完整 ShaderMap 一定在打开地图时编完” |
| 同上 `:181` | ODSC 使用逐 shader DDC 时不取完整材质图缓存；Cook 路径有不同条件 | DDC 与完整 ShaderMap 缓存需要区分 |
| `Source/Runtime/Engine/Private/Materials/MaterialShared.cpp:3057` | 根据模式查内存、DDC 或待编译 ShaderMap | 未完成不必立刻阻塞当前绘制 |
| `Source/Runtime/Engine/Private/Materials/MaterialRenderProxy.cpp:870` | `GetMaterialWithFallback` 检查完整性；找可用 fallback，编辑器提交编译任务 | 这是材质源码阶段的回退路径，不是任意未完成 PSO 都能自动替换 |
| `Source/Runtime/Engine/Private/Materials/MaterialShared.cpp:4501` | render thread 提交任务并避免重复优先级提交 | 保留异步完成模型 |
| `Source/Runtime/Engine/Private/ShaderCompiler/ShaderCompiler.cpp:2889` | 以时间预算处理完成的编译结果；特定 global shader 路径也会阻塞 | 编辑器流畅有条件，并非所有编译永不阻塞 |
| `Source/Runtime/D3D12RHI/Private/D3D12Shaders.cpp:168` | `InitShaderCommon` 从已编译数据读本机 shader code | 创建 RHI shader 不在此重新调用 DXC 编译 HLSL |
| `Source/Runtime/D3D12RHI/Private/D3D12Shader.h:86` | `GetShaderBytecode` 返回 `Code` | PSO 输入是字节码 |
| `Source/Runtime/D3D12RHI/Private/D3D12Pipelinestate.cpp:93` | 管线描述取 `Shader->GetShaderBytecode()` | 与 Web 的 WGSL 输入阶段不同 |
| `Source/Runtime/RHI/Private/PipelineStateCache.cpp:159`、`:4176` | 默认运行期异步 PSO，但受 RHI 能力等条件约束 | 它不是无条件启用，也没有取消使用依赖 |
| 同上 `:4896`、`:4918` | 未完成的运行期管线加入 command list prerequisite | 立即需要的 PSO 仍然可以卡帧 |
| 同上 `:4999` | `WITH_EDITOR` 下 `IsPSOPrecachingEnabled()` 返回 false | 不能用“编辑器默认自动预缓存”解释用户观察 |
| `Source/Runtime/Engine/Private/PSOPrecache.cpp:139`、`:164` | 组件预缓存、代理延迟也检查 `!GIsEditor` | 打包游戏的代理策略不应冒充编辑器默认行为 |
| 同上 `:34` | 新 CVar `r.PSOPrecache.ProxyCreationStrategy` 默认 1，0/1/2 对应直接创建/延迟/回退 | 公共文档仍使用旧 CVar 名；本地旧名已标 deprecated |
| `Source/Runtime/Renderer/Private/MeshPassProcessor.cpp:56`、`:1291` | 逐 draw 跳过 precache 中 PSO 的开关缺省 0，且需请求处于 Active | 不是“所有 UE5 绘制缺 PSO 就默认跳过” |

对于已经打开并使用过一段时间的编辑器，按需编译、DDC、已有 RHI/PSO 对象及驱动缓存都会改变“转镜头时剩多少工作”。“没有感受到编译掉帧”不能单凭体感推断“同一时刻仍编了同样多 HLSL，却神奇地没有等待”。也不能反过来断言用户会话完全没编译；本轮没有其 trace。

## 当前 Web 实现为什么没有得到同样效果

`tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp:1420`：加载 Cook 资源后通过 `WGPUShaderSourceWGSL` 创建模块。原生 bytecode 的就绪点在这里被 WGSL 模块的就绪点替代，浏览器中后续的 DXC 不属于 UE ShaderCompileWorker 队列。

同文件 `:3981`、`:4209`：运行期异步模式通过任务线程提交 owner，再由 `createRenderPipelineAsync` 回调完成请求。任务线程等待结果，owner 需要返回事件循环收回调。没有“PSO 未完成时继续使用该正确 PSO”的路径。

`reference-engine/Engine/Source/Runtime/RHI/Private/RHICommandList.cpp:240`：Web 为避免 owner 自等待，在命令列表翻译前使用 `DontCompleteUntil`。Windows 桌面将等待记录到命令使用点，可以先翻译较早命令；但较早翻译是否已经提交 GPU，要看提交边界，不能直接宣称消除了等待。

真实场景已有证据：运行期异步实验最长提交间隔约 205ms，详细 trace 的一次诊断约 247ms，均不能混称平均帧率；这类间隔倒数约为 4–5 FPS，可对应用户感受到的瞬间个位数。该证据支持临用管线导致停帧，不是本轮新增性能数据。独立同输入 DXC 计时已排除“同一 HLSL 在浏览器内编译数倍更慢”的解释，没有排除 Web 生成代码相对 UE 原始 HLSL 更复杂。

## 对后续优化的约束

应先分清两个目标：缩短必要编译的计算量，以及让必要编译少阻塞当前帧。前者要比较生成代码/变体/实际编译次数，后者要查使用依赖和实际 GPU 提交。把 API 改成 async 只覆盖其中一部分。

如借用 UE 的“就绪后再显示”方案，必须在材质/组件的多个 pass 一起处理就绪状态；简单跳过一个 base/depth/shadow draw 会带来缺物或 pass 不一致。默认代理延迟本身也会推迟出现，不能承诺无视觉代价。现有 ShaderMap fallback 不能直接知道浏览器某个 PSO 正在 DXC。

若坚持新物体立即正确显示、没有可用结果缓存、没有发现到使用的提前量、又不允许任何回退或延迟，那么几十毫秒的首次必要编译仍会落在关键路径上。UE5 官方方案也没有同时免除这些条件；它主要改变工作时机和未就绪时的处理。

最有区分力的下一次原生/网页对照应在同场景同转向标记下记录：编辑器的 shader job 是否增加、DXC 是否运行、PSO miss/创建耗时；网页从首次发现、提交编译、完成到 `queue.submit` 的时间。保留现有驱动缓存并记录状态，不以清全机缓存打乱用户环境。此项是后续验证建议，本轮没有假称已采集编辑器时间线。

研究证据索引：`tests/web-platform/evidence/editor-shader-stutter-research-20261105.json`；此前测量仍见 `same-shader-compile-20261105.json` 和 `runtime-async-pso-20261105.json`。
