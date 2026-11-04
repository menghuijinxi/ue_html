# 对齐桌面帧同步语义的 Web 调度候选

2026-11-04，接续 [帧调度诊断](UE58_WEB_FRAME_SCHEDULING_DIAGNOSIS.md)。已实现默认关闭的页面直连 Game 帧许可、GPU 完成预算和消费线程查询等待，并完成同包六轮交错计时。组合候选 **77.89 → 81.60 FPS（+4.76%）**，1% Low **34.81 → 37.33（+7.22%）**。这是固定视角的一组实验，尚不提升为默认模式。

上一轮尽快运行的本地循环达到 91 FPS，但正常窗口的遮挡查询读取全部未就绪。本轮候选保留原遮挡查询及两帧历史，组合模式查询未就绪率约 1.7%。恢复正确的结果消费后，没有复现上一轮的大幅增益。

## 借鉴桌面逻辑，改变 Web 平台实现

桌面普通程序在 Game 线程循环 `EngineTick()`，UE 公共 `FFrameEndSync` 控制 Game/Render/RHI 超前；D3D12 还会在呈现路径等待 GPU 帧完成信号，查询读取按 `bWait` 等待对应 sync point。

本项目 Web 同样调用 `GEngineLoop.Tick()` 和公共帧同步，但嵌套 Game Worker 的 rAF 经过 RHI owner 请求/回传；其查询路径此前忽略等待请求，未就绪就按可见处理。不能把 D3D12 的阻塞代码搬到 GPU owner：owner 一旦睡眠，自己的 Promise/map 回调就不能发布结果。

本轮实现：

- `WebWorkerCanvas.js` 接收专用 MessagePort，Game 后续帧请求直接传到页面。旧包、默认模式继续走原 owner rAF。
- 页面最多保留一个最新显示许可；GPU 预算满时继续让出浏览器。GPU 完成后可立即消费尚未使用、未过期的许可，不要求再次等待下一个 rAF。隐藏页面清除许可并暂停发帧，恢复后重新取显示节拍。
- owner 在明确的 `RHIEndFrame` 通知后调用 `queue.onSubmittedWorkDone()`。共享原子计数分别跟踪已许可、已提交、已完成帧及峰值。候选参数 `-WebFrameScheduler=4` 将包括 Game/Render 中尚未提交工作在内的未完成预算限制为四帧；它不是精确输入延迟指标。
- 新 CVar `r.WebGPU.OcclusionQueryWaitMs` 默认 0。非 owner、非浏览器主线程在 UE 请求等待旧查询时使用 futex 休眠，结果由 owner 的原 map 回调发布并唤醒。每个消费线程每个 Render 帧最多等待设定预算，范围 0–20 ms；本轮测试 8 ms，超时继续保守地按可见处理。owner 始终不在此路径阻塞。
- 等待次数、等待后仍未就绪次数和累计休眠时间按原有低频统计上报；没有改变查询结果值、generation 检查、灯光、阴影质量、分辨率或 Cook。

GPU 完成预算采用独立的完整帧序号。原型曾用 viewport 呈现累计值计算，启动阶段该值从 2 开始，导致预算门禁失败；该次失败保留并排除。正式版本不再依赖 HUD/viewport 的呈现计数。

引擎帧时钟桥已本地提交为 `c72dedf23`。外围的 GPU 完成预算、查询等待实现及测试保存在本仓库，实际执行输入以可携带证据中的 SHA-256 为准。

## 构建与筛选

v63、v64 都完成 Web UBT 编译、链接和构建脚本验证，mimalloc 保持启用。v64 使用 `villa-lumen-off-current-mimalloc-v59` 已核验的原 Cook、内容和配置打包，没有重新 Cook。v62 实验包作为打包来源时暴露既有打包器不支持对象形态 `baselineCookPayload` 的问题，未产生输出；随后直接使用原始 v59 证据成功打包。

早期每次请求都等待新 rAF 的两帧预算约 69 FPS，未采用。v64 增加单个最新许可和完成通知后，五秒筛选为：原路径约 78.19、三帧加等待约 78.55、四帧加等待约 82.66 FPS。筛选只用于选择下一次实验；最终结果来自下述独立长窗口。

## 同包六轮交错计时

`control → controlw8 → frame4w8 → frame4w8 → controlw8 → control`。每次重新启动同一 v64 WASM，可见 Edge 156.0.4314.58，15 秒预热、20 秒正常计时。CSS 2289×1287、DPR 1，内部 1484×835、输出 2289×1288、TSR=4；独立 Game/Render/RHI、核心预算 4、三个任务 Worker。使用普通页面的 PSO consolidation 默认约定，各分支一致，没有额外开启预缓存。

| 指标 | 原路径 | 原路径 + 8 ms 查询等待 | 页面直连 + 四帧预算 + 查询等待 |
| --- | ---: | ---: | ---: |
| 合并 FPS | 77.89 | 73.00 | **81.60** |
| 两次独立 FPS | 77.66 / 78.12 | 65.53 / 80.48 | **81.45 / 81.75** |
| 合并 1% Low | 34.81 | 30.23 | **37.33** |
| RHI pump 墙钟 ms/帧 | 约 9.25 | 约 8.95 | 约 8.09 |
| direct draw/帧 | 约 3058 | 约 2567 | 约 2467 |
| indirect draw/帧 | 约 77 | 约 13 | 约 4 |
| dispatch/帧 | 约 158 | 约 147 | 约 145 |

组合候选较原路径约 +4.76% FPS、+7.22% Low。两次候选及两次原路径各自接近，但只有一次交错实验，不能当作跨环境稳定收益或最高帧率上限。查询等待单独分支有一次明显回退，未丢弃该次运行，也不将合并后的组合/等待差值作为稳定的调度增益。

组合候选正常计时每帧约等待一次、累计休眠约 7.05 ms；它发生在消费线程，可与 RHI/GPU 重叠，不能与 RHI 时间相加求整帧成本。查询读取未就绪比例从原路径约 45.6% 降到约 1.7%，仍有超时和非等待读取。绘制/dispatch 减少来自更多查询结果得到消费，不是关闭灯光或降低质量；具体图像边界见后续验证。

两次组合运行的已提交及已许可预算峰值均为四帧，GPU 完成计数持续增长。Promise 每帧创建一次、完成通知每帧一次，相关开销包含在计时中。此边界限制由实际队列完成通知驱动，不只比较 Game/RHI 的 CPU 帧计数。

正常计时没有 profiler、trace、逐 draw 包装、额外 GPU 读回或时间戳。1% Low 对各分支两次提交间隔合并，取最慢 `ceil(N×1%)` 个间隔的平均值再求倒数。提交完成不等于 GPU 完成或物理显示。

## 运行验证边界

首次压力脚本在设置固定相机后验证玩家移动，因视角仍绑定测试相机而失败；已把输入检查移到设置固定相机之前。冻结时钟的压力尝试会影响查询行为，因此最终改为正常时钟。切换标签页和最小化窗口时，自动化宿主均未报告 `document.hidden=true`；最终单独触发 visibility 处理函数，记录模拟标志，不将它称为真实后台验收。一次重试遇到本地 8765 服务退出，启动失败，重启服务后使用新标签；该次没有性能样本。

这些失败报告和日志均保留，未合并进六轮正常计时。运行压力与画面结果单独记录，不能以参数默认关闭代替实际正确性验证。

最终正常时钟压力测试按 `control → frame4w8 → control` 完成：三次都通过键盘移动、五个视角切换与三种窗口尺寸检查，流送等待归零，没有捕获到 GPU 验证或运行错误。候选在整个压力过程中已提交与已许可的未完成预算峰值均不超过四帧，完成回调持续推进。模拟隐藏期间帧数停止增长，恢复后继续运行；`actualHiddenObserved=false`、`handlerSimulated=true` 明确保留在证据中。

五个视角使用候选前后的独立原路径运行夹测，排除动态 HUD，全部通过仓库既有时序漂移阈值。候选与较接近原路径图像的最大全图平均 RGB 差为 0.704/255，最大超过 8 色阶的像素比例约 0.223%；人工检查差异最大的视角，未见明显缺物或光照差异。这不是运动伪影或逐像素一致性验收。画面检查不冻结时钟，也没有关闭遮挡查询。

汇总及输入哈希见 [可审查证据](tests/web-platform/evidence/frame-scheduler-20261104.json)。本地原始数据为 `tests/web-platform/results/frame-scheduler-v64-abccba-20261104.json`、`frame-scheduler-v64-stress5-20261104.json` 和 `frame-scheduler-v64-images-20261104.json`；大体积包、截图、日志按仓库惯例留在忽略的 build/results 目录中。

## 复现

候选默认关闭。调度参数为 `-WebFrameScheduler=1..4`；查询等待可通过 CVar 设置，实验 RPC 为 `WebLightingQualityTest(20, 8)`，0 恢复原查询行为。两项可独立测试。

在 `G:/UE_HTML/ue_html` 启动既有 8765 静态服务，按顺序执行，使用新包名、新标签：

```powershell
tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4
node tests/web-platform/package-web-runtime-experiment.cjs --baseline=villa-lumen-off-current-mimalloc-v59 --output=villa-frame-repeat --evidence=tests/web-platform/results/post-mimalloc-v59-profile-20261104.json
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-frame-scheduler.cjs --folder=villa-frame-repeat --tag=frame-repeat-perf --modes=control,controlw8,frame4w8,frame4w8,controlw8,control --seconds=20 --warmup=15
node tests/web-platform/probe-web-frame-scheduler.cjs --folder=villa-frame-repeat --tag=frame-repeat-stress --modes=control,frame4w8,control --seconds=5 --warmup=15 --stress
& 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' tests/web-platform/compare-frame-scheduler-images.py tests/web-platform/results/frame-repeat-stress.json tests/web-platform/results/frame-repeat-images.json
node tests/web-platform/summarize-web-frame-scheduler.cjs --benchmark=tests/web-platform/results/frame-repeat-perf.json --stress=tests/web-platform/results/frame-repeat-stress.json --images=tests/web-platform/results/frame-repeat-images.json --output=tests/web-platform/evidence/frame-repeat.json
```

没有量测 OS GPU 利用率、输入到显示延迟或同条件桌面完整 GPU 帧，也没有重新验证首次转向 PSO 编译长帧。浏览器每帧 GPU 完成反馈和原生 D3D12 sync point 的交付延迟不同；更紧的预算在本场景会减少吞吐。后续应量化 query 提交、GPU 完成和 owner 回调发布的时间关系，不能承诺仅搬用桌面调度即可恢复此前诊断增幅。
