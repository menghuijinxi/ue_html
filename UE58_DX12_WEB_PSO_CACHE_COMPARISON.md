# 同一别墅项目的 DX12 / Web PSO 缓存复用实测（2026-11-02）

保留缓存重新启动后，原生 DX12 的 5039 个自动 PSO 预缓存任务在约 1.2 秒内完成。限制到与 Web 相同的 8 个预编译线程，仍为 1.14 / 1.22 秒。补测 2 线程为 5.25 / 4.52 秒，1 线程为 7.94 / 7.81 秒。当前 Web 的 1108 个请求在 8 并发独立重放测试中为 6.40 / 6.51 秒，在 1 并发下为 34.94 / 34.02 秒。两端的 shader platform 和 PSO 集合不同，这些数字说明当前实现的启动成本差距，不能当作相同 PSO 的逐条 API 性能比。

## 环境与测试口径

- 项目：`G:/UE_HTML/TriplexHouseVilla/TriplexHouseVilla.uproject`，默认关卡 `/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla`。
- 引擎：`D:/UE_5.8`，5.8.1，CL 56057345。CPU i9-12900K（24 逻辑核心），GPU RTX 4090，驱动 621.01。
- 使用项目原设置打包 Windows Development 游戏，运行 D3D12 / SM6。Web 仍是既有 SM5 包。未修改项目 Config 或安装引擎源码。
- TSR=4、距离场生成=1、DFAO=1、距离场阴影=1、GI=0、反射方法=0、虚拟阴影=0、纹理池=1000 MB。原生光追开关遵循项目设置为 1，Web 能力集合不同。
- 原生使用 `-RenderOffscreen`、2290×1288 输出、固定默认视角；截图确认别墅入口关卡。测试启动开销，不评估窗口呈现延迟。
- 首轮作为预热排除；之后关闭进程再启动，保留全部缓存，没有清除驱动缓存或 DDC。先测默认 18 线程三次，再测 8 线程两次。测试顺序未随机化，系统和驱动缓存可能继续变热。
- 8 线程诊断只通过 `-ini:Engine:[SystemSettings]:r.pso.PrecompileThreadPoolSizeMax=8` 限制调度，项目文件没有写入此设置。日志和 trace 均确认实际线程数。
- 1 / 2 线程补测使用同一个包，顺序为 2、1、1、2。1 线程同时将运行时覆盖的 `r.pso.PrecompileThreadPoolSizeMin` 设为 1，避免默认最小值 2 与最大值 1 冲突。每轮实际预缓存并发和线程数均由 trace 验证。限制仅作用于预缓存线程池，运行时补建 PSO 仍可在其他 UE 任务线程执行。
- 全程启用 UE 自带 CPU trace 和 CSV。启动时间从 UE trace 的时间原点计算，不能等同于用户点击到可见画面的完整时间。

## 实测

“预缓存跨度”为首个 `PSOPrecache: Precaching` 任务开始到最后一个结束的墙钟时间，包含两者间资源加载和任务调度的空隙；不是各线程时间的相加。全体预缓存任务每轮均为 5039，重复启动的 CSV 完成计数也为 5039，采集结束前队列均为零。

| 重复启动 | 实际预编译线程 | 预缓存跨度 | DX12 创建 API 中位数 | DX12 创建 API P95 | UE LoadMap | 首个游戏 Tick 开始 |
|---|---:|---:|---:|---:|---:|---:|
| 默认 1 | 18 | 1.242 秒 | 0.847 ms | 12.410 ms | 0.701 秒 | 2.432 秒 |
| 默认 2 | 18 | 1.125 秒 | 0.817 ms | 5.274 ms | 0.688 秒 | 2.309 秒 |
| 默认 3 | 18 | 1.132 秒 | 0.800 ms | 4.424 ms | 0.692 秒 | 2.405 秒 |
| 限制 8 线程 1 | 8 | 1.141 秒 | 0.575 ms | 2.456 ms | 0.732 秒 | 2.327 秒 |
| 限制 8 线程 2 | 8 | 1.224 秒 | 0.598 ms | 2.874 ms | 0.742 秒 | 2.341 秒 |

默认三次预缓存跨度平均 1.166 秒；8 线程两次平均 1.182 秒。本次实验中增加到 18 线程没有明显缩短整体跨度，不能把 Web 的主要差距归因于预缓存线程数。

以下补测表的 API 指标只包含 `PSOPrecompilePool` 线程，排除了运行时其他线程的补建；前表 API 指标覆盖全部创建线程。

| 补测 | 预缓存任务数 | 预缓存跨度 | 预缓存线程实际创建 API 次数 | API 中位数 | API P95 |
|---|---:|---:|---:|---:|---:|
| 2 线程，第 1 轮 | 5039 | 5.246 秒 | 4981 | 0.765 ms | 3.267 ms |
| 2 线程，第 2 轮 | 5039 | 4.516 秒 | 4988 | 0.587 ms | 2.347 ms |
| 1 线程，第 1 轮 | 5039 | 7.940 秒 | 4968 | 0.516 ms | 1.762 ms |
| 1 线程，第 2 轮 | 5039 | 7.813 秒 | 4970 | 0.516 ms | 1.769 ms |

2 线程跨度平均 4.881 秒；1 线程平均 7.877 秒。2 线程不是严格快一倍，线程争用、调度、运行时 PSO 补建和较慢个例都会影响结果。1 线程两轮 API 累计时间为 7.787 / 7.656 秒，已接近预缓存整批跨度；此时不是单纯等待资源才使整批拉长。

默认 / 8 线程每轮直接捕获了 **5146 次 D3D12 `CreatePipelineState`**，1 / 2 线程全体线程共为 5119–5126 次：这是引擎源码中紧贴 `Device->CreatePipelineState` 的 `Create time` scope，覆盖预缓存及随后运行时创建，不含单纯从 UE RHI 对象缓存取回的调用。任务数和 API 次数不必相同：RHI 内部描述符去重及运行时创建与预缓存的先后顺序会影响实际调用数。因此分别记录固定的 5039 个自动预缓存任务、预缓存池 API 次数、其他线程 API 次数。这些 API 时长包含驱动执行和线程被抢占的等待，不是纯 CPU 指令执行时间，也没有逐条缓存命中标记。

| 当前 Web 对照 | 请求数 | 并发 | 时间 |
|---|---:|---:|---:|
| 用户正常页面 PSO 阶段 | 当前包预热 1108 请求 | 默认 8 | 约 6 秒 |
| 保留缓存、独立重放 1 | 1108 | 8 | 6.403 秒 |
| 保留缓存、独立重放 2 | 1108 | 8 | 6.507 秒 |
| 保留缓存、独立重放 1 | 1108 | 2 | 17.915 秒 |
| 保留缓存、独立重放 2 | 1108 | 2 | 18.267 秒 |
| 新补测，独立重放 1 | 1108 | 1 | 34.941 秒 |
| 新补测，独立重放 2 | 1108 | 1 | 34.020 秒 |

Web 独立重放的第一轮单请求中位数为 18.605 ms，P95 166.715 ms，最大 833.845 ms。它计时到 WebGPU async Promise 完成，包含浏览器排队、验证、翻译和驱动工作；不能与原生 `CreatePipelineState` scope 视为相同边界。8 个已知工作组尺寸不合法的 compute 请求仍包含在 Web 1108 次请求中，与此前报告一致。

Web 1 并发两轮的单请求中位数分别为 12.770 / 13.205 ms，平均单请求约 31.533 / 30.702 ms。1 / 2 / 8 并发下 Web 都有明显额外成本；继续增加并发只能遮蔽部分墙钟时间，不能说明缓存重建路径已经高效。

### Web 管线对象保留对照

补测发现旧的独立重放工具没有持有成功创建的 `GPUPipeline` 引用，长达约 35 秒的单并发测试中，同设备第二轮仍耗时 26.974 / 28.306 秒。增加 **仅限诊断工具** 的 `--retain-pipelines` 后，显式保留 1100 个成功对象：首次创建 34.189 秒，同一设备第二轮 0.072 秒，请求数和已知失败项不变。

这个对照说明对象生命周期会影响同设备的复用测试。旧报告中同设备毫秒级复用来自当时的较短批次，不能外推到不持有对象的长批次。未采集对象回收栈，因此不把具体回收机制认定为已定位。

当前 UE Web 运行时已经保留有界的预缓存 RHI 对象，本轮没有再修改运行时对象缓存。显式保留对象并没有缩短新的浏览器设备第一次重建的约 34 秒；跨进程重建成本仍需另外优化。用户正常页面的 6 秒预热阶段也不能用“同一设备已有对象”的 72 ms 替代。

## 缓存路径核对

安装引擎的 `WindowsD3D12PipelineState.cpp` 默认将 `D3D12.PSO.DiskCache` 和 `D3D12.PSO.DriverOptimizedDiskCache` 初始化为 0。本次实际日志也确认二者为 0。因此这些数字来自 **保留驱动缓存的重复启动**，没有启用旧的 D3D12 Pipeline Library 文件缓存。不能声称每次调用都被证实命中了驱动缓存；UE 本身没有提供此次逐条命中记录。

`PipelineStateCache.cpp::IsPSOPrecachingEnabled()` 在 `WITH_EDITOR` 下直接返回 false，所以不能用 `UnrealEditor.exe -game` 测自动预缓存。本轮专门生成了 cooked Development 游戏；日志确认 `r.PSOPrecaching=1`、全局 shader 预缓存=1、组件预缓存=1。

DX12 Cook 已提供本机平台的 shader bytecode，启动时调用原生管线创建；当前 Web 提供 WGSL，后续仍经过浏览器的验证、转换和原生管线创建。结合相同 8 并发仍存在的差距，后续调查应拆分 Web 的浏览器缓存读写、shader 转换、管线验证及驱动 API 耗时。当前结果尚不能证明其中哪一项占比最大，也不能证明某层缓存完全未命中。

## 加载阶段与异常边界

用户正常页面仍按其实际结果记录：校验 2 秒、打开关卡 18 秒、PSO 6 秒，共 26 秒。原生 `LoadMap` 约 0.7 秒，原生首个游戏 Tick 约 2.3–2.4 秒。Web 页面“启动关卡”阶段还包含引擎和渲染管线初始化，因此不能把 Web 的 18 秒直接除以原生 `LoadMap` 的 0.7 秒宣称纯资源加载慢了多少倍。当前结果也不能直接推出缩短 PSO 后总启动时间会等量缩短，因为它与加载可能重叠。

原生允许游戏 Tick 与后台预缓存重叠，例如 1 线程时约 2.2 秒开始 Tick，预缓存到 trace 约 9.1 秒才全部结束。当前 Web 页面会等待整批预热完成后再隐藏加载画面。因此预缓存跨度不等于原生进入游戏前的额外等待；也不能把原生 Tick 起点当作全部 PSO 已就绪。

原生所有采集都在 CSV 完成、游戏关闭、日志关闭后返回 **777003**，该值在 UE 中命名为 `CrashReporterCrashed`。本轮尚未定位具体退出栈。重复启动的预缓存工作在退出前约十秒就已全部完成，trace 和 CSV 数量相互核对，所以保留启动计时，但 `cleanExit=false`；这不是原生稳定性通过。分析结果中的 `pass` 只表示启动采样与计数核验通过。

首轮预热的 CSV 截止时仍有 1679 项未完成，部分任务延续到退出阶段，因此不把它的 25.75 秒 scope 跨度作为有效的完整冷启动 PSO 结果，也不拿它计算冷热缓存倍数。

## 证据与复现

脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/web-platform/package-villa-native-pso.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/web-platform/capture-villa-native-pso.ps1 -Runs 4
node tests/web-platform/analyze-villa-native-pso.cjs villa-native-pso-v1 4

powershell -NoProfile -ExecutionPolicy Bypass -File tests/web-platform/capture-villa-native-pso.ps1 -Label villa-native-pso-c8-v1 -Runs 2 -WarmupRuns 0 -PrecompileThreads 8
node tests/web-platform/analyze-villa-native-pso.cjs villa-native-pso-c8-v1 2

# 1 / 2 并发补测；实际执行顺序为 2、1、1、2。
powershell -NoProfile -ExecutionPolicy Bypass -File tests/web-platform/capture-villa-native-pso.ps1 -Label villa-native-pso-c2-v1 -Runs 1 -WarmupRuns 0 -PrecompileThreads 2
powershell -NoProfile -ExecutionPolicy Bypass -File tests/web-platform/capture-villa-native-pso.ps1 -Label villa-native-pso-c1-v1 -Runs 2 -WarmupRuns 0 -PrecompileThreads 1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/web-platform/capture-villa-native-pso.ps1 -Label villa-native-pso-c2-v1 -StartRun 1 -Runs 2 -WarmupRuns 0 -PrecompileThreads 2
node tests/web-platform/analyze-villa-native-pso.cjs villa-native-pso-c2-v1 2
node tests/web-platform/analyze-villa-native-pso.cjs villa-native-pso-c1-v1 2

# 需配置 Playwright 的 NODE_PATH。
node tests/web-platform/probe-web-pso-replay.cjs --input=tests/web-platform/results/pso-v17-reload-timing-v2-inputs.json --tag=pso-v18-native-compare-c1 --concurrency=1 --browsers=2
node tests/web-platform/probe-web-pso-replay.cjs --input=tests/web-platform/results/pso-v17-reload-timing-v2-inputs.json --tag=pso-v18-native-compare-c1-retained --concurrency=1 --browsers=1 --retain-pipelines
```

捕获脚本拒绝覆盖已有标签。再次执行时需另选 Label，运行脚本通过 PackageLabel 指向已打包目录。

本地 `tests/web-platform/results/`：

- `villa-native-web-pso-comparison.json`：跨组汇总，校验各轮相同项目 Config SHA256、完成计数、队列清空及 Web 请求数。
- `villa-native-pso-v1-summary.json`、`villa-native-pso-c8-v1-summary.json`、`villa-native-pso-c2-v1-summary.json`、`villa-native-pso-c1-v1-summary.json`：启动、PSO、API 耗时与异常边界。
- 各 `*-runN.utrace`、`.events.csv`、`.api.csv`、`.statistics.csv`、`.csv`、`.png`、`.log`：原始证据。当前采集的直接 API scopes 另存 `.api.csv`，新脚本已将其合并进 `.events.csv`。
- 各 `*-launch.json`、`*-complete.json`、`*-environment.json`：参数、配置 SHA256、进程退出码与环境快照。
- `villa-native-pso-v1-package-complete.json`：打包成功且项目 Config 哈希未变。
- `pso-v18-concurrency-2-c8.json`、`pso-v18-concurrency-5-c8.json`：此前 Web 保留缓存独立重放。详见 `UE58_WEB_PSO_CONCURRENCY.md`。
- `pso-v18-native-compare-c1.json`、`pso-v18-native-compare-c1-retained.json`：新增 Web 单并发和对象保留对照。

原生可执行文件 SHA256：`7102179a80df8b24fc17a305b066860c3b2d5d62c54da71184dd94d699c1aba9`。

另保存此前网页启动分阶段对照脚本 `benchmark-web-startup-pso.cjs`。其 `pso-v18-startup-on-off-abba.json` 报告通过；该工具使用独立浏览器 profile 和自动化运行条件，只用于自身组内对照，不替代用户普通浏览器实测的 26 秒。
