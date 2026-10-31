# TriplexHouseVilla：复用 UE RHI 与原生性能记录

本轮按用户同意的方向处理 Web 平台适配，继续使用 UE 的 Renderer、RDG、MeshDrawCommand、TaskGraph 和 RHI 命令列表。项目配置与 Cook 内容未改。正式性能结论来自同机交错对照，不能与桌面截图的 147 FPS 直接计算精确差距。

## 已实现的适配

- Web RHI 为当前 render encoder 保存 vertex/index buffer、绑定组及动态偏移，仅把变化提交给 WebGPU；每次 render pass 开始和结束清空缓存，并保留资源引用。直接和间接 indexed draw 共用 index 状态。
- 已完成 staging readback 的 CPU 字节通过 acquire/release 发布，以互斥锁保护快照切换并保留至 Unlock。覆盖 UE 的 `LockStagingBuffer_RenderThread` 接口，只有 fence 就绪且没有待执行写入时才直接读取；其余情况保留引擎原有 flush/stall 路径。没有整体声明 RHI 支持任意并发资源访问。
- Sampler 的 CPU 描述创建无需同步到 GPU owner；实际 WebGPU sampler 仍在 RHI 所在线程创建。
- Buffer 使用 UE 自带的 `FRHIBufferInitializer`：CPU 描述和初始化字节在记录线程准备，Finalize 把 GPU 创建/上传排入原有 RHI 命令列表，由引擎保证先创建、后使用及引用生命周期。Buffer SRV/UAV 仍是 CPU 描述，实际绑定在执行阶段读取 GPU handle。
- 每次 draw 的绑定组整理采用 UE `TArray` / `TInlineAllocator`，替代临时稀疏哈希表。解析、访问检查和缓存键比较仍保留。

WebGPU 对象、绑定布局和命令 encoder 与 D3D12 不同，因此后端状态缓存需适配 WebGPU。上述改动没有另写场景遍历、渲染调度、剔除器或任务系统。

## 同条件 A/B

可见 Edge，原始出生相机，CSS 1863×1030，DPR 1.25，内部 1484×835、输出 2290×1288，AA=2。每次先完成至少 90 个游戏帧，再记录约 15 秒的 RHI 呈现次数。顺序 A→B→B→A，不同时编译或运行其他测试。

| 运行顺序 | 基线 A FPS | 候选 B FPS |
| --- | ---: | ---: |
| 第 1 次 | 17.77 | — |
| 第 2 次 | — | 19.94 |
| 第 3 次 | — | 19.85 |
| 第 4 次 | 17.18 | — |
| 按总帧数/总时间合计 | **17.48** | **19.90** |

这一组候选提升 **13.84%**，帧时间约从 57.22 ms 降到 50.26 ms。它仍不达用户预期。此前第一版只做状态去重、sampler 和 readback 适配，17.30→16.72 FPS，没有收益，未更新正式包；第二版再修正 buffer 同步创建及临时分配后才得到上述改善。

配置 SHA-256 两侧均为 `b130a60d69483856772c2dc588b696ad55c5f687f7b4fcc60137a09c91a6c77b`；内容包均为 `033f3799994bcc70ba111d125c2839b1e18ccc5790abbbb06a595189c0fa986e`。比较脚本同时校验相机、实际渲染尺寸和无页面异常。

原始证据：`tests/web-platform/results/adaptation-v2-abba.json`；初版的 `rhi-adaptation-abba.json` 保留失败收益证据。

## 调用栈复核与剩余瓶颈

[候选图表](http://127.0.0.1:8765/results/performance-capture-adaptation-v2.html) 的另一次基线为 19.95 FPS，CPU 采样时 19.31 FPS，逐 API/pass 计时时 14.45 FPS。计时探针明显影响性能，不能把采样阶段等同于原生帧时间。

- 原先 Draw 中 `GPUMessage → LockStagingBuffer → StallRHIThread` 的大段等待消失；第一版暴露的 `BeginOcclusionTests → RHICreateBufferInitializer → proxy_sync` 大段等待也消失。候选主要等待是 Render 线程的 TaskGraph 空闲，并不是该比例的 CPU 计算。
- RHI 的 `SetDrawBindings` 仍占完整采样窗口约 **48.79%**，其中 `CreateGroups` 约 **30.32%**，为包含关系。`TSparseArray::AllocateIndex` 已退出主要热点。后续仍应处理绑定解析、WebGPU 调用桥接与计算 pass 编码。
- 对比早先完整捕获，`setVertexBuffer` 约从 25,940 次/帧降到 11,219；`setIndexBuffer` 从 5,210 降到 4,174；`setBindGroup` 仍约 7,894。drawIndexed 约从 5,208 增至 6,091，createBindGroup 从约 296 增至 737。没有通过少画物体换帧率；异步遮挡/资源调度下的 draw 与缓存变化还需要继续分析。
- 三个完整帧 GPU render/compute pass 合计 **12.52、4.33、13.43 ms**。波动较大，且不覆盖 copy 与 pass 间空档；不据此宣称 GPU 问题全部解决。

图表原始数据、18 个 Worker 的 CPU profile、浏览器 trace、三帧 GPU 时间戳均已校验；Edge 中的线程切换、缩放、筛选和 PNG 导出通过。

## 稳定性

`project-gameplay-rhi-adaptation-v2.json`：两个独立启动各执行 45 秒 WASD、跳跃、鼠标转向及反复改变窗口尺寸，均无捕获到的崩溃、fatal 或 GPU validation 错误。分别推进至 906 / 479 个游戏帧，移动 156.6 / 164.6 cm，转向 45.2 / 48.9 度；Game=2、Render=14、RHI=1 的独立线程继续工作。不同启动的性能仍会波动，这些短时结果不能替代长时间用户压力测试。

## 复现命令

```powershell
Set-Location G:/UE_HTML/ue_html
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/compare-web-rhi-adaptation.cjs --candidate=villa-rhi-adaptation-v2 --tag=adaptation-v2
node tests/web-platform/capture-web-performance.cjs --folder=villa-rhi-adaptation-v2 --tag=adaptation-v2 --dpr=1.25
```

原生 Trace 使用 UE 的 TraceLog、已有 CPU/frame/task/RHI 命令事件及 `FTraceAuxiliary::Relay`，Web 层只提供线程、时钟、字节传输与下载接口。[Epic 的 Trace 开发指南](https://dev.epicgames.com/documentation/en-us/unreal-engine/developer-guide-to-tracing-in-unreal-engine) 推荐优先使用已有事件及分析器。

诊断目标 `UEWebEngineThreadsTrace` 通过 `UE_WEB_TRACE=1` 启用事件；普通目标维持 Trace 关闭，避免把采集开销混入性能包。WebAssembly 的时钟与 `FWebPlatformTime::Cycles64` 同为每秒一百万 tick；仅补齐 TraceLog 所需的平台服务。浏览器使用 Relay 下载，原生 TCP 输出不适用于 Web。

```powershell
pwsh -NoProfile -File tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -Trace -MaxParallelActions 6 -StandaloneCompiles
node tests/web-platform/package-web-project.cjs --project=triplex-project --desktop --threads --trace --distance-fields --reuse-cook --output-folder=villa-insights-candidate
node tests/web-platform/capture-web-ue-trace.cjs --folder=villa-insights-candidate --tag=villa-insights
pwsh -NoProfile -File tests/web-platform/export-web-ue-trace.ps1 -Trace tests/web-platform/results/villa-insights-0.utrace
```

诊断页右上角提供“录制 8 秒性能”，下载 `.utrace` 后可以用 Unreal Insights 打开。录制期间可以操作场景。自动捕获脚本同时验证按钮下载和同一页面再次录制；导出脚本调用安装版 Unreal Insights 分析文件并导出线程、定时器、事件和汇总 CSV，不自行解析或转换 Trace 协议。

这里接入的是 CPU、帧和任务等原生事件。WebGPU 的原生 GPU 轨道尚未接通，GPU 时间仍以已有浏览器时间戳图表为准。

## 原生 Insights 实际验证

`villa-insights.json` 两次采集均无页面异常：第一次通过页面按钮下载，第二次在同一运行实例重新开始、停止及下载。原版 `D:/UE_5.8/Engine/Binaries/Win64/UnrealInsights.exe` 成功分析两份文件，导出结果再以流式方式核对事件和线程。

| 文件 | 大小 | 有限事件时间跨度 | 原生定时事件数 |
| --- | ---: | ---: | ---: |
| `villa-insights-0.utrace` | 9,588,614 字节 | 8.066 秒 | 5,316,758 |
| `villa-insights-1.utrace` | 6,741,602 字节 | 8.125 秒 | 3,346,713 |

两份文件都有 GameThread、RenderThread、RHIThread 的实际事件，以及 WebGPU 绑定、绑定组解析、buffer 创建和提交的 UE CPU scope。结束录制时尚未退出的 scope 分别为 21 / 15 个，Insights 以 `+inf` 标识，验证器保留该信息并只用有限时间计算跨度。Trace 中线程 ID 属于 Trace 协议，不等同于浏览器 Worker 的 ID。

第一份捕获中 `WebGPU_SetDrawBindings` 累计包含时间约 3.594 秒，其中 `WebGPU_CreateGroups` 约 2.045 秒；两者有包含关系，不能相加。第二份对应约 3.573 / 1.789 秒。两个采样方式均指向 RHI 绑定开销，支持下一步继续针对该处优化。

Trace 目标录制前一次短测约 23.98 FPS，两次录制期间约 12.60 / 6.74 FPS。采集大量事件的额外开销很明显，不把这些数值作为普通包的性能结果，也不把累计跨线程等待当成单帧运算时间。普通目标默认不编译 Trace；诊断页用于定位调用关系及等待点。

诊断证据保存于 `tests/web-platform/results/villa-insights*.{json,utrace}` 及 Insights 导出的 `.threads.csv`、`.timers.csv`、`.events.csv`、`.statistics.csv`。事件 CSV 很大，校验使用逐行读取，避免一次加载数百万行占满内存。


## 对照 UE D3D12 的后续绑定缓存试验（2026-11-01）

本轮直接阅读参考引擎的 D3D12RHI 实现，未修改 D3D12：

- `D3D12Commands.cpp::BindUniformBuffer` 标记 uniform slot 为脏；`SetResourcesFromTables` 调用引擎 `SetUniformBufferResourcesFromTables`。后者取 `ResourceTableBits & DirtyUniformBuffers`，只枚举相关的变化槽，并清理 dirty 位。
- `D3D12StateCache.cpp::SetShaderResourceView` 比较新旧 SRV 指针，仅变化时标记槽。`ApplyResourceTables` 将当前 shader 的寄存器使用范围与 dirty mask 相交；只有需要更新的表才进入 descriptor 构建/提交。
- `DirtyStateForNewCommandList`、root signature / shader 变化，以及 descriptor heap 切换都会重新标脏。因此 D3D12 仍在 draw 前调用 commit，但不等于每次完整重建全部绑定。重复调用 uniform setter 仍可能标脏，底层资源槽缓存还会进一步去重。

对应源码为 `reference-engine/Engine/Source/Runtime/D3D12RHI/Private/D3D12Commands.cpp`、`D3D12StateCache.cpp`、`D3D12DescriptorCache.cpp` 和 `RHI/Internal/RHIUniformBufferUtilities.h`。

WebGPU 试验将准备好的描述符保存在每个反射 binding 上，源资源、uniform 内容版本、globals 版本及访问状态序号一致时复用。新 pass、transition Begin/End、CPU buffer/texture lock/unlock 均使访问校验失效。每次仍解析当前来源，因此 TextureReference 更换目标、静态 uniform 切换或资源表成员变化能立即生效；每帧清理保留的 RHI 引用。动态 offset 在复用原始 entry 后按当前 pipeline 的布局处理，不缓存为另一 pipeline 的归一化偏移。

这一步仍逐 binding 检查当前来源，没有声称已复用 D3D12 的整个 descriptor heap 实现，也没有跳过所有资源解析。D3D12 的资源类型和 root signature 不能直接用于 WebGPU；此处复用的是引擎已经采用的变化跟踪与按需提交方法，Renderer/RDG/任务系统继续走原有接口。

诊断控制 `r.WebGPU.ValidateBindingCache=1` 会对每个本应命中的 entry 走完整准备路径，比较 buffer、texture view、sampler、offset 和 size。该选项只验证后端缓存，不改变项目画质。测试入口：

```powershell
node tests/web-platform/probe-web-project-gameplay.cjs --folder=villa-dx-binding-candidate --tag=dx-binding-validate --runs=1 --seconds=45 --width=1863 --height=1030 --dpr=1.25 --require-render-threads --validate-binding-cache
node tests/web-platform/compare-web-rhi-adaptation.cjs --baseline=villa-rhi-adaptation-v2 --candidate=villa-dx-binding-candidate --tag=dx-binding
```


第一版试验的 `dx-binding-abba.json` 为 17.04 / 17.84 / 15.50 / 22.34 FPS，合计基线 19.69、候选 16.67 FPS（-15.36%）。每帧 RHI 执行时间约为 34.69 / 33.74 / 34.02 / 34.25 ms，只略有下降；两次基线自身也有较大波动。因此没有将这一版替换正式包。该结果保留，不用单次较快的数据宣称优化有效。

`project-gameplay-dx-binding-validate.json` 的 45 秒移动/转向/窗口变化通过，末次采样记录 14,289,749 次完整路径与缓存描述符比较，无不一致、fatal 或 GPU validation 错误；移动 152.15 cm、转向 31.50 度，GT=2、RT=14、RHI=1。最初诊断入口遗漏 GameThread task tag，已修复后重新构建和完成上述测试。

第二版补齐全局 sampler 的固定解析路线缓存，避免反复从 JSON 提取字段及查找名称；uniform slot 缓存注册的 immutable layout 元数据，仍每次取当前 static/shader uniform 并校验类型和 hash。Global sampler 只在 RHI 初始化时创建，解析路线持有引用。参考项目 `DefaultEngine.ini` 明确配置 `DefaultGraphicsRHI_DX12`，选择 D3D12 作为对照与该桌面配置一致。

后续对照在至少 90 帧后再预热 20 秒、再计时 15 秒，并同时记录每帧 RHI 执行时间。预热用于减少启动期间流送、遮挡 readback 及管线准备波动；仍保留每次独立启动的数据，不用该方法消除或隐瞒测量波动。此前旧报告的预热条件不变。


第二版的 `dx-binding-v2-abba.json`（额外预热 20 秒）为 31.07 / 30.89 / 32.10 / 30.63 FPS，基线 30.85、候选 31.50 FPS，约 +2.10%，不足以证明稳定收益。每帧 RHI 时间分别 26.46 / 26.34 / 25.28 / 26.77 ms。`project-gameplay-dx-binding-v2-validate.json` 则完成 34,343,992 次缓存一致性检查，45 秒游戏帧推进至 1062，无捕获到的错误。

第二版 CPU 复核 `performance-capture-dx-binding-v2.json`：不采集时 32.08 FPS、CPU 采样时 29.41、API/pass 逐项计时时 22.74；RHI 的 SetDrawBindings 包含时间约占窗口 48.02%，CreateGroups 约 29.63%，ResolveBinding 含子调用约 2.51%。CreateGroups 自身约 10.99%，createBindGroup 桥接路径约 9.47%，setBindGroup 桥接约 7.67%，setVertexBuffer 桥接约 7.10%。因此不能把最初大 scope 的全部耗时都归因于资源解析。三帧 GPU pass 合计 6.62 / 6.88 / 7.60 ms，不包括 copy 和 pass 间隙。

第三版进一步复用 RHI owner 的描述符 scratch 数组容量；每个 pipeline 在当前帧记住最近的绑定组，entry 完全相等时直接复用，省去重新计算 hash 和全局查找。跨帧先清理这些非拥有指针，避免缓存淘汰后使用。全局绑定组缓存持有 GPU 引用，graphics encoder 仅在句柄变化时变更自己的引用；缓存容量满时新建的组仍以明确的拥有标志转移/释放，compute 的临时组也保留释放路径。缓存 entry 及 GPU 资源的上限与淘汰条件不变。


第三版交错对照 `dx-binding-v3-abba.json`：

| 顺序 | 旧版 FPS | 候选 FPS | RHI 工作 ms/帧 |
| --- | ---: | ---: | ---: |
| A | 29.45 | — | 27.56 |
| B | — | 31.64 | 25.49 |
| B | — | 32.22 | 25.09 |
| A | 29.23 | — | 28.02 |

按总帧数/时间计算基线 **29.34**、候选 **31.93 FPS（+8.82%）**。按帧数加权 RHI 工作时间约 **27.79 → 25.29 ms**。两次候选均快于两次基线；这是当前预热条件下的一组证据，仍不足以达到用户桌面 147 FPS 的目标。不能把旧的短预热 17~20 FPS 与本组直接相比，宣称整体翻倍。

`project-gameplay-dx-binding-v3-validate.json`：45 秒、1024 个游戏帧，36,636,870 次描述符一致性比较，3,099,883 次最近绑定组快速命中，无捕获到的错误。原始配置和内容 SHA-256 与此前一致，实际内部 1484×835、输出 2290×1288、AA=2、原始出生相机一致。

引擎仓库原生 Trace 接入已提交为 `3d6d9f5fe`，未推送。外围提交包含 RHI 适配、D3D12 对照、原生采集桥接和验证脚本，具体验证证据以上述结果文件为准。


第三版完整采样 `performance-capture-dx-binding-v3.json` 通过数据与图表控件校验：18 个 Worker、235,588 个浏览器 trace 事件、3 帧 GPU；另一次不采集基线 31.31 FPS、CPU 采样 28.36、API/pass 计时 22.04。RHI 的 SetDrawBindings 含子调用约 45.71%、CreateGroups 约 27.55%，仍是主要热点，不把本轮改善描述为完整解决。不同内联上下文可能有同名节点，采样占比不可任意相加。三帧 GPU pass 合计 13.43 / 11.60 / 10.68 ms，波动依然存在。同视角候选与基线截图已人工核对，未见明显的材质、阴影或几何差异。

正式普通包已更新为第三版，入口保持 `http://127.0.0.1:8765/build/triplex-project-distance-fields-threads/index.html`。之前的正式包按目录整体保存至 `tests/web-platform/build/triplex-before-dx-binding-20261101`，其 WASM 为原 `cddb7ed5daa1948e718d35dd2ee8f947345ea2faee69255a8c92975547853223`。新普通包 WASM 为 `9a48ce73affbf45f73e71c43de891ccb95627a0605f8c7b635005253ba6fe595`，与 `villa-dx-binding-v3` 相同；项目 config 与 content 的前述 hash 保持一致。


正式入口验证 `project-gameplay-dx-binding-final.json` 通过：两个独立启动各执行 45 秒 WASD、跳跃、转向与窗口缩放，分别至 1234 / 1135 个游戏帧，未捕获到崩溃、fatal 或 GPU validation 错误；均确认 Game、Render 与 RHI 三个独立线程实际工作。这里只是短时验证，不替代更长场景巡游与显存压力测试。

D3D12 对照的另一个实际差异是 `D3D12DescriptorCache.cpp::SetConstantBufferViews` 的 root CBV 路径：变化时直接 `SetGraphicsRootConstantBufferView` / `SetComputeRootConstantBufferView` 更新 GPU 地址，随后清理 dirty 位。WebGPU 的 bind group 不可变，dynamic uniform offset 又受 adapter 的 `maxDynamicUniformBuffersPerPipelineLayout` 限制，超出部分仍需对应的不可变组。现有 Web 后端已经申请并遵守该实际限制，没有通过强行宣称更高能力规避。后续应重点考虑布局拆分、常量变化与稳定材质组分离，以及降低桥接调用；这些尚未在本轮实现。


最终诊断包也已同步为第三版（`villa-insights-candidate`）。`villa-insights-dx-binding-v3.json` 验证按钮下载及同一实例第二次录制均通过，原始相机在两次录制前后完全一致，无页面错误。原版 Unreal Insights 成功分析两份：

| 文件 | 字节 | 事件数 | 有限事件跨度 |
| --- | ---: | ---: | ---: |
| `villa-insights-dx-binding-v3-0.utrace` | 11,340,606 | 6,814,214 | 8.072 秒 |
| `villa-insights-dx-binding-v3-1.utrace` | 11,893,367 | 7,216,406 | 8.086 秒 |

两份均包含 Game、Render、RHI 与四个 WebGPU scope；停止时未闭合 scope 分别 17 / 24 个。第一份 SetDrawBindings 累计 3.419 秒、CreateGroups 1.895 秒，第二份为 3.438 / 1.909 秒，均为包含关系。事件次数与旧录制不同，不以累计秒数直接计算优化收益。诊断包录制前短测 32.35 FPS，两次录制约 18.86 / 19.84 FPS，再次确认采集开销明显。

可查看普通性能图表：`http://127.0.0.1:8765/results/performance-capture-dx-binding-v3.html`。需要自己录制时打开 `http://127.0.0.1:8765/build/villa-insights-candidate/index.html`，右上角“录制 8 秒性能”。最近一份原生文件为 `tests/web-platform/results/villa-insights-dx-binding-v3-0.utrace`。
