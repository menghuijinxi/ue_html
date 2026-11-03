# Web 窗口同步查询与绑定准备优化

2026-11-04 后续：空 RHITick 同步、原生存储绑定元数据及跨 Pass 描述符复用已单独验证，组合包更新为 v52，见 [三项热点对照](UE58_WEB_RHI_HOTSPOTS_AB.md)。下文保留 v47/v48 当轮结果。

2026-11-03。以 mimalloc、移除 UE 额外分配锁后的 v45 为基线。场景仍是 TriplexHouseVilla 的既有 Cook，没有改项目渲染设置，也没有启用最终 Wasm/JS 优化、SIMD 或 PSO 预热。

## 修改原因与实现

上轮 v45 采样中，Game 约 21.64% 的样本位于同步代理路径，窗口 DPI 查询约 16.59%，窗口尺寸刷新约 4.45%，这些路径互相包含。Worker 模式下 `BrowserScale/BrowserSize` 使用 `MAIN_THREAD_EM_ASM_DOUBLE`，读取引擎 owner Worker 的 `__webBrowserState`。owner 同时执行 RHI，Game 因读取几乎不变的窗口属性而等待其应答。

v47 让 owner 在运行时初始化完成、启动 Game pthread 之前，以及收到浏览器窗口变化时，调用 `WebUpdateBrowserMetrics` 更新原生共享快照。各字段均为原子变量，序列号保证宽、高、DPR 来自同次更新。Game 直接读取；DPI 单独读取原子值。Canvas 的实际配置仍由渲染器负责。非 Worker 分支沿用原有浏览器查询。

v48 实验在 v47 上减少 Web RHI 的重复绑定准备：同一槽位重复绑定同一个 RHI 对象时，跳过 `TMap.Add`；已有绑定组通过帧、访问状态、资源版本、纹理引用检查后，跳过对应 scratch 数组的清空。如果一个 Shader 的所有反射绑定组都已通过这些检查，则直接跳过逐条扫描。该实验没有显示帧率收益，已从默认源码撤回，保留在 [实验补丁](tests/web-platform/experiments/web-binding-skips-v48.patch) 和独立 v48 包中。

Uniform 内容更新、静态 Uniform 更新、纹理引用目标改变的检查继续生效。`r.WebGPU.ValidateBindingCache` 开启时重新解析并比较描述符，避免用缓存结果验证自身。手动顶点读取维持原有格式相关路径；本轮 Cook 的实际统计为 `manualVertexFetchEnabled=false`，未将该功能作为本次收益来源。

## 验证方法

两组独立 ABBA：v45 / v47 / v47 / v45；v47 / v48 / v48 / v47。每次重新启动页面，等待至少 90 帧，再预热 15 秒、记录 20 秒。固定默认出生点、可见 Edge、2289×1287 CSS、DPR 1。Game、Render、RHI 各自独立，UE 核心预算 4、Task Worker 3。正式帧率窗口没有 CPU profiler、绑定校验模式、分配探针、构建或打包。

FPS 根据 RHI 完成 viewport present 的次数计算。1% Low 为最慢 1% 帧间隔平均值的倒数，按每组两个记录窗口合并计算。该固定视角测试不等于移动过程的 Low。逐轮原始时间戳、绘制量、相机、渲染参数和浏览器前台状态均保留。

v47、v48 各完成六个视角检查并保存截图，人工检查阴影、材质和距离场画面。v47 另测四种窗口尺寸/DPR 组合，核对实际 Canvas CSS 大小、浏览器 DPR、原生共享快照与 RHI 输出尺寸。v48 另行开启完整绑定缓存校验，移动、转向并切换尺寸 30 秒，检查 GPUScene、资源表、独立渲染线程和实际渲染进展。

窗口测试最初将 Canvas 高度当成 viewport 高度，以及将浏览器实际 DPR 当成精确的 1，导致三次测试断言失败。页面保持 16:9，CDP 下 DPR 也有浮点误差；修正测试为实际 Canvas 尺寸、实际 DPR 和合理误差后通过。这些失败保留原始报告，期间没有修改引擎来规避断言。

## 窗口查询的独立对照

| 版本 | 两轮 FPS | 合并 FPS | 合并 1% Low |
|---|---|---:|---:|
| v45 mimalloc 基线 | 76.70、77.34 | 77.02 | 37.37 |
| v47 原生窗口快照 | 78.76、77.92 | 78.34 | 36.14 |

平均 FPS 高约 1.70%，1% Low 低约 3.27%，本轮没有显示 Low 改善。v47 每帧 draw 约 3008–3021，基线约 2972–2979；场景内动画/可见性与阴影刷新导致工作量有小幅差异，indirect draw 约 66–73。RHI 记录的工作时间仍在每帧 9.1–9.3 ms。故这次修改可移除已知同步查询，但不能宣称解决整体瓶颈或保证稳定的 1.7% 收益。

## 绑定准备的独立对照

| 版本 | 两轮 FPS | 合并 FPS | 合并 1% Low |
|---|---|---:|---:|
| v47 窗口快照 | 78.33、78.81 | 78.57 | 35.58 |
| v48 叠加绑定实验 | 76.97、79.14 | 78.05 | 35.55 |

FPS 低约 0.65%，Low 基本持平，且 v48 单轮间的变化大于组间差异，没有显示明确收益。draw 约 3015–3024，两个版本工作量接近；RHI 工作时间约 9.1–9.5 ms。每帧重复绑定约 323 次、跳过 Shader 反射扫描约 3136–3146 次，证明实验路径执行了，但减少这些扫描没有改变总体瓶颈。

默认源码保留 v47 窗口快照。实验源码以补丁保存，原始 v48 C++ 源码快照和构建哈希保留在 results。已重新构建 v47，并核对 417 个对象及最终 JS/Wasm 与通过画面和 ABBA 的 v47 相同。推荐测试页面为 [v47](http://127.0.0.1:8765/build/villa-browser-metrics-v47/index.html)；[v48](http://127.0.0.1:8765/build/villa-binding-skips-v48/index.html) 用于复现实验。

## 剩余成本

另行采集 v48 所有 Worker CPU 栈，未把 Profiler 阶段计入上述 FPS。Game 的 DPI/窗口尺寸同步查询均未采到；所有同步代理路径约 6.67%，修改前 v45 约 21.64%。这两个采样的线程窗口和环境不同，不能把占比差换算成精确的每帧节省时间。

剩余 Game 同步等待主要落在 `FWebGPUDynamicRHI::RHITick`，约 6.57% 的叶子样本在等待该代理。当前 Web 分支只代理到 owner 并检查线程身份，`wgpuInstanceProcessEvents` 被平台条件排除，浏览器回调靠 JS 事件循环执行。这是另一处可单独验证的空操作同步，但当前未修改或宣称帧率收益。

RHI 的 `SetDrawBindings` 包含子调用约 27.99%、`CreateGroups` 约 20.35%、JS 回放约 10.91%，这些路径相互包含。`CreateGroups` 的一个同名自身叶子约 7.98%，说明除了被跳过的反射扫描还有实际准备成本。叶子分类中 Wasm 约 44.45%、WebGPU API 约 15.31%、JS 脚本约 11.22%、显式跨语言边界约 1.02%、idle 约 24.96%；边界占比不是所有跨语言开销的完整测量，API/JS 也不能都当成参数转换。

具体仍可见 `setVertexBuffer` 自身约 4.36%、`beginRenderPass` 约 2.25%、命令流对象登记约 1.87%、`WebGPU.getJsObject` 约 1.78%、JSON 反射字段查找约 1.77%、资源访问校验约 1.48%、`createBindGroup` 约 1.39%。JSON 查询的栈明确位于 `ValidateStorageSRVBinding → CreateGroups`，不是场景启动时解析。下一步更适合拆分绑定组实际构造/缓存未命中、仍在绘制中发生的反射字段查询，以及顶点/索引状态提交；当前实验没有证明减少循环扫描就能加速这些操作。

Render 约 67.53% 叶子为 futex 等待，其中包含 `EndFlushResourcesRHI` 路径的样本约 11.45%，不能把所有等待当成线程锁竞争。Game 大量 idle 也不能当成 GPU 空闲。以上采样没有浏览器 GPU 进程与真实 GPU 时间，尚未确定 Low 尖峰原因。

## 复现

引擎配套提交：`4febbbbaa`（独立 `UnrealEngine-1` 仓库，窗口尺寸/DPI 原子快照）。宿主修改、实验补丁与证据保存在本仓库；均只提交本地。

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
./tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -Mimalloc -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4 -RendererRevision d175ae4ae
node tests/web-platform/benchmark-villa-threading.cjs --folders=villa-mimalloc-no-proxy-v45,villa-browser-metrics-v47,villa-browser-metrics-v47,villa-mimalloc-no-proxy-v45 --tag=window-rerun
node tests/web-platform/benchmark-villa-threading.cjs --folders=villa-browser-metrics-v47,villa-binding-skips-v48,villa-binding-skips-v48,villa-browser-metrics-v47 --tag=binding-rerun
node tests/web-platform/verify-villa-command-stream.cjs --folder=villa-binding-skips-v48 --tag=binding-views-rerun --window-metrics
```

构建脚本仍默认 dlmalloc；本次三个对照包均显式选择 mimalloc。编译审计逐对象确认 417 个单元中 416 个 `-O2`、一个 Chaos `-O1`；最终链接无 `-O`、无 SIMD/LTO，保留断言。两个新包与 v45 的 Cook 内容和配置完全一致。

原始记录位于 `tests/web-platform/results/`。汇总命令 `node tests/web-platform/summarize-window-bindings.cjs` 在全部计时结束后核对包、源码、构建、采样与环境记录，输出 [window-bindings-20261103.json](tests/web-platform/evidence/window-bindings-20261103.json)。后台用户软件继续运行，不能宣称机器独占。短时间通过也不能证明间歇断言或长期稳定性问题全部解决。
