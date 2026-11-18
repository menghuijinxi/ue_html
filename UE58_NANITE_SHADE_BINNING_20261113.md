# Nanite 全局着色分组与两轮 HZB 代价定位

日期：2026-11-13。引擎提交见 `UnrealEngine-1`（“按着色掩码一次生成全部 Web Nanite 材质瓦片列表”），运行时包 `nanite-shadebin-{default,villa,regression}-20261113`。本轮是 `UE58_NANITE_NEXT_STEPS_20261113.md` 计划的第 3 项，上一轮见 `UE58_NANITE_PROGRAMMABLE_MERGE_20261113.md`。

## 实现

此前每个材质组（Villa 每帧 81–154 个）各自准备瓦片：5 个缓冲、2–3 次上传、逐成员 `copyBufferToBuffer`、一次清零、一次瓦片 dispatch、一个 uniform 缓冲，像素着色器再用逐成员循环判断像素归属。原生 Nanite 的做法是对着色掩码做一次 Count / Reserve / Scatter，为所有着色 bin 一次生成瓦片列表。

本轮按原生结构实现：

- `FWebNaniteShadeBinTilesCS`（Count 与 Scatter 两个排列）和 `FWebNaniteShadeBinReserveCS` 对合成阶段已经写好的着色掩码做三次 dispatch，输出所有 bin 共用的一份瓦片列表和一份间接参数缓冲。
- 每个 GBuffer 布局组一个光栅通道，逐 bin `DrawPrimitiveIndirect(Arguments, Bin * 16)`；顶点着色器 `MainBinVS` 把 bin 编号放在 `ViewIndex` 高 16 位传给像素着色器。Nanite 着色像素着色器的首个输入是 `FNaniteFullscreenVSToPS`，级间位置为 0/1，与瓦片顶点着色器一致。
- 像素着色器的归属判断 `WebNaniteMaterialOwnsPixel` 在分组路径下变为一次着色掩码读取（深度相等判断两条路径都保留），旧路径的逐成员循环保留给未重新烘焙的着色器。
- 逐着色器检测：只有绑定了 `WebNaniteShadeBin` uniform 的像素着色器走新路径，其余继续走旧的逐组路径，同一帧内可以混用。
- 开关 `r.Nanite.WebShadeBinning`（默认 1），0 回到旧路径。

## 过程中的失败

- 编译失败一次：`TShaderMapRef<FWebNaniteShadeBinTilesCS>(Map)` 缺排列向量，补 `FPermutationDomain()` 后通过。
- 磁盘写满（G: 剩余 0）：本会话的测试产生了 45 个浏览器 profile，每个约 3.4 GB。只删除本会话创建的 profile（145.55 GiB，清单 `results/nanite-shade-binning-20261113/cleanup-profiles-1.json`），之后每个批次结束都清理。因写满而失败的回归夹具 Cook 已重跑。
- 回归夹具必须重新 Cook：运行时参数结构变化后旧着色器会先触发布局校验断言，不会安全回退。
- 路线全程的 GPU 时间戳第一次采集失败：50 秒窗口的逐通道记录超过单条消息上限（`gputime-too-long.log`），改为 `--gpu-summary` 在页面内聚合后重测。

## 正确性

全部使用冻结时钟和固定时序索引，同一运行时、同一 Cook 内切换开关。

| 项目 | 结果 |
|---|---|
| Villa 四视角 0→1→0（`nanite-shadebin-villa-correctness-20261113`） | 深度和全部材质通道逐像素一致；分组绘制 149 / 94 / 81 / 154，旧路径绘制 0；关闭时相反 |
| 默认场景 packed / scalar（`nanite-shadebin-default-{correctness,scalar}-20261113`） | 各 12 步、3 组对比通过 |
| 遮罩/PDO 52 项 × packed/scalar，分组开与关 | 208 项通过 |
| WPO 36 项 × packed/scalar，分组开与关 | 144 项通过 |
| 图元恢复 8 项 × packed/scalar | 通过 |
| 资格判定 13 项 | 通过 |

GPU 验证错误 0。路径观察器确认专项确实走了新路径：遮罩/PDO packed 整次运行累计分组材质绘制 40,375 次、着色分组 dispatch 77,415 次，关闭时两者为 0。

## 发给浏览器的命令量

`count-webgpu-calls.cjs`，Villa 首次室内路线，每帧平均。包装方法会拖慢帧率，这里只用次数。

| 每帧调用 | 旧路径 | 分组 | 分组 + 单轮 HZB | Nanite 关 |
|---|---:|---:|---:|---:|
| `copyBufferToBuffer` | 687 | 88 | 71 | 49 |
| `writeBuffer` | 336 | 89 | 72 | 51 |
| `clearBuffer` | 104 | 21 | 18 | 15 |
| `beginComputePass` | 117 | 36 | 28 | 21 |
| `dispatchWorkgroups` | 257 | 179 | 137 | 115 |
| `createBindGroup` | 39 | 23 | 18 | 14 |
| `drawIndirect` | 219 | 223 | 154 | 0 |
| 合计 | 7,474 | 6,064 | 5,604 | 6,403 |

分组后 Nanite 开启的调用总数已经低于关闭；剩余差距来自调用更重（计算通道、间接绘制、每帧多约 1 MB 的缓冲拷贝）。

## 性能

Edge / RTX 4090，有界面，2560×1440、DPR 1，正常时钟，首次 60 秒室内移动转向路线，无 profiler。

同包分组开关（`nanite-shadebin-motion-{abba,baab}-20261113`，Nanite 开启）：

| 分组 | 四轮 FPS | 四轮 1% low | RHI ms/帧 | 渲染线程 ms/帧 |
|---|---|---|---:|---:|
| 关 | 89.76 / 83.16 / 83.50 / 83.15 | 29.7 / 26.9 / 25.9 / 28.0 | 7.5–8.0 | 8.2–8.8 |
| 开 | 103.66 / 103.87 / 103.97 / 104.40 | 37.6 / 37.6 / 37.0 / 36.9 | 6.4 | 7.5 |

平均 FPS 提高约 22%，1% low 提高约 35%。这两组没有记录前台窗口（见下节），关闭的第一轮偏高可能与此有关，四轮都保留。

同包 Nanite 开关（`nanite-shadebin-onoff-{abba,baab}-20261113`）：开 104.72 / 100.42 / 104.48 / 104.25，关 124.13 / 122.91 / 123.44 / 123.19。开启平均 103.5，比关闭的 123.4 低约 16%（上一轮为 33%，本会话开始时为 36%）。

GPU 进程主线程（浏览器 trace，路线第 2–9 秒）：

| `HandleDawnCommands` 每帧 | Nanite 关 | Nanite 开 |
|---|---:|---:|
| 上一轮 | 5.63 ms | 9.94 ms |
| 本轮 | 5.78 ms | 7.27 ms |

窗口内超过 30 ms 的帧由 5 个降为 0。渲染线程里 `AddWebNativeMaterialPasses` 由 0.51 降到 0.06 ms/帧。

## 测量方法：前台窗口

同一配置的重复轮次出现过约 9% 的系统性偏差。原因不是测试内容：远程执行代理的窗口在每次下发命令时取得桌面前台，测试用的 Edge 窗口不在前台时整轮变慢（i9-12900K 混合架构的调度）。对照 `nanite-shadebin-onoff-env-20261113`：同为 Nanite 关闭，前台是 Edge 时 135.29 FPS，前台是代理窗口时 123.80 FPS。

之后的做法：`sample-test-environment.cjs` 在每轮前后记录前台进程、Edge 进程优先级和一次 CPU 校准；性能轮次作为单条阻塞命令运行，期间不下发其他命令；只比较前台状态相同的轮次。上面两张性能表属于“后台”状态，下面的 HZB 对照属于“前台”状态，两者不合并。

## 两轮 HZB 的代价

`r.Nanite.WebHZB=1`（默认）每帧做：主剔除 → 完整光栅 → 解析 → 深度导出 → 建 HZB → 最终剔除 → **再完整光栅一次** → 解析 → 深度导出 → 再建一次 HZB（每次 11 个 dispatch）。原生 Nanite 的后一轮只光栅前一轮被遮挡、现在重新可见的簇；Web 实现为了让记录表只有一份压实结果，把保留下来的簇又光栅了一遍。

前台状态、四条独立命令（`nanite-shadebin-fg-hzb{1,0}-{a,b}-20261113`）：

| `r.Nanite.WebHZB` | 两轮 FPS | 两轮 1% low | RHI ms/帧 | 渲染线程 ms/帧 |
|---|---|---|---:|---:|
| 1（两轮） | 114.34 / 115.17 | 39.6 / 41.1 | 5.94 | 6.82 |
| 0（单轮） | 124.02 / 123.21 | 47.6 / 43.8 | 5.38 | 6.08 |

单轮快约 7.7%，与 Nanite 关闭（135.29）的差距由 15% 缩到 8.6%。后台状态的同包对照结论相同（103–104 对 111–112）。

GPU 侧也不吃亏。路线第 5–55 秒逐通道时间戳（`nanite-shadebin-gputime-{hzb1,hzb0,off}-d-20261113`，带时间戳的帧率不作性能依据）：

| | 两轮 HZB | 单轮 | Nanite 关 |
|---|---:|---:|---:|
| GPU 通道时间均值 ms/帧 | 4.68 | 4.29 | 3.50 |
| P95 | 5.57 | 5.05 | 4.06 |
| `Nanite.Web.RasterExtent` 光栅通道 | 0.66 | 0.41 | — |

Villa 出生点：606 个候选实例，簇容量合计 16,947；层级选中 4,461 个簇（470,755 个三角形），HZB 之后可见 1,193 个簇（131,744 个三角形）。也就是说单轮多光栅了约 3.7 倍的簇，但光栅通道总时间仍比两轮少：这个规模下光栅时间主要是固定开销和屏幕覆盖，不是簇数。

结论：验收场景的规模下，两轮 HZB 的固定命令开销大于它省下的光栅。按 Villa 的数据线性外推，GPU 时间的平衡点在层级选中约 4 万个簇附近，帧率的平衡点更高。下一轮把默认改为自动策略，簇容量小的视图走单轮，并保留强制两轮的测试。

## RDG 校验

`r.RDG.Validation` 在非 Shipping 构建默认开启。同包对照（`nanite-shadebin-rdgvalidation-abba-20261113`，Nanite 开启）：开 103.10 / 104.27，关 106.75 / 106.94；渲染线程 7.47 → 6.11 ms/帧。约 +3% FPS。这是全局配置，同时影响 Nanite 开与关两侧，本轮没有改默认值。

## 渲染线程还剩什么

静态出生点视角下渲染线程接近满载（空闲等待 5%，Nanite 关闭时 26%）。`analyze-render-cpu-tree.cjs` 对采样结果做调用树，Nanite 开启每帧多约 2.4 ms，可归因的部分：

| 渲染线程每帧 | ms |
|---|---:|
| `AddWebResidentSceneDepthPasses`（两轮光栅准备） | 0.61 |
| `AddWebResidentSceneCullPasses`（每帧重建 606 个候选条目） | 0.34 |
| `UE::WebOcclusion::Usable`（遮挡历史对 256 条包围盒变更逐一检查） | 0.27 |
| `AddWebNativeCompositionPasses`（含每帧重建材质绘制表 0.10） | 0.18 |
| RDG 执行阶段增量（含校验 0.11） | 0.52 |

## 后续

1. HZB 自动策略（单轮为小场景默认），连同已写好未构建的改动一起进入下一轮：遮挡历史变更区域合并、按管线排序绘制、候选条目就地构建并共享视图对象。
2. 实例数据持久化（原第 5 项）：每帧多出的约 1 MB 上传来自 CPU 逐实例预乘的视图矩阵和裁剪面，改为只上传不变的实例数据、由着色器合成，需要改着色器并重新 Cook。
3. 两轮模式下只光栅重新可见的簇（原生做法），只对大场景有意义。

## 证据与复测

结果目录位于 `tests/web-platform/results/`：`nanite-shade-binning-20261113`（批处理脚本与日志）、`nanite-shadebin-*`（回归、性能、trace、GPU 时间）、`webgpu-calls-shadebin-*.json`、`render-cpu-nanite-shadebin-*`。

```powershell
node probe-nanite-hierarchy-batch.cjs --folder=<包> --tag=<新名称> --shade-binning --villa
node probe-nanite-off-regression.cjs --tour --headed --width=2560 --height=1440 --seconds=60 --modes=candidate,candidate,candidate,candidate --shade-binnings=0,1,1,0 --folder=<包> --tag=<新名称>
node probe-nanite-off-regression.cjs --tour --headed --width=2560 --height=1440 --seconds=60 --modes=candidate --cvar=r.Nanite.WebHZB --cvar-values=0 --folder=<包> --tag=<新名称>
node count-webgpu-calls.cjs --folder=<包> --nanite=1 --headed --tag=<新名称>
node analyze-render-cpu-tree.cjs <render-cpu 标签> 110
```

测试入口（本地服务运行时）：

- Villa：`http://127.0.0.1:8765/build/nanite-shadebin-villa-20261113/index.html`
- 默认场景：`http://127.0.0.1:8765/build/nanite-shadebin-default-20261113/index.html`

未完成边界：Nanite 开启的完整性能验收仍未通过（`naniteFullPerformanceAccepted=false`）；本轮未推送。
