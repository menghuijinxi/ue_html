# TriplexHouseVilla 周期长帧调查与缓解候选

2026-11-06。保留用户认可的 memory32 优化，调查静止时每隔几秒出现的长帧。**旧的 RHI 唤醒修复没有丢失；本轮减轻了停顿，但没有彻底消除，暂不替换默认版本。**

[人工测试页](http://127.0.0.1:8765/villa-parity-test.html)的两个主要入口现在是“长帧缓解候选”和“本轮原版”。后者就是上一轮 memory32 + 阴影缓存 + 计算 pass 复用版本，而非更早的 memory64 版本。所有旧比较入口仍保留。

## 为什么记得修过，现在又出现

[11 月 5 日调查](UE58_WEB_RHI_WAKE_STUTTER_DIAGNOSIS.md)确实修复过相关问题：RHI Worker 的唤醒从 MessageChannel 改为 `scheduler.postTask({priority:'user-blocking'})`，避免在两段唤醒之间反复插入约 5 ms 的浏览器堆清扫。该修复仍存在，当前包实际启用 priority。

当时验收用的是 **Game 本地时钟**，两次各 60 秒窗口中 >18 ms 从 100 次降到 0 次。随后用户否决本地调度手感，提交 `2fc384e` 把默认帧时钟改回 owner。它保留了 RHI 优先级修复，但原生 owner rAF 又进入每帧启动的依赖路径。因此不能把旧的局部验收结论直接套用到当前 owner 模式。旧修复也没有消除 WebGPU 对象分配或浏览器 GC。

另一个已有修复是 PSO 复用，针对首次使用的编译停顿。本次稳定静止段没有新增 shader/pipeline，纹理流送 pending 为 0，不能用首次编译解释这里的周期。

## 本次时间线证据

原版独立正常诊断 30 秒：108.58 FPS / 1% low 43.13，最长 42.03 ms。RHI `setImmediate` 第二段唤醒排队最大仅 0.24 ms，说明原优先级修复仍有效；该探针不覆盖更早的 native proxy 跳转。

在另行采集的 trace 中，一个 owner rAF 从请求到回调等待 **41.87 ms**，其中同线程清扫占 **24.78 ms**；另一个等待 **55.74 ms**，清扫约 **24.55 ms**。这条每帧启动路径仍会被清扫拖住。完整 trace 本身明显扰动首次回收，出现约 150 ms 的异常等待，不能把该数值当作普通运行的最大帧。

候选的第二份完整 trace 又分出两类剩余停顿：

- 20 秒中有 6 组清扫，总计每组约 19.4–29.3 ms，单片最大 5.28 ms。通常间隔约 3.3 秒，并非严格定时器。
- 8 个 >18 ms 帧中，只有 4 个与 >4 ms 清扫直接重叠。
- 清扫后，`CrGpuMain` 的 `CommandBufferService:PutChanged` / `WebGPUDecoderImpl` 出现 **10–20.31 ms** 的 CPU 任务。例如 owner 时间 54140 ms 附近开始清扫，GPU 服务在 54165 ms、54188 ms 分别处理 14.62、20.31 ms；随后提交间隔达到 28.05 ms。

因此还有浏览器 GPU 服务的后续工作，单改 owner rAF 不能覆盖全部停顿。对象析构集中向 Dawn 发送释放操作是合理怀疑，但现有 trace 没有细分具体 WebGPU 命令或析构类型，**尚不能把它写成已经证明的根因**。GPU 服务的 CPU 任务时长也不等于 GPU 执行时长。

机制参考：[V8 cppgc 清扫实现](https://github.com/v8/v8/blob/main/src/heap/cppgc-internal/sweeper.cc)、[Chromium Worker rAF 实现快照](https://chromium.googlesource.com/chromium/src/+/78c3f601c9b3851be1810f3c3f885167a134b6af/third_party/blink/renderer/core/animation_frame/worker_animation_frame_provider.cc)、[Dawn 对象析构快照](https://chromium.googlesource.com/chromium/src/+/740573b24a368bf050ccbedbc0bfbd477b8f7f34/third_party/blink/renderer/modules/webgpu/dawn_object.h)。这些资料支持机制分析，不代表已核对 Edge 156.0.4314.58 的完全相同实现。

## 候选怎样避免无限提前渲染

候选是 **page rAF + owner 提交确认 + GPU 完成反馈**，不是原来的 owner 原生 rAF，也不是 Game 本地计时器。只有明确使用 `clock=page&framebudget=3` 才启用；公共默认仍为 owner。

- 总预约帧数减去已完成帧数最多 3，包含尚在 Game/Render 准备、RHI 执行和已提交 GPU 的帧。
- 尚未提交最多 2，分别容纳 RHI 当前帧及下一帧准备工作；owner 停住后不能继续无界生产。
- 一个页面刷新时刻最多发放一次许可，超过 16 ms 的未使用时刻丢弃，不累计补发；隐藏时清空，恢复后等待新刷新。
- GPU 完成使用原有 `onSubmittedWorkDone()` 回调，测量不会再附加一套完成请求。
- 保留 RHI user-blocking 优先级、owner 转发输入、原画质、`t.MaxFPS=0` 和 `r.VSync=0`。

同时组合现有 staging 上传页、RDG render-pass 合并、小 uniform 页、present encoder 复用、批量提交和 JS replay scratch。原来的 CSM 缓存、compute-pass 复用保持启用。候选与对照的编译 JS、Wasm 和 Cook 清单 SHA-256 一致。该组合只通过候选入口启用，不能把总收益单独归功于某一个设置。

## 无详细探针的交错复测

Edge 可见窗口，1280×720、DPR 1；每次加载完成后预热 30 秒，再经过采集器的稳定等待。B/A/A/B 每窗 60 秒：B1、B2 为独立浏览器会话，A1、A2 在同一已预热会话连续测量，共用独立测试 profile。每次只运行一个游戏。正常段没有 trace、CPU profiler、API 计数包装、上传验证或额外 GPU 完成探针。

统计 RHI 完整帧提交间隔。1% low = `1000 / 最慢 ceil(N×1%) 个间隔的均值`，不删除任何长帧，不把窗口之间的间隔计入。

| 各 120 秒合并 | 本轮原版 A | 三帧候选 B |
| --- | ---: | ---: |
| 平均 FPS | 111.47 | 118.62（+6.4%） |
| 1% low | 42.80 | 52.97（+23.8%） |
| P95 间隔 | 11.79 ms | 11.48 ms |
| P99 间隔 | 13.59 ms | 12.92 ms |
| 最长间隔 | 45.74 ms | 40.68 ms |
| >20 ms | 73 | 55 |
| >25 ms | 41 | 22 |
| >33.333 ms | 25 | 4 |
| >50 ms | 0 | 0 |

单窗 FPS / 1% low：B1 118.23 / 52.34，A1 111.13 / 42.54，A2 111.82 / 43.40，B2 119.02 / 53.62。四个窗口的全部逐帧曲线在 `tests/web-platform/results/periodic-frame-times-20261106.png`。候选仍会出现约 3.4 秒一次的 25–32 ms 帧，不能只展示 >33 ms 次数下降 84% 而忽略它们。

## 被排除的方案与反馈延迟

| 方案，单次筛选 | FPS / 1% low | 最长帧 | 判断 |
| --- | ---: | ---: | --- |
| 只允许当次 rAF 发放、三帧预算 | 105.41 / 42.24 | 39.81 ms | 吞吐下降 |
| owner 最多一帧未提交 | 95.80 / 48.61 | 35.37 ms | Game/Render/RHI 过度串行 |
| 两帧未提交、总三帧，无额外资源复用组合 | 115.38 / 49.16 | 35.09 ms | 有缓解，继续组合测试 |
| 资源复用组合、原 owner 时钟 | 116.25 / 48.00 | 47.04 ms | 未解决周期 |
| 资源复用组合、总四帧 | 129.16 / 57.95 | 28.31 ms | GPU 完成反馈变慢，否决 |
| RHI 改为 user-visible | 119.24 / 47.32 | 49.64 ms | 低帧及最长帧回退 |
| 三帧候选再启用 render bundles | 110.34 / 50.68 | 35.41 ms | 平均及低帧低于候选，否决 |

这些是筛选结果，不能与正式交错统计混合。完整筛选记录包括未采用的初始调度器，保存在证据 JSON。user-visible 首次采集因脚本把 Worker 补丁应用到 HTML 而在启动前断言失败，没有性能 JSON；保留 source/log，修正后以新 tag 重跑。该 retry 期间曾执行一次约 4.7 秒的证据汇总/hash，不用于正式性能收益结论。

独立 GPU 完成反馈测量从完整帧提交到 `onSubmittedWorkDone` 回调，**包含回调调度，不是纯 GPU 耗时或输入到显示延迟**：

| 静止，原版 30 秒 / 四帧 30 秒 / 三帧 45 秒 | 原版 | 四帧方案，否决 | 最终三帧候选 |
| --- | ---: | ---: | ---: |
| 已提交未完成峰值 | 4 | 4 | 3 |
| 平均反馈 | 12.50 ms | 14.63 ms | 11.90 ms |
| P99 | 20.79 ms | 28.19 ms | 23.77 ms |
| 最慢反馈 | 49.83 ms | 39.99 ms | 34.11 ms |

四帧方案的高分没有被接受。三帧方案虽然平均及峰值更好，**静止 P99 仍比原版慢约 3 ms**，不能宣称各项延迟都改善。

## 路线、输入、画面与正确性

相同定时相机路线、每段 20 秒的结果（原版 → 候选，FPS / low / max ms）：

| 路段 | 原版 | 候选 |
| --- | ---: | ---: |
| 首次区域 | 117.96 / 42.74 / 42.93 | 124.88 / 53.77 / 35.52 |
| 移动 | 116.26 / 43.06 / 44.13 | 125.17 / 59.74 / 31.79 |
| 转向 | 102.79 / 41.61 / 40.98 | 102.70 / 45.42 / 28.86 |
| 重复区域 | 121.98 / 40.97 / 45.19 | 121.29 / 42.96 / 49.42 |

首次区域两边各新增 1 个 shader，管线数分别新增 2 / 6，不能把差值解释成纯调度收益。后三段没有新增管线；重复区域候选最大帧反而更差。路线绕过碰撞，用于复现镜头负载，不能代替真实输入手感测试，也不是重复 ABBA 验收。

实际键鼠输入另测各 30 秒、预热 30 秒。候选使用正式 URL 与打包输入路径，移动距离 2545 cm（原版 2542 cm），转向量略有不同，因此这组只用于输入回归。原版 111.06 / 37.34、最长 39.11 ms；候选 121.24 / 44.38、最长 30.31 ms。GPU 反馈平均 12.17 → 11.50 ms，P99 32.16 → 31.52 ms，但最慢一次 **37.99 → 47.03 ms**，发生在正式窗口内，保留该回退。所有测得完成请求最终均返回。

候选真实输入期间总预约峰值 3、未提交峰值 2；模拟 document 隐藏后帧计数稳定，恢复继续。此检查不等于 OS 实际冻结后台标签页。页面观察到的变化数与提交数接近，也不能证明显示器逐帧呈现。

五视角截图人工检查未发现明显画质回退。排除 HUD 后的 RGB 通道平均绝对差约 0.46–1.04/255；时域 AA/光照会导致小差异，数值只作描述，不作自动画质验收。完整五视角回归使用同配置四帧诊断入口，最终三帧入口另外做了 GPU、真实输入及截图检查。

上传验证完成 **1024 次真实复制回读、4,375,308 字节、1002 个非零偏移**，无错误；UE 纹理回读通过。开启绑定重算后验证数从 817,274 增至 9,290,404。没有运行期 GPU 验证或页面错误；启动日志仍有 834 个已知不支持的 PSO 预缓存请求，与 unsupported 计数对应，不能写成整份日志无错误。

## 代码、复现及后续边界

- `web-engine-host.js` / `web-engine-worker.js`：可选页面时钟、owner 提交确认、总预约及未提交双重限制，旧默认保留。
- 采集器支持独立 G 盘 profile、复用已有 GPU 完成回调的探针；trace 分析记录 rAF 等待及 GPU 服务长任务。
- `verify-web-frame-credits.cjs` 检查预算 1–4、延迟确认、过期时刻、重复通知、取消、隐藏恢复及释放；`verify-web-input-bridge.cjs` 检查 URL 与输入路径。11 个 JS 文件语法检查通过，测试页 20 个链接 HTTP 200。
- [汇总证据](tests/web-platform/evidence/villa-periodic-stalls-20261106.json)保留原始文件 SHA-256、每窗数据、所有长帧、未采用方案及回退指标。`pass` 表示采集/断言通过，`performanceAccepted`、`periodicStallsEliminated`、`physicalPresentationValidated` 都为 false。

复现命令（在仓库根目录；使用新的 output/tag 防止覆盖历史）：

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/package-villa-parity-candidate.cjs --baseline=villa-address32-compute-20261106 --output=villa-periodic-repro --current-worker --staging --merge-raster --batch-submissions --reuse-present --frame-uniforms --replay-scratch
node tests/web-platform/capture-villa-parity-web.cjs --folder=villa-periodic-repro --tag=periodic-repro-b1 --frame-budget=3 --seconds=60 --warmup=30 --no-presentmon --profile=periodic-stall-checks
node tests/web-platform/capture-villa-parity-web.cjs --folder=villa-address32-compute-20261106 --tag=periodic-repro-a --rounds=2 --seconds=60 --warmup=30 --no-presentmon --profile=periodic-stall-checks
node tests/web-platform/capture-villa-parity-web.cjs --folder=villa-periodic-repro --tag=periodic-repro-b2 --frame-budget=3 --seconds=60 --warmup=30 --no-presentmon --profile=periodic-stall-checks
node tests/web-platform/probe-web-rhi-stalls.cjs --folder=villa-periodic-repro --tag=periodic-repro-trace --clock=page --frame-budget=3 --immediate=native-priority --seconds=10 --trace-seconds=20 --width=1280 --height=720
node tests/web-platform/analyze-web-rhi-stalls.cjs tests/web-platform/results/periodic-repro-trace.json
node tests/web-platform/verify-web-frame-credits.cjs
node tests/web-platform/verify-web-input-bridge.cjs
```

本轮没有改引擎 C++ 或重新编译，没有修改 H:/UE_5.8。后续需要把 GPU 服务突增进一步归因到具体命令/资源释放，或减少高频 WebGPU 原生对象分配，再重复无探针、长时间、输入和实际呈现检查；不能靠加深队列或压低帧率将当前周期掩盖。用户要求“解决后应用”的条件尚未满足。
