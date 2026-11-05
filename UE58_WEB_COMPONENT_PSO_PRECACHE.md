# UE 自动组件 PSO 预编译：v70 首次转向复测

2026-11-05。当前 WebGPU 已经接通 UE 自动组件/全局 PSO 预编译，通过 `-WebPSOPrecacheTest` 开启。最近的运行期异步编译测试明确关闭了这个功能，研究的是首次使用时如何缩短等待，不能用那些结果评价提前准备 PSO 的效果。

这次四轮 off/on/on/off 使用同一 v70 WASM、Cook、画质、分辨率和相机路线，常规 UE TaskGraph worker 均为 3。开启预编译后，首次转向没有任何新 shader module / pipeline 创建，原来 178–236ms 的 PSO 相关停帧没有再出现；首次转向整段最慢帧为 34–38ms。收益来自在使用之前准备并复用管线，而不是证明单次编译更快。

## 机制及当前开关

这里是 UE 自动组件 PSO precaching，不要求先人工跑图生成 `.upipelinecache`，也不依赖浏览器跨页面磁盘缓存。

1. `UStaticMeshComponent::PostLoad` 在资源初始化后调用 `PrecachePSOs()`；`OnRegister` 也会根据状态补充收集。
2. `UPrimitiveComponent::PrecachePSOs()` 根据组件材质、顶点工厂、渲染状态等收集完整 PSO，并提交 UE 预编译任务。
3. Web RHI 把任务交给 GPU owner，调用 `createRenderPipelineAsync` / `createComputePipelineAsync`。实际浏览器回调到达之后才解除请求等待，UE 任务完成代表管线对象已经返回。
4. 默认 `r.PSOPrecache.ProxyCreationStrategy=1`。静态网格的渲染代理创建检查发现 PSO 未就绪时返回 `WaitingPSOs`，延迟创建；完成后再创建代理。
5. 既有 Web 适配保留并复用已准备的管线对象。页面初始加载也等预编译队列清空、请求完成，再允许交互。

准确的时序是“组件已经加载，渲染代理还未创建”。组件 UObject 尚不存在时，通常还没有它最终的材质/顶点布局/渲染状态组合可供收集。仅提前 `createShaderModule` 不足以替代完整 pipeline 准备。

当前入口在 `tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp:713`：没有 `-WebPSOPrecacheTest` 就将 `GRHISupportsPSOPrecaching` 设为 false，即使 UE 的 `r.PSOPrecaching` 默认值为 1 也无法启用。开启后使用已有独立预编译池（本机 8 路）和 `KeepInMemoryUntilUsed=1`。

相关源码位置：

- `reference-engine/Engine/Source/Runtime/Engine/Private/Components/StaticMeshComponent.cpp:2273`、`:883`：加载/注册时准备。
- `reference-engine/Engine/Source/Runtime/Engine/Private/Components/PrimitiveComponent.cpp:5407`：收集并提交。
- `reference-engine/Engine/Source/Runtime/Engine/Public/StaticMeshComponentHelper.h:521`：代理创建等待。
- `reference-engine/Engine/Source/Runtime/Engine/Private/PSOPrecache.cpp:18`、`:34`：组件开关和代理策略。
- `reference-engine/Engine/Source/Runtime/RHI/Private/PipelineStateCache.cpp:4999`：总开关与平台能力联合判断。
- `WebGPUDynamicRHI.cpp:3994`、`:4225`：任务等待和真实异步回调完成。
- `tests/web-platform/web-engine-host.js:408`：加载就绪判断。

本地 UE 源码中 `PipelineStateCache::IsPSOPrecachingEnabled()` 在 `WITH_EDITOR` 下返回 false，组件检查还排除 `GIsEditor`，因此不能把编辑器流畅直接归因为这条组件机制。这里验证的是打包运行时可用的 UE 路径。

早期 Web 适配的顶点步长匹配、预编译对象回收及全局 pass 漏收集问题已经在 [PSO 复用记录](UE58_WEB_PSO_CACHE_REUSE.md) 中处理；本轮复核当前版本，没有重新实现一套组件收集器。

## 四轮结果：以首次编译卡顿为判据

环境：RTX 4090、i9-12900K、Edge 156.0.4314.58。每轮重新启动测试浏览器，关闭 GPU shader 磁盘缓存，保留驱动缓存。未开 trace / 每次绑定包装器，未预走相机路线。等待初始场景稳定后进行首次转向 25 秒，再重复同一路线 25 秒。

| 顺序 | 自动预编译 | 首次转向新 PSO / module | 首次转向最慢帧 | 等效最低单帧速率 | 超过 100ms 的帧 |
| --- | --- | ---: | ---: | ---: | ---: |
| A1 | 关 | 15 / 10 | 235.615ms | 4.24 FPS | 1 |
| B1 | 开 | 0 / 0 | 34.020ms | 29.39 FPS | 0 |
| B2 | 开 | 0 / 0 | 38.485ms | 25.98 FPS | 0 |
| A2 | 关 | 15 / 10 | 177.740ms | 5.63 FPS | 1 |

`等效最低单帧速率 = 1000 / 最慢帧毫秒`，不是一秒窗口 FPS，也不是平均 FPS 或 1% Low。记录的是视口提交间隔，不是显示器实际呈现延迟。

关闭侧两轮各有 15 条入口 label 多重集相同的 async PSO 请求，分别组成 203.015ms、161.655ms 的连续重叠请求窗口；窗口内均没有新的视口帧提交。对应停帧正是表中的 235.615ms、177.740ms；其后 500ms 最慢帧为 20.590ms、16.710ms，没有超过 50ms 的恢复延迟。完整停帧还包含命令准备等工作，不能把它全部当成 DXC CPU 时间。

开启侧每轮在测量前已完成 **1121 / 1121** 条实际异步预编译请求，失败为 0，队列与浏览器 pending 均为 0。首次转向时已使用预编译 graphics PSO 的累计数量 **70 → 85**，新增使用 15 个，同时 pipeline/module API 创建数均为 0。因此没有靠跳过这批绘制达到零创建。

首次转向最慢帧中位数 **206.678 → 36.252ms（-82.46%）**；两侧对应的是不同原因的最慢帧。开启侧没有首次 PSO 请求，剩余 34–38ms 不能称为 shader 编译耗时，也不能宣称所有非 PSO 卡顿已经消失。

A1 另有一个与 PSO 请求不重叠的 66.955ms 帧，重复路线也有一个 67.015ms 帧；都保留在证据中，不归因于 PSO。四轮重复路线均无新增 shader/PSO，其他三轮重复路线最慢帧分别为 35.170ms、45.700ms、33.290ms。

四轮 GPU 验证/引擎/页面错误均为 0；检查了 A1/B1 相同最终视角截图，未见明显缺物。这不能替代动态加载时的逐帧视觉验收。

## 代价与边界

- 加载到前 30 个 Game 帧：关闭 11.267s、11.519s；开启 15.323s、15.029s，中位数增加 **3.783s**。这是相同启动里程碑，不是精确首屏或可交互时间。开启侧观察到页面 ready 分别为 15.437s、15.047s。
- 常规 TaskGraph worker 两侧均为 3，但开启后会使用已有的 8 路专用预编译池。因此这不是严格“所有编译线程数量相同”的实验，也不以此推断编译器加速。关键观察是准备工作已经在首次转向前完成。
- 收集器另提出了每轮 834 个被 RHI 判为不支持的推测组合，未提交给浏览器；实际提交的 1121 个请求全部成功。该测试路线无漏项，不代表所有材质、pass 都已覆盖。
- 提前准备会产生额外加载期 CPU 工作和管线缓存内存占用；当前路线实际使用 85 个预编译 graphics PSO，不能按这一条路线删除其余候选。
- 初始整关卡可以在加载界面等就绪。运行中流式加载、动态生成组件或更换材质时，若提前量不足，默认延迟代理策略可能表现为物体晚出现；这一轮没有测试这些触发方式。需要在资源/组件进入可见范围前准备，不能仅开开关就声称动态加载没有视觉代价。
- 本轮只修改测试、分析工具和证据，没有更改生产默认开关，也没有改画质或 Cook。

## 复现与证据

人工体验页：`http://127.0.0.1:8765/build/villa-runtime-async-pso-v70/component-pso.html`。该页复制同目录 `index.html`，仅在启动参数追加 `-corelimit=4`、`-WebPSOPrecacheTest`、`-WebRuntimeAsyncPSO`，使用相同 WASM/Cook 和加载就绪检查，不带自动相机路线或测量注入。重新生成构建目录后需按以上参数重新生成体验页。

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/serve.cjs
# 另一终端，使用未带 WebPSOPrecacheTest 的现有 v70 包：
node tests/web-platform/probe-web-runtime-pso.cjs --folder=villa-runtime-async-pso-v70 --tag=<新标签> --modes=async,async,async,async --core-limits=4,4,4,4 --precache=off,on,on,off --disable-disk-cache=true
node tests/web-platform/diagnostics/analyze-component-precache.cjs <新标签>
```

原始逐帧/逐请求报告、日志、截图保存在 `tests/web-platform/results/component-pso-v70-20261105*`。精简证据为 `tests/web-platform/evidence/component-pso-v70-20261105.json`，包含所有轮次、请求时间、恢复窗口、加载里程碑、真实对象使用数量、原始报告/工具/包和截图的 SHA-256。

分析器检查四轮顺序、固定常规工作线程、相同画质/视角、请求完成、帧间隔连续、事件计数与累计 API 计数一致，以及关闭侧请求入口一致。开启侧专门接受零首次编译事件，并检查实际新增使用预编译对象，避免继续用要求两侧都有首次编译的旧分析器。
