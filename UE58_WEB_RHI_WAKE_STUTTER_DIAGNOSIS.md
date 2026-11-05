# Web RHI 唤醒与静止画面周期长帧

2026-11-05。调查对象是 Villa 静止镜头、Game 本地时钟、有效遮挡历史默认模式。先保留 v67 原包复现，再在相同 WASM、Cook、光照及分辨率的 v68 包内对照 RHI 回调调度。

## 已定位的原因

问题可以复现，与 RHI 唤醒和排队有关。直接占用 GPU 所属 Worker 的工作是浏览器原生堆清扫 `cppgc::internal::Sweeper::…::IncrementalSweepTask`，不是新增 PSO 编译。

- 未加详细探针的 v67 连续 60 秒：105.26 FPS，1% Low 51.77 FPS，最长 22.47 ms；54 帧超过 18 ms，30 帧超过 20 ms。长帧通常每隔约 3.2 秒成组出现。
- 独立诊断的 60 秒：104.23 FPS、1% Low 52.39 FPS，说明细化记录没有制造这种周期。
- 另行录制的 25 秒浏览器时间线中，20 个超过 18 ms 的帧全部与同一 RHI Worker 上的清扫任务重叠。典型 20 ms 长帧里约 10.4 ms 来自两次清扫。
- 清扫通常每隔约 3.4 秒成组执行，每组总计约 28～32 ms，分散插入多次事件循环。单片约 5.1～5.4 ms。`MajorGC` 本身约 2.5～2.9 ms，不能仅靠它的总时长解释长帧。
- 诊断期间没有管线或 shader 创建事件；累计 graphics/compute pipeline 数量稳定，纹理流送 pending 为 0，摄像机与画质配置稳定。

RHI 当前在 `TaskGraph.cpp` 每处理一批任务后主动让出 Worker。`WebWakeRHIThread()` 将下一次执行先放进 Emscripten 代理队列，再通过 Worker 本地 `setImmediate` / MessageChannel 调用 `FRHIThread::WebPump()`。

典型长帧的过程：

```text
上一批 RHI 结束
  → 浏览器清扫约 5 ms
  → 代理回调接收唤醒，排入 MessageChannel
  → 浏览器再次清扫约 5 ms
  → 执行下一批 RHI，约 9～10 ms
```

因此，“排队慢”是症状之一；排队期间 Worker 正在执行浏览器清扫。普通帧的第二段排队中位数约 0.255 ms，长帧期间约 5～6 ms。该探针只测量 `setImmediate` 这一段，未单独测量前面的原生代理排队。

## 候选调整

仅把 owner Worker 的 `setImmediate` 回调改用 `scheduler.postTask(..., {priority:'user-blocking'})`。继续异步让出事件循环，让 WebGPU 回读和清扫继续执行，保留回调取消语义。浏览器没有该 API 时回退 MessageChannel。

候选开关为 `?rhiwake=priority`，对应 `-WebRHIWake=priority`；`?rhiwake=channel` 为原调度。当前默认仍为 channel。可从 `__webRHIWakeScheduler` 查看请求模式和实际模式。

初步带探针实验为 104.23 → 107.17 FPS、1% Low 52.39 → 66.44 FPS；60 秒超过 20 ms 的帧为 28 → 0。这只是定位阶段的数据，正式收益以不带详细探针的交错测试为准。

## 复测与证据

正式对照使用 v68 同一个包，按 channel / priority / priority / channel 顺序，每轮独立可见 Edge 会话，等待至少 600 帧、纹理流送完成，再额外预热 15 秒，采样 60 秒。沿用原 Cook、光照、2289×1287 CSS 像素、DPR 1、实际渲染分辨率；每轮启动前检查 GPU 空闲。正常性能段没有 CPU profiler、浏览器 trace、逐 draw 包装或额外 GPU query。

| 指标 | 原 MessageChannel | priority 候选 |
| --- | ---: | ---: |
| 平均 FPS，合并两轮 | 108.03 | 107.41（-0.58%） |
| 1% Low，合并两轮帧间隔 | 53.43 | 66.95（+25.30%） |
| 最长帧 | 24.73 ms | 16.88 ms |
| 超过 18 ms，合计各 120 秒 | 100 帧 | 0 帧 |
| 超过 20 ms，合计各 120 秒 | 40 帧 | 0 帧 |
| P95 | 10.43 ms | 10.77 ms |
| P99 | 14.03 ms | 14.44 ms |

每轮 FPS / 1% Low 依次为：107.65 / 53.78、107.10 / 66.73、107.71 / 67.19、108.42 / 53.28。改善集中在最差的一小部分帧；P95、P99 没有改善，平均吞吐没有提升。不能将这一调整描述为提高最高 FPS。

两组都持续消费真实遮挡结果。候选平均每帧历史命中约 545 次，原调度约 558 次；候选 direct draw 约 2858，原调度约 2833。回读消费时序发生小幅变化，候选更常回退到可见绘制，没有修改有效期、遮挡精度或画质 CVar。

人工复核链接：[priority 候选](http://127.0.0.1:8765/build/villa-rhi-wake-v68/index.html?rhiwake=priority)、[同包原调度](http://127.0.0.1:8765/build/villa-rhi-wake-v68/index.html?rhiwake=channel)。两侧默认都使用 Game 本地时钟与有效遮挡历史。

候选的独立 25 秒时间线仍有 8 轮 `MajorGC` / 清扫、60 个清扫任务、清扫总计 245.65 ms，单片最长 5.39 ms；没有超过 18 ms 的提交帧。第二段排队中位数为 0.030 ms、最大 0.200 ms。原调度对应 25 秒里有 7 轮清扫、57 个任务、211.98 ms。两次录制窗口与对象数量不完全相同，不把总清扫耗时作性能收益对比；这里只验证回收持续推进，候选没有靠停掉回收换取短时间低帧改善。约 14～16 ms 的回收帧仍然存在。

功能检查还包括：异步执行、回调取消、priority 参数，以及在真实 Edge Worker 中人为隐藏 `scheduler` API 后的自动回退。回退实测 10 秒正常运行，实际模式报告为 channel。四轮正式对照与两侧时间线均未报告 GPU validation、device lost、fatal、assert 或 Ensure 错误。

```powershell
node tests/web-platform/probe-web-occlusion-history.cjs --folder=villa-rhi-wake-v68 --tag=rhi-wake-abba-20261105 --modes=default,rhi-priority,rhi-priority,default --seconds=60 --warmup=15
node tests/web-platform/probe-web-rhi-stalls.cjs --folder=villa-rhi-wake-v68 --tag=rhi-wake-priority-trace-20261105 --immediate=native-priority --seconds=10 --trace-seconds=25
node tests/web-platform/analyze-web-rhi-stalls.cjs tests/web-platform/results/rhi-wake-priority-trace-20261105.json
node tests/web-platform/probe-web-rhi-stalls.cjs --folder=villa-rhi-wake-v68 --tag=rhi-wake-fallback-20261105 --immediate=native-priority --without-task-scheduler --seconds=10 --trace-seconds=0
```

v67 首次时间线录制时尚未加 capture-start mark。分析器用连续 RHI callback 的开始时间和执行时长匹配两条记录，时钟偏移为 93556241.16 ms，owner thread 为 19744。后续录制直接通过 `performance.mark` 自动对齐。证据中保留原始文件 SHA-256 和对齐样本。

可携带的汇总证据为 `tests/web-platform/evidence/rhi-wake-stutters-20261105.json`；完整逐帧数组、trace 和当次注入源码留在 `tests/web-platform/results/`。v68 复用已经完成正常 UBT 编译的 v67 JS/WASM，没有重新编译引擎。本轮仅增加 Worker 调度候选、诊断脚本和 URL 开关；原 v67 证据与包保持原样。

## 边界

- 本轮确认的是该场景静止镜头的周期长帧，不能推断所有移动长帧或所有浏览器都来自同一原因。
- 调度优先级只能减少清扫插队造成的连续停顿，不能消除对象创建和回收本身的成本。尚未按具体原生对象类型归因，不能断言某类 GPUBuffer 或 BindGroup 是来源。
- FPS 与 1% Low 来自 RHI 提交间隔，不是物理屏幕显示或端到端输入延迟测量。
- 诊断还看到了 `FGenericPlatformMemory::GetStats not implemented` 的逐帧警告。它值得另行处理；本轮没有把它认定为周期清扫的根因，也没有同时修改它。
- HZB、遮挡结果有效期、Game 时钟、画质参数均沿用既有模式。候选尚未替换默认调度。
