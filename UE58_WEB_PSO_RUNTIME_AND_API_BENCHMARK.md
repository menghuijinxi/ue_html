# PSO 运行期复用与独立 WebGPU / DX12 对照（2026-11-02）

本次补齐第三类数据，并用不依赖 UE 的程序对照第二类复用。在本机、这组 128 个简单管线、单并发的条件下，刷新或重开浏览器后取得管线对象平均需要 70.04 ms；DX12 Pipeline Library 为 27.14 ms，CachedPSO blob 为 42.47 ms。Web 分别慢约 2.58 / 1.65 倍。这个结果不能推广为所有 GPU、浏览器和复杂 UE 材质的固定倍数。

别墅默认视角的稳定绘制中，已观测的 UE PSO 查找、状态取得与 RHI 切换合计约 0.94 ms CPU/帧，两次采集均没有新建 PSO。此前的 72 ms 是同次运行第二批创建请求的总耗时，不能当作一帧或一次 draw 的管线复用成本。

## 三类测试的边界

| 类别 | 本次如何测试 | 能确认什么 |
|---|---|---|
| 首次构建 | 新诊断 profile / 新 Pipeline Library | 只保证应用缓存新建；没有清除 NVIDIA / Windows 全局驱动缓存，不能声称彻底冷启动 |
| 刷新 / 重启后的复用 | 真正 reload；关闭浏览器再打开同一 profile；DX12 每轮新进程加载磁盘库或 blob | 重新取得管线对象的成本，不是每帧绑定成本 |
| 运行期间使用已有 PSO | UE 连续两次 8 秒 trace，断言创建数为零；独立程序直接 setPipeline / SetPipelineState 并实际 draw / dispatch | 现有对象的查找、状态切换、CPU 命令编码及提交等待 |

不把同页面新建 GPUDevice 的诊断值混入刷新数据。每次 Web 重启测试记录不同的随机 Device ID，页面刷新后创建的管线不会沿用上次页面的 GPU 对象。

## 别墅场景：第三类实测

包：`villa-pso-runtime-trace-v20`，复用已校验的 `villa-pso-concurrency-v18-default` Cook 内容及 Config，字节相同，只更换带追踪的运行时。TSR=4、距离场生成/DFAO/距离场阴影=1，GI/反射方法/虚拟阴影=0，纹理池=1000 MiB；未修改项目设置。输出 2290×1288，内部 1484×835，固定入口视角。

新增的 scope 位于 UE 自带 `PipelineStateCache` 和 Web RHI 中；GPU API 计数器另行包裹浏览器原方法，涵盖 RenderPass、ComputePass、RenderBundle 的 setPipeline。

| 每帧 CPU 时间 | 第一次 | 第二次 |
|---|---:|---:|
| UE 图形及计算缓存查找 | 0.284 ms | 0.283 ms |
| 从缓存状态取得 RHI PSO | 0.151 ms | 0.151 ms |
| RHI owner 上的图形切换及计算状态赋值 | 0.511 ms | 0.505 ms |
| 上述 scope 合计均值 | **0.945 ms** | **0.939 ms** |
| 上述合计的逐帧 P95 | 2.033 ms | 2.026 ms |
| 浏览器 setPipeline 的 JS 调用时间 | 0.168 ms | 0.163 ms |
| 采集窗口中新建图形 / 计算管线 | **0 / 0** | **0 / 0** |

JS 调用与 RHI scope 有重叠，不能把两行相加。计算 RHI 切换 scope 记录状态赋值，实际 ComputePass.setPipeline 在 dispatch 路径执行，由浏览器计数器另行覆盖。JS 计时不包含 GPU 进程后续验证和执行的全部成本。

原始 JS 计数窗口含 trace 停止及下载：第一次 260 个呈现帧、151128 次图形绑定、17289 次计算绑定；第二次 252 帧、147478 / 16826 次。原生 CPU trace 裁掉两端不完整帧后，分别按 242 / 243 个游戏帧时间区间归集。任务线程上的查找与 RHI 线程上的切换可能并行，CPU 相加不是关键路径墙钟耗时，也不是 GPU 时间。

追踪关闭时本诊断包基线约 48.07 FPS；开启 CPU trace、API 计时及传输后约 30.36 / 30.46 FPS。这里的 scope 时间包含追踪开销，浏览器时钟约 5 微秒的量化也会使许多短调用显示为零，因此不把单次零值解释为免费。截图确认仍是别墅入口。两次 `.utrace` 均经 UE 自带 UnrealInsights 导出与线程、计时器、持续时间验证。

这个静止视角样本说明已有管线的上述 CPU 路径没有每帧 72 ms 的成本。它没有覆盖完整走动路线，不能排除移动时首次遇到新材质、PSO、纹理或其他资源造成的卡顿。

## 独立程序：第二类实测

环境：i9-12900K、24 逻辑核心、RTX 4090、Windows 11 Pro，Edge 156.0.4314.58。所有 UE 编译、其他基准和游戏进程结束后才运行；Web、DX12 顺序测试，没有同时跑渲染基准。

两端各有 64 个图形 + 64 个计算管线。WGSL / HLSL 执行对应的 64 轮 uint32 乘加，使用不同常量生成不同管线。图形使用同样的三角形、RGBA8、16×16 目标、1×1 scissor，无深度、混合和背面剔除；计算使用 64 线程、256 字节输出。预先实际执行每个管线，最后回读像素和全部 64 个整数，均通过验证。

Web 输入 WGSL；DX12 输入预先准备的 DXIL，HLSL 编译不计入 PSO 复用时间。两端着色器功能和绘制状态对应，编译器、根签名及浏览器安全验证并不逐字节相同。计时覆盖各自公开 API 的处理及 Web 异步完成通知，不代表纯 GPU 驱动函数的逐条对照。

| 单并发重新取得全部 128 个对象 | 各轮总时间 | 均值 |
|---|---|---:|
| WebGPU，真正刷新页面，保留磁盘缓存 | 66.31 / 83.50 / 66.45 ms | 72.09 ms |
| WebGPU，关闭浏览器后重开同 profile | 66.95 / 67.00 ms | 66.98 ms |
| WebGPU，上述五轮合并 | 66.31–83.50 ms | **70.04 ms** |
| DX12，重新进程加载 Pipeline Library，含库文件读取和初始化 | 27.38 / 26.91 ms | **27.14 ms** |
| DX12，逐条读取 CachedPSO blob 并创建对象 | 43.32 / 41.63 ms | **42.47 ms** |
| DX12，不显式提供库或 blob，保留驱动缓存 | 31.31 ms | 31.31 ms |
| WebGPU，关闭浏览器着色器磁盘缓存的刷新 / 重开对照 | 605.24–628.11 ms，五轮 | **613.35 ms** |

主比较均关闭浏览器 trace。Web 的 ShaderModule 入队另计，约 0.2–0.4 ms/轮；DX12 表内 Pipeline Library 数值包含库读取与初始化，不包含事先准备 DXIL 的时间。CachedPSO 测试也包含逐文件读取 blob 的时间，文件组织方式会影响结果。

Pipeline Library 两轮各有 **128/128 LoadGraphicsPipeline / LoadComputePipeline 成功**，零新建回退；blob 两轮各有 **128/128 非空 CachedPSO 输入并创建成功**，没有失败后无缓存重试。不能把传入 blob 成功直接称为驱动内部的可观测命中率。

Web 关闭磁盘缓存后，同一组管线在刷新和重开时约慢 **8.76 倍**，证明浏览器持久缓存对本工作负载有实际收益。诊断 trace 的通用 CacheHit 事件在关闭磁盘缓存时仍可出现：同页面再次新建 Device 会利用内存缓存。因而这类通用事件既不是磁盘命中计数，也不是最终 GPU PSO 的逐条命中率。

新 profile 首轮为 631.21 ms，新显式库首轮为 29.07 ms；两者都已经处于前序测试保留的驱动缓存环境，不能以此得出完全冷启动的差距。独立同页面新建 Device 的额外 trace 样本为 37.54 / 37.88 / 41.21 ms，单独标注 `cache-trace-diagnostic`，未混入表内刷新 / 重开统计。

## 独立程序：第三类实测

每个模式先预热 10 轮、测量 80 轮。对象始终保留，正常使用循环中不调用任何管线创建 API。下面按每轮中位数归一到 1000 次绑定，只计 CPU 编码；实际测量批次是 10000 次绑定，避免对单次纳秒值过度解读。

| 已有对象的绑定 | WebGPU | DX12 |
|---|---:|---:|
| 重复绑定同一图形管线，1000 次 | 0.018 ms | 0.026 ms |
| 在 64 个图形管线间循环切换，1000 次 | 0.0185 ms | 0.0494 ms |
| 重复绑定同一计算管线，1000 次 | 0.0205 ms | 0.0174 ms |
| 在 64 个计算管线间循环切换，1000 次 | 0.0205 ms | 0.0577 ms |

两端处理边界不同：Web 把部分处理推迟到 finish / submit / GPU 进程，不能据此宣称 Web 完整执行比 DX12 快。另测 1000 次图形绑定并 draw，Web CPU 编码约 0.035 ms，finish/submit/等待完成约 2.36–2.63 ms；DX12 CPU 编码约 0.034 ms（同对象重复）或 0.080 ms（轮换对象），Close/提交/fence 等待约 0.046–0.056 ms 或 0.166–0.173 ms。等待时间包含实际 GPU 工作、进程通信、调度及回调，不能当成纯 GPU 耗时。

这些测试支持的结论是：本机这组管线跨页面启动的 Web 缓存恢复慢于 DX12，缓存恢复与绘制期间使用已有对象有不同的成本。简单管线的差距约 1.65–2.58 倍，没有重现复杂 UE 重放的数十秒总耗时，后者不能用固定“每个 WebGPU PSO 都很慢”来解释。

## 实现参考与后续定位边界

Dawn 的 [图形管线实现](https://github.com/google/dawn/blob/main/src/dawn/native/d3d12/RenderPipelineD3D12.cpp) 和 [计算管线实现](https://github.com/google/dawn/blob/main/src/dawn/native/d3d12/ComputePipelineD3D12.cpp) 都有读取缓存 blob、填充 `CachedPSO`、调用 D3D12 创建 API，以及未命中后 GetCachedBlob 保存的路径。不是缺少底层 DX12 PSO 缓存这一功能。此源码用于核对机制，不冒充当前 Edge 二进制中每个 PSO 的最终命中证据。

独立 native 程序的 Pipeline Library 路径还参考了 [微软 PSO 缓存示例](https://github.com/microsoft/DirectX-Graphics-Samples/blob/master/Samples/Desktop/D3D12PipelineStateCache/src/PSOLibrary.cpp) 和 [CreatePipelineLibrary 的内存生命周期要求](https://learn.microsoft.com/en-us/windows/win32/api/d3d12/nf-d3d12-id3d12device1-createpipelinelibrary)。传入的序列化库内存保留到库对象销毁。

复杂 UE 启动仍需进一步区分 shader/layout 的解析与验证、缓存键稳定性、命中后的 native 对象构建，以及浏览器通知调度。本次没有完成这些成本的逐项归因，也没有据此修改画质或声称解决所有 low 帧。

## 证据与复现

可提交的数字及原始证据 SHA256 汇总：`tests/web-platform/evidence/pso-runtime-api-20261102.json`。完整本地证据位于忽略目录 `tests/web-platform/results/`：

- `pso-api-v3.json`、`pso-api-v3-disk-off.json`、`pso-api-v3-comparison.json`：独立实测、缓存关闭对照、统计；`*-dx12-*.json` 和 `*-trace.json` 为各轮原始结果。
- `villa-pso-runtime-trace-v20.json`、`*-analysis.json`、`*-0.utrace`、`*-1.utrace`：浏览器计数、原生 trace 及分析；`.events.csv`、`.statistics.csv`、`.timers.csv`、`.threads.csv` 是原生 Insights 导出。
- `villa-pso-runtime-trace-v20-package.json`、`*-build.json`、`*-scene.png`：Cook 不变校验、完整 UBT Trace 构建和入口截图。
- 中间 `pso-api-v2` 含与正式统计不同的追踪条件；`villa-pso-runtime-bind-v19` 是不含 Trace 的中间包，未取得 trace，不作为验收数据。

```powershell
pwsh -NoProfile -File tests/web-platform/build-pso-api-benchmark.ps1
# 需设置 Playwright 的 NODE_PATH；每次使用新 tag，保留既有测试证据。
node tests/web-platform/benchmark-pso-apis.cjs --tag=pso-api-new
node tests/web-platform/benchmark-pso-apis.cjs --tag=pso-api-new-disk-off --no-disk-cache --web-only
node tests/web-platform/analyze-pso-apis.cjs pso-api-new pso-api-new-disk-off

node tests/web-platform/capture-web-ue-trace.cjs --folder=villa-pso-runtime-trace-v20 --tag=pso-runtime-new --pso-bindings
pwsh -NoProfile -File tests/web-platform/export-web-ue-trace.ps1 -Trace tests/web-platform/results/pso-runtime-new-0.utrace -PsoOnly
pwsh -NoProfile -File tests/web-platform/export-web-ue-trace.ps1 -Trace tests/web-platform/results/pso-runtime-new-1.utrace -PsoOnly
node tests/web-platform/analyze-web-pso-runtime.cjs pso-runtime-new
```

引擎普通及 Trace 目标均完整 UBT 编译链接成功，WASM 结构校验通过。独立 D3D12 程序编译、像素和计算结果回读、磁盘库加载断言通过。项目 Config 及既有页面均保持原样。
