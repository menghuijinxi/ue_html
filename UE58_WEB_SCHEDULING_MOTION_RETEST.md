# PSO 预缓存开启后的运动视角调度对照

后续更正：本报告的平均帧率和 Low 只统计 RHI 提交间隔，不能排除 GPU 积压和页面画面更新下降。另一设备已复现持续键鼠运动下的画面堵塞，见 [完整流水线预算修复](UE58_WEB_LOCAL_PIPELINE_BUDGET_20261105.md)。本报告不能作为“本地调度没有画面卡顿”的依据；新交付见 [v74 复测包](UE58_WEB_SCHEDULING_PIPELINE_V74_RELEASE.md)。

2026-11-05。补充上一轮固定视角数据，按用户要求测持续平移、连续转向和首次进入其他区域，并显式开启 PSO 预缓存。使用新增默认关闭的游戏线程相机测试钩子的运行时，复用本机 Lumen 关闭版别墅 Cook，独立测试包为 `villa-scheduling-motion-pso-v73`，原 v71/v72 包保持原样。

## 测量方法

同包切换 `clock=owner` / `clock=local`，有效遮挡历史和 RHI priority 始终开启。四轮顺序 owner → local → local → owner，每轮为独立可见 Edge 会话。保持 CSS 2289×1287、DPR 1、相同画质和相机路线，运行时及 Cook 不变。

每轮要求 `-WebPSOPrecacheTest` 生效、`__webPSOPrecacheReady=true`、预缓存 active 和 filePrecompileTasks 为零、异步预缓存请求全部完成、纹理流送 pending 为零。至少运行 600 帧，随后再预热 15 秒，才开始运动测试。浏览器与驱动自动缓存保留。

试跑时，出生点按 W 约一秒后撞到门，后续按住 W 已无明显位移。最初改用 `WebProjectViewTest` 相机 RPC 连续驱动 v72，但检查发现 owner 约每秒 61 次、local 约 30 次，相机控制频率随调度变化，不适合用于公平比较。主动关闭第四轮测试浏览器并保留失败报告，整组初测排除，不采用曾在进度消息中报告的初测数字。

正式数据新增默认关闭的 `WebMotionBenchmarkControl` 测试入口，RPC 只启动或重置路线，实际相机位置在每个 Game Tick 前直接按墙钟插值更新。两种模式中每个游戏帧都更新视角，不依赖 RPC 回传速度；普通包未调用入口时不启用路线。引擎发布更新次数及完成序号，并保留约 100 ms 一次的真实相机轨迹验证。该路线绕过 Pawn 碰撞，属于脚本运动视角测试，不能据此判断真实键鼠输入延迟或正常步行路径。

| 阶段 | 路线和时长 |
| --- | --- |
| 首次区域巡游 | 首次从出生点连续移动至车库、客厅、门厅和浴室机位，20 秒；此前没有相机巡游预热 |
| 持续平移 | 室内 `(-175,-80,160)` 至 `(100,-60,160)` 平滑往返四次，固定俯仰和朝向，20 秒 |
| 连续转向 | 室内固定位置连续转满 360°，20 秒 |
| 重复区域巡游 | 重复首次区域巡游的相同路线和时长，20 秒 |

平移和转向正式计时前分别用 5 秒覆盖完整路线，再等待预缓存及流送完成，额外等待 2 秒。使用少量管线/着色器创建 API 观察；如果稳定阶段仍有创建，则保留该次记录并补测热路线。正式稳定数据要求没有新增管线或着色器。首次区域巡游保留剩余首次使用开销，另以重复路线作对照；预缓存并不保证覆盖所有运行期变体。

每次提交只记录一个时间戳，相机按约 100 ms 采样；不使用 profiler、浏览器 trace、逐 draw 包装、额外 GPU 查询或时间戳。平均 FPS 为完整采样窗口的 RHI 提交帧数除以实际墙钟时长，1% Low 由合并后的最慢 1% 提交间隔计算。结果不等同于物理显示帧率。

## 结果

四轮均通过。每轮进入计时前均确认 1121 个异步预缓存请求全部完成，已预缓存 graphics pipeline 数为 484，active / filePrecompileTasks 为零。设置、相机起点和实际渲染分辨率一致；实际渲染 1484×835，输出 2289×1288，TSR=4，GI / 反射方法为 0。以下按每种模式两轮总帧数除以总采样时长合并，不使用 HUD 瞬时读数。

| 场景 | 关闭本地调度 FPS | 开启本地调度 FPS | 平均 FPS 变化 | 关闭 / 开启 1% Low |
| --- | ---: | ---: | ---: | ---: |
| 持续平移 | 98.28 | 131.63 | +33.94% | 38.06 / 68.28 |
| 连续转向 | 85.61 | 110.01 | +28.49% | 35.15 / 58.37 |
| 首次区域巡游 | 95.29 | 115.31 | +21.01% | 32.92 / 44.71 |
| 重复区域巡游 | 99.32 | 117.43 | +18.24% | 34.66 / 42.43 |

两轮关闭 / 开启的独立 FPS：平移 99.44、97.13 / 131.21、132.06；转向 86.21、85.01 / 110.90、109.11；首次巡游 97.77、92.81 / 115.31、115.31；重复巡游 100.64、98.00 / 120.08、114.78。首次和重复区域巡游有约 5% 的运行间变化，未将两轮接近表述为所有场景完全稳定。

四次首次区域巡游均出现一个额外 render pipeline，已预缓存不意味着覆盖所有变体；12 个稳定平移、转向及重复巡游窗口均没有新增管线或着色器。没有额外剔除长帧。所有完成的正式运行无运行错误、GPU validation、device lost 或预缓存失败。每个阶段更新相机次数与 RHI 帧数相差不超过两帧；平移累计约 22.0 米、首次和重复巡游约 19.8 米，持续运动采样比例均大于 99%，转向位置保持不变。默认启动时路线未激活，显式启动后才驱动相机。

本机运动场景仍体现收益，没有复现另一设备的暴跌。本轮不能确定跨设备回退原因，或将 Lumen 关闭的结果外推至 Lumen 开启场景。

完整构建、链接和 WASM 验证通过，最终构建日志 `tests/web-platform/results/web-engine-full-thread-20261105-152906.log`。输入转发、共享输入队列、时钟选择、暂停恢复及回调取消回归通过，脚本语法与差异空白检查通过。没有修改引擎仓库或全局调度默认值。

可携带证据为 [scheduling-motion-game-pso-20261105.json](tests/web-platform/evidence/scheduling-motion-game-pso-20261105.json)。正式数据为 `tests/web-platform/results/scheduling-motion-game-pso-v73-abba-20261105.json`；被排除的 RPC 初测为 `tests/web-platform/results/scheduling-motion-pso-v72-abba-20261105.json`，该报告 pass=false，保留关闭测试浏览器造成的中止错误。所有测试浏览器均已关闭，运行时包、截图和逐帧数据按仓库约定保留在忽略的 build/results 目录。

## 复现

```powershell
./tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4
node tests/web-platform/package-web-runtime-experiment.cjs --baseline=villa-lumen-off-current-mimalloc-v59 --output=villa-scheduling-pso-repeat --evidence=tests/web-platform/results/post-mimalloc-v59-profile-20261104.json --pso-precache
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-scheduling-motion.cjs --folder=villa-scheduling-pso-repeat --tag=scheduling-motion-pso-repeat --seconds=20 --warmup=15
node tests/web-platform/summarize-web-scheduling-motion.cjs --report=tests/web-platform/results/scheduling-motion-pso-repeat.json --output=tests/web-platform/evidence/scheduling-motion-pso-repeat.json
```

本轮只覆盖本机 RTX 4090、Lumen 关闭场景。没有清空浏览器或驱动缓存，没有验证另一台设备、Lumen 开启、运动画质或正常键鼠游戏路线。首次巡游是每次引擎会话首次访问这些位置，不是清空全部缓存后的冷启动。
