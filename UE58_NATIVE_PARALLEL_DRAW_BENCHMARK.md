# TriplexHouseVilla 桌面并行绘制实测（2026-11-02）

使用用户指定的 **D:/UE_5.8**，默认出生视角约 **155 FPS**。单独关闭 RHI 并行翻译后为 **143.67 FPS**，开启收益 **7.84%**。本次覆盖的绘制录制、Mesh 准备及 RHI 翻译一起关闭后仍有 **144.94 FPS**。这些并行路径有贡献，本轮没有支持“缺少它们就足以解释 Web 约 53 FPS”的判断。

## 环境与方法

- UE **5.8.1，CL 56057345**；项目 `G:/UE_HTML/TriplexHouseVilla/TriplexHouseVilla.uproject`，地图 `/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla`。
- i9-12900K（16 核 / 24 逻辑处理器）、RTX 4090、驱动 621.01；D3D12 / SM6。
- 安装版 `UnrealEditor.exe -game -RenderOffscreen` 独立运行游戏，不含编辑器视口绘制，也不是 Cook 后的 Shipping 包。
- 沿用项目渲染、光照、距离场和画质设置，只临时切换被测并行 CVar。项目 `Config/` 前后逐文件 SHA256 相同。
- 固定输出 **2289×1287**；原生 GPU Profile 确认内部 **1484×835**，默认 TSR（AA=4）。VSync=0，t.MaxFPS=0，动态分辨率模式=0，独立 RHI 线程模式=1。
- 同一进程预热 2400 帧，每项 **开 / 关 / 关 / 开**。每段稳定 240 帧、测量 1200 帧；每个状态 2400 帧，六项共 **28800 个测量帧**。FPS 按总帧数 / 总时间计算，没有剔除慢帧。
- 复用引擎 CSV Profiler 与 `csvExecCmds`，按捕获帧执行命令。验证全部窗口的相机位置和方向不变、命令按帧执行、结束恢复默认值。
- 正常测量使用 `-traceautostart=0` 阻止后台 Unreal Insights 自动录制。详细 `.utrace` 和 GPU Profile 另外采集。早期自动录制开启的预采集不用于下表。
- 保存了 126 次后台进程 / GPU 采样。未发现此前的 `cod.exe` 或 ShaderCompileWorker；ChatGPT、远程控制、Epic Launcher、Zen、任务管理器、搜索工具等仍有负载，结果包含普通桌面后台干扰。

## FPS 对照

每行是独立 ABBA 实验；开启收益为该行开启 FPS / 关闭 FPS − 1，多行收益不能相加。

| 被测路径 | 开启 FPS | 关闭 FPS | 开启收益 |
| --- | ---: | ---: | ---: |
| RHI 并行翻译 | **154.94** | **143.67** | **+7.84%** |
| 并行阴影绘制 | 155.44 | 158.10 | −1.68% |
| RHI 翻译与并行阴影一起 | 155.51 | 147.72 | +5.28% |
| 主通道 / 预通道 / 速度 / 半透明 / 阴影录制与 RDG 并行执行 | 147.76 | 147.59 | +0.12% |
| Mesh Draw Command 并行准备 | 155.05 | 151.72 | +2.20% |
| 上述绘制录制、Mesh 准备、RHI 翻译一起 | **155.01** | **144.94** | **+6.94%** |

上游录制组没有测出稳定的整帧收益，其两个开启窗口约 147.7–147.8 FPS，低于其他组的默认基线。阴影的约 1.7% 负收益和 Mesh 准备的约 2.2% 正收益较小，包含后台与调度噪声。本轮没有以这些小差异决定 Web 功能开关。

RHI 单项四段为 **156.14 / 143.80 / 143.54 / 153.76 FPS**，两次关闭均下降。联合关闭组为 **155.85 / 143.97 / 145.93 / 154.17 FPS**。各测量窗口没有超过 33.33 ms 的帧。

## Game / Draw / RHIT / GPU

以下来自单独测试 RHI 翻译的两个状态，单位 ms/帧：

| 状态 | 整帧 | Game | Draw（RenderThread） | RHIT | GPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| 并行翻译开 | **6.454** | 1.899 | **6.453** | **1.857** | 4.570 |
| 并行翻译关 | **6.960** | 1.661 | **6.959** | **4.851** | 3.668 |

关闭后 RHIT 增加约 **2.99 ms**，整帧增加约 **0.51 ms**。多个阶段重叠，Draw 仍限制整帧。RHIT 不包含工作线程上的全部翻译时间，不能将 1.86 ms 当成所有 RHI 命令的总 CPU 成本。关闭后 GPU 读数下降也不能直接解释为 GPU 算法变快。

默认状态 RenderThread 的 CSV 独占分类中，等待阴影任务约 **1.32 ms**、等待可见性任务约 **1.13 ms**，RenderLighting 约 **0.87 ms**，RenderShadows 自身约 **0.41 ms**。等待项反映依赖与调度，不能直接算成可移除的浪费。总 Draw Calls 在各状态均约 **2523.6/帧**。并行时各 pass 分类计数会变化，本轮只用总 Draw Calls 核对绘制量。

## `.utrace` 确认实际执行

复用 `Trace.File`、CPU / GPU / Task / RHICommands 通道和原生 Unreal Insights 无界面导出。两个文件开启 named events，仅用于确认执行位置。UE 会带入开始录制前的 trace tail，分析只取各文件最后 **160 个完整 GameThread 帧**，排除尾缓存混入另一个状态。

- 开启：`RHI_Translate` 出现在 **25 条线程**（RHIThread 和工作线程），最多 **21 个区间重叠**。
- 关闭：全部在 **1 条 RHIThread**，最大并发 **1**。

这次开关确实改变了原生命令翻译的执行位置。轨迹中工作线程的区间总和包含调度与抢占，不能当作整帧关键路径或纯 CPU 执行时间。

本次上游组使用 `r.ParallelBasePass`、`r.ParallelPrePass`、`r.ParallelVelocity`、`r.ParallelTranslucency`、`r.ParallelShadows`、`r.RDG.ParallelExecute`；RDG 开启保留默认 **2（异步任务）**。Mesh 准备使用 `r.MeshDrawCommands.ParallelPassSetup`，翻译使用 `r.RHICmd.ParallelTranslate.Enable`。

`r.ParallelShadowsNonWholeScene` 保留默认 **0**，阴影单项主要测试方向光全场景阴影的并行绘制。可见性、阴影初始化等其他任务并行仍存在，联合关闭行不代表整个引擎单线程。

## 对 Web 的意义

本次内部 / 输出尺寸与上一轮 Web 测试一致。桌面使用 SM6 + TSR，Web 为 SM5 + TAA，绘制数量和后端路径也不同，还不能据此给出严格相同绘制负载的平台倍率。

原生关闭被测并行路径后仍约 145 FPS，单线程 RHI 翻译约 4.85 ms；现有 Web 测试约 52.77 FPS、RHI 工作约 14.29 ms。Web 串行路径的绑定准备、Wasm / JS 编码、重复提交及阴影兼容路径，仍应继续定量拆分。原生约 8% 的整帧收益不能作为 Web 并行重构的收益上限，也不能用来预告 Web 帧率。

## 复现与证据

```powershell
./tests/web-platform/capture-villa-native-parallel.ps1 -Suite all -Label native-villa-new -SettleFrames 240 -MeasureFrames 1200
python tests/web-platform/analyze-villa-native-parallel.py tests/web-platform/results/native-villa-new

./tests/web-platform/capture-villa-native-trace.ps1 -Label native-villa-trace-new
./tests/web-platform/export-web-ue-trace.ps1 -Backend native -Trace tests/web-platform/results/native-villa-trace-new-on.utrace
./tests/web-platform/export-web-ue-trace.ps1 -Backend native -Trace tests/web-platform/results/native-villa-trace-new-off.utrace
node tests/web-platform/analyze-villa-native-trace.cjs tests/web-platform/results/native-villa-trace-new
```

标签需要未被使用；引擎与项目路径支持参数覆盖。

- 正式测量：[analysis.json](tests/web-platform/results/native-villa-20261102-final-analysis.json)、[CSV](tests/web-platform/results/native-villa-20261102-final.csv)、[运行日志](tests/web-platform/results/native-villa-20261102-final.log)、[画面](tests/web-platform/results/native-villa-20261102-final.png)。
- 线程证据：[thread-analysis.json](tests/web-platform/results/native-villa-20261102-trace-thread-analysis.json)、[开启 .utrace](tests/web-platform/results/native-villa-20261102-trace-on.utrace)、[关闭 .utrace](tests/web-platform/results/native-villa-20261102-trace-off.utrace)、[GPU Profile 日志](tests/web-platform/results/native-villa-20261102-trace.log)。
- 原始大文件位于本地忽略的 `tests/web-platform/results/`；复现脚本与本文进入 Git。
