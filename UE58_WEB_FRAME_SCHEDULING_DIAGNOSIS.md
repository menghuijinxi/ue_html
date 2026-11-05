# 三项小收益实验之后：帧调度与异步遮挡查询复核

后续实现见 [桌面同步语义的 Web 候选](UE58_WEB_FRAME_SCHEDULER_EXPERIMENT.md)：保留正常查询消费并加入 GPU 在途预算后，六轮交错计时约 77.89 → 81.60 FPS，尚未提升为默认模式。下文的 91/97 FPS 属于早期隔离诊断，不能作为可交付收益。

2026-11-04。绑定槽位计划、TLV 级联共享、GPUBuffer 上传页三项实验均未确认稳定 FPS 收益。重新检查 Game 帧循环后，发现它每次继续运行都要经过正在执行 RHI 的 owner Worker。本轮运行时替换诊断得到 **78.31 → 91.31 FPS**；另行关闭两侧遮挡查询、使绘制量接近一致的对照得到 **74.51 → 96.82 FPS**。这支持优先研究帧生产调度，而不是继续按热点采样占比微调相同路径。

这些是固定视角的调度诊断，**尚未形成可默认启用的优化**。直接让 Game 在线程本地连续运行，会使正常模式的遮挡查询读取全部未就绪。后续实现必须兼顾异步查询消费、GPU 队列上限、显示节拍和输入延迟。

## 三项已有实验改变了什么判断

| 候选 | 同包平均 FPS 变化 | RHI pump 墙钟变化 | 实际省下的工作 |
| --- | ---: | ---: | --- |
| 绑定槽位计划 | +0.77% | -0.134 ms/帧 | 槽位组装；描述符重建量基本不变 |
| TLV 级联共享 | +0.69% | -0.056 ms/帧 | 部分参数与 RDG 准备；dispatch 仍约 158/帧 |
| GPUBuffer 上传页 | +0.73% | -0.190 ms/帧 | 创建数约减少 80%；上传调用与复制保留 |

详见 [绑定与 TLV](UE58_WEB_BINDING_TLV_EXPERIMENTS.md)、[Buffer 生命周期](UE58_WEBGPU_BUFFER_LIFECYCLE.md)。这些实现确实减少了局部工作，但不能据此宣称最高帧率或 Low 得到稳定提升。也不能把“TLV 参数共享未获明显收益”扩大成“兼容阴影的真正多灯 shader 合批已被否定”。

上一轮把包含子调用的 RHI 热点占比当成实施优先级，缺少对关键调度依赖的验证。`rhiWorkMilliseconds` 是 pump 墙钟累计，和 Game/Render 重叠，也不是 GPU 执行时间；它不能直接代表整帧瓶颈。

## 帧生产为什么依赖 RHI owner

`reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js:8` 为嵌套 pthread 实现 rAF 桥。Game 的调用仅保存 callback，并向父 Worker 发送 `web-game-raf-request`。

`tests/ue-web-smoke/Source/UEWebEngine/Private/UEWebEngine.cpp:1394` 在 owner 接收请求，再请求 owner 的 rAF，回传后才执行 Game callback。owner 同时拥有 OffscreenCanvas 和 WebGPU/RHI。

当前生成的 Emscripten `MainLoop.runner` 在 `MainLoop.runIter(iterFunc)` 返回后才调用 `MainLoop.scheduler()`。因此每一帧都存在以下依赖：

`Game tick 返回 → owner 收到请求 → owner 执行 rAF callback → Game 收到回传 → 下一次 tick`

这使下一帧生产受 owner 事件循环影响。Game 等待期间 RHI 可能正在正常工作，不能把整段等待当成可全部删除的空转。

## 普通模式六轮诊断

顺序 `owner-raf → owner-immediate → game-local → game-local → owner-immediate → owner-raf`。每轮重启可见 Edge，15 秒预热、10 秒正常计时，随后另行采集 4 秒调度时间戳。正常计时只有呈现计数 hook，没有 CPU profiler、trace、GPU 时间戳或逐 draw 包装。

三种模式使用同一个 v62 WASM、Cook 和配置。`owner-raf` 保留原路径；`owner-immediate` 仅将 owner 的 rAF 回应改为 MessageChannel immediate；`game-local` 使用 Game 本地 MessageChannel 继续下一帧，省去 owner 请求/回传。后两者是尽快运行的诊断替换，并不保持原显示节拍语义。

| 调度 | 合并 FPS | 合并 1% Low | RHI 墙钟 ms/帧 | direct / indirect draw | dispatch |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原 owner rAF | 78.31 | 35.11 | 9.207 | 3053.71 / 76.42 | 158.01 |
| owner immediate 回应 | 80.35 | 41.35 | 9.529 | 3166.20 / 90.86 | 160.65 |
| Game 本地继续 | 91.31 | 49.10 | 10.343 | 3854.27 / 170.00 | 174.46 |

本地模式两次为 92.27 / 90.36 FPS，原路径为 78.27 / 78.34。合并平均 FPS +16.61%，Low +39.86%，明显大于前三项实验的变化。但绘制量不同，因此这张表不能当成相同渲染工作下的正式优化验收。

独立的调度采样中，原路径从发出下一帧请求到 Game callback 开始平均 **10.402 ms**：owner 接收前 3.399 ms，owner 收到后到回应 6.955 ms，回传到 Game 约 0.047 ms。owner immediate 的总等待仍约 9.522 ms，说明简单更换 owner 的定时 API 没有绕过排队依赖。本地 MessageChannel 约 0.056 ms。

Game callback 墙钟从约 2.296 增到 10.871 ms，包含引擎同步等待；不能解释为 Game 计算量增加到五倍。采样窗口与正常 FPS 分开，以上数字不能直接相减推算加速上限。

## 遮挡查询是必须一起解决的问题

普通原路径中，查询结果读取调用约 **45.28%** 返回 pending；本地模式在正常计时窗口为 **100%**，两轮都没有 ready 读取。它是调用计数比例，不是唯一查询对象数量比例。

`WebGPUDynamicRHI.cpp:4639` 的 Worker 路径读取 `ResultReady` 原子状态，未就绪立即返回 false；UE 将不可用结果按可见处理。因此本地模式虽然更快，却几乎失去这部分遮挡剔除，提交量反而增加。现有数据还没有区分 GPU 结果完成延迟、owner 回调排队、消费帧过早各占多少，不能只凭 pending 宣布 GPU 或事件循环中的某一项是唯一原因。

另做两侧均设四帧查询缓冲的探索，仍观察到本地模式约一半读取未就绪，未获得相同绘制量。该探索报告的最终汇总校验还错误地比较了递增帧号，保留失败状态，不纳入上表及下表性能汇总。单纯扩大历史窗口不足以作为本轮解决方案。

## 去掉查询差异后的独立对照

为检查收益是否依赖遮挡历史，另做 `owner-raf → game-local → game-local → owner-raf`，每轮 15 秒预热、**20 秒正常计时**。仅在这组诊断的两侧调用 `WebOcclusionTestMode(0, 0)`，关闭硬件遮挡查询；这是隔离变量的实验设置，不作为产品建议。

| 指标 | 原 owner rAF | Game 本地继续 |
| --- | ---: | ---: |
| 合并 FPS | 74.51 | 96.82 |
| 合并 1% Low | 36.05 | 57.84 |
| 两次独立 FPS | 74.47 / 74.56 | 96.13 / 97.50 |
| RHI 墙钟 ms/帧 | 9.670 | 9.933 |
| direct draw/帧 | 3162.2857 | 3162.2842 |
| indirect draw/帧 | 170.00 | 170.00 |
| dispatch/帧 | 175.00 | 173.54 |
| ready / pending 读取 | 0 / 0 | 0 / 0 |

平均 FPS +29.94%，Low +60.42%。绘制量几乎相同，dispatch 仍少约 **0.83%**，不是完全相同的 GPU 工作。这组结果强化了调度方向的证据，仍不能把诊断增幅直接当成正式模式的预期收益。

两组固定相机、项目渲染设置和分辨率均核对一致。Game/RHI 在采集前后的帧计数相差约 0–1 帧，说明观察时点没有只生产 Game 帧而停止提交；它不证明 GPU 队列深度有上限，也不等同显示器实际显示 FPS。

## 后续实施顺序

1. **帧时钟与 owner 队列**。试验由页面显示节拍直接向 Game 传递可合并的帧许可，避免每帧先经繁忙 owner 请求再回传；最多保留有限许可，保留隐藏页面暂停/降频和输入处理。仅在 owner 上将 rAF 换成 immediate，现有结果只有小幅改善。
2. **异步查询消费与回调公平性**。记录查询发出、提交、map 完成、结果发布、Render 消费的帧号和时间，区分真正 GPU 未完成与回调没有及时执行。限制 owner 一次 pump 的工作预算，并测 GPU 在途帧数；保持事件循环能处理 map、资源 IO 和设备错误。不要通过忙等、同步排空 GPU 或强行把未完成结果标记 ready 来提升计数。
3. **重新判断真正减少提交量的改动**。只有描述符解析复用、稳定命令重放、阴影合批或兼容阴影的 TLV 多灯合批实际减少工作时，再评估其相同画面的整帧收益；不继续重复固定槽位装配和对象创建微调。
4. **首次 PSO 单独处理 Low**。此前首次转向 331 ms 与浏览器管线准备相关，仍需小工作集预热和首次/重复转向对照。本轮只测固定视角，没有证明首次 PSO 卡顿已经改善。

## 环境、校验与证据边界

v62 `villa-buffer-lifecycle-v62`，mimalloc、独立 Game/Render/RHI、核心预算 4、三个任务 Worker；绑定计划与上传页实验关闭，TLV 共享沿用默认关闭。原 Cook、材质和光照配置。可见 Edge 156.0.4314.58，2289×1287 CSS、DPR 1，内部 1484×835、输出 2289×1288、TSR=4。使用普通页面启动，不增加 `-WebThreadingTest=full`，各侧均保留普通页面的异步 PSO consolidation 约定；不要与之前关闭 consolidation 的 ABBA 拼成一次对照。

采集只在 `results` 写诊断 JS，并通过页面 Worker 的运行时 URL 载入；嵌套 pthread 导入同一诊断文件。owner 模式标记和 Game 消息确认均核验，打包 JS/WASM/HTML/配置及内容清单哈希复核一致。没有编译或修改正式引擎调度。

首次尝试只做浏览器路由替换，嵌套 pthread 未载入插桩，Game 确认失败；整轮排除。后续四帧探索的帧号比较错误，以及查询关闭组在汇总时把新 Worker 的逻辑 threadId 当成渲染设置比较的错误，均保留原始失败。汇总器对查询关闭组重新核验全部逐轮门禁、执行源码快照、包哈希、相机、画质、尺寸和 AA；仅排除 `frame`、`threadId` 两个运行时元数据字段，未重写原始计时或原始错误。采集器已修正对应校验，证据记录 `rawPass=false` 和重新核验结果。

两组正常计时及之后的独立调度采样均没有捕获 GPU validation、设备丢失、引擎断言或崩溃。每种调度留有截图，人工查看出生视角没有明显缺失；没有通过严格像素一致性、移动/快速转向、输入延迟、后台页面、长期运行或跨浏览器验收。没有量测 OS GPU 利用率、完整 GPU 帧、GPU 在途深度或同条件桌面帧时间。1% Low 是合并提交间隔中最慢 `ceil(N×1%)` 个间隔的平均值取倒数。

可携带证据：[frame-scheduling-20261104.json](tests/web-platform/evidence/frame-scheduling-20261104.json)，包含两组逐模式汇总、读取 pending 比例、调度分段、包及源码 SHA-256、原始失败来源和验证修正。完整逐帧、日志、JS、截图及执行源码快照在本机 `tests/web-platform/results/`。

## 复现

运行前启动既有 8765 静态服务，串行运行测试，使用新标签：

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-frame-scheduling.cjs --tag=pacing-normal-new
node tests/web-platform/probe-web-frame-scheduling.cjs --tag=pacing-isolated-new --modes=owner-raf,game-local,game-local,owner-raf --queries=off --seconds=20
node tests/web-platform/summarize-web-frame-scheduling.cjs --normal=tests/web-platform/results/pacing-normal-new.json --noqueries=tests/web-platform/results/pacing-isolated-new.json --output=tests/web-platform/evidence/pacing-new.json
```

最新采集器自动保存 `-source.cjs` 执行快照。历史普通组在加入自动快照前执行，因此汇总时额外传 `--normal-source=tests/web-platform/results/frame-scheduling-v62-20261104-v2-executed-source.cjs`，快照 SHA-256 必须等于原始报告中的 source 摘要。
