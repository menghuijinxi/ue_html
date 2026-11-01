# WebGPU 并行绘制命令录制

本轮复用 UE 的 `FParallelMeshDrawCommandPass` / `FDrawVisibleMeshCommandsAnyThreadTask`，让任务线程录制独立的 `FRHICommandList`。任务录制成功，但本关卡四轮对照 **52.85 → 51.83 FPS（−1.94%）**，未获得帧率收益，因此最终保留为默认关闭的实验入口。

最终显式启用页面：[并行录制实验包](http://127.0.0.1:8765/build/villa-parallel-recording-opt-in/index.html)。原始四轮测试使用 `villa-parallel-recording-candidate` 对照上轮资源表版本 `villa-resource-tables-candidate`，保留这两个目录及原始 WASM，便于核对测试产物 SHA。

引擎配套提交：`f0b5629ed`（真实绘制任务线程记录）；行为入口、打包和验证工具由外围仓库保存。

## 接入范围与线程约束

Web 的线程版运行时支持独立 Game、Render、RHI 线程，但原先 `GSupportsParallelRenderingTasksWithSeparateRHIThread=false` 使 UE 的 `UseParallelAlgorithms()` 返回 false，关闭了多个 mesh pass 的并行命令录制入口。最终仅在线程版且有 `-WebParallelDrawRecording` 启动参数时开启这项能力。打包选项 `--parallel-recording` 写入该参数，普通打包继续使用原路径，项目设置不变。

- shader 创建能力仍为 false。UE 的 `FMeshDrawCommandInitResourcesTask` 会先在 RenderThread_Local 初始化 shader，作为绘制任务的前置依赖，沿用引擎已有的安全路径。
- shader、PSO 等 WebGPU 对象创建仍经现有 owner 代理执行；PSO 异步创建、资源多线程能力均未扩大。
- `GRHISupportsParallelRHIExecute=false` 保持串行翻译与提交顺序。任务只录制 CPU 命令，未并发调用当前唯一的可变 RHI context 或 encoder。
- RDG 通用并行 setup/execute 仍受多线程 shader 创建能力限制。这次验证的是 mesh pass 的分任务命令录制，尚未接入 RDG 全面并行或多个 RHI context。

相关源码：[Web 能力配置](G:/UE_HTML/ue_html/tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp)、[UE mesh draw 任务及 shader 前置任务](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/Renderer/Private/MeshDrawCommands.cpp)、[UE RHI 命令执行器](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/RHI/Private/RHICommandList.cpp)、[RDG dispatch pass 命令列表](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/RenderCore/Private/RenderGraphPass.cpp)。

## 实际执行证据

在引擎真实绘制任务中，每个物理线程仅首次输出一次执行记录；没有逐 draw 日志。最终候选的首次记录为线程 **3、4、5**，都不是 Game=2、Render=14、RHI=1。任务分成 3 份，该组首次记录的绘制范围分别是 128、128、126 项。此记录证明任务分配和执行位置，不代表三份任务在每个时刻均同时占用 CPU。

运行诊断发布 `parallelCommandRecording=true`、`parallelRHITranslation=false`。行走探针新增 `--require-parallel-recording`，要求至少两个物理任务线程实际录制非空的多任务绘制范围，同时验证命令录制能力及串行翻译约束。CPU 性能图另外检查这些任务线程的采样栈。

项目画质设置及 Cook 数据继续沿用现有版本；对照要求 `content.bin` 和 `config-files.json` SHA 完全相同。

## 验证结果

线程版 UBT 编译/链接及 WASM 结构校验通过。最终包完成 60 秒行走及转向，从第 4 帧到第 2830 帧，移动约 154cm、转向约 36°；GPUScene、资源表及三个独立主线程检查通过，未捕获运行错误。任务录制检查确认上述三个物理任务线程均实际执行了非空范围。

记录：[构建审计](G:/UE_HTML/ue_html/tests/web-platform/results/parallel-recording-v2-build.json)、[60 秒行走](G:/UE_HTML/ue_html/tests/web-platform/results/project-gameplay-parallel-recording-v2.json)。

原始实验包另一次开启绑定一致性校验，完成 45 秒、第 3 到 1426 帧的行走，累计校验 **39,059,861** 个条目，无来源解析或 prepared descriptor 不一致，未捕获运行错误。记录：[绑定校验行走](G:/UE_HTML/ue_html/tests/web-platform/results/project-gameplay-parallel-recording-validation-v2.json)。

### 同场景帧率

依次旧、新、新、旧，每轮预热 20 秒、测量约 15 秒。固定出生视角、viewport=1863×1030、DPR=1.25，实际渲染 1484×835、输出 2289×1287、AA=2。内容包和配置文件 SHA 相同，不接收外部输入。测量前后未发现后台游戏或引擎编译进程；环境快照不是全程监控。

| 轮次 | FPS | RHI 工作 ms/帧 |
| --- | ---: | ---: |
| 旧 1 | 52.278 | 14.415 |
| 新 1 | 51.652 | 14.636 |
| 新 2 | 52.003 | 14.544 |
| 旧 2 | 53.431 | 14.052 |
| 旧合并 | **52.853** | **14.232** |
| 新合并 | **51.828** | **14.590** |

FPS 合并后 **−1.94%**，RHI 工作时间约 **+2.51%**。只有四轮，旧包两轮之间也有约 2.2% 的帧率波动，不能声称已确定稳定的退化幅度，但本组没有证据支持默认开启它。帧率来自未开启 CPU 采样、API 计数/计时、绑定校验的阶段；诊断钩子仍安装。

纹理流送存在运行波动，例如第一轮旧包记录 5762 mips / 497680464 bytes，第一轮新包 5729 mips / 482738256 bytes；内容与配置完全相同，未单独控制流送完成时间，不能把小幅差值全部归因于录制方式。

原始记录：[四轮对照](G:/UE_HTML/ue_html/tests/web-platform/results/parallel-recording-v2-abba.json)、[测量前环境](G:/UE_HTML/ue_html/tests/web-platform/results/parallel-recording-v2-environment-before.json)、[测量后环境](G:/UE_HTML/ue_html/tests/web-platform/results/parallel-recording-v2-environment-after.json)。

### CPU 与 API 图

新旧各单独录制 5 秒 CPU 采样、5 秒 API 计数及 3 个 GPU pass 时间戳帧。两次均完成，无运行错误。按 CPU 采样阶段实际 RHI 帧数归一化：

- 旧包 `SubmitDrawCommands` 栈采样集中在 Render 线程，约 **0.604 ms/帧**。
- 新包 Render 线程同类栈约 **0.176 ms/帧**，另有三个任务 worker 的 `FDrawVisibleMeshCommandsAnyThreadTask` 栈，合计约 **0.483 ms/帧**。RHI 线程没有这些录制任务。
- 这些是所选栈的统计采样，包含所选范围内的子调用；三个 worker 的合计不是关键路径时间，也不能与 RT/RHI 时间直接相加推算 FPS。

API 阶段的绘制工作仍接近：`setVertexBuffer` **7980.67 → 7990.01 次/帧**，`drawIndexed` **2994.41 → 2991.08 次/帧**。但 render pass 从 **276.55 增至 286.42 次/帧**，`setPipeline` 从 **648.77 增至 658.35 次/帧**，`setBindGroup` 从 **1400.29 增至 1412.35 次/帧**。其中 WholeSceneShadowmap pass 约 **4 → 10 次/帧**，SceneColor 约 **66 → 68 次/帧**。

这是当前后端使用普通 render pass 执行分拆命令列表的代价。GPUScene、RHI 编码及大量顶点流绑定没有因录制并行而消失；本组 ABBA 的 RHI 时间也未下降。因此后续应调查减少这些提交或安全合并 pass 的方式，再判断是否值得默认开启，而不是继续增加任务数量。

性能图：[旧包](G:/UE_HTML/ue_html/tests/web-platform/results/performance-capture-parallel-recording-v2-baseline-profile.html)、[并行录制包](G:/UE_HTML/ue_html/tests/web-platform/results/performance-capture-parallel-recording-v2-candidate-profile.html)、[CPU/API 汇总](G:/UE_HTML/ue_html/tests/web-platform/results/parallel-recording-v2-profile-comparison.json)。RHI 图仍可见绑定组整理和顶点缓冲提交等工作；采样归属及内联会影响单个函数的 self 数字。

### 画面

四轮截图人工核对未见明显画面回归；旧新 RGB 平均绝对差约 **0.663/255**，旧旧约 **0.919/255**，新新约 **0.693/255**，处于重复录制波动范围。这不证明全场景像素完全正确。见 [旧左新右截图](G:/UE_HTML/ue_html/tests/web-platform/results/parallel-recording-v2-scene-pair.png)、[差异记录](G:/UE_HTML/ue_html/tests/web-platform/results/parallel-recording-v2-scene-comparison.json)。

### 最终默认行为

上述对照针对最初的启用实验产物。随后将启动入口改为显式参数，录制与 RHI 执行逻辑不变；最终默认关闭版和显式开启版使用同一个新 WASM，内容及配置 SHA 与原始对照相同。最终两种入口的线程版编译/链接、WASM 校验及打包均通过。

- 默认包完成 10 秒行走至第 416 帧，运行期 `parallelCommandRecording=false`，无绘制任务线程执行记录，无运行错误。
- 显式开启包完成 20 秒行走至第 624 帧，三个任务线程执行检查通过，`parallelCommandRecording=true`、`parallelRHITranslation=false`。开启绑定一致性检查累计校验 **15,344,005** 个条目，无错误。

入口复核期间，v3 检查曾发现启动桥接重建命令行时丢失实验参数；已补充转发，最终以 v4 两组检查为准。v3 没有进入帧率对照，也未被列为通过项。短功能验证的帧率不混入上述 ABBA。

记录：[最终默认包](G:/UE_HTML/ue_html/tests/web-platform/results/project-gameplay-parallel-recording-default-v4.json)、[最终实验包](G:/UE_HTML/ue_html/tests/web-platform/results/project-gameplay-parallel-recording-opt-in-v4.json)、[最终构建](G:/UE_HTML/ue_html/tests/web-platform/results/parallel-recording-final-build.json)、[完整验证汇总](G:/UE_HTML/ue_html/tests/web-platform/results/parallel-recording-validation-summary.json)。

## 复现

```powershell
& tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -MaxParallelActions 4 -StandaloneCompiles
node tests/web-platform/package-web-project.cjs --project=triplex-project --desktop --threads --distance-fields --reuse-cook --parallel-recording --output-folder=villa-parallel-recording-opt-in

$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-project-gameplay.cjs --folder=villa-parallel-recording-opt-in --tag=parallel-recording-opt-in --runs=1 --seconds=60 --dpr=1.25 --require-render-threads --require-gpuscene --require-resource-tables --require-parallel-recording
node tests/web-platform/compare-web-rhi-adaptation.cjs --baseline=villa-resource-tables-candidate --candidate=villa-parallel-recording-opt-in --tag=parallel-recording-new-run --headless --warmup-seconds=20
```

本地构建主机的 `MeshDrawCommands.cpp` 覆盖由 prepare 脚本管理，构建审计同时记录引擎来源及实际编译副本 SHA。仅修改工作区及独立引擎仓库，不修改安装引擎。
