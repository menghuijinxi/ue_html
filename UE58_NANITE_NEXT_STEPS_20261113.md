# Nanite 开启性能：线程测量与原生实现对照

2026-11-13，引擎 `d22111374`，包 `nanite-fixed-final-villa-20261113`。本轮只做测量和源码对照，未修改运行时；仅给 `profile-web-render-cpu.cjs` 增加了启动前 `--nanite=0/1` 选项。完整开启性能仍未验收。

## 一、测量结果

### 1. 渲染线程与 RHI 线程（新测）

Edge 无界面，1280×720，Villa 室内固定视角（-175,-80,160 / -5 / 50），正常时钟，同一个包只在启动前切换 `r.Nanite`。渲染线程采样 12 秒、间隔 500 µs；采样期间 FPS 与未采样基线接近（开 92.3/88.4，关 135.5/132.8）。

| 每帧 | Nanite 关 | Nanite 开 | 增量 |
|---|---:|---:|---:|
| 帧周期 | 7.38 ms | 10.83 ms | +3.45 |
| 渲染线程忙 | 4.94 ms | 8.35 ms | +3.41 |
| 渲染线程等待 | 2.40 ms | 2.40 ms | 0 |
| RHI 线程工作 | 5.00 ms | 8.08 ms | +3.08 |

**帧周期 ≈ 渲染线程忙时 + 约 2.4 ms 固定等待。** 之前只跟踪 RHI 时间，渲染线程同样多出约 3.4 ms，且是直接决定周期的一方。两个线程必须一起降。

渲染线程增量的去向（包含时间，互有嵌套，不能相加）：

| 项目 | 开启 ms/帧 |
|---|---:|
| `FRDGBuilder::Execute`（pass lambda 设参数、发命令） | 2.36（关 1.30） |
| `AddWebResidentSceneDepthPasses`（含下两项） | 0.66 |
| 其中 `AddWebResidentRasterPasses` | 0.53 |
| 其中 `AddWebProgrammableRasterPasses` | 0.39 |
| `AddWebNativeMaterialPasses`（含 `AddWebMaterialBinPass` 0.36） | 0.51 |
| `AddWebResidentSceneCullPasses` | 0.36 |
| `UE::WebOcclusion::Usable`（遮挡历史范围检查） | 0.27（关 0.004） |
| `AddWebNativeCompositionPasses` | 0.20 |
| RDG 校验 `FRDGUserValidation::*` | 0.75（关 0.33） |

构建是 Development 配置：RDG 校验、`RDG_EVENT_NAME` 字符串格式化（`FormatV`+`printf_core` 约 0.18 ms）、`FMallocPoisonProxy` 都在运行。这些成本与 pass 数量成正比，Nanite 开启后被放大。

### 2. RHI 提交计数（挖掘已有 `nanite-fixed-final-onoff-abba-20261113` 四轮移动数据）

| 每帧 | 关 | 开 | 增量 |
|---|---:|---:|---:|
| 普通 draw（非间接） | 876 | 563 | −313 |
| 间接 draw | 139 | 604 | +465 |
| dispatch | 124 | 265 | +141 |
| 新开计算 pass | 18 | 112 | +94 |
| 绑定项处理（binding plan entries） | 6,286 | 14,288 | +8,001 |
| 存储描述符重新校验 | 212 | 1,057 | +845 |
| 新建绑定组 | 10.5 | 33.7 | +23 |
| uniform 快照 | 586 | 1,185 | +599 |
| 新建管线 | 0 | 0 | 0 |

Nanite 省掉 313 次普通 draw，却增加 465 次间接 draw 和 141 次 dispatch，每次调用平均约 13 个绑定项，绑定处理量翻了一倍多。移动中没有新建管线。

### 3. 长帧

四轮移动数据逐帧拆分（帧间隔、该帧 RHI 工作、Game 帧耗时）：

| | 关 | 开 |
|---|---:|---:|
| >30 ms 的帧（每轮） | 2–4 | 30–31 |
| 这些帧的平均间隔 | 34–40 ms | 38–41 ms |
| 这些帧内 RHI 实际工作 | 约 6 ms | 11–13 ms |
| RHI 工作占间隔 70% 以上的帧 | 0 | 0–1 |

**长帧不是 RHI 线程造成的**：40 ms 的帧里 RHI 只工作约 11 ms。约一半长帧的 Game 帧耗时超过 8 ms，另一半 Game 只有 1.2 ms。最慢 1% 的帧有一半以上集中在路线最后 5 秒。剩余时间在渲染线程或 GPU 进程一侧，现有数据无法区分，这是下一步唯一还缺的测量：需要在长帧上记录渲染线程帧耗时（正常运行，不开采样器）。

## 二、与原生 Nanite 的结构差异

原生实现见 `Renderer/Private/Nanite/NaniteCullRaster.cpp`、`NaniteShading.cpp`、`NaniteShared.h`。

| 阶段 | 原生 | 当前 Web 实现 | 代价 |
|---|---|---|---|
| 实例来源 | GPUScene，`InstanceCull` 一次 dispatch 处理全部实例 | 渲染线程每帧遍历 2,062 个代理，逐实例算矩阵、裁剪面、拷贝材质数组（`NaniteWebScene.cpp:222`） | 渲染线程 0.36 ms，随实例数线性增长 |
| 层级/簇剔除 | 全场景一条持久队列：`NodeAndClusterCull`，输出一份全局可见簇表 | 每实例一个工作组、每 128 个实例一批，每批三个输出缓冲 | 多批 dispatch；每视图簇上限 65,536 |
| 光栅分组 | `RasterBinCount/Reserve/Scatter` 在 GPU 上把簇按**光栅 bin**（材质管线）分组；每个 bin 一次间接绘制 | 固定路径已合并；可编程路径按"实例×材质槽"逐个绘制，每次重设管线和全部材质参数（`NaniteWebProgrammableRaster.cpp:242`） | 间接 draw +465 的主要来源 |
| 光栅 bin 注册 | 加入场景时 `FNaniteRasterPipelines::Register` 去重并缓存，逐帧 CPU 成本与 bin 数成正比 | 每帧对每个实例的每个材质槽查 shader、判断是否可编程 | 渲染线程 |
| 可编程回退 | WPO 被禁用（组件关闭或超过距离）、像素可编程超过距离时，簇落到固定功能或简化 bin（`GetFallbackPipeline`，`NaniteShading.cpp:2627`） | 只要材质带 WPO 就走可编程（`NaniteWebRaster.cpp:442`），不看实例的 `EvaluateWPO` | 可编程 draw 偏多（待统计确认） |
| 着色分组 | `ShadingCount/Reserve/Scatter` 三次全屏 dispatch 为所有着色 bin 生成像素列表 | 每个材质组单独建 3 个缓冲、上传、逐成员 `CopyBuffer`、单独做瓦片分类（`NaniteWebGBuffer.cpp:192`） | 约 107 组 × 多个 pass；新开计算 pass +94 |
| 着色命令 | `BuildShadingCommands` 仅在材质集合变化时重建（`bBuildCommands`），绑定预先缓存 | `BuildWebNativeMaterialDraws` 每帧为每个实例的每个槽重新生成 `FMeshDrawShaderBindings` 再比对分组 | 渲染线程 |
| 公共参数 | 一个 `FNaniteRasterUniformParameters`，逐 bin 只换极少常量 | 逐 draw 的松散常量和多个存储缓冲视图 | 每帧 +8,000 绑定项 |
| 缓冲 | 可见簇、队列缓冲跨帧持久 | 每帧按批次大小创建 RDG 缓冲 | 每帧 +23 个新绑定组 |

结论：差距的根源是**逐帧 CPU 成本与实例数成正比，而原生与 bin 数成正比**。此前的批处理把 dispatch 数量压下去了，但每帧仍在渲染线程重建全部逐实例数据，并为每个批次、每个材质组声明新的 RDG 资源和 pass。

## 三、可以向原生靠拢的优化

按"收益明确程度 / 改动范围"排序。数字是本次测到的相关成本上限，不是收益预告。

1. **可编程光栅按光栅 bin 合并。** 对应原生 raster bin。注册时为每个可编程材质管线分配 bin 并缓存 shader 与材质绑定；每帧每个 bin 一次间接绘制，逐实例数据走结构化缓冲（固定合并已有同样机制）。影响：间接 draw +465、渲染线程 `AddWebProgrammableRasterPasses` 0.39 ms 及其 pass 执行、RHI 绑定项。
2. **补上原生的可编程回退规则。** WPO 未求值的实例进固定 bin；像素可编程距离外的实例按 `GetFallbackPipeline` 规则降级。先统计 Villa 中这类实例的数量再决定优先级。遮罩/PDO 在距离内必须保留。
3. **着色分组改成原生的全局 count/reserve/scatter。** 一组 dispatch 为所有材质组生成瓦片列表；成员状态直接按偏移读共享缓冲，去掉逐成员拷贝和逐组缓冲。影响：`AddWebNativeMaterialPasses` 0.51 ms、新开计算 pass +94、新建绑定组。
4. **材质/着色命令在注册时缓存。** 对应 `BuildShadingCommands` 的 `bBuildCommands`。已有 `WebMaterialRegistryRevision` 可作失效依据。
5. **实例数据持久化到 GPU。** 实例变换读 GPUScene，剔除输入（层级偏移、根页、包围盒）在注册时写入持久缓冲，每帧只上传可见实例索引。影响：`AddWebResidentSceneCullPasses` 0.36 ms，并为后续全局队列剔除打基础。
6. **Nanite 活动时的遮挡历史检查。** `UE::WebOcclusion::UnaffectedByBoundsChanges` 开启后每帧 0.27 ms（关闭 0.004）。原生没有这一项，它是为解除遮挡当帧恢复加的保护；可以改成空间索引或只检查本帧有变化的范围。
7. **跨帧持久的批次缓冲。** 按高水位保留层级/HZB/打包输出缓冲，避免每帧新缓冲导致绑定组重建。
8. **全局持久队列剔除。** 最终形态，去掉 128 实例/65,536 簇的限制。改动最大，建议在 1–5 完成后再评估。

与 Nanite 无关但被它放大的一项：**用 Shipping 或关闭 RDG 校验的配置出性能包。** RDG 校验加事件名格式化在开启时约 0.9 ms/帧渲染线程，关闭时约 0.5 ms。需要确认当前 Web 构建脚本是否支持 Shipping。

## 四、未确认与边界

- 渲染线程采样只覆盖一个静止室内视角和 1280×720；移动路线上的渲染线程分布未测。
- 长帧的归属（渲染线程还是 GPU 进程）未确定。
- 第 2 项的实例数量未统计。
- 所有测量在 RTX 4090 / Edge 上完成。
- Villa 是提交次数受限的室内场景，关闭 Nanite 时用回退网格；合理目标是接近持平，验收线待定。

## 证据

- 渲染线程采样：`tests/web-platform/results/render-cpu-nanite-on-research-20261113.{json,cpuprofile}`、`render-cpu-nanite-off-research-20261113.{json,cpuprofile}`
- RHI 计数与逐帧数据：`tests/web-platform/results/nanite-fixed-final-onoff-abba-20261113/report.json`（已有）

复测：

```powershell
node tests/web-platform/profile-web-render-cpu.cjs --folder=nanite-fixed-final-villa-20261113 --nanite=0 --tag=<新名称>
node tests/web-platform/profile-web-render-cpu.cjs --folder=nanite-fixed-final-villa-20261113 --nanite=1 --tag=<新名称>
```
