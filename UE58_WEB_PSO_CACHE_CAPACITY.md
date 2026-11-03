# PSO 创建异常：Dawn 缓存工作集超过 GPU 进程容量

日期：2026-11-03。项目：TriplexHouseVilla。浏览器：Edge 156.0.4314.58。

本轮确认一个主要原因：磁盘里有缓存，并不意味着 GPU 进程创建管线时仍能取到缓存。本机默认 Dawn 内存缓存约 6 MiB，完整场景的相应缓存工作集约 35.7 MiB；载入磁盘缓存时以及随后创建 PSO 时会发生淘汰。扩大**实际供 GPU 使用的缓存**后，真实场景 1108 条请求在浏览器重新启动后的管线阶段由数秒降至 154–164 ms。

这是缓存容量的诊断结果。普通网页不能通过标准 WebGPU API 修改浏览器的内部缓存容量。本轮交付了计时、管线身份记录和独立复现工具；诊断参数未写入项目或游戏页面。

## 真实场景独立测试

从 UE 调用 WebGPU 的边界导出 793 个真实 WGSL 模块、实际布局、设备特性与 limits，以及完整的 1108 次异步创建请求。包含 482 次图形请求、626 次计算请求；1100 次成功，另外 8 次为原有的推测预缓存 workgroup_size 超限拒绝。每项重放都检查失败请求的 ID 集合相同。

新建浏览器进程和 GPUDevice，保持同一持久化 profile，按原请求顺序、8 并发，在独立 Worker 内重放。模块用 `getCompilationInfo()` 等待解析、校验完成，随后才开始管线阶段。没有 UE、Wasm、内容 IO、场景渲染和同步 PSO 请求。

| 条件 | 模块阶段 | 管线阶段 | GPU 内存缓存 |
| --- | ---: | ---: | ---: |
| 普通浏览器，完整场景，热重启两轮，不开 trace | 548–636 ms | 5753–5774 ms | 默认容量 |
| 普通浏览器，单独 trace 诊断 | 548 ms | 5411 ms | 6,287,382 B / 405 条 |
| 进程内 GPU，默认容量，trace 对照 | 537 ms | 6792 ms | 6,240,492 B / 404 条 |
| 进程内 GPU，256 MiB 容量，热重启两轮，trace | 537–641 ms | **154–164 ms** | **37,475,641 B / 2600 条** |

进程内 GPU 只是为了使容量参数真正被 Dawn 所在进程读取。默认容量的进程内 GPU 对照仍然很慢，排除了仅靠改变 GPU 进程位置就能解释结果的可能。37,475,641 B 约为 35.7 MiB，是实际缓存占用，并非使用了全部 256 MiB。

默认容量的 trace 记录到 2385 次 WebGPU blob 载入，最终只驻留 405 条；编译工作线程累计占用 42.59 秒，最多同时运行 8 个任务。大缓存的两轮重启中，相应工作线程累计时间降至 0.91–0.97 秒。累计线程时间包含并行重叠，不能当作加载墙钟时间。

`DawnCachingInterface::CacheHit` 包含不同层次的缓存访问，不能把事件数量直接换算成最终 PSO 的命中率。本轮没有声称测到了最终 PSO 的精确命中率。

128 条真实管线的小工作集也验证了缓存能力：新 profile 首轮管线阶段 204 ms，留出 8 秒完成缓存写入后，浏览器重启两轮分别为 20.68、22.33 ms。因此，简单管线单测和复杂场景曾出现很大差距，缓存工作集大小是其中的关键变量。

## 为什么普通的容量参数没有生效

仅给浏览器传 `--gpu-disk-cache-size-kb=262144`，独立 GPU 进程的完整场景热重启管线阶段仍为 5755–5756 ms。

Chromium 源码中，Dawn 的内存缓存工厂调用 `GetDefaultGpuDiskCacheSize()`；该函数检查**当前进程**的容量参数。桌面默认值为 6 MiB。本机普通启动时该参数未出现在 GPU 子进程命令行中，单独扩大浏览器端参数没有解决 GPU 端容量。使用 `--in-process-gpu` 后，两者在同一进程，memory dump 确认完整缓存可以驻留，管线阶段才出现上述显著变化。

这条实验路径只用于确认原因，不应作为网站部署条件。浏览器侧可研究把明确的缓存容量传到 GPU 进程、增加 Dawn 缓存预算，或改善磁盘缓存向内存缓存载入及按需访问的方式。

源码依据：

- [Chromium 桌面缓存默认值](https://github.com/chromium/chromium/blob/main/gpu/config/gpu_preferences.h)
- [容量参数读取当前进程命令行](https://github.com/chromium/chromium/blob/main/gpu/config/gpu_preferences.cc)
- [Dawn 缓存工厂及内存查询](https://github.com/chromium/chromium/blob/main/gpu/command_buffer/service/dawn_caching_interface.cc)
- [内存缓存的 LRU 淘汰逻辑](https://github.com/chromium/chromium/blob/main/gpu/command_buffer/service/memory_cache.cc)
- [Dawn D3D12 编译缓存 Load-or-Run 路径](https://github.com/google/dawn/blob/main/src/dawn/native/d3d12/ShaderModuleD3D12.cpp)
- [Dawn D3D12 PSO 缓存 blob 使用](https://github.com/google/dawn/blob/main/src/dawn/native/d3d12/ComputePipelineD3D12.cpp)

源码链接是上游实现依据；本机行为另由上述启动参数、实际 memory dump 和管线重放验证，不假设上游 main 与 Edge 内部源码完全相同。

## UE 内部计时与重复创建

新增可选原生计时：线程池请求入队 → owner 代理被执行 → 独立 JS task 开始 → WebGPU API 提交 → JS Promise 完成 → C++ 回调。不同 Worker 都使用 `performance.timeOrigin + performance.now()` 对齐，未启用启动分析时不读取 JS 计时钟或写入诊断记录。

普通浏览器的两轮关卡测试均完成 1954 次预缓存处理：1108 次进入 WebGPU，846 次由原有能力检查提前拒绝。

- 入队到代理执行的中位数约 0.03 ms。
- 代理到 owner 独立 task 的中位数 0.065–0.095 ms，但着色器集中加载期间有约 **1.5 秒**长停顿，8 个预缓存线程同时等 owner。
- 原生描述构建平均 0.41–0.49 ms，中位数约 0.22 ms。
- JS Promise 完成到 C++ 回调的中位数约 **0.025 ms**，P95 约 0.045–0.050 ms。回调桥接没有造成数秒的尾部。

最初的身份记录还确认：1108 次异步请求只对应 1078 个不同的完整 WebGPU 描述，存在 30 次重复异步创建。同一轮还发现 30 类管线先被运行期创建、随后才预缓存，23 类管线在异步预缓存完成后又被运行期创建；只有 1–2 类是在异步请求仍未完成时发生运行期创建。它们是可优化的额外工作，但这组数据不支持把主要损耗归因于“首次绘制与未完成预缓存大量竞争”。

身份键记录完整描述、模块及布局对象身份，忽略 label；不会将不同模块或省略默认值不同的描述强行合并。因此重复计数是保守值，不能简单用它替换 UE 原有 PSO hash，也不能在 owner 上阻塞等待 Promise。

## 实际关卡验证

使用同一个 `villa-pso-queue-v29` 包；Wasm、Cook 内容、配置、视角与画质一致。所有以下热启动内容下载量均为 0。

| 浏览器诊断条件 | 导航至画面可见 | 引擎 READY 至最后一个异步 PSO 完成 |
| --- | ---: | ---: |
| 普通浏览器，默认容量，第二轮 | 16.244 s | 3.150 s |
| 进程内 GPU，默认容量，两轮 | 22.368 / 23.317 s | 11.247 / 11.238 s |
| 进程内 GPU，256 MiB，第二轮 | **11.744 s** | **0.054 s** |

进程布局本身会影响性能，因此普通浏览器与特殊诊断参数的端到端差值只用于说明缓存改善确实能传导到关卡启动，不把 11.744 s 声称为普通用户页面现已获得的优化。

较大缓存下图形异步请求平均 10.84 ms、计算 4.08 ms，普通浏览器相应为 52.60、76.34 ms。完整 UE 的异步创建跨度仍有 6.23 秒，因为请求随着着色器与关卡加载逐步产生，并穿插 owner 停顿；不能把这段跨度全部算作浏览器编译时间。

页面还要求至少经过 30 个引擎帧，并满足预缓存计数归零后才关闭加载提示。故加载提示的 PSO 阶段还可能包含帧预热及状态轮询；它不等于单纯创建管线的时间。新增原生记录可以分开观察这些时刻。

本轮构建通过；两个普通浏览器启动及四个带诊断参数的关卡启动通过，画面已检查。保留原有八个推测预缓存拒绝，未增加未捕获的 GPU 错误。此次关注启动与缓存，不作为运行期平均帧率或 1% Low 的性能验收。

## 工具、复现与后续方向

新增 `analyze-web-pso-identity.cjs`、`benchmark-web-pso-corpus.cjs`、`web-pso-replay-worker.js`、`analyze-web-pso-cache.cjs`。可选 `--pso-corpus` 在采样冻结后导出 WGSL 与描述，避免把导出耗时计入启动。语料位于被忽略的本地 results 目录，未作为普通页面的额外资源。

诊断页面：`http://127.0.0.1:8765/build/villa-pso-queue-v29/index.html`。正常打开使用浏览器默认行为，可通过“导出启动分析”采集身份及原生分阶段数据。

```powershell
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node capture-web-startup-phases.cjs --folder=villa-pso-queue-v29 --tag=pso-capture-new --rounds=2 --manual --pso-corpus
node benchmark-web-pso-corpus.cjs --corpus=results/pso-capture-new-1-pso-corpus.json --tag=pso-replay-new --rounds=2 --module-fence --settle-cache-ms=8000
```

容量因果对照在第二条命令基础上加入 `--gpu-cache-kb=262144 --in-process-gpu`，并使用相同的 `--profile`。这些是隔离测试浏览器的参数，不是项目画质设置或生产运行要求。第一次填充缓存与浏览器重新启动后读取缓存的数据需要分开报告。

优先处理方向：浏览器侧完整缓存驻留；UE Web 后端复用实际相同的已完成管线、合并重复预缓存请求；缩短集中着色器加载对 owner 的阻塞。前两者分别对应本轮确认的主要缓存损耗和较小的重复工作。应继续保持预缓存覆盖率，不能用跳过全部预缓存或降低项目设置来宣称修复。

紧凑证据：`tests/web-platform/evidence/pso-cache-capacity-20261103.json`。原始记录及 trace 的路径、SHA-256 和运行条件均保留在证据中。
