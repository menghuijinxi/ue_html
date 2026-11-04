# Web 分配器与重复代理锁实景对照

2026-11-03。保持 v38 的 Cook、TSR、距离场、灯光、分辨率、线程和最终链接优化设置，分别验证平台声明和底层分配器。

## 已确认的代码路径

Web 使用 `FGenericPlatformMemory::BaseAllocator()` 创建 `FMallocAnsi`；Web 定义 `PLATFORM_USE_ANSI_POSIX_MALLOC=1`，因此引擎调用 `posix_memalign / malloc_usable_size / free`。Emscripten 默认使用 dlmalloc，其共享内存版本开启内部 mutex。

Web 先前遗漏 `PLATFORM_IS_ANSI_MALLOC_THREADSAFE`，继承 `HAL/Platform.h` 默认值 0，`FMallocAnsi::IsInternallyThreadSafe()` 因此返回 false。`UnrealMemory.cpp` 按引擎正常逻辑再包一层 `FMallocThreadSafeProxy`，所有 Malloc/Realloc/Free/GetAllocationSize 经过同一 `FCriticalSection`。Windows、Unix、Apple 都将该平台标志设为 1。修复 Web 平台声明可直接复用引擎的判断，保留底层分配器自己的线程安全机制。

本轮真实 v38 重新采样，RHI 分配调用栈占其采样区间约 13.72%，Render 约 18.47%；明确保留代理函数名的锁等待，RHI 约 2.08%。部分函数已被内联，按函数名分类会漏记，不能将该百分比当成全部分配等待。包含采样既有计算也有等待；多线程区间长短不同，不能把各线程时间相加换算成一帧。采样与正常性能测试分开。

## 候选与隔离

| 包 | UE 外层代理锁 | C 分配器 | 用途 |
|---|---|---|---|
| v38 | 有 | dlmalloc | 原版基线 |
| villa-mimalloc-proxy-v43 | 有 | mimalloc | 仅替换底层分配器，417 个 UE 对象与基线哈希完全相同 |
| villa-allocator-no-proxy-v44 | 无 | dlmalloc | 仅补齐平台线程安全声明 |
| villa-mimalloc-no-proxy-v45 | 无 | mimalloc | 与 v44 的 417 个 UE 对象相同，仅改变链接分配器 |
| villa-allocation-probe-v46 | 无 | dlmalloc | 仅作 libc 调用计数和采样，不接受为正常性能数据 |

底层分配器候选没有启用 SIMD、最终 `-O1/-O2`、LTO，也没有更改画质或 Cook。WebGPU API 所有权和线程配置保持一致。

直接 `-sMALLOC=mimalloc` 会与 UE 全局 `new/delete` 定义冲突。`build-web-mimalloc.py` 生成工作区私有 archive：仅在其 `alloc.o` 中排除 C++ 覆盖块，保留 C/POSIX 覆盖及其余 SDK archive 成员，检查不存在 `_Znw/_Zna/_Zdl/_Zda` 全局定义。使用整库链接确保原版 SDK archive 不被再次选入。不使用允许重复符号的链接选项，不修改 SDK 源文件或共享缓存；保留 UE 自己的 C++ 分配入口。

v43 初次实景启动在约第 18 帧触发 `StatsData.cpp:863`，`Stat None_460 was not cleared every frame, but was used with a scope cycle counter`；复测通过六机位及返回出生点，截图明暗与原版一致。失败与成功记录都保留，说明异常是间歇出现；尚不能归因于 mimalloc 本身或现有 Web 内存/并发问题，不能通过关闭统计或断言绕过它。

## 独立分配器契约与模型

`allocator-contract.cpp` 验证 8～4096 字节对齐、可用块大小、重分配复制、realloc 内容保持、四线程分配后由其他线程释放并检查数据。并复用上一轮 3200 draw / 24 entries 的 CPU 准备模型，按 dlmalloc → mimalloc → mimalloc → dlmalloc 执行。

这里使用 SDK 原版分配器，原版 mimalloc 也覆盖 C++ new/delete；UE 候选保留 UE 自己的覆盖，两者边界不同，独立模型数据不能替代实景结果。构建重叠期间的 validation 数据仅用于功能检查，不报性能收益。

正式独立对照使用 `allocator-contract-v43-final-v2.json`，没有编译和打包重叠，四轮契约和校验和均通过。同一 `rebuild-allocation` 模型，两次运行中位数的平均值如下：

| 线程数 | dlmalloc | mimalloc |
|---|---:|---:|
| 1 | 0.658 ms | 0.653 ms |
| 2 | 0.605 ms | 0.335 ms |
| 4 | 1.375 ms | 0.193 ms |

此项四线程约快 7.14 倍，单线程没有相应差距，支持竞争开销的判断；不等于游戏帧率可提高七倍。

官方说明 dlmalloc 的全局锁和 mimalloc 的线程局部分配上下文，亦说明 mimalloc 会增加内存占用：[Emscripten Allocator performance](https://emscripten.org/docs/porting/pthreads.html#allocator-performance)。这些是选择实验的依据，具体项目收益以本轮 A/B 为准。

## 实景帧率与决定

Edge 156.0.4314.58，i9-12900K / RTX 4090；浏览器视口 2289×1287，RHI 输出 2289×1288，内部 1484×835，AA=4，4 核上限、3 个任务 Worker，Game/Render/RHI 分离。每轮加载后预热 15 秒、记录 20 秒。1% Low 使用最慢 1% 帧间隔的平均值取倒数，表中汇总合并两轮样本，不是两个 Low 值取平均。

| 对照组 | 轮次 FPS | 汇总 FPS | 汇总 1% Low |
|---|---|---:|---:|
| 第一组：v38 原版 | 56.38 / 50.35 | 53.36 | 24.05 |
| 第一组：v44 去代理、dlmalloc | 57.30 / 57.42 | 57.36 | 24.31 |
| 第二组：v44 去代理、dlmalloc | 62.01 / 52.15 | 57.08 | 26.04 |
| 第二组：v45 去代理、mimalloc | 69.00 / 64.61 | 66.81 | 26.15 |

两组分别按 A→B→B→A 顺序，不能将不同组的数字直接拼成一次对照。第一组汇总约提高 7.5%，但原版首尾漂移约 6 FPS，去锁效果尚不足以可靠定量。第二组汇总提高约 17.0%，RHI 工作时间两轮均值约 13.28→10.61 ms；对照版首尾又漂移约 9.9 FPS，所以 17% 只是本轮观测值，不承诺稳定幅度。

项目配置、Cook、视角、分辨率完全相同；实际遮挡结果未完全相同：第二组 v44 每帧约 3141～3237 draw / 88～98 indirect，v45 约 3029～3046 / 74～77，dispatch 都约 66.4～66.6。不能把这些轮次当成逐条完全相同的 GPU 命令流，也不能把所有帧率差归于分配器本身。保留完整负载计数和首尾波动。

**平均帧率有收益，1% Low 没有明确改善，远未消除与桌面端的差距。** v44、v45 均通过六机位及返回出生点检查，未发现距离场/光照变化、GPU 验证错误或崩溃；v45 两次正式记录和后续独立 CPU 采样也完成。v43 的早期间歇 Stats 失败仍未定位，因此 mimalloc 保持显式实验选项，不进入默认构建。不以关闭统计、关闭断言或降低画质掩盖失败。

默认构建已恢复为 v44：dlmalloc、无额外 UE 代理、无分配插桩、无 SIMD/最终链接 O2/LTO；JS 和 Wasm 哈希逐字节与 v44 包一致。417 个对象中 416 个仍使用 O2，Chaos 单元 O1，最终 Wasm/JS 链接仍采用已验证画面的原设置。上一轮最终链接优化后的画面异常继续保留调查，不因本轮放弃该路线。

可直接测试 [v45 mimalloc 实验页](http://127.0.0.1:8765/build/villa-mimalloc-no-proxy-v45/index.html) 或 [v44 dlmalloc 对照页](http://127.0.0.1:8765/build/villa-allocator-no-proxy-v44/index.html)。实验页不包含分配探针。

## 实际调用次数与采样

v46 独立计数窗口约 5.008 秒 / 212 个 RHI 完成帧，包含第三方在 libc 边界的调用，不是内存存量：

| 已确认线程 | 每帧 posix_memalign | 每帧 free | 每帧 malloc_usable_size |
|---|---:|---:|---:|
| RHI | 3698 | 5445 | 5603 |
| Game | 264 | 212 | 214 |

其余 7 个活跃记录保留 pthread 指针；阻塞 Worker 的 JS 身份查询未返回，不能可靠把它们映射到 Render/Task/IO，所以不猜测线程身份。RHI 的分配申请流量约 1.28 MB/帧，不代表每帧永久增加相同内存。

另一组独立 CPU 采样，按各线程自己的采样时段分类：

| 版本 | RHI 分配相关栈 | Render 分配相关栈 | RHI 底层分配器锁等待 | Render 底层分配器锁等待 |
|---|---:|---:|---:|---:|
| v46 去代理、dlmalloc，探针未启用的采样阶段 | 13.07% | 15.41% | 3.77% | 4.05% |
| v45 去代理、mimalloc | 2.84% | 3.06% | 未采到 | 未采到 |

采样确认默认去代理后仍存在底层竞争，替换分配器后相关热点下降。未采到不等于等待绝对为零；两版本采样窗口、负载和内联情况不同，不能用占比直接精确计算每帧节省。v46 即使关闭计数也保留链接包装入口，因此只作诊断，不进入正式帧率表。计数窗口的逐调用时间包含时钟和插桩开销，不能与正常 RHI 工作时间直接相减。

原版 RHI 分配热点涉及 `TArray` 扩容、RHI transition 临时数据、`FWebGPUUniform` 析构/内存释放及块大小查询；Render 涉及 `FRDGBuilder::SetupPassInternals` 等。后续可以针对短生命周期分配减少重建/扩容，但需逐点验证生命周期与跨线程释放，不能直接把临时对象改成共享缓存。

## mimalloc 后剩余差距的归因

用户继续测试 v45，未遇到早期 Stats 断言；这是额外的正面运行反馈，仍不能据此确认间歇失败根因已解决。本节重新分析上轮已保存的 v45 Worker profile，没有启动新性能测试或修改运行时。

**Wasm/JS 交互仍有开销，但现有证据不支持将剩余差距全部归于跨语言调用。** RHI 中 `SetDrawBindings` 包含子调用约 30.43%，`CreateGroups` 约 19.91%，JS 命令回放约 9.60%；这些路径相互包含，不能相加。其中 `CreateGroups` 相同函数名的自身采样合计约 7.70%，不是 19.91% 都消耗在函数自身或纯 Wasm 计算。实现位于项目 WebGPU RHI，涉及资源解析、版本/状态检查、已准备绑定复用、临时描述符、JS 对象/API 调用；不是 D3D12 RHI 原样运行，也不能因名称是 C++ 就全部归给 UE 公共代码。

按采样叶子划分 RHI 时段，各分类互斥：

| 采样叶子 | RHI 采样时长占比 | 解释 |
|---|---:|---|
| Wasm 函数 | 46.02% | 包含引擎、Web 后端和平台基础逻辑，不能视为普通 UE 计算独占 |
| 按名称识别的浏览器 WebGPU API | 14.39% | 如 setVertexBuffer/createBindGroup/writeBuffer，包含前端实现成本 |
| JS 脚本 | 10.07% | 包含包装、对象表、回放及运行时，不是纯 ABI 成本 |
| 显式跨语言边界 | 1.16% | 只包含叶子恰好落在边界帧的样本，会漏掉内联转换，不能当成交互总开销 |
| idle | 25.60% | owner Worker 无任务时段，不代表 GPU 利用率 |
| 其他/GC | 2.76% | 未可靠细分的叶子及 GC |

`WebGPU.getJsObject` 自身约 1.83%、`growMemViews` 约 1.01%、`bigintToI53Checked` 约 0.48%，说明此前减少桥接调用并未将其消除。另一方面，`CreateGroups`、访问状态校验和 C++ 命令资源表本身仍有计算，不能指望只优化 BigInt 转换就消除其余全部成本。此前独立动态绘制命令流的完整前端已到约 0.605 ms，纯 JS 约 0.550 ms；该模型不覆盖真实场景所有资源绑定与浏览器后台，不能用 0.055 ms 直接代表实景差距。

线程等待也需分别判断：Render 约 69.62% 的叶子落在 futex 等待，其中约 52.11% 是任务队列等工作，约 10.96% 明确位于 `EndFlushResourcesRHI` 的 RHI 完成等待；不能把所有等待都当成锁竞争。RHI 未采到同步代理主线程等待，不支持“每个 draw 都同步代理到页面主线程”的解释。

Game 约 21.64% 的采样位于同步主线程代理路径，`GetDPIScaleFactor` 包含子调用约 16.59%，`RefreshWindowSize` 约 4.45%。源码 `WebApplication.cpp` 的 `BrowserScale/BrowserSize` 在 Worker 模式使用 `MAIN_THREAD_EM_ASM_DOUBLE`，读取 owner Worker 的 `__webBrowserState`；这里的 Emscripten main runtime thread 是引擎 owner Worker，不能误称所有请求都访问 DOM 或浏览器页面 UI 线程。Game pthread 等待 owner 应答，是后续减少同步跨线程查询的具体线索；当前未单独做修改或 A/B，不能承诺帧率或 Low 收益。

后续已对平台属性同步查询和 Web RHI 绑定准备分别实施修改、画面校验及 ABBA，见 [Web 窗口同步查询与绑定准备优化](UE58_WEB_WINDOW_BINDINGS_AB.md)。本节保留修改前 v45 的采样归因。与 Low 帧时间对齐的线程/浏览器跟踪、最终 Wasm/JS 链接优化后的画面异常仍需继续调查；这个短 CPU 栈不能覆盖浏览器 GPU 进程、Dawn 后台与真实 GPU 时间，也没有证明 1% Low 是上述任一热点造成。

复现分析：`node tests/web-platform/analyze-web-frame-costs.cjs tests/web-platform/results/villa-mimalloc-no-proxy-v45-cpu-profile-1-workers tests/web-platform/results/new-frame-costs.json`。输出已保存为 [mimalloc-v45-frame-costs-20261103.json](tests/web-platform/evidence/mimalloc-v45-frame-costs-20261103.json)，包含原始采样及分析源码哈希。所有百分比均以各线程自己的采样时段为分母；这些线程窗口不同，不能合并为一帧的成本。

## 诊断与复现

`analyze-web-allocator.cjs` 从原始所有 Worker CPU profile 中分类调用路径和等待。`web-allocation-probe.cpp` 是显式启用的独立链接诊断：在 libc 边界记录每个 pthread 的调用数、申请字节和包含耗时。使用每线程独立记录，没有共享计数锁；只在启动后的一小段采样中开启。该计时有插桩和时钟开销，且不包含进入 libc 前的 UE 代理锁等待；不能拿来报告正常 FPS。

计数窗口在 CPU profiler 停止后开启。pthread 身份查询只作为可选信息，阻塞线程无法执行 JS 查询时会超时返回，避免影响采样。普通帧率测试不启用 profiler 或分配探针。

```powershell
./tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 6 -RendererRevision d175ae4ae
./tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -Mimalloc -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4 -RendererRevision d175ae4ae
./tests/web-platform/build-allocator-contract.ps1
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/benchmark-allocator-contract.cjs allocator-contract-rerun
node tests/web-platform/benchmark-villa-threading.cjs --folders=villa-bridge-extras-v38,villa-allocator-no-proxy-v44,villa-allocator-no-proxy-v44,villa-bridge-extras-v38 --tag=allocator-proxy-rerun
node tests/web-platform/benchmark-villa-threading.cjs --folders=villa-allocator-no-proxy-v44,villa-mimalloc-no-proxy-v45,villa-mimalloc-no-proxy-v45,villa-allocator-no-proxy-v44 --tag=allocator-mimalloc-rerun
```

后台用户程序保留；构建、独立性能测试和实景性能测试串行执行，环境监控保留。完整原始日志位于 `tests/web-platform/results/`。

正式记录期间没有游戏、UE 编辑器、ShaderCompileWorker 或编译器重叠；TGitCache、语音、后台下载等程序仍有 CPU 活动，不能宣称独占机器。机器环境和轮次漂移是本轮结论的限制。

汇总与校验：`node tests/web-platform/summarize-web-allocator.cjs`，产出 [evidence/web-allocator-20261103.json](tests/web-platform/evidence/web-allocator-20261103.json)。它检查独立契约、两个 ABBA、对象与产品哈希、画面检查、保留的失败、原始采样及环境窗口。帧率捕获后仅修正诊断分支的 Wasm64 指针转数字：为原始帧率驱动保留精确源码快照并核对哈希，未改写原始报告或将历史哈希冒充当前源码。汇总验证成功不代表 mimalloc 间歇问题已解决。
