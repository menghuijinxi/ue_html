# HZB、PSO 预缓存与 RDG 内存测试（2026-11-01）

游戏关闭后的复测已完成：实例 HZB **48.32→48.45 FPS（+0.27%）**，整体持平；之前 −8% 受干扰，不能作为确定回退幅度。传统 HZB 的对应帧结果消费与 PSO shader 线程障碍均再次复现；RDG 池仍约 468MiB。新数据见 [统一复测记录](UE58_WEBGPU_IDLE_RETEST.md)，下文保留游戏运行时的历史测量。

本轮没有测出值得默认开启的性能候选。实例 HZB 没有吞吐收益；传统 HZB 暴露出结果回读与帧历史的时序障碍；PSO 预缓存触发 shader 创建线程契约检查。RDG 已在使用 UE 资源池，不能把空的 native transient allocator 直接换成 DX12 堆别名实现。

| 项目 | 实测 | 结论 |
| --- | --- | --- |
| GPUScene 实例 HZB | ABBA 基线 21.46、候选 19.75 FPS；RHI 工作 35.04→37.72ms/帧 | 本视角无收益，保留项目原值 0 |
| 传统 HZB | 完成 133 次回读，消费 0 次；单独像素回读测试通过 | 尚未得到有效遮挡结果，不报告性能收益，平台能力继续关闭 |
| UE PSO 预缓存 | 收集请求时触发多线程 shader 创建检查，未进入有效性能对照 | 只设置支持标志不成立；默认关闭，异步编译尚未实现 |
| RDG | 135 个 pooled render targets，约 467.66MiB；转身后数量及总量不变 | 已有池复用，本轮未实现 native transient allocator，也未证明其缺口解释全部显存差距 |

## 测试边界与复现包

使用 TriplexHouseVilla 原有 Cook 内容及配置。运行包 `villa-render-diagnostics` 与历史测量包 `villa-parallel-recording-default` 的 `content.bin`、`content-files.json`、`config-files.json` 逐字节 SHA 相同。只替换 Web runtime 和诊断脚本，没有重新 Cook、修改项目 Config 或调整画质。运行时实验只修改明确列出的遮挡 cvar，测试结束恢复原值；PSO 使用单独的失败实验包。默认页面未带 PSO 实验参数。

- [默认诊断页面](http://127.0.0.1:8765/build/villa-render-diagnostics/index.html)
- 构建快照：`tests/web-platform/results/villa-render-diagnostics-build.json`，完整 wasm64 threads 链接通过。
- 打包审计：`tests/web-platform/results/villa-render-diagnostics-package.json`。
- 汇总证据：`tests/web-platform/results/render-optimization-summary.json`。
- 引擎仓库基于 `a4bd99841`，本轮未修改引擎源码；只修改外围 Web RHI、诊断及测试工具。

Edge 156.0.4314.58，NVIDIA Lovelace，单个 headless 浏览器，viewport 1863×1030、DPR 1.25。按用户要求保留 `cod.exe` PID 4008 运行，存在 CPU/GPU 资源竞争；本轮绝对 FPS 不与历史其他环境的 50+ FPS 或桌面截图 147 FPS直接比较。

## 1. 两种 HZB 路径分别验证

GPUScene 可用不代表实例 HZB 已开启。实际原值为 `r.HZBOcclusion=0`、`r.InstanceCulling.OcclusionCull=0`；传统平台 capability 也为 false。

### 实例 HZB：实际创建新计算管线，但当前视角没有吞吐收益

仅将 `r.InstanceCulling.OcclusionCull` 设为 1；复用 UE 原有实例剔除及上一帧 HZB 路径。四轮为基线、候选、候选、基线，每轮预热 20 秒、测量 15 秒，相同位置、角度、Cook、runtime 和画质。

| 轮次 | FPS | RHI 工作 ms/帧 |
| --- | ---: | ---: |
| 基线 A | 22.80 | 33.20 |
| 候选 B | 19.66 | 37.62 |
| 候选 B | 19.84 | 37.82 |
| 基线 A | 20.14 | 37.11 |
| 按帧数及测量时间汇总 | 21.46→19.75（−8.00%） | 35.04→37.72 |

两次基线自身下降 11.65%，因此不能把 −8.00% 全部归因于候选。可以确认的是：两轮候选未观察到收益，尚无默认启用依据。实际 compute pipeline 数从 48 增至 49；截图未观察到明显画面缺失。

另行插桩的 API 调用数，不与上表 FPS 混用：

| 每帧调用 | 原值 | 实例 HZB |
| --- | ---: | ---: |
| draw + drawIndexed + drawIndexedIndirect | 3146.36 | 3146.22 |
| setVertexBuffer | 8009.81 | 8009.16 |
| setBindGroup | 1403.43 | 1405.30 |
| createBuffer | 54.03 | 61.03 |
| writeBuffer | 51.03 | 58.03 |
| dispatchWorkgroups | 47.51 | 49.51 |

CPU 绘制提交数量几乎不变，新增计算和临时数据工作。间接绘制内部的实例数量不能从这些 API 次数推导，因此这不是“GPU 没有剔除任何实例”的证据。

记录：`instance-hzb-abba.json/.log`。该次旧版脚本的 API 阶段还额外采了一次传统 HZB；汇总工具明确排除它，只使用 mode 0/2。修正后的脚本仅捕获请求的唯一 modes。

### 传统 HZB：数据回读有效，当前帧历史消费失败

用 `r.HZBOcclusion=2` 进入 UE 自己的 `FHZBOcclusionTester`，不修改平台配置。补齐过程中发现并修复了 Web RHI 缺失的 float4 纹理区域上传、CPUReadback 纹理、CopyDest/CPURead 状态、纹理到 MAP_READ buffer 复制、非阻塞 Map/Unmap，以及 UE 原有 RenderThread 提交 flush。

最新时序检查的计数为：134 次纹理回读入队、133 次完成、0 次被 HZB Map 消费、133 次 Map 未就绪。UE 要消费对应结果时仍未拿到它，随后 `FHZBOcclusionTester::MapResults()` 把该帧标为无效、保守返回可见。测试脚本因此主动判失败，拒绝把其 FPS 当成遮挡优化收益。

独立测试使用 UE `FRHIGPUTextureReadback`，上传 3×2 RGBA8 非均匀图案，跨帧轮询完成后逐字节校验，已通过；返回 rowPitch=64 pixels、height=2，覆盖 WebGPU 的 256 字节行对齐。异步回调只持有共享计数器，不依赖已销毁的 RHI 对象。

需要继续处理的是与实际结果帧匹配的回读和 primitive 索引历史。不能把更旧的已完成结果冒充为当前 frame/index 的结果；当前实现不这样做。原生 UE 这里允许等待上一帧 GPU，而本实现使用跨帧非阻塞回读，两者时序不能仅靠能力开关对齐。

记录：`hzb-submit-flush-check.json/.log`（遮挡消费失败）；`rdg-ledger-verified.json` 的 `readbackTest`（独立数据接口通过）。

## 2. PSO：明确定位在 shader 创建线程前提

单独包 `villa-pso-probe` 通过 `-WebPSOPrecacheTest` 允许 UE 原有 PSO 请求收集，未修改 DDPI 异步能力或声称已接入异步 WebGPU pipeline API。启动时实际触发：

`ShaderCodeArchive.cpp:1754`：`IsInRenderingThread() || GRHISupportsMultithreadedShaderCreation` 检查失败。

调用栈经过 `FMaterialPSOPrecacheCollectionTask`、mesh pass PSO initializer 收集、shader map/library 创建；Web 后端声明 `GRHISupportsMultithreadedShaderCreation=false`，与此后台收集路径不兼容。尚未形成能运行的预缓存候选，不能给出预缓存收益。

现有 shader 创建函数会代理到 WebGPU owner，但把全局多线程 shader 能力设为 true 还会放开 UE 的 RDG parallel setup/execute 等分支，需要一并验证资源与 context 的线程约束。这次没有为了越过检查直接打开该全局标志。失败实验参数仅用于复现，默认页面不携带它。

默认包的转身捕获：第一次转 90° 新建 15 个 graphics PSO，帧间隔最大 661ms、p95 113ms；后续角度没有新增管线。此阶段有 API 插桩及后台游戏干扰。15 次 `createRenderPipeline` 的 API CPU 调用时间只有约毫秒量级，不能据此把全部尖峰归因于 PSO；浏览器/驱动延迟编译、流送和其他渲染工作尚未分离。

当前浏览器具有 `createRenderPipelineAsync`、`createComputePipelineAsync`；Web RHI 仍使用同步创建。后续若做完整实现，应复用 UE 的请求、缓存和完成事件，分别处理 shader 创建线程与 WebGPU 异步完成，避免只把同步创建提前后称作异步预缓存。规范接口见 [WebGPU async pipeline creation](https://gpuweb.github.io/gpuweb/#dom-gpudevice-createrenderpipelineasync)。

记录：`pso-precache-check.json/.log`、`villa-pso-probe-package.json`、`rdg-ledger-verified.json` 的 tour。

## 3. RDG：池复用已经存在，内存账本已补齐

实际 `r.RDG.TransientAllocator=1`，但 Web RHI 没有 native allocator，UE 使用 pooled 路径。没有为了本次测试调整 `r.RenderTargetPoolMin` 或清空 UE 资源池。

UE 自身 `GRenderTargetPool.GetStats()` / `DumpMemoryUsage()`：

- 135 个 render targets，总量 467.66MiB，快照时仍被占用的约 203.16MiB。
- Dump 中没有 `UnusedForNFrames>2` 的闲置项；相邻帧反复使用的项多数显示 0/1。不能将两项统计之差直接当作泄漏或立即可省的显存。
- 转过 0°、90°、180°、270°、0° 后，池数量及总量不变；这是本轮有限路径的稳定性证据，不是长时间无泄漏证明。

另在 WebGPU API 层记录 texture/buffer 逻辑大小。记录使用 WeakRef，不把已释放对象强行保活；性能采样结束后对引擎 Worker 强制 JS GC，再汇总存活资源。覆盖本次全部纹理格式，包括 BC 块压缩和 depth16，未知格式为零。

最终 texture 约 **1280.73MiB**、buffer 约 **55.94MiB**。最大几项：

| 资源 | 逻辑大小 | 说明 |
| --- | ---: | --- |
| 项目 `T_HdrImage` | 192MiB | 2048²×6，RGBA16F，1 mip |
| SkyTextureCube | 64MiB | 1024²×6，RGBA16F，11 mips |
| 距离场 brick atlas | 32MiB | 1024×1024×32，R8 |
| ReflectionEnvs | 31MiB | 128²×186，RGBA16F，8 mips |
| WholeSceneShadowmap | 24MiB | 6144×2048，depth16 |
| 两份 TAA.History | 约 45.12MiB | 每份 2296×1288，RGBA16F |

所有 depth16 纹理合计约 211.88MiB。Web 阴影已经使用 16 位深度，不能再把所有阴影翻倍当成本轮已发现的问题。613 个 streamable 资源仍经过 UE 流送，resident/requested 5769 mips，maximum 7241；转身后资源流送会改变 texture 总量。

这些是 API 描述符推算的逻辑分配，不包含驱动对齐、浏览器/GPU 进程缓存、提交中资源的物理寿命等；`depth24plus` 的物理存储也由实现决定。不能将其与任务管理器显存或 UE 的池快照直接相加。本轮尚未采集同视角 PC 的同口径逐资源账本，不能声称已经解释或解决整个 Web/PC 显存差距。

本机另测 `TRANSIENT_ATTACHMENT=32`：1×1 pass 使用 clear/discard 成功，零 validation error。但它只能用于符合相应限制的 pass 附件；不能替代跨 pass 被采样的 SceneColor/GBuffer/history，也不等价于 DX12 `CreatePlacedResource` 的堆别名。UE D3D12 transient allocator 依赖原生堆和放置资源；当前 WebGPU 没有直接对应的通用显存堆别名 API。参见 [WebGPU texture usage](https://gpuweb.github.io/gpuweb/#texture-usage)。本轮没有把该标志应用于 UE 资源。

记录：`rdg-ledger-verified.json/.log`、`webgpu-optimization-capabilities.json`。

## 复现命令

所有命令在 `G:/UE_HTML/ue_html` 执行，需现有 8765 本地服务及 Playwright 的 NODE_PATH。工具不会改写项目 Config。

```powershell
node tests/web-platform/probe-web-render-optimizations.cjs --folder=villa-hzb-probe-v3 --tag=instance-hzb-repeat --modes=0,2,2,0 --warmup=20 --seconds=15 --capture-api
node tests/web-platform/probe-web-render-optimizations.cjs --folder=villa-render-diagnostics --tag=memory-repeat --modes=0,0 --warmup=15 --seconds=5 --resource-ledger --tour --readback-test
node tests/web-platform/probe-webgpu-optimization-capabilities.cjs
node tests/web-platform/analyze-web-render-optimizations.cjs
```

汇总工具的 `evidenceChecksPass=true` 只表示证据及预期检查一致，不表示失败候选已经可用。三项结果未自动转为默认开启；后续应先解决传统 HZB 的有效帧消费和 PSO shader 创建线程前提，再分别做收益对照。
