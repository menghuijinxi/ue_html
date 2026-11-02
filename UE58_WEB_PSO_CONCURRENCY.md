# WebGPU PSO 启动并发测试与修复（2026-11-02）

此前每次刷新后重建 PSO 需要约半分钟。浏览器缓存条目确有命中，但当前跟踪不能证明每条着色器二进制和最终驱动 PSO 缓存都命中。本轮验证了另一项可以直接修复的原因：Web 后端把 UE 预编译线程池固定为两个任务，而每个任务都阻塞等待浏览器异步创建完成，导致整个启动批次只能保持两个请求并发。

## 修改

- 继续使用 UE 原有的 PSO 收集、去重、任务优先级、线程池和有界 RHI 对象缓存，没有新增一套 PSO 管理系统。
- Web 的请求并发默认取浏览器逻辑核心数的一半，限制在 2–8。本机 24 个逻辑核心，实际为 8。增加 `-WebPSOPrecacheConcurrency=1..8` 参数，方便同一二进制做对照；它控制预热调度，不修改渲染质量。
- Wasm pthread 预分配池由 20 扩到 28，为最多八个等待任务以及 UE 的渲染、游戏、IO 等线程保留容量。增加 RHI 诊断字段 `precacheConcurrency`。
- 预热的 1108 条请求全部保留，页面继续等 UE 队列和真正的浏览器异步回调完成后才开放输入、显示场景。

## 独立页面对照

复用 v17 捕获的相同 WGSL、管线描述、设备功能和限制，在不运行 UE 的同源页面重建。每次关闭并重开 Edge，保留同一专用配置目录、浏览器磁盘缓存和驱动缓存。顺序为 `2,4,8,16,16,8,4,2`，每组两次；没有同时运行多个 GPU 测试。

| 同时请求数 | 两轮整批耗时 s | 均值 s |
| --- | --- | ---: |
| 2 | 17.915 / 18.267 | 18.091 |
| 4 | 10.270 / 10.316 | 10.293 |
| 8 | 6.403 / 6.507 | 6.455 |
| 16 | 5.033 / 5.043 | 5.038 |

8 相比 2 缩短约 64%；16 的进一步收益较小。本轮实际 UE 上限选 8，独立页面的 16 不能直接等同于有完整渲染负载的收益。请求数均为 1108，拒绝的仍是原来的八个超工作组大小排列，拒绝索引一致；没有新增未捕获 GPU 错误。

原始报告：`tests/web-platform/results/pso-v18-concurrency-{0..7}-c*.json`。

## 实际 UE 场景启动

修改后完整 UBT 编译、417 对象链接和 Wasm 结构验证通过。构建日志 `tests/web-platform/results/web-engine-full-thread-20261102-165007.log`，审计报告 `web-engine-full-thread-build-results.json`。复用之前验证的原项目 TSR Cook；本轮不重新 Cook，不修改项目配置。新包与 v17 的 `content.bin`、资源清单、项目配置文件哈希相同。

先启动一次新运行时进行预热，不计入正式结果。之后顺序 `2,4,8,8,4,2`，每轮重开浏览器。所有组使用同一份新 JS / Wasm、同一页面和持久配置目录，只通过启动参数调整并发。

| 同时请求数 | 两轮页面就绪 s | 就绪均值 s | 首条请求至末条完成均值 s |
| --- | --- | ---: | ---: |
| 2 | 41.309 / 36.670 | 38.990 | 33.655 |
| 4 | 25.009 / 25.322 | 25.166 | 19.636 |
| 8 | 18.072 / 18.096 | 18.084 | 11.621 |

页面就绪均值降低约 54%，请求批次完成时间降低约 65%。这里的页面就绪包含资源加载、Wasm / UE 初始化、前 30 帧及预热完成；请求跨度不等同于编译器 CPU 时间，也不能与独立页面耗时直接相减作严格归因。

六轮交叉断言通过：1565 种着色器内容、1108 条请求 / 1078 种管线描述的哈希集合一致，原有八个拒绝保留，未捕获 GPU 错误为空。TSR 实际 AA=4，距离场、DFAO、距离场阴影开启，内部 1484×835、输出 2290×1288，各轮一致。最大观察到 23 个活动 pthread，至少保留三个空闲 Worker，未出现线程池耗尽。

完整对照：`pso-v18-ue-{0..5}-c*.json`；交叉核对与均值：`pso-v18-ue-concurrency-summary.json`，均位于 `tests/web-platform/results/`。

## 转向与对象复用复核

以同一新运行时另打包强制并发 2 的基准页和默认并发 8 的修改页，JS / Wasm、Cook、配置哈希一致。使用 `2,8,8,2` 四轮，每轮静止 10 秒、首次转向 25 秒、重复转向 25 秒。两组都启用完整预缓存，加载结束后额外等待 15 秒，避免将后台预热混入帧率。

| 次序 | 并发 | 静止 FPS | 首次转向 FPS | 首次转向整段 1% Low | 最长帧 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 | 2 | 46.60 | 66.69 | 25.05 | 68.27 |
| 1 | 8 | 47.79 | 66.50 | 26.93 | 67.71 |
| 2 | 8 | 47.61 | 66.33 | 26.47 | 78.42 |
| 3 | 2 | 48.56 | 67.64 | 27.62 | 86.45 |

四轮功能验证全部通过，`performanceComparable=true`，同组静止 FPS 最大漂移 4.2% / 0.4%。首次与重复转向中的图形 PSO、计算 PSO 和 shader module 新建数全为零，页面异常和未捕获 GPU 错误为空，加载层等待断言通过。8 并发稳定帧率与 2 并发接近，不支持宣称提高运行帧率或进一步改善 Low；它的确定收益是缩短启动等待，同时保留预缓存复用。截图检查中原场景材质、光照和 TSR 显示正常。

逐帧记录、截图与日志：`tests/web-platform/results/pso-v18-concurrency-abba-v2*`。首次尝试启动 ABBA 时，我让它与仍持有配置目录的上一项诊断发生了目录争用，浏览器未启动；该失败报告 `pso-v18-concurrency-abba.json` 保留但不计入结果。确认前一进程结束后完整重跑 v2，通过后才采纳上述数据。

## 实际使用集合的诊断

增加可选的 `--capture-use`，同时观察图形 / Bundle / 计算编码器的 `setPipeline`，以对象身份记录成功异步预热的 PSO 是否实际绑定。加载结束后站立 10 秒，执行五个方向的 25 秒巡检，实际使用了 85 / 482 条图形请求、38 / 626 条计算请求，共 123 条。C++ 的图形复用计数同为 85。这项带绑定观测的运行只作功能与覆盖记录，不用于上表帧率。

独立页面以 8 并发只重放这 123 条实际使用请求，重开浏览器两次分别为 2.329 / 2.300 秒，拒绝和未捕获 GPU 错误均为零；同设备第二轮为 1.7 / 1.8 毫秒。准备 shader module 和布局另计约 111 毫秒。

这支持进一步接入 UE 实际使用记录，优先预热相关组合；**不能据此删掉其余请求或宣称全场景只需 123 条**。巡检没有覆盖所有位置、移动、分辨率和渲染状态，当前交付包仍完整预热全部 1108 条。

记录：`pso-v18-used-route.json`、`pso-v18-used-route-inputs.json`、`pso-v18-used-only-replay.json`。全量 8 并发的附加浏览器跟踪 `pso-v18-full-replay-trace.json` 仍观察到 3224 个底层缓存读取命中，整批为 7.085 秒，累计 Worker CPU 44.378 秒；该跟踪有采集开销，不与无跟踪数据混算。底层事件数继续不能换算为完整 PSO 命中率。

## 结论边界

本轮已证明两请求限制显著拉长了缓存保留后的重建队列，半分钟不是 WebGPU 必然的缓存复用成本。独立页面在 8 / 16 并发下仍有约 6.5 / 5 秒，浏览器内部的着色器缓存、驱动缓存分层耗时还没有完整拆开。本轮不宣称已获得完整 PSO 命中率。

## 复现

```powershell
node tests/web-platform/probe-web-pso-replay.cjs --input=tests/web-platform/results/pso-v17-reload-timing-v2-inputs.json --tag=pso-concurrency-c8 --concurrency=8 --browsers=1
node tests/web-platform/probe-web-pso-reload.cjs --folder=villa-pso-concurrency-v18-default --tag=pso-startup-c8 --concurrency=8 --rounds=1
node tests/web-platform/benchmark-web-pso-precache.cjs --off=villa-pso-concurrency-v18-c2 --on=villa-pso-concurrency-v18-default --tag=pso-concurrency-abba --fresh-browser --both-enabled --aa=4
node tests/web-platform/probe-web-pso-reload.cjs --folder=villa-pso-concurrency-v18-default --tag=pso-used-route --rounds=1 --capture-use
node tests/web-platform/probe-web-pso-replay.cjs --input=tests/web-platform/results/pso-used-route-inputs.json --tag=pso-used-replay --used-only --concurrency=8 --browsers=2
```

`--both-enabled` 表示两组都启用 PSO 预缓存，`off` / `on` 在此仅为基准 / 修改组。所有浏览器测试必须依次运行，不能同时占用 `browser-profiles/stutters`。

测试页：<http://127.0.0.1:8765/build/villa-pso-concurrency-v18-default/index.html>。
