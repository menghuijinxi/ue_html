# PSO 自动收集与启动并行诊断

2026-11-13。本轮将启动等待与自动收集的开销拆开验证，制作独立对照包。
正式发布默认值未变，也没有将全局自动收集重新默认启用。

## 先澄清历史机制

11 月 5 日的自动组件预缓存是真实的 UE 自动收集，不要求人工跑图。
当时的 v70 四轮对照中，开启侧完成 1121 条请求，首次转向无新管线，
但该包没有开启当前的 Lumen、VT、VSM，不能把当时覆盖结论套到现在。
依据见 `UE58_WEB_COMPONENT_PSO_PRECACHE.md` 及其入库证据。

11 月 9 日为了缩短大量推测性编译的等待，采用了实际管线捕获与重放。
这是另一种覆盖来源，不能称为所有效果都自动覆盖。
11 月 10 日发布收尾会自动寻找匹配记录，无记录则自动启动浏览器采集；
它使打包流程自动化，不代表采集覆盖全部镜头和后续功能。
此前将这几层都简称为“自动预热”，没有清楚说明覆盖边界。

本地 UE 5.9 参考源码也同时包含不同机制。
`E:/UE59WebBenchmark/engine-5.9/Engine/Platforms/Wasm/Build/Tools/web/prewarm_pack.py`
的 make 路径启动浏览器捕获，默认两次加载、ready 后 6 秒合并；
`Build/Template/wasm-prewarm.js` 提前交接设备，允许重放与引擎启动重叠，
相同异步请求可以共享尚未完成的编译。
这不能推出所有 UE 5.9 原生打包平台都依赖捕获。

历史官方包的 `results/villa-startup-20261109-baseline/0-official.log` 记录：
设备交接 340ms，261 条管线完成 1411ms，引擎采用设备 1536ms，ready 4323ms。
这些是历史包的单次分段记录，不是当前机器的固定速度保证。

## 本轮修改

- 保留默认整包等待，增加显式 `pipelinePrewarm.handoff="overlap"` 诊断选项。
  已准备好的同一 GPU device 提前交给引擎，预热完成前仍保留加载层。
- 同一条已在重放中编译的管线，异步请求共享 Promise；
  同步请求若尚未就绪，仍创建真实管线，不跳过绘制或替换材质。
- 混合模式的就绪判断同时等待记录重放与 UE 自动队列，避免只等一边。
- 对照页显示加载时长、自动队列完成数和失败数，保留原生键鼠、
  切版保留玩家位置、人工开始/停止录制及项目内导出。

没有改 WASM、Cook、Lumen、VT、VSM、TSR 或分辨率。
四个包都以原始 311 条记录为起点，没有加入此前手动补齐的 10 条。
组件模式只在配置增加 `r.PSOPrecache.GlobalShaders=0`；
全局管线仍由原始记录和运行期未命中路径处理，不能称为完全免采集。

## 观察结果

同一个 Edge profile，缓存/驱动缓存保留，固定渲染 1400×788、
输出 1920×1080，TSR、Lumen、VT、VSM 开启。
计时终点是预缓存门槛通过、加载层隐藏且至少运行 60 帧。
以下单轮值仅用于定位阶段，不用于宣称帧率收益。

| 模式 | 到检查终点 | 自动请求 / 失败 | 出生点四次转向新增管线 |
| --- | ---: | ---: | ---: |
| 记录预热、整包等待 | 12.070s | 0 / 0 | 9 |
| 记录预热、并行启动 | 8.489s | 0 / 0 | 9 |
| 并行启动、自动组件 | 9.497s | 487 / 0 | 1 |
| 并行启动、自动组件及全局 | 36.319s | 1610 / 2 | 0 |

首次无资源缓存的单独一轮下载约 3.67GB、总计 16.086s，未混入表中。
整包等待与并行启动相差约 3.58s，证明该执行条件下存在可重叠阶段；
不是浏览器编译器本身加速，也没有消除记录覆盖漏项。

将用户 `09:17:23` 导出记录每 15 个上下文取一个镜头，首次依次访问：
整包等待版新增 10 条图形管线，组件版新增 2 条，其中一条为异步请求。
这些是采样位置上的创建事件，不是人工连续移动的 FPS 测试。
组件版进入交互时实际完成 487/487，失败 0，之后继续按组件加载状态准备。
尚未证明整条原始路线或未来新增功能不会再发生长帧。

全局模式的两项失败均为 unfilterable-float 纹理与 filtering sampler 不匹配，
入口 `main_00005884_08dcdb95`、`main_00005998_995efe04`。
未通过验证，不作为推荐模式或正式包。

## 验证与未完成项

完整描述符匹配、设备隔离、异步复用、同步回退、提前采用、失败传播、
混合队列门槛测试通过。正式发布收尾回归通过，包含匹配记录复用、
配置失效重新采集、旧 worker 拒绝、硬链接保护和固定物理像素规则；
原生输入桥接回归通过。

无管线插桩的真实页面验证通过记录版、组件版及切换到并行版，
确认键盘移动、鼠标转向、位置保持、录制导出、DPR 1.5 下固定输出，
1600×1000 和 900×700 布局及非空画布。
另一次页面主线程受控 GC 检查通过，不将它当成性能数据。

设备稳定性仍有未关闭的问题：一轮组件页面启动，以及另一轮全局探测，
出现 `A valid external Instance reference no longer exists`。
后续正常交互和 29 次受控主线程 GC 均通过，尚未定位该错误原因；
不能因为重试通过就宣称修复，当前候选不改正式默认。

接下来应按渲染功能和实际状态收集全局 PSO，补查组件模式剩余的两个请求，
并修正推测性布局及设备生命周期。扩大人工捕获路线只能作为诊断，
不能代替这项自动覆盖工作。

## 复现

服务 `8765` 上的独立页面：
`/build/villa-pso-startup-20261113-b/comparison.html#components`。
单次只运行一个场景，各模式可手动切换和导出。

```powershell
node tests/web-platform/diagnostics/package-villa-pso-startup.cjs --tag=<新包标签>
node tests/web-platform/diagnostics/probe-villa-pso-startup.cjs --suite=<包标签> --tag=<新结果标签>
node tests/web-platform/diagnostics/probe-villa-pso-startup.cjs --suite=<包标签> --tag=<新路线标签> --modes=recorded,components --route=tests/web-platform/results/villa-turn-manual/villa-turn-2026-11-13T09-17-23-425Z-10ddd198.json
node tests/web-platform/diagnostics/verify-villa-pso-live.cjs <包标签> <新页面验证标签> components
node tests/web-platform/verify-web-pipeline-prewarm.cjs
node tests/web-platform/verify-web-release-defaults.cjs
```

浏览器脚本要求 Playwright 和 sharp 可用。所有新增入口初始化项目内临时路径，
拒绝覆盖历史包或结果。原始报告在 `tests/web-platform/results/`，
入库摘要由 `diagnostics/analyze-villa-pso-startup.cjs` 生成到
`tests/web-platform/evidence/pso-startup-overlap-20261113.json`。
