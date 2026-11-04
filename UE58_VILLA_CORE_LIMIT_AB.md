# Web 核心数与线程规模对照（2026-11-03）

同一别墅包、默认出生视角下，提高 Web 的核心数上限没有带来收益。4 核 / 3 个任务工作线程最快；6 核与 8 核平均帧率分别下降约 4.37% 和 8.79%。本轮保留默认 4 核策略。

## 六轮结果

| 向 UE 报告的核心数 | 任务工作线程 | FPS | 相对 4 核 | 1% low | RHI 工作 ms/帧 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4 | 3 | 53.39 | 基线 | 29.25 | 14.37 |
| 6 | 5 | 51.05 | -4.37% | 29.99 | 15.31 |
| 8 | 7 | 48.69 | -8.79% | 28.42 | 16.22 |

顺序为 4 / 6 / 8 / 8 / 6 / 4。逐次 FPS：4 核 53.43 / 53.35；6 核 51.16 / 50.95；8 核 48.64 / 48.75。每组两次趋势一致；6 核的 1% low 仅比 4 核高约 0.75 FPS，结合单次波动，不作为稳定性改善的结论。

RHI 工作时间随线程规模增加而上升，更多任务线程没有抵消这部分开销。此结果支持优先调查提交、绑定和同步开销，不能仅靠提高核心数上限缩小与桌面端的差距。

## 控制条件与实际线程

- 同一个 pthread WASM、相同 Cook 内容与配置、同一可见 Edge 配置，未设置 CPU affinity；这是 UE 并行调度规模的对照，不是把硬件限制到 4 / 6 / 8 个物理核心。
- i9-12900K，16 物理核心 / 24 逻辑处理器，RTX 4090；浏览器只提供逻辑并发数，不提供物理核心拓扑。
- 每次重新载入页面，至少完成 90 帧，再预热 15 秒，测量约 20 秒。正常帧率测量不启用 CPU 采样、逐 draw 计时或显式 PSO 预缓存，也不扩大浏览器 GPU 缓存。
- 保留独立 Game、Draw、RHI，以及现有 UE 调度器。线程见证确认实际任务线程为 3 / 5 / 7；没有线程池耗尽、GPU 校验错误、致命断言或页面异常。
- 相机、项目渲染设置、TSR、距离场和光照不变。实际内部尺寸 1484×835、输出 2289×1288、TSR（AA=4）。
- 所有测试统一 `-WebThreadingTest=full`，沿用前一轮统一的 `r.pso.EnableAsyncCacheConsolidation=0`，避免混入 PSO 缓存维护调度差异。

FPS 取完成的 RHI viewport presents / 测量墙钟时间；1% low 取最慢 1% 帧间隔的均值倒数。合并同组两次的全部样本，不删除慢帧，不把短时预检查或 CPU 采样数据混入此表。

同设置不等于完全相同的提交工作量。4 / 6 / 8 核平均 draw 约 3134 / 3152 / 3186，间接 draw 约 87.7 / 89.8 / 94.1，dispatch 约 66.51 / 66.52 / 66.55；8 核 draw 比 4 核约多 1.66%。异步遮挡结果的消费和纹理流送也受线程时序影响，不能把全部帧率差都归为相同工作量下的调度成本。

各测量区间纹理流送均无 pending，请求与驻留已稳定；不同运行间驻留 mip 为 5731～5764，驻留纹理约 460.45～474.70 MiB。没有修改流送或画质设置来强行统一驻留量。完整驻留与工作量记录留在证据中。

## 4 / 8 核的 CPU 采样

六轮正常测量结束后，另开 4 / 8 核运行，各自预热并完成独立短时帧率检查，然后才开启 Worker CPU 采样。采样期间的数据不进入上面的 FPS 表；不同 Worker 依次启停，窗口约 6～7 秒，不是同步的全进程时间线。

| 调用栈采样类别 | 4 核 | 8 核 |
| --- | ---: | ---: |
| RHI 互斥锁 futex 等待 | 6.61% | 9.82% |
| Draw 互斥锁 futex 等待 | 7.24% | 10.42% |
| Draw 在 `EndFlushResourcesRHI` 下等待 | 15.31% | 19.80% |
| Game 互斥锁 futex 等待 | 0.79% | 2.70% |
| RHI 的 `SetDrawBindings` 调用栈 | 33.25% | 33.85% |
| RHI 顶点缓冲绑定桥接调用栈 | 9.60% | 9.72% |

增加线程后，锁等待和 RHI 依赖等待占比都升高。等待栈涉及 `FMemory::Malloc/Realloc/Free`、命令与资源释放、静态 uniform 数组扩容、运行期反射对象字段查询，以及资源生命周期等路径。下一轮应区分分配器竞争与具体资源锁，独立验证减少分配、复用绑定数据或替换分配器的收益。

这些百分比按各线程采样窗口计算，含等待和空闲；类别重叠，不能相加或直接换算成可提升的 FPS。每种配置仅采样一次，也没有记录锁持有者，不能据此断言所有下降都来自同一把锁。采样支持“更多线程加重竞争”的方向，尚未证明锁竞争解释了与桌面端的全部差距。

## 实现边界

原 Web 平台固定最多报告 4 核。UE 通用 `NumberOfWorkerThreadsToSpawn()` 在游戏 / client-only 模式下另有最多 4 个任务工作线程的限制，但当前 Web 是 Program 目标（`UE_GAME=0`、`UE_EDITOR=0`、`WITH_SERVER_CODE=1`），不触发该游戏模式上限。这里更正此前把它当作当前第二层限制的解释：当前 Program 通用函数本来就会按核心数减一创建工作线程。

本轮 Web 平台复用 UE 的 `GetConfiguredCoreLimits()` 读取标准 `-corelimit=`，未指定参数时仍为 4 核，显式测试最多为 8 核，并限制在浏览器报告的可用并发数内。Web 工作线程策略明确为 `max(核心数-1, 2)`，与当前 Program 的通用策略一致，也让未来游戏目标使用明确的相同规模。标准 UE TaskGraph 和 queued pools 对应 3 / 5 / 7，没有另写调度器。核心数在 UE 命令行初始化后缓存，避免过早固定为默认值。

参考引擎实现已提交本地 `f4ad8be4e`，未推送。

Emscripten 最终池容量仍为 28；三组不改变该容量。旧报告中工具链基础值 16 已更正为 Target 的最终覆盖值 28，原始性能样本未改动。

运行时正常 UBT 编译、链接及 WASM 结构验证通过。新诊断包为 `build/villa-core-limit-v34`，复用 `villa-reflection-binary-base-v28` 的已审计 Cook，并沿用匹配该 Cook 的三个隔离渲染源码文件（`d175ae4ae`）。本轮没有重新 Cook、修改安装引擎或替换原发布地址。

## 复现与证据

```powershell
./tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4 -RendererRevision d175ae4ae
node tests/web-platform/package-web-runtime-experiment.cjs --baseline=villa-reflection-binary-base-v28 --output=villa-core-limit-new --evidence=tests/web-platform/results/web-project-triplex-binary-distance-fields-threads-package-results.json
node tests/web-platform/benchmark-villa-threading.cjs --folder=villa-core-limit-new --cores=4,6,8,8,6,4 --tag=core-limit-web-new
node tests/web-platform/analyze-villa-core-limits.cjs tests/web-platform/results/core-limit-web-new.json
```

使用新的包名和报告标签。Playwright 沿用工作区现有 NODE_PATH。只做启动检查可使用 `--cores=8 --warmup=3 --seconds=5`；该数据不应与正式六轮合并。

纳入 Git 的结果、检查状态及源码 / 产物哈希见 [core-limit-ab-20261103.json](tests/web-platform/evidence/core-limit-ab-20261103.json)。本机完整数据：

- `results/core-limit-web-20261103-abba.json`、`-analysis.json`：六轮原始帧间隔及汇总。
- `results/core-limit-web-20261103-abba-{index}-full.log / .png`：线程见证、日志、截图。
- `results/villa-core-limit-v34-build.json`、`-package.json`：普通构建、源码、产品与复用 Cook 证据。
- `results/core-limit-20261103-environment.jsonl`：运行环境抽样。
- `results/core-limit-web-20261103-cpu-{1,2}-workers-analysis.json` 及 `.cpuprofile`：4 / 8 核采样与调用栈。

以上结果来自固定出生视角，不能作为全部场景的核心数最优值。默认值仍为 4，下一轮应独立验证具体 RHI 热点的优化。
