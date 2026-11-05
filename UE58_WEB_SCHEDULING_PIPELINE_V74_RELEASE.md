# v74：完整流水线预算与 PSO 预缓存复测包

2026-11-06 状态更新：用户实测本版本仍有抖动，本地调度优化已否决。请使用 [关闭本地调度入口](http://127.0.0.1:8765/build/villa-scheduling-pipeline-v74/index.html?occlusion=history&clock=owner&rhiwake=priority&gpuahead=0&gpumode=submitted)；下文为原始交付记录，采用决定见 [本地调度已否决](UE58_WEB_LOCAL_SCHEDULING_REJECTED.md)。

2026-11-05。按用户在另一台设备上的实际卡顿反馈，合并远端最新修复后重新构建并交付。此前本机的提交 FPS / 1% Low 不能排除实际画面更新下降，已在两份旧复测文档顶部补充这一限制。

## 使用

- [打开新版对比页](http://127.0.0.1:8765/build/villa-scheduling-pipeline-v74/comparison.html)
- [新版默认入口](http://127.0.0.1:8765/build/villa-scheduling-pipeline-v74/index.html)
- 便携压缩包：`tests/web-platform/build/villa-scheduling-pipeline-v74.zip`，1,412,457,566 字节，约 1.41 GB。

另一台设备上解压后运行 `start.cmd`，需要 Python 3。也可执行 `python serve.py`，打开 `http://127.0.0.1:8875/comparison.html`。比较时仅保留一个场景页面，等待预缓存加载完成后持续移动和转向，观察画面流畅度、跟手程度与 HUD 的页面观察帧率。

对比页提供：新版默认 pipeline3、原始无背压本地调度、关闭本地调度的 owner 路径、上一轮 submitted4，以及放宽到 pipeline4。它们使用相同运行时、PSO 设置和资源，参数只影响调度。

## 合入的方案

详见 [远端完整流水线预算说明](UE58_WEB_LOCAL_PIPELINE_BUDGET_20261105.md)。原始本地循环可以让 GPU 工作及回调积压；仅对已提交帧限流仍漏计 Game/Render 已经开始但尚未提交的工作。新方案从实际 Game tick 开始占用名额，GPU 完成反馈到达后释放，默认完整预算为 3 帧。

新版包默认：本地 Game 时钟、pipeline 模式、预算 3、有效遮挡历史、RHI priority 和 PSO 预缓存。输入仍经 owner 转发；运行期异步 PSO 保持关闭，首次场景加载使用已有自动预缓存机制。没有设置固定 FPS 上限。

本轮同步与来源：

- 外围远端 `f1cbe19`，合并提交 `1274603`。解决宿主参数和 README 冲突，保留本地运行期 PSO 参数与既有测试。
- 引擎远端 `a0d2e40011c55a5078944ec54d6d69509e9f3d52` 已包含在本地合并 `cff23e314`，无需再次合并。
- 完整多线程 mimalloc UBT 目标构建、重新链接及 WASM 验证通过，日志 `tests/web-platform/results/web-engine-full-thread-20261105-192849.log`。
- 使用 `villa-lumen-off-current-mimalloc-v59` 已审计的原 Cook、内容与配置，哈希保持一致；Lumen 关闭，没有重新 Cook。

运行时打包器增加完整预算参数，并拒绝缺少新 Game 桥的运行时。便携预览页记录实际默认值与 PSO 开关，保留旧调度入口。

## 本轮验证

流水线预算、GPU 完成唤醒竞争、取消、计数回绕、输入桥接及隐藏恢复回归通过。便携 Python 服务的对比链接、COOP/COEP 响应头和 WASM MIME 检查通过。7-Zip 对最终压缩包 16 个文件的完整性检验通过。

可见 Edge、1280×720，直接访问无参数新版默认入口，不替换宿主输入路径。等待页面预缓存就绪后，8 秒键鼠运动预热，再测 8 秒持续运动：

- 自动预缓存启用，1121/1121 条异步准备请求完成，失败 0；active 与 filePrecompileTasks 均为 0。
- 实际相机累计平移约 7.11 米、转向约 358.68 度。
- 预算模式 pipeline、阈值 3，已提交未完成帧峰值 3，GPU 完成持续推进。
- 页面观察进度与提交进度之比约 0.991；这是页面 rAF 观察计数，不是物理显示帧率。
- 暂停后帧计数停止，恢复后继续增长。通过合成 visibility 事件调用真实处理链路，未验证 OS 标签冻结。
- 捕获的 GPU、引擎和页面错误为 0；运动结束截图可见别墅场景。

这是功能交付检查。测试前 GPU 已有 98% 利用率，后续采样为 93%；本轮没有进行同条件 owner/local ABBA。原始提交平均 26.86 FPS、1% Low 12.39 的结果保留在证据中，不能与先前空闲环境数据比较或宣称性能提升。另一设备的帧节奏改善仍需用户实际复测，不能将远端 RTX 3070 的旧包结果视为本包验收。

压缩包 SHA-256：`f89296cb8c68fb6e1a1390e938076317dbaba2c20a210d7a0d44e9511b98ed63`。

可审查证据：[v74 交付核验](tests/web-platform/evidence/scheduling-pipeline-v74-release-20261105.json)。其中保留构建与打包报告哈希、最终文件及压缩包哈希、实际预缓存状态、运动记录、预算和原始帧率，明确 `performanceComparison=false`。

## 复现

```powershell
node tests/web-platform/verify-web-pipeline-budget.cjs
node tests/web-platform/verify-web-local-frame-budget.cjs
node tests/web-platform/verify-web-input-bridge.cjs
./tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4
node tests/web-platform/package-web-runtime-experiment.cjs --baseline=villa-lumen-off-current-mimalloc-v59 --output=<新目录> --evidence=tests/web-platform/results/post-mimalloc-v59-profile-20261104.json --pso-precache --local-frame-budget=3 --local-frame-budget-mode=pipeline
node tests/web-platform/package-web-scheduling-preview.cjs --folder=<新目录>
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-local-clock-motion.cjs --folder=<新目录> --tag=<新标签> --modes=pipeline3 --seconds=8 --width=1280 --height=720 --packaged-input --default-settings --visibility-check
```

打包及验证使用新目录和新标签，保留原有 v71、PSO 运动包与本次原始报告。本轮没有推送 Git 或创建远端发布。
