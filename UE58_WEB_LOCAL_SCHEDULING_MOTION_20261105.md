# 本地调度运动掉帧：复现、GPU 背压候选与边界

日期：2026-11-05。

## 结论

按用户补充的条件，必须持续移动并旋转相机。固定视角的吞吐测试不能作为本问题验收。

本机复现的主要问题是**提交吞吐与页面刷新脱节**。本地 MessageChannel 循环持续生产帧，GPU 完成回调明显落后，页面 rAF 频率和页面观察到的新帧数严重下降。仅观察 HUD 大号的提交 FPS 会得到相反结论。

新增可选的 GPU 完成背压：未完成帧达到阈值时暂缓下一次 Game tick，GPU 完成后唤醒；有余量时仍直接在 Game Worker 本地启动下一帧。它没有固定 FPS 上限，也不等待页面 rAF。测试包默认阈值为 4；通用宿主默认仍为 0，避免未经跨设备验收就改变所有包。

这能消除本机运动时“提交 80 多 FPS、页面观察只有十几 FPS”的严重退化，但没有证明它全面优于 owner rAF。候选的 1% Low 仍低于 owner，另一设备的收益也尚未验证。GPU 实际执行、浏览器 GPU 服务、合成器调度、回调投递各自贡献尚未完全分离，不应称为已定位 NVIDIA 驱动 bug。

## 复现方法

- 导入用户下载的同一个 v71 包，RTX 3070、i9-14900KF，Edge 156，2289 x 1287、DPR 1。
- v71 原包是 **Lumen 关闭**，本轮保留原包画质、WASM、Cook、输入桥接、遮挡历史和 RHI 默认优先级；不恢复此前暂停的动态模糊调查。
- 可见浏览器，每轮重启，同一浏览器配置目录；无 CPU 亲和性强制，无逐 draw/GPU 包装。
- DOM 鼠标事件经过实际输入桥接，右键转向，同时 W/S 交替移动。预热运动 16 秒，再测 16 秒；相机采样验证实际平移和转向。
- 各轮约移动 13–15 米、累计转向 800–1035 度。输入函数与时间表相同，但输入分批和帧节奏导致实际路径、可见物体和 draw 数并不完全一致，不能据此声称精确的同工作量提速百分比。
- 正常计时只记录 RHI 提交时刻和已有 HUD。GPU 完成计时单列诊断轮，不混入正常性能结果。

`probe-web-local-clock-motion.cjs` 支持 `--min-visible-ratio=0.65`：要求页面观察的新帧/提交帧比例不崩塌，并且确实发生移动和转向。该比值适用于本次显示器、分辨率和负载，不能当作高 FPS/低刷新率设备的通用门槛。

## 数据

第一组 ABBA（owner、local、local、owner）：

| 模式 | 提交 FPS | 提交 1% Low | 页面观察新帧/秒 | 页面 rAF/秒 |
| --- | ---: | ---: | ---: | ---: |
| owner 1 | 76.63 | 35.28 | 68.66 | 110.50 |
| local 1 | 87.38 | 20.64 | 16.25 | 22.63 |
| local 2 | 82.38 | 16.75 | 17.38 | 24.50 |
| owner 2 | 76.49 | 34.74 | 68.53 | 109.50 |

“页面观察”是页面 rAF 采样共享提交计数发生变化，不是光学测量的物理显示帧率。表中页面数值是测量窗口内滚动 HUD 的均值，也不是逐帧 GPU 时间。

独立 GPU 完成诊断：

| 模式 | `onSubmittedWorkDone` 平均投递延迟 | 最大延迟 | 未完成帧峰值 |
| --- | ---: | ---: | ---: |
| owner | 41.65 ms | 73.04 ms | 7 |
| local | 207.44 ms | 307.90 ms | 34 |

此延迟包含 GPU 执行与浏览器完成回调投递，不能直接当作 GPU 耗时。异步完成监测没有让原始问题消失。

阈值探索，仍然持续运动：

| 模式 | 提交 FPS | 提交 1% Low | 页面观察新帧/秒 | 页面 rAF/秒 | 未完成峰值 |
| --- | ---: | ---: | ---: | ---: | ---: |
| local 无背压 | 88.80 | 19.51 | 15.09 | 21.66 | 未额外计时 |
| local 阈值 2 | 74.44 | 22.86 | 61.75 | 120.06 | 5 |
| local 阈值 4 | 78.43 | 27.70 | 65.88 | 97.25 | 7 |
| local 阈值 8 | 84.54 | 23.53 | 30.09 | 42.50 | 11 |
| owner | 77.18 | 34.06 | 68.91 | 111.16 | 未额外计时 |

阈值不是在途帧的严格硬上限：已有 GT/RT/RHI 工作会继续提交，本机观察到最多约 3 帧超出阈值。放宽到 8 后页面进度再次明显下降，支持积压是主要可控因素。

v72 正式复测 local4、owner、local4：

| 模式 | 提交 FPS | 提交 1% Low | 页面观察新帧/秒 | 页面 rAF/秒 |
| --- | ---: | ---: | ---: | ---: |
| local4 1 | 75.52 | 25.37 | 64.66 | 93.44 |
| owner | 76.31 | 34.02 | 68.38 | 111.63 |
| local4 2 | 78.78 | 26.31 | 63.59 | 93.13 |

两次 local4 的未完成帧峰值均为 7。均通过运动、画质/分辨率一致、无 GPU 验证错误、暂停后帧停止增长、恢复后继续增长检查。

再单独将 RHI 唤醒从 priority 换为 channel，无背压 local 的提交 FPS 为 110.11，但页面观察新帧仍只有 12.88、页面 rAF 为 17.78；local4 恢复到 67.06、107.72。该轮两条实际相机路径及 draw 数差异明显，不能据此宣称 channel 比 priority 更快；能确认的是单独关闭高优先级没有消除崩塌，增加背压仍有效。因此候选不额外改变 RHI 默认值。

## 源码原因与修复位置

1. `reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js`：原本 local 回调结束后继续投递 MessageChannel，无 GPU 进度检查。新增共享提交/完成计数、等待标记；只在达到阈值时暂缓 Game 回调。
2. `tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp` 的现有 `RHIEndFrame`：所有 encoder 提交后已调用 `__webGPUFrameSubmitted`。本次复用该边界，不改 C++ 或 WASM。
3. `tests/web-platform/web-engine-worker.js`：在完整帧提交之后注册 `queue.onSubmittedWorkDone()`，更新共享计数；只在 Game 正在等待时跨线程唤醒，不给每个正常帧增加 Game→owner→Game 往返。
4. `tests/web-platform/web-engine-host.js`：读取 `gpuahead=0..8`，仅 local 生效。0 为原始无背压；owner 保持原来的调度。

Game 等待采用挂起 JS 回调，不使用阻塞 owner 的 `Atomics.wait`。等待标记写入后再次检查完成计数，避免完成回调恰好到达导致丢失唤醒。队列去重保证隐藏/恢复或多个完成通知不会重复执行同一回调。

旧 local 在运动中遮挡结果 pending 大量增加，历史结果频繁过期，实际 draw 数也会变化；候选降低积压后可用结果恢复。因此设备表现相反可能受 GPU 吞吐、浏览器/驱动完成节奏和场景负载共同影响。尚不能仅凭 GPU 型号或 CPU 核数自动选择模式。

## 网上资料核对

未找到并核实一个能够直接对应“本项目 v71 + 此设备 + 运动时”的公开已知问题。搜索服务本轮未返回可用结果；以下官方页面通过 HTTP 实际读取，提供机制依据而非现成补丁：

- WebGPU W3C 规范，`https://www.w3.org/TR/webgpu/#dom-gpuqueue-onsubmittedworkdone`：该 Promise 在调用前已提交的队列工作完成后结算，结算涉及 content/device/queue 时间线。可以用作异步完成反馈，不能把 `submit` 返回当作 GPU 已完成。
- 同规范 Promise Ordering，`https://www.w3.org/TR/webgpu/#promise-ordering`：同队列的先后完成 Promise 有规定顺序；不要臆测其他异步 API 的顺序。
- Chrome 官方《Use scheduler.yield() to break up long tasks》，`https://developer.chrome.com/blog/use-scheduler-yield`：任务优先级和让出事件循环影响响应性。该文主要讨论主线程，不足以证明给本项目 Worker 换成某个 `postTask` 优先级就能解决 GPU/合成竞争。

Emscripten、WICG 和 GitHub raw 的部分请求超时，未把未读到的内容当作证据。最终修复依据是本地连续运动实验和队列完成反馈。

## 产物与回归

候选包：`tests/web-platform/build/villa-local-budget-v72-20261105`。

参考引擎提交：`abe02d37fb`。可审查的汇总证据：`tests/web-platform/evidence/local-frame-budget-motion-20261105.json`，包含五组通过的采集、源码哈希与候选包逐项哈希；原始日志和逐帧时间保留在 `tests/web-platform/results/`。

默认页面启用阈值 4；`comparison.html` 提供 owner、原始 local、local2、local4、local8。同一包只改查询参数，刷新生效，不需要重新 Cook。

打包脚本逐项校验 v71 清单 SHA-256，未修改的资源使用硬链接/复制；新包维护自己的版本哈希和来源元数据。原始 v71 文件保持不变。

验证脚本：

```powershell
node tests/web-platform/verify-web-local-frame-budget.cjs
node tests/web-platform/verify-web-input-bridge.cjs
node tests/web-platform/probe-web-local-clock-motion.cjs --folder=villa-local-budget-v72-20261105 --tag=<new-tag> --seconds=16 --modes=local4,owner,local4 --min-visible-ratio=0.65 --visibility-check
```

前两项覆盖实际 owner/GT 边界、取消、GPU 完成竞争、计数符号位回绕、隐藏恢复、GPU 失败上报及原有输入桥接。

自动化 Edge 的多个标签均报告 `document.hidden=false`，直接切标签检查失败并保留记录。正式 `--visibility-check` 通过临时 document.hidden getter 和 `visibilitychange` 事件调用真实宿主处理链路；不能据此声称完成了真实 OS 标签冻结/恢复验收。

最初误用 `WebProjectViewTest` 复位相机的探针因该 RPC 改用静态 CameraActor，导致输入不能驱动相机，被实际位移断言拒绝。固定视角样本、失败的相机探针和失败的标签隐藏探针均不纳入验收统计。

需要用户继续在两台设备上用相似路线移动/转向，优先比较 local4、原始 local、owner。此阶段只交付可回退的候选修复；尚未确定所有设备的最佳阈值，没有降低画质，也没有宣称解决原先的动态模糊问题。
