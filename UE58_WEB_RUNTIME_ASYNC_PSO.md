# WebGPU 首次使用 PSO 的运行期异步创建

2026-11-05。按用户澄清，本轮测试 UE 自带的运行期异步 PSO 路径。PSO 预缓存保持关闭，不增加启动预缓存等待，不预先巡游镜头。

## UE 已有的两套机制

本地 UE 5.8 `Engine/Source/Runtime/RHI/Private/PipelineStateCache.cpp` 中：

- `r.AsyncPipelineCompile` 默认 `All = 1`。首次遇到绘制/计算状态时，可启动 UE 编译任务，命令列表记录其完成事件，使用前保证 PSO 已就绪。
- `PipelineStateCache::IsPSOPrecachingEnabled()` 在 `WITH_EDITOR` 下直接返回 false。编辑器中的默认运行期异步编译不依赖开启预缓存。
- 运行期异步还要求 RHI 声明 `GRHISupportsAsyncPipelinePrecompile`、平台支持异步编译，并使用独立 RHI 线程。此前 Web 后端将该能力设为 false，因此仅有引擎默认 CVar 并不能启用 Web 的异步路径。

## 本轮实现

实验参数 `-WebRuntimeAsyncPSO` 打开 Web RHI 的异步能力，并保证 PSO 创建任务在任务线程运行。首次实际需要的 graphics/compute PSO 由这些任务发起，GPU 所属 Worker 使用 WebGPU `createRenderPipelineAsync` / `createComputePipelineAsync`。任务线程收到完成结果后才完成 UE 的编译事件，真实异步返回的管线对象进入后续绘制。

Web 的命令列表在开始翻译前等待依赖就绪，采用 UE 已在 Android/Mac 使用的 `DispatchEvent->DontCompleteUntil` 机制。原桌面分支把等待放进 RHI 命令执行中；直接复用会阻塞 GPU 所属 Worker，同时 WebGPU 完成回调也要返回该 Worker，形成互相等待。

提交创建的代理回调继续让出一轮事件循环，避免在 emdawnwebgpu 事件管理锁内重入创建。请求按 initializer 地址匹配，避免同步代理重入时误用外层异步回调。运行期和预缓存的请求/完成/失败计数分别报告。

需要实际 UAV 格式才能确定的 compute storage-format 变体仍在 dispatch 时同步创建；GPU 所属 Worker 内直接创建也保留同步回退。这些路径不能通过在 owner 内等待 Promise 来改成异步。

## 测试入口

同一 v70 包切换模式：

- [运行期异步](http://127.0.0.1:8765/build/villa-runtime-async-pso-v70/index.html?pso=async)
- [原同步模式](http://127.0.0.1:8765/build/villa-runtime-async-pso-v70/index.html?pso=sync)

无参数仍使用原同步模式。Game 本地时钟、有效遮挡历史和 RHI priority 唤醒沿用已验收默认值。公共打包流程没有默认开启运行期异步或预缓存。

`__webOptimizationRHI` 的 `runtimeAsyncPSO / runtimeAsyncRequested / runtimeAsyncCompleted / runtimeAsyncFailed` 用于确认实际运行模式；`__webPSOPrecache.enabled` 和 `asyncPrecacheRequested` 用于确认预缓存关闭。

## 验证方式

正常完整引擎编译、WASM 验证和同 Cook 打包通过。RHI 命令列表覆盖同时纳入构建准备和源码哈希审计，安装版引擎不作修改。

浏览器测试脚本为 `tests/web-platform/probe-web-runtime-pso.cjs`。正式对照为同一 WASM/Cook 的 sync / async / async / sync 四轮独立可见 Edge 会话。每轮等待至少 600 帧、纹理流送 pending 为 0，再等 10 秒，记录静止 5 秒、首次五方向巡游 25 秒、相同方向重复巡游 25 秒。每次只改变 yaw，位置及俯仰保持相同。CSS 视口 2289×1287、DPR 1；脚本核对实际输出/渲染分辨率、抗锯齿和画质配置一致。启动前检查 GPU 空闲，测试不与编译或其他测试同时运行。

性能段仅包装稀少的 PSO/shader 创建 API，并记录每次提交间隔；不包装逐 draw/逐 bind，也不使用 CPU profiler、浏览器 trace 或附加 GPU 查询。1% Low 按合并后的最慢 1% 帧间隔平均值计算。提交间隔不等于显示器上的物理呈现间隔。浏览器与驱动缓存保留，不能把启动时间解释为彻底清空缓存的冷启动。

`--verify-use=true` 单独开启逐 bind 身份追踪，确认异步 API 返回的 graphics/compute 对象确实被使用；该诊断的帧时间不参与性能结论。

## 结果与边界

正式四轮性能结果和单独使用验证记录于 `tests/web-platform/evidence/runtime-async-pso-20261105.json`。

| 场景与指标 | 原同步 | 运行期异步 |
| --- | ---: | ---: |
| 静止平均 FPS | 107.01 | 105.05 |
| 静止 1% Low | 67.40 | 67.86 |
| 首次巡游平均 FPS | 131.10 | 132.85 |
| 首次巡游 1% Low | 35.93 | 40.61（+13.03%） |
| 首次巡游最长帧 | 152.58 ms | 205.28 ms |
| 首次巡游 >100 ms 帧数，各合计约 50 秒 | 4 | 2 |
| 重复巡游平均 FPS | 136.52 | 135.39 |
| 重复巡游 1% Low | 52.94 | 51.83 |
| 重复巡游最长帧 | 32.45 ms | 33.81 ms |

四轮首次巡游分别新增相同的 15 个 graphics PSO 和 10 个 shader；重复巡游均无新增。同步两轮各出现两个 >100 ms 的帧；异步两轮各集中成一个，最长分别为 194.65 / 205.28 ms。异步改善了本场景首次巡游的 1% Low，但没有改善最坏一次停顿，不能据此设为默认。静止与重复巡游未体现收益。

异步两轮的最长帧均与这批 PSO 请求和回调交付重叠。单个异步 API 从发起到 Promise 完成最高约 74 / 89 ms，包含浏览器排队、校验、编译和完成回调交付，不能把这个时长全部归为编译器 CPU 时间。同步创建 API 的 JS 调用很快返回，也不代表驱动工作已全部完成。

第四轮原始脚本在采样前读取首个 RHI 统计时出错：Game 已发布第 30 帧，RHI 还未发布其第 30 帧统计。修正脚本，明确等待 owner 统计存在后，补测最后一轮同步；没有混入出错运行的任何性能阶段，原始失败记录及补测记录均保留。正式汇总顺序仍为 sync / async / async / sync。补测包含后来增加的使用诊断代码，但其逐 bind 追踪关闭。

独立使用诊断确认 220 个 graphics、67 个 compute 异步返回对象实际传入了 `setPipeline`，并记录到 3 个仍同步创建的 storage-format compute 变体。该轮开启逐 bind 跟踪，帧时间完全排除在上表之外。所有完成的运行均无 GPU 校验错误、异步创建失败或预缓存请求。同机位同步/异步截图未发现明显缺物或材质变化；该检查不代替人工快速移动验收。

异步创建可以把编译交给后台并保留正确的使用依赖，但首次发现与首次使用距离很短时，相关帧仍需要等待编译完成。采用异步 API 并不保证首次使用没有卡顿。本轮没有通过跳过绘制、替代材质或降低画质隐藏等待。

引擎仓库提交：`d5e91d514`，仅修改线程版 Web 异步能力开启时的命令依赖等待方式。本轮只验证这一场景、每种模式两次采样；未测桌面端编译时长，不能把所有 Web/编辑器差距归因于 PSO。
