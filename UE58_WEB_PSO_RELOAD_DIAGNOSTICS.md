# WebGPU 刷新后的 PSO 等待调查（2026-11-02）

浏览器缓存实际有命中，刷新后仍等待不能直接解释成“着色器全部重新编译”。上一轮只测了 UE 整体准备时间，尚未区分编译结果缓存、GPUDevice 内的对象缓存和重新创建管线的成本。

## 本次观测

使用同一个 `villa-pso-reuse-v17-tsr-on` 包、同一个 Edge 持久配置目录和同一个源地址。没有清理缓存、修改项目设置或重新 Cook。新增两个诊断工具，产物均在 `tests/web-platform/results/`，运行时和测试包本身不变。

1. `probe-web-pso-reload.cjs`：相同页面连续刷新，记录每条异步管线从请求到 Promise 完成的时间，捕获 WGSL、布局与完整管线状态，并比较内容哈希。只比较着色器内容集合，允许同内容 shader module 的重复创建数量因线程时序不同；管线请求的内容与数量均做比较。
2. `probe-web-pso-replay.cjs`：将捕获到的相同着色器、设备功能 / 上限和管线描述放到不运行 UE 的独立同源页面，仍保持两个请求并发。每次重开浏览器后创建 GPUDevice，完整请求一次，再在同一设备中重复一次。可选采集 GPU / Dawn 跟踪，不用页面帧率推断编译成本。

### 连续刷新

`pso-v17-reload-timing-v2.json` 两轮均通过，实际设置不变，1565 种 WGSL 内容和 1108 条管线请求的描述哈希一致（1078 种不同描述）。因此本轮没有发现因刷新产生随机 shader / 管线内容而破坏缓存键的证据。

| 指标 | 初次打开此轮测试 | 同页面刷新 |
| --- | ---: | ---: |
| 页面就绪 ms | 35351 | 35296 |
| 首次请求到末次完成 ms | 30214 | 30428 |
| 最大并发请求 | 2 | 2 |
| 请求数 / 拒绝数 | 1108 / 8 | 1108 / 8 |
| 单条请求完成耗时中位数 ms | 28.70 | 31.75 |

这些时间包含浏览器调度和 UE 渲染 Worker 忙碌期间的回调延迟，不能全部算成编译器 CPU 时间。8 条拒绝仍是上一轮已记录、巡检路线未使用的超工作组大小计算排列。

### 排除 UE 调度后的复测

`pso-v17-idle-replay.json`：

| 测试 | 重开浏览器后首次请求整批 ms | 同一 GPUDevice 再请求整批 ms |
| --- | ---: | ---: |
| 浏览器 0 | 17919 | 39.19 |
| 浏览器 1 | 17937 | 44.00 |

创建 shader module、还原布局和描述的准备工作另计，约 121 ms。这里完整重建相同的 1108 条请求，预期拒绝仍是 8 条，没有未捕获 GPU 错误。独立页面仍需约 18 秒，说明 UE 排队和跨线程开销不能解释全部等待。同一 GPUDevice 的重复请求约 40 ms，也不能代表刷新后的重建成本。

### 缓存命中的直接证据

`pso-v17-idle-replay-trace.json` 及其两份 `*-trace.json` 记录：

| 观测 | 浏览器 0 | 浏览器 1 |
| --- | ---: | ---: |
| `DawnCachingInterface::CacheHit` 事件 | 4362 | 4358 |
| 位于 Dawn Worker 任务内的上述事件 | 1472 | 1468 |
| Dawn Worker 任务累计线程 CPU 时间 ms | 33863 | 34091 |
| 整批请求耗时 ms | 18009 | 18107 |

缓存事件数量不是 PSO 命中数量：同一条目可能先查询大小再读取，且编译流程包含多层条目。不能据此给出完整 PSO 的命中率。不过，它足以证明并非所有浏览器缓存都失效。

Chromium 的 [MemoryCache::Find](https://github.com/chromium/chromium/blob/main/gpu/command_buffer/service/memory_cache.cc) 在找不到条目时直接返回，只有找到条目才发出这个命中事件；[Dawn 缓存接口](https://github.com/chromium/chromium/blob/main/gpu/command_buffer/service/dawn_caching_interface.cc) 将该事件名用于其缓存。跟踪同时有从磁盘向 GPU 进程填充 Dawn 缓存的事件。相关源码在本轮核对，链接指向上游当前实现。

CPU 时间是两个 Worker 的累计值，约 34 秒，与约 18 秒墙钟时间并不矛盾。这些任务内部仍有较多 CPU 工作；本次公开跟踪未细分到 Tint、DXC、驱动创建各自的占比，不能把 34 秒全部称为重新编译或全部称为校验。

### 禁用磁盘缓存的诊断对照

`pso-v17-idle-replay-no-disk-cache.json` 在诊断浏览器进程中临时加 `--disable-gpu-shader-disk-cache`，不删除现有缓存，不改用户常用浏览器或项目配置。整批首次请求为 19874 ms，同设备重复为 53.75 ms；磁盘缓存填充事件为 0，仍有 1128 次运行内缓存读取命中。

正常缓存的多次结果约 18 秒，此次禁用为约 20 秒。该结果支持磁盘缓存带来部分收益，不能据此承诺固定节省两秒：禁用组只有一次，驱动自己的缓存仍保留，而且没有模拟干净驱动环境。

Edge 的 CDP 和内部直方图页未提供可用的 Dawn 着色器 / PSO 分层命中统计。系统 CPU 栈采样尝试被 Windows 的性能分析策略拒绝（WPR `0xc5585011`），没有获得函数级调用栈；未更改系统策略。这限制了对浏览器内部剩余 CPU 耗时的进一步归因。

## 现在能确认什么

- 浏览器确实复用了缓存条目，不能说“每次刷新都从头编译全部着色器”。
- 缓存二进制条目和当前设备中可直接使用的完整管线对象不同。Dawn 的 [D3D12 计算管线实现](https://github.com/google/dawn/blob/main/src/dawn/native/d3d12/ComputePipelineD3D12.cpp) 即使加载到缓存 blob，仍调用 `CreateComputePipelineState` 建立对象。实际还可能发生部分缓存未命中；本次证据不能给出各层的命中率。
- 当前每次启动广泛预热 1108 条请求。上一轮的 482 条图形预编译中，只有 85 条在已验证的巡检路线中实际绑定。其余管线可能服务其他视角 / 功能，不能简单删除；可以继续接入 UE 的实际使用 PSO 记录，让启动优先准备实际会用到的组合。
- 两个预编译任务的并发限制会把重建工作串成较长队列。独立页面约 18 秒，带 UE 渲染的请求跨度约 30 秒，说明浏览器管线构建本身和运行时调度两部分都需要处理。

本轮只增加诊断与修正结论，没有更改运行时策略。减少不必要的启动预热、改善投递和并发，以及进一步拆解 Dawn / 驱动 CPU 工作，是基于现有证据的后续优化方向。

## 复现命令

需要项目已有的 Playwright 依赖、Edge，以及端口 8765 的本地服务。各浏览器检查顺序运行，复用专用 `stutters` 配置目录。

```powershell
node tests/web-platform/probe-web-pso-reload.cjs --tag=pso-v17-reload-timing-v2 --rounds=2
node tests/web-platform/probe-web-pso-replay.cjs --input=tests/web-platform/results/pso-v17-reload-timing-v2-inputs.json --tag=pso-v17-idle-replay
node tests/web-platform/probe-web-pso-replay.cjs --input=tests/web-platform/results/pso-v17-reload-timing-v2-inputs.json --tag=pso-v17-idle-replay-trace --trace
node tests/web-platform/probe-web-pso-replay.cjs --input=tests/web-platform/results/pso-v17-reload-timing-v2-inputs.json --tag=pso-v17-idle-replay-no-disk-cache --browsers=1 --trace --no-disk-cache
```
