# 别墅从页面启动到游戏画面的耗时分析（2026-11-03）

已经定位到我们 Web 接入层自身的一项明显额外开销：着色器反射信息以 JSON 保存在 Cook 数据中，运行时在 RHI / WebGPU 所在 Worker 上反序列化。原始 v18 的 CPU 采样与新增原生计时相互印证，它造成了约 3.1 秒的连续事件循环停顿。这段时间大部分没有在途的异步 PSO API 请求，不能归因于浏览器读取 PSO 缓存。

本轮添加测试、原生 trace 范围和手动导出页面，保留所有项目设置及 Cook 内容，尚未实施反射格式或启动调度优化。没有把独立小程序的速度解释为 UE 接入已经达到最佳速度。

## 测量方法和边界

- 原始包为用户指定的 `villa-pso-concurrency-v18-default`。首先在原始包上仅注入计时器，避免将重新编译的运行时当成原始版本。
- 使用实际 Edge `156.0.4314.58`，有窗口，1863×1030、DPR=1.25；游戏输出 2290×1288、内部 1484×835，默认入口视角。
- 后续正式诊断包 `villa-startup-profile-v24` 和 trace 包 `villa-startup-trace-v22`，均以 SHA-256 校验确认 content.bin、content-files.json、config-files.json 与 v18 相同。TSR=4，距离场生成/DFAO/距离场阴影=1；GI、反射方法、虚拟阴影=0，纹理池 1000 MiB。没有手动开关渲染功能。
- 每轮关闭并重新打开浏览器，保留同一专用 profile 的缓存；明确记录下载字节、持久缓存命中、哈希耗时。缓存缺失样本单列。
- 原生使用 UE 自带 `FTraceAuxiliary`、CPU/frame/task/RHI/loadtime 通道并导出 `.utrace`，由 Unreal Insights 导出分析。跨 pthread 的启动标记在调用线程取时间，再发送给 Worker，避免把消息到达延迟当成业务耗时。
- 区分“早期 canvas 工作”“游戏循环开始后的场景提交”“GPU 队列完成”“撤下加载层”。RHI present 计数首次达到 2 作为首个游戏循环画面的提交边界，早期 present=1 可发生在关卡准备之前。队列完成和加载层隐藏都不等于显示器实际扫描输出。
- CPU 采样与 trace 会改变耗时。常规计时使用未开启 CPU 采样 / 原生 trace 的样本；采样和 trace 用于解释调用栈。计时器自身的影响尚未通过无探针对照量化。

## 完整启动过程

正式诊断包的两次保留缓存重开：下载字节为 0，哈希字节为 0，持久缓存命中均为 2。首个游戏循环画面的队列完成均约在 16.39 秒，加载层撤下后两个 RAF 为 17.09 / 16.96 秒。

下表为第一次保留缓存样本，所有边界相对页面 navigation；按先后列出，避免将并行等待相加。

| 阶段 | 起止 | 本段耗时 | 解释 |
|---|---:|---:|---|
| 页面、运行时脚本、WASM 和 Worker 准备 | 0–0.479 s | 0.479 s | WASM instantiate 本身约 0.249 s；两次样本为 0.249 / 0.286 s |
| 内容挂载 | 0.479–3.250 s | 2.772 s | 持久缓存命中仍需读数据、创建文件和复制到 MEMFS |
| 挂载后配置及启动交接 | 3.250–3.416 s | 0.166 s | 包含配置写入、依赖完成和游戏线程开始 |
| UE PreInit | 3.416–5.722 s | 2.306 s | 对象/模块/默认资源、全局计算 PSO 收集等 |
| UE Init / 关卡启动 | 5.722–12.882 s | 7.160 s | 包含引擎引用加载、关卡包加载、材质/着色器初始化及等待 |
| 启动线程验证并 FlushRenderingCommands | 12.882–14.505 s | 1.623 s | 当前启动框架的验证同步点，会等待前序渲染/RHI 工作 |
| READY 日志及游戏循环交接 | 14.505–14.506 s | 约 0.002 s | 原生时间戳 |
| READY 到首个游戏循环画面提交 | 14.506–15.905 s | 1.399 s | 初始 Tick、渲染同步和 RHI 提交 |
| 提交到 GPU 队列完成通知 | 15.905–16.392 s | 0.487 s | 包含此前已提交工作的完成等待及通知，不是稳定帧的 GPU 时间 |
| 队列完成到加载层撤下后两个 RAF | 16.392–17.087 s | 0.695 s | PSO 收尾、达到 30 游戏帧的门槛，以及页面消息/呈现调度 |

另一轮的 PreInit=2.298 s、Init=7.384 s、线程验证=1.504 s。原始 v18 两个完整缓存样本在约 16.43 / 16.29 秒撤下加载层，RHI Worker 最大停顿为 3.141 / 3.153 秒；这个热点不是新诊断包才引入的。

用户实测仍是约 26 秒（校验 2 / 打开关卡 18 / PSO 6），本轮没有复现到同样的 26 秒，也不能用上述 17 秒覆盖用户结果。手动页面用于记录用户实际浏览器环境的完整区间。另有一轮内容缓存被淘汰，下载约 3.52 GB，加载层到约 28.48 秒才撤下；该轮属于重新填充缓存，不混入保留缓存结论。

## 已确认的耗时来源

### 1. 在 RHI Worker 上解析大量反射 JSON

原始 v18 上的 CPU 采样，最大 Worker 停顿窗口约 3.199 秒，其中扣除定时器正常间隔后的延迟为 3.179 秒。通过 CDP NavigationStart 将 CPU profiler 的单调时钟与页面绝对时间对齐后：

| 此窗口内调用栈 | 采样时间 |
|---|---:|
| Web `LoadShader` | 3095.543 ms |
| 其内 JSON Deserialize | 2714.920 ms |

同一窗口内异步 PSO 请求的在途时间并集仅 **11.985 ms**，8 个请求都集中在窗口尾部。换言之，绝大部分时间管线尚未交给浏览器创建。

新增 trace scope 的独立验证：

| 原生范围 | 全部采集累计 | 最大停顿窗口内 |
|---|---:|---:|
| WebShader_Load | 1685 次 / 3700.723 ms | 1475 次 / 3121.368 ms |
| WebShader_MetadataJSON | 1685 次 / 3289.470 ms | 1475 次 / 2762.364 ms |
| WebShader_CreateModule | 1685 次 / 219.764 ms | 1475 次 / 189.228 ms |

这些范围包含父子关系，不能相加。`CreateModule` 是 C++ 到浏览器 API 调用返回的同步部分，不包含浏览器后续 WGSL 处理或管线编译。JS 层还会记录引导/探针创建的 module，所以总数约 1695，与 LoadShader 的 1685 不同。

源码原因在 `WebGPUDynamicRHI.cpp::LoadShader`：UTF-8 转 FString → FJsonSerializer 构建完整对象树 → 再读取资源表与绑定字段。RHICreate*Shader 把整个过程同步转发到 GPU owner，使其同时阻塞 RHI、异步请求发起和消息处理。

对照本地 UE D3D12 的 `D3D12Shaders.cpp::InitStandardShaderWithCustomSerialization`：使用 `FShaderCodeReader`、`FMemoryReaderView` 和 `SerializeShaderResourceTable` 读取二进制数据。这里可以参考 UE 原生做法：Cook 输出紧凑、可验证的二进制反射结构，运行期直接反序列化；并评估将纯 CPU 的解析移出 GPU owner。实际收益需要随后 A/B，不能承诺直接减掉全部 3.29 秒。

### 2. “打开关卡”包含引擎准备和等待，不能等同硬盘 IO

一轮原生 trace 的 Init=7.584 s，其中 `GEngine->Init`=2.830 s、`GEngine->Start()`=4.741 s。前者加载引擎对象引用的一次 FlushAsyncLoading 约 2.542 s；后者加载关卡包的一次 FlushAsyncLoading 约 4.482 s。

游戏线程 `MainThreadWaitingOnAsyncLoadingThread` 累计约 6.355 s，材质布局创建约 0.872 s。但异步加载依赖着色器/RHI 初始化，不能把这些等待全解释成硬盘读耗时，亦不能与上述 RHI 解析时间再相加。

### 3. 缓存命中之后，文件挂载仍有成本

内容包共 5157 个文件、3,339,065,897 字节。其中 3860 个非 ubulk 启动文件合计 **664,497,185 字节**，当前每次启动仍读取并写入 MEMFS；1297 个 ubulk 采用占位及流式读取。没有重新下载或哈希，不代表启动数据已驻留于本次 WASM 进程。

本轮挂载约 2.1–2.8 s。全流程还会继续流送纹理等资源；diskReadMs 是并发请求的累加值，不能直接当作启动墙钟耗时。后续可考虑文件挂载方式和数据复制，但需另外验证 IO 正确性与内存占用。

### 4. READY 之后仍有同步和显示门槛

启动线程验证当前调用 FlushRenderingCommands，一轮 trace 等待约 1.443 s，正式包两轮为 1.623 / 1.504 s。它等待的是已有工作，不应声称去掉验证就一定净省这段时间。

首轮 Tick 约 70 ms，下一 Tick 在一轮 trace 中约 1044 ms，其中约 968 ms 是 Sync_RenderingThread / GameThreadWaitForTask。需要继续沿 Render/RHI 的依赖分析，不能算成稳定运行期间每帧的 PSO 复用成本。

当前网页要满足 PSO active=0、异步请求全部完成、游戏帧数≥30 才标记 PSO-ready。正式缓存样本中，最后一个异步 PSO API 完成到页面 PSO-ready 还差约 1–2 秒。因此页面显示的“PSO 阶段”包含初始帧和消息门槛，不能全部算作驱动缓存读取。

### 5. 发现 8 个计算 PSO 请求失败

本组异步请求为 482 个图形 + 626 个计算。图形全部成功；计算有 8 个明确被拒绝：WGSL workgroup_size(512,1,1) 超过当前请求出的 GPUDevice 的 X 维上限 256。错误同时说明本机 adapter 支持更高上限，但 requestDevice 没有申请对应 requiredLimits。

不是全部 PSO 缓存失败。其余 1100 个异步请求完成，失败请求通常在约 0.4–1.1 ms 返回；8 个失败不足以解释几秒停顿。设备能力申请与预缓存能力筛选需要后续修正。本次不通过更改项目渲染设置规避。

## 手动复测与自动化

手动页面：<http://127.0.0.1:8765/build/villa-startup-profile-v24/index.html>。右上角“导出启动分析”保存 `ue-startup-phases-*.json`。加载层撤下约半秒后自动冻结启动样本；之后走动不会改变这份启动数据。原始 v18 页面保持原样。

该页面只包含计时和导出功能，不默认启动 CPU profiler 或原生 trace。实际计时取 Worker 本地时间，页面标签更新速度不会改变已记录的 PreInit/Init 边界。

在 `tests/web-platform` 中，设置 Playwright 的 NODE_PATH 后运行：

```powershell
node capture-web-startup-phases.cjs --folder=villa-pso-concurrency-v18-default --tag=example-startup-01 --rounds=2
node capture-web-startup-phases.cjs --folder=villa-pso-concurrency-v18-default --tag=example-startup-cpu-01 --rounds=1 --cpu-profile
node capture-web-startup-phases.cjs --folder=villa-startup-trace-v22 --tag=example-startup-trace-01 --rounds=1 --ue-trace
node capture-web-startup-phases.cjs --folder=villa-startup-profile-v24 --tag=example-startup-manual-01 --rounds=2 --manual
node analyze-web-startup-phases.cjs results/example-startup-01.json
pwsh -NoProfile -File export-web-ue-trace.ps1 -Trace results/example-startup-trace-01-0.utrace -Engine D:/UE_5.8
node analyze-web-startup-native.cjs results/example-startup-trace-01.json results/example-startup-trace-01-0.events.csv
```

实际标签只允许小写英文、数字和连字符。`--browser-trace` 可补抓 Dawn/Chromium trace，体积较大且有额外开销；通过 CDP stream 保存，避免在 Node 内构建超大 JSON 字符串。

验证：正式和 Trace 两种完整 UBT 编译、链接及 WASM 校验通过；原始 v18 常规采集、CPU 采样、原生 trace 导出与 Insights 分析通过；诊断页及两轮完整缓存重开通过，手动按钮下载 JSON 已自动验证，最终别墅画面截图检查通过。没有未捕获的 GPU 验证错误或崩溃，另单独保留上述 8 个可捕获的异步 PSO 拒绝。

可审查证据见 `tests/web-platform/evidence/startup-phases-20261103.json`。完整日志、截图、`.utrace`、CPU profile、Chromium trace 和 CSV 保存在 `tests/web-platform/results/villa-startup-phases-*`；记录原始文件与构建产物的 SHA-256，未将大文件纳入 Git。

下一步优先级：二进制反射并减少 GPU owner 上的纯 CPU 工作；随后检查初始 Render/RHI 同步、PSO-ready 的 30 帧门槛、挂载复制，以及设备 limits 的申请。每项分别 A/B，再判断对用户 26 秒启动和运行期低帧的收益。
