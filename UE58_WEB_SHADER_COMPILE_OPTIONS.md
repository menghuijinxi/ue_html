# WebGPU 着色器编译优化实测

2026-11-05。RTX 4090、i9-12900K、Edge 156.0.4314.58，沿用 v70 的真实首次转向 shader / PSO。测试目标是减少必要编译的计算量、批次等待和首次使用停顿，不启用 PSO 预缓存，不降低画质。

## 已确认的收益

1. **增加实际可并发的编译任务**：完整 Villa 场景中，UE 工作线程从 3 个增加到 7 个，四轮 ABBA 对照的首次转向最长提交间隔中位数 **248.80 → 137.09ms，缩短 44.9%**。这是减少等待；单个复杂 shader 的 DXC 时间仍约 65–70ms。
2. **共享 shader 的 PSO 错开编译**：独立真实 PSO 回放中，同为 3 路并发，DXC 次数中位数 **28 → 23**，DXC 线程 CPU 总时间 **551.61 → 481.20ms，减少 12.8%**，批次 **227.98 → 194.86ms，缩短 14.5%**。这是避免同一会话中同时 miss 的重复计算，不是扩大磁盘缓存，也不依赖跨页面命中。
3. **较大 shader 优先提交**：独立回放同为 6 路并发，批次 **162.50 → 123.76ms，缩短 23.8%**；CPU 总时间只有小幅减少，主要作用是提前开始最长任务。这需要已经拿到待编译描述，不能把预知未来 PSO 的离线回放结果直接当作实时场景收益。

完整场景的反向复测没有确认 shared 调度的稳定额外收益：普通调度的 DXC 次数会从 13 变成 11，后者已与 shared 相同。因此优先考虑增加有效并发，shared 和成本排序只保留为有条件的候选，不据此默认启用。

本轮只提交诊断工具与证据，未改变产品默认开关。`corelimit=8` 会同时改变 UE 的任务/其他线程池，不是独立 PSO 线程池；不能直接认定它是最终实现。

## 控制条件和测量边界

- 微基准是之前捕获的 15 个真实首次使用 PSO、23 个 WGSL 模块、30 个 shader 阶段请求。使用原始布局、入口和渲染状态，不绘制、不运行 UE。
- 原生 DXC 使用 Edge 自带的同一个 `dxcompiler.dll`，同一份浏览器导出的 HLSL、入口、Shader Model 与其他参数。O3 每次 30 个 DXIL hash 均与浏览器基线一致。
- 24 次原生试验、39 次浏览器选项试验、48 次浏览器调度试验；每种配置 3 轮，轮间轮换测试顺序。浏览器每次新进程、新 device，测试前 GPU 占用不超过 50%，无并行构建或其他本任务基准。
- 浏览器试验均关闭 shader 磁盘缓存；明确分为额外关闭 Dawn blob cache 和保留会话内 blob cache 两组。没有清用户全机驱动缓存。
- 浏览器微基准有 `gpu.dawn` trace。累计 DXC wall 时间可因线程重叠大于批次时间，CPU 总量来自线程 CPU scope；这三者不混用。
- `getCompilationInfo` fence 仅隔离模块准备阶段，不代表 DXIL 已编译。该准备时间另记，不包含在下面的 pipeline 批次时间里。
- 完整场景非 trace 对照采用同一 WASM、Cook、分辨率、默认出生点和转向序列；本轮同时禁用 shader 磁盘缓存以稳定首次使用负载，驱动缓存保留。

## 编译参数与源代码处理

### 原生 DXC：30 次阶段编译，中位数

| 选项 | 编译 wall 累计 | 整批 wall | 与 O3 相同的 DXIL hash |
| --- | ---: | ---: | ---: |
| O3 基线 | 596.91ms | 597.79ms | 30/30 |
| O0 | 465.50ms | 466.33ms | 0/30 |
| O1 | 588.00ms | 588.93ms | 4/30 |
| O2 | 600.23ms | 601.22ms | 26/30 |
| Od | 467.77ms | 468.64ms | 0/30 |
| O3，3 路 | 642.33ms | 217.76ms | 30/30 |
| O3，6 路 | 673.35ms | 137.91ms | 30/30 |
| O3，8 路 | 717.99ms | 127.83ms | 30/30 |

O1/O2 没有明显收益。O0/Od 约节约 22%，但会改变 GPU 代码；本轮没有测其 GPU 执行效率，不能只看编译速度就采用。

### 浏览器：强制 30 次阶段编译，串行，中位数

| 处理 | WGSL 字符数 | 模块准备 | DXC wall 累计 | pipeline 批次 |
| --- | ---: | ---: | ---: | ---: |
| 原始 | 320129 | 33.97ms | 558.68ms | 617.89ms |
| Tint minify | 136083 | 26.09ms | 557.00ms | 615.64ms |
| Tint IR roundtrip | 320263 | 33.45ms | 560.35ms | 620.11ms |
| Dawn 跳过优化诊断开关 | 320129 | 33.31ms | 429.41ms | 508.17ms |

压缩 WGSL 减少约 57.5% 文本、约 7.9ms 模块准备，但没有降低关键的 DXC 成本。IR 重写也无收益。

从原 Cook 产物按 WGSL 内容 hash 找回全部 23 个 SPIR-V，分别使用 UE 自带 ShaderConductor 的 `-O`、`-Os` 和 `--eliminate-dead-code-aggressive --simplify-instructions --ccp --redundancy-elimination --cfg-cleanup`，再经同版 Tint 生成 WGSL。三组最终均 **23/23 字节完全相同**，无需重复跑相同内容的浏览器基准。这些常规离线优化已没有剩余空间，不代表所有可能的算法/生成代码优化均已耗尽。

`d3d_skip_shader_optimizations` 是 [Dawn 的内部设备 toggle](https://dawn.googlesource.com/dawn/+/refs/heads/main/src/dawn/native/Toggles.cpp)，通过测试启动参数设置；[标准 WebGPU 管线描述](https://www.w3.org/TR/webgpu/#dictdef-gpurenderpipelinedescriptor)没有对应的 DXC 优化等级选项，不能作为正常打包即可生效的方案。测试未关闭 robustness，也未省略渲染功能。

还观察到：minify 和跳过优化各自第一次使用新字节码时，pipeline 初始化中扣除 shader 编译后的剩余耗时约 **389ms / 411ms**，后两轮约 14–15ms。该剩余包括驱动和其他初始化，不能全部标成驱动编译。原始字节码已在此前测试中使用过，所以不拿这两个首次运行的整批时间作同等冷驱动比较；表里保留全部三轮、中位数与原始证据，不隐去首轮。

## 并发、重复编译和顺序

### 固定 30 次 DXC，避免缓存改变工作量

| 并发上限 | 实际 DXC 峰值 | DXC CPU 总量 | pipeline 批次 |
| --- | ---: | ---: | ---: |
| 1 | 1 | 557.03ms | 617.89ms |
| 3 | 3 | 578.88ms | 240.59ms |
| 6 | 6 | 634.94ms | 168.08ms |
| 8 | 8 | 637.17ms | 160.62ms |
| 16 | 15 | 784.69ms | 137.28ms |

高并发明显减少批次等待，但 CPU 总量反而增加。因此不能称为“单个 shader 编译提速”，也不应无限堆并发。

### 保留会话内缓存，真实重复阶段

`shared` 只阻止同一 shader module / entry 同时在两个未完成 PSO 中编译，待前一条完成后再发；所有原 PSO 都照常创建。`largest` 按当前已知 WGSL 字符总数降序提交，是成本启发式，并非精确编译时间预测。

| 并发 | 策略 | DXC 次数 | DXC CPU 总量 | pipeline 批次 |
| --- | --- | ---: | ---: | ---: |
| 3 | FIFO | 28 | 551.61ms | 227.98ms |
| 3 | shared | 23 | 481.20ms | 194.86ms |
| 3 | largest | 27 | 526.51ms | 202.92ms |
| 3 | shared + largest | 23 | 477.74ms | 183.66ms |
| 6 | FIFO | 28 | 589.30ms | 162.50ms |
| 6 | shared | 23 | 507.74ms | 137.61ms |
| 6 | largest | 26 | 567.69ms | 123.76ms |
| 6 | shared + largest | 23 | 521.31ms | 132.11ms |
| 8 | FIFO | 28 | 611.31ms | 159.70ms |
| 8 | shared | 23 | 538.63ms | 130.66ms |
| 16 | FIFO | 30 | 781.30ms | 136.68ms |
| 16 | shared | 23 | 548.04ms | 128.07ms |

最快完成与最少 CPU 不是同一个选择。当前独立批次的折中在约 6–8 路；实际引擎还需要让出 CPU 给 Game/Render，不能直接把离线最优上限复制过去。

## 完整场景：首次 PSO 编译事件的四轮交错对照

两侧均为 v70 运行期 async PSO 实验；命令行 `-corelimit=4/8`，对应实际 TaskGraph worker 3/7。顺序 4、8、8、4，每次首次转向 25 秒、重复转向 25 秒，先等待初始加载/纹理与编译完成。

**主要判据是首次编译事件覆盖的帧间隔，不是整段平均 FPS 或 1% Low。** 按用户指出的口径，重新分析原始未开 trace 的逐帧/逐请求记录。以下是上轮数据的事件级重算，没有冒充新的性能试验。

每轮首次转向均有一批连续重叠的 15 个 `createRenderPipelineAsync` 请求，入口 label 多重集一致，另有 10 个新 shader module。以请求开始到回调完成的区间组成事件窗口，再寻找与窗口重叠的完整帧间隔。四轮都只有一个这样的帧间隔，且待编译期间 **没有新的视口帧提交**。

| 运行顺序 | UE worker | 首次 PSO 对应的停帧 | 等效单帧速率 | PSO 请求到完成跨度 | 后续 500ms 最慢帧 |
| --- | ---: | ---: | ---: | ---: | ---: |
| A1 | 3 | 243.735ms | 4.10 FPS | 197.010ms | 17.770ms |
| B1 | 7 | 140.865ms | 7.10 FPS | 123.560ms | 16.875ms |
| B2 | 7 | 133.315ms | 7.50 FPS | 114.775ms | 18.565ms |
| A2 | 3 | 253.865ms | 3.94 FPS | 200.610ms | 21.360ms |

`等效单帧速率 = 1000 / 帧间隔毫秒`，用于表达这个卡顿帧的严重程度，不是按一秒窗口统计的 FPS。事件停帧中位数 **248.80 → 137.09ms（-44.9%）**，对应约 **4.02 → 7.29 FPS**。PSO 请求批次跨度 **198.81 → 119.17ms（-40.1%）**。

四轮在该事件外均没有超过 50ms 的帧；事件完成后的 500ms 内也没有超过 50ms 的帧。重复相同转向时，四轮均无新 shader/PSO 请求，也没有超过 50ms 的帧。该范围内未发现把长停顿转移到邻帧的情况。

结论是这批首次 PSO 相关卡顿确实缩短，但两侧仍每次都有一个超过 100ms 的卡顿帧，没有实现“编译时保持正常帧率”。每种配置只有两个首次事件，不能据此代表所有场景/材质。完整帧间隔还包含 UE 命令准备、模块处理等工作，不能把全部 249ms 或 137ms 归为 DXC 计算；另外的 GPU trace 用于确认后台确实发生了 DXC。

事件证据为 `tests/web-platform/evidence/shader-first-use-stalls-20261105.json`；分析器 `diagnostics/analyze-first-use-stalls.cjs` 同时保留每个 PSO 请求的相对时间、相邻帧和恢复窗口，检查输入帧时间连续性及四轮请求入口多重集。

下面的长区间数据仅作为稳定运行是否退化的补充，不用于判断 PSO 首次编译卡顿是否改善：

| 指标，中位数 | 3 worker | 7 worker |
| --- | ---: | ---: |
| 首次转向平均 FPS | 131.70 | 129.74 |
| 首次转向 1% Low | 39.39 | 43.61 |
| 首次转向最长提交间隔 | 248.80ms | 137.09ms |
| 首次新 PSO 请求批次跨度 | 198.81ms | 119.17ms |
| 同时未完成 PSO 请求峰值 | 3 | 7 |
| 每轮首次转向超过 100ms | 1 | 1 |
| 重复转向平均 FPS | 134.19 | 133.86 |

两侧首次转向均新增 10 个模块、15 条管线，重复转向无新增 PSO。增加并发减少严重停顿，但没有消灭 >100ms 帧，平均 FPS 没有提升；也没有证据可把收益称为稳定最高帧率提升。所有管线完成，无编译失败；最终同视角截图未见缺物，但这不是逐帧像素等价证明。

15 次 async API 调用本身累计仅约 0.44–0.47ms。此前网上“每约 8ms yield”的案例不能直接套用：这里长时间发生在后台编译及 UE 使用依赖上，单纯给这 15 次 API 提交加 yield 不会省去 DXC。

## 完整场景 trace：去重收益的反向验证

另外进行了 5 次完整场景诊断，首次/重复转向各 5 秒；这些 trace 帧间隔不与上面无 trace 的 FPS 对照混用。所有运行都提交了同样的 15 条首次转向 PSO。

| 次序 | UE worker | 策略 | DXC 次数 | DXC CPU 总量 | DXC 实际峰值 | PSO 后台初始化跨度 |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 3 | FIFO | 17 | 329.67ms | 3 | 145.77ms |
| 2 | 7 | FIFO | 13 | 316.74ms | 7 | 91.32ms |
| 3 | 7 | shared | 11 | 272.80ms | 5 | 91.64ms |
| 4，反向复测 | 7 | shared | 11 | 283.58ms | 5 | 94.03ms |
| 5，反向复测 | 7 | FIFO | 11 | 282.95ms | 7 | 93.56ms |

第 2/3 次看起来节约约 14% CPU，但第 4/5 次没有复现，不能挑前一组宣称完整场景稳定减少 14%。shared 将重复 miss 稳定压到 11 次，普通调度有时自身也能做到；即使节约了 CPU，最慢 shader 仍约 70–77ms，完成时间没有跟着显著缩短。

完整场景已存在初始视角的会话内 shader 结果，所以这里的 DXC 次数少于独立新 device 的 23/30 次。3/7 worker 还会改变请求和缓存填充顺序，不能把不同 DXC 次数的 CPU 总量作严格相同工作量比较；固定 30 次的微基准才是纯并发对照。

本节结论限于首次使用时才发起编译的路径：足够并行度可缩短等待，但尚未证明任何普通网页可用的通用源码处理能把单次复杂 DXC 从几十毫秒降到一帧以内。这里的测试范围不是编译器理论下限。

后续对 UE 自动组件预编译做了同 v70、固定 3 个常规 worker 的四轮复测：提前准备后首次转向新 PSO 为 0，最慢帧从 178–236ms 降到 34–38ms，加载里程碑约增加 3.8 秒。详见 [组件 PSO 预编译复测](UE58_WEB_COMPONENT_PSO_PRECACHE.md)。这条路径应作为消除首次使用卡顿的主要方向，运行期异步并行作为未覆盖 PSO 的补充；不应再将单纯增加线程数等同于解决最低帧率问题。

## 复现和文件

- `tests/web-platform/diagnostics/prepare-shader-variants.cjs`：匹配原 Cook SPIR-V、生成五类源代码变体。
- `diagnostics/optimize-spirv.cpp`：调用与 UE Cook 相同的 ShaderConductor optimizer。
- `diagnostics/benchmark-same-dxc.cpp`：同 DLL / HLSL 的 O0/O1/O2/O3/Od 与并发试验。
- `diagnostics/run-compile-options.cjs native|browser|scheduling <tag>`：每配置三轮交错，使用保存的真实 corpus。
- `diagnostics/analyze-compile-options.cjs <tag>`：流式分析 DXC/Tint/PSO scope，保留所有轮次。
- `probe-web-runtime-pso.cjs`：新增 core-limits、磁盘缓存控制与仅用于测试的 shared 调度注入；默认调用行为不变。
- `diagnostics/analyze-compile-scene.cjs <tag>`：校验真实线程数，统计帧间隔与异步请求跨度。
- `diagnostics/analyze-first-use-stalls.cjs <tag>`：以首次 PSO 事件对齐卡顿帧，检查相邻帧及完成后 500ms 恢复情况，排除长区间平均值稀释。

浏览器测试依赖 Playwright，使用本地 8765 测试服务器。raw JSON、trace、输入/输出 shader 与截图留在 `tests/web-platform/results/compile-options-*`，大文件不纳入 Git。精简证据为 `tests/web-platform/evidence/shader-compile-options-20261105.json`，包含原始报告 hash、各轮数据、工具与输入 hash。

完整场景复现示例：

```powershell
node tests/web-platform/probe-web-runtime-pso.cjs --folder=villa-runtime-async-pso-v70 --tag=<新标签> --modes=async,async,async,async --core-limits=4,8,8,4 --disable-disk-cache=true
node tests/web-platform/diagnostics/analyze-compile-scene.cjs <新标签>
```

需要同时设置本机 Playwright 的 `NODE_PATH`。新增调度诊断可通过与 modes 等长的 `--schedules=fifo,shared,...` 指定；trace 只用于归因。全部过程使用测试启动的浏览器上下文，没有修改用户浏览器配置。
