# 本地调度运动卡顿：完整流水线预算 v73

日期：2026-11-05。接续 `UE58_WEB_LOCAL_SCHEDULING_MOTION_20261105.md`。

## 结论

本轮候选将限流起点从“RHI 已提交”提前到“Game 实际开始一帧”，减少此前漏计的 Game/Render/RHI 排队工作。默认完整预算为 3 帧；保留本地调度，不依赖页面 rAF，不设固定 FPS 上限。

本机持续移动、转向的 ABBA 中，提交 1% Low 从 25.6–26.9 提升到 33.7–39.4，提交间隔 P95 从 27.6–29.1 ms 降到 18.6–18.7 ms，平均提交 FPS 从 83–86 降到约 78。帧节奏改善，不能据此宣称鼠标到显示器的延迟已完全解决。

参考引擎提交：`a0d2e40011`。外围源码、脚本和证据由根仓库单独提交。

## 原因与改动

原预算只计算 `submitted - completed`。Game 和 Render 已准备、但尚未送到 GPU 的帧不占预算；原阈值 4 实测可以积压到 7 个尚未完成的提交。完成回调到达后，Game 又可能连续快速启动数帧，然后等待，形成不均匀的节奏。

本轮依次检查三个假设：未提交的 CPU 帧漏计、完成唤醒引起突发、输入经 owner 转发等待。完整预算的持续运动结果支持前两者相关的排队机制；额外输入直达未显示明显帧节奏优势，不改默认输入路径。

- `reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js`：在实际 `MainLoop.preMainLoop` 入口增加 `startedFrames`，包括预算附加前的启动 tick。仅请求或取消回调不占名额。pipeline 模式以 `startedFrames - completed` 判断是否暂缓下一次 Game 回调。
- `tests/web-platform/web-engine-worker.js`：增加 `pipeline` 模式及第 4 个共享计数槽；完整 RHI 帧提交后的 GPU 完成回调释放名额，仅唤醒正在等待的 Game。submitted 模式保留原逻辑。
- `tests/web-platform/web-engine-host.js`：支持 `gpumode=submitted|pipeline` 和输入路径查询参数。通用宿主仍默认 submitted、预算 0；只有 v73 包默认 pipeline、预算 3。
- 不使用阻塞 owner 的 `Atomics.wait`。保留等待标记双重检查、取消和隐藏恢复去重。

预算统计依赖当前运行时的一次 Game tick 对应一次 RHIEndFrame；这不是可直接移植到任意多视口、无渲染 tick 或其他主循环的通用算法。`budget.pending/peak` 仍表示已提交未完成数，不是完整流水线计数；本轮候选实测峰值为 3。

源码核对还发现，TaskGraph 的 Web RHI 路径已经在执行一次图任务后退出并重新唤醒。不能仅凭 `ProcessThreadUntilIdle` 的名字认定一次唤醒会清空所有任务。本轮没有修改 RHI 优先级或任务循环，也没有发现 GPU 命令乱序的证据。

## 测试条件与结果

RTX 3070、i9-14900KF、Edge 156；浏览器视口 2289 × 1287，DPR 1，实际渲染尺寸在每组比较中一致。保持 v71 原包的 WASM、Cook、着色器与配置，Lumen 关闭。右键持续转向，W/S 交替移动，16 秒运动预热后再测 16 秒。断言实际相机平移及转向，未使用会切到静态 CameraActor 的复位 RPC。

实际相机路径和可见物体会随输入分批、调度变化，不能把同一输入时间表当成精确相同的 GPU 工作量。常规轮只加轻量提交时刻采样；逐线程和额外 GPU 完成采样单列诊断轮。

常规 ABBA：`results/pipeline-normal-abba-20261105.json`。

| 模式 | 提交 FPS | 提交 1% Low | 提交间隔 P95 / ms | 已提交未完成峰值 |
| --- | ---: | ---: | ---: | ---: |
| 旧 submitted4，A1 | 83.10 | 25.58 | 29.09 | 7 |
| 新 pipeline3，B1 | 78.34 | 39.38 | 18.72 | 3 |
| 新 pipeline3，B2 | 78.32 | 33.74 | 18.62 | 3 |
| 旧 submitted4，A2 | 85.94 | 26.92 | 27.57 | 7 |

独立诊断（`v72-pipeline-motion-20261105` 与 `pipeline-credit-motion-20261105`）：

| 指标 | 旧 submitted4 | 新 pipeline3 |
| --- | ---: | ---: |
| Game tick 间隔中位数 | 6.36 ms | 11.38 ms |
| Game tick 间隔 P95 | 35.79 ms | 24.43 ms |
| GPU 完成回调延迟中位数 | 45.68 ms | 23.95 ms |
| 输入最早事件到下一 Game tick 中位数 | 25.52 ms | 12.00 ms |
| 输入最早事件到下一 Game tick P95 | 51.87 ms | 29.81 ms |

GPU 指标包含浏览器回调投递时间，不是纯 GPU 执行时间。输入指标止于 Game tick 入口，不是原生输入消费或物理显示时刻。诊断包装增加开销。第二诊断组的 local4 样本还出现 53.8 FPS 的低值，不能选择该样本宣称新预算带来大幅平均帧率提升；上述常规 ABBA 是主要帧节奏证据。

最终 v73 包：

- 默认入口、无宿主输入替换：提交 80.93 FPS，1% Low 38.84，P95 18.78 ms，峰值 3。
- 通过 URL 选择 direct-game-thread：提交 82.55 FPS，1% Low 37.29，P95 19.15 ms，峰值 3。两轮路径/draw 数不同，尚无稳定优势，因此仅作为可选对比。
- 两种输入均实际驱动相机，并通过暂停恢复检查。自动化 Edge 标签的可见性不可靠，检查通过临时 `document.hidden` getter 与 `visibilitychange` 调用真实宿主链路；未验收真实 OS 标签冻结。

后续轮浏览器 rAF 约 60 Hz，而早期 ABBA 约 96–120 Hz。不同阶段页面 HUD 数据不能直接跨组比较。提交 FPS 及页面 rAF 采样共享提交数都不是显示器实际新帧数。

## 合成器追踪

`v73-compositor-warm-20261105` 是单独的 8 秒运动诊断。使用 CDP `cc,viz,benchmark,blink.user_timing`，用页面 mark 限定统计区间：

| Display::FrameDisplayed 反馈 | 旧 submitted4 | 新 pipeline3 |
| --- | ---: | ---: |
| 记录次数 / 秒 | 46.74 | 51.80 |
| 同时间戳间隔数 | 45 | 13 |
| 间隔 P95 | 33.38 ms | 33.35 ms |
| 间隔最大值 | 66.69 ms | 50.05 ms |

只支持合成反馈有小幅改善，不能声称显示卡顿消失。回调可能批量交付；这些事件不能识别唯一 UE 画面或物理扫描输出。Renderer 的 PipelineReporter 可能只覆盖页面/HUD，不能把其 dropped 数称为游戏丢帧数。没有按大整数 trace ID 跨表关联，以免 JSON 数值精度造成错误匹配。

## 冷启动失败边界

后续全新自动化浏览器缓存出现两次渲染进程崩溃，以及旧 v72 owner 模式、新 v73 默认入口的 WebGPU device lost：

`A valid external Instance reference no longer exists.`

Windows 18:01:25 记录 Edge `msedge.dll` 访问异常；18:07:42 的旧 v72 owner 对照记录 `dxcompiler.dll` 访问异常。前者早于移动测量，后者未启用新预算。故不能把这些失败归因于输入直达或 pipeline 模式，也不能宣称冷启动兼容问题已解决。

复用此前成功的自动化浏览器配置目录 `pipeline-normal-abba-20261105` 后，新包默认入口、直接输入、合成追踪均成功。未修改用户浏览器设置或驱动。缓存与编译失败之间的因果仍待单独验证，失败采集保留在证据的 `excluded` 中。

## 交付与复现

包：`tests/web-platform/build/villa-local-pipeline-v73-20261105`。服务监听 `0.0.0.0:8765`，局域网地址 `10.1.1.200`。

默认入口是 pipeline3。`comparison.html` 提供 pipeline3、pipeline3 + direct input、旧 submitted4、owner rAF、pipeline4。比较时仅保留一个运行中的场景标签。

仅更新 JS 调度桥、宿主、Worker 和包清单；原始 WASM/Cook/配置逐项 SHA-256 不变。查询参数切换不需要重新 Cook。

```powershell
node tests/web-platform/verify-web-pipeline-budget.cjs
node tests/web-platform/verify-web-local-frame-budget.cjs
node tests/web-platform/verify-web-input-bridge.cjs
node tests/web-platform/probe-web-local-clock-motion.cjs --folder=villa-local-pipeline-v73-20261105 --tag=<new-tag> --seconds=16 --modes=local4,pipeline3,pipeline3,local4 --packaged-input --visibility-check
```

第一项回归在修改前失败（未提交工作超过三帧仍继续 tick），修改后通过，覆盖启动帧、提交不释放预算、每次完成释放一个名额、取消及隐藏恢复。既有竞争、计数回绕、GPU 错误及输入桥接测试也通过。

可审查汇总：`tests/web-platform/evidence/local-pipeline-budget-motion-20261105.json`，保留 6 组通过采集、4 组失败记录及源码/包哈希。逐帧原始日志、截图和追踪保存在 `tests/web-platform/results/`。

仍待两台设备实际持续移动与转向比较。当前交付是帧节奏改善候选，并非通用调度问题或动态模糊问题的最终解决。
