# 稀疏同步之后的优化空间

研究日期：2026-11-11。测试项目：`H:/TriplexHouseVilla`。

2026-11-12 进度：前三项已实现并分别验证，以下正文保留原始研究依据。
自适应采样已由用户验收，见 `UE58_WEB_VSM_ADAPTIVE_RELEASE.md`；
间接绘制复用降低 RHI CPU 工作约 6%～10%，见 `UE58_WEB_INDIRECT_DRAW_REUSE.md`；
页标记与镜像同步将转向页标记通道从约 0.448 ms 降至 0.066 ms，
自动镜像复制负载减少约 40%，平均 FPS 增加 1.35%～2.24%，见
`UE58_WEB_VSM_PAGE_MARKING_SYNC.md`。静止和移动 Low 提高，转向 Low 基本持平，尚未全面改善 Low。
第 4 项已新增 TSR 大分块及设备额度回退，Lumen 页表实验没有稳定收益，未合入。
用户反馈流畅度回退后，大分块已恢复默认关闭，32x32 只作为试验选项。
TSR 着色拒绝通道下降约 17%～25%，整体平均 FPS 小幅提升；
转动 Low 仍有约 2.3% 回落，不宣称全面改善 Low。
详见 `UE58_WEB_LUMEN_TSR_HOTSPOTS.md`。
当前流畅度对照页为 `http://127.0.0.1:8765/villa-smoothness-live.html`，
默认打开 16x16 回退包；复测与边界见 `UE58_WEB_SMOOTHNESS_REGRESSION.md`。
历史第三项 C 盘页面在外部清理后已失效，相关源码与报告保留。

以下为 2026-11-11 的原始研究记录：

建议下一步先做 **VSM 投影的自适应射线提前结束**，再研究 **间接绘制的绑定和命令复用**。
前者针对当前较大的 VSM GPU 通道，后者针对额外的 CPU 提交及 Low 帧风险。
本轮只增加诊断工具和证据，没有修改引擎、运行包、画质设置或安装引擎。
以下是候选方向，不是已实现的收益。

## 基线与测量边界

正式帧率继续使用 `UE58_WEB_VSM_LOW_COMPARISON.md` 的四轮配对测试：

| 阶段 | 无 VSM 平均 FPS | 有 VSM 平均 FPS | 无 VSM 1% Low | 有 VSM 1% Low |
| --- | ---: | ---: | ---: | ---: |
| 静止 | 51.23 | 43.85 | 35.49 | 36.03 |
| 转动 | 50.87 | 43.95 | 40.71 | 30.45 |
| 移动 | 51.51 | 43.71 | 41.59 | 35.70 |

平均帧率差约 14%～15%，转动 Low 差约 25%。本轮没有新的生产 FPS 结论。

本轮使用 `villa-shadow-on-20261111-sparse` 和 `villa-shadow-off-20261111-sparse`：

- 同一 Wasm、Cook 和宿主版本，各用匹配的实际管线预热记录。
- 输出 1920×1080，实际内部渲染 1400×788，TSR；Lumen GI、反射、VT 开启。
- 当前别墅实际 VT 资产数量为 0，不能据此测出真实 VT 流送的优化收益。
- Edge 157.0.4341.42，当前机器 RTX 3070；不沿用旧文档 RTX 4090 的结果。
- GPU 模式临时在内存中设 `r.WebGPU.ReuseComputePass=0`，分开计算通道以识别着色器。
  每种开关各采静止、转动各 6 帧，共 24 帧；时间戳呈 0.065536 ms 量化。
  小通道的 0 ms 不代表没有成本。拆通道改变同步和驱动开销，不能把结果换算为生产 FPS。
- CPU 模式保留正式包配置，分别启动单页采样转动阶段，每次 30 个 worker。
  栈为统计采样，包含等待，inclusive 分类彼此重叠，不能相加。
- 最终四次采集均通过配置、分辨率、帧推进和预热检查，预热 miss 为 0；
  没有页面/GPU 报错，GPU 两次另检查了 uncaptured validation errors 为 0。
- 中途一次连续 CPU 采样卡在第二次调试连接，一次浏览器恢复双页的 CPU 采样被排除。
  新工具改成单次 CPU 阶段、关闭恢复页，并断言线程只属于一个页面。
  最终 GPU 也重新按单页流程采集。未删除这些失败/排除记录。

汇总及原始数据哈希在
`tests/web-platform/evidence/vsm-remaining-costs-20261111.json`。
199 个计算着色器中，196 个匹配 Cook 元数据及归一化存储格式后的 WGSL。
两个稀疏同步入口通过资源签名和实际 WGSL 读写方向识别；通用 `main` 未强行归属。

## 按优先级排序

### 1. 恢复兼容 Web 的 SMRT 自适应采样

**证据：** `FVirtualShadowMapProjectionCS` 的局部光一次投影在静止/转动分别约
2.06/1.81 ms，方向光投影约 0.34/0.37 ms。转动时两者合计约 **2.18 ms**。
当前 WGSL 没有 subgroup 操作。

参考源码主动用 `COMPILER_WEBGPU` 条件排除了提前结束分支：

- `reference-engine/Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapProjectionSpot.ush:455`
- `reference-engine/Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapProjectionDirectional.ush:280`
- `reference-engine/Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapProjection.usf:621`

`r.Shadow.Virtual.SMRT.AdaptiveRayCount` 源码默认值为 1，但设置开关不能启用已经被编译掉的代码。
2026-11-06 的适配明确选择完整射线采样，原因是非一致子组控制流兼容性，
并非本轮遗漏配置。参见 `UE58_WEB_VIRTUAL_RESOURCES.md`。

**试验方向：** 为实际支持 subgroups 的设备编译局部能力分支，研究投票与活跃线程掩码，
在完全明亮/完全遮蔽区域恢复 UE 的提前结束逻辑；保留完整采样回退。
当前机器的 adapter 支持 subgroups，RHI 也已有请求该能力的路径。
已有 Nanite 专用转换器涉及 subgroup uniformity，可参考其验证方式，
但不能把那里的 active-lane 假设直接套到 VSM。

**边界：** 2.18 ms 是整个投影通道成本，不是可全部消除的成本。
不能只删除条件编译或全局关闭校验。需要检查点光跨立方体面、聚光灯、方向光、
半影、掠射角、动态遮挡，以及转动中的噪声/闪烁；不能用降低射线数冒充等画质优化。

### 2. 减少间接绘制重复绑定和提交

**证据：** 最终转动 GPU 捕获中，`WebGPU.UAVRasterExtent` 每帧约有
5878 次 `drawIndexedIndirect`、13654 次顶点绑定、4793 次索引绑定。
静止仍有约 6610 次间接绘制。这些是命令数，包含可能由 GPU 剔除为空的绘制，
不代表每条都实际产生阴影片元。该标签还包含一个少量直接绘制的 UAV pass。

独立 CPU 转动采样中，RHI 计数器约为 **10.13 ms/帧（开）对 7.12 ms/帧（关）**。
RHI 采样墙钟中，间接绘制栈占 20.4% 对 0.57%，`CreateGroups` 占 12.9% 对 9.0%；
两个分类有重叠。开启组 RHI 仍有约 54% idle，不能据此断言所有平均帧率都受 CPU 限制。
Game 线程约 95% idle，不支持优先优化游戏逻辑的判断。

**代码：** `WebGPUDynamicRHI.cpp` 的 `RHIDrawIndexedPrimitiveIndirect` 每次执行绑定。
现有 `DrawIndexedBundle` 仅覆盖直接绘制，而且查缓存前仍调用 `CreateGroups`；
key 包含资源句柄与动态 uniform 偏移，简单给间接绘制套同一缓存未必能跨帧命中。

**试验方向：** 先统计稳定命令块、动态偏移和 bind group 版本变化，再为可复用的
间接绘制批次记录 Render Bundle，或者减少同一批次的重复绑定准备。
当前浏览器实测存在 `GPURenderBundleEncoder.drawIndexedIndirect`，
不存在 `GPURenderPassEncoder.multiDrawIndexedIndirect`，不能依赖后一接口直接批量化。

**边界：** 不做 GPU 参数同步回读来判断空 draw，这可能引入更大停顿。
必须正确处理资源改写、页面失效、挥发缓冲换句柄、动态偏移、生命周期，以及 bundle
执行后的绑定状态重置。收益重点还包括提交抖动和较弱 CPU；不能把 3 ms RHI 差直接加到 GPU 收益上。

### 3. 页标记的共享头部读取与剩余镜像复制

2026-11-12 已用合并尺寸常量和连续计算通道的延迟回写完成局部优化。
仍保留必要纹理消费者的复制；尚未改为 buffer-only 表示。
实现、开关、回读、计时及发布记录见 `UE58_WEB_VSM_PAGE_MARKING_SYNC.md`。

**证据：** `FGeneratePageFlagsFromPixelsCS` 静止约 0.42 ms、转动约 **0.45 ms**。
实际 WGSL 仍多次执行：

```wgsl
atomicLoad(&(OutPageReceiverMasks.tint_symbol_3[2u]))
atomicLoad(&(OutPageReceiverMasks.tint_symbol_3[0u]))
atomicLoad(&(OutPageReceiverMasks.tint_symbol_3[1u]))
```

这些是共享的行跨度和尺寸，不是像素本身。生成代码来自
`WebGPUTextureAtomics.h` 的 `WebTextureAddress`。此前阴影深度的头部读取已经优化，
页标记这条路径尚未采用同样的处理。

**先试的局部改动：** 将这类不变尺寸由已有 uniform 或独立只读元数据提供，
保留坐标、层和 mip 的边界检查。该通道只有约 0.45 ms，应先验证实际竞争和收益，
不能照搬此前深度通道的巨大改善幅度。

正常 compute-pass 复用状态的已有捕获还显示以下有效复制负载：

| 静止时资源名 | 纹理到镜像次数/帧 | 镜像到纹理次数/帧 | 估算负载/帧 |
| --- | ---: | ---: | ---: |
| PageRequestFlags | 1 | 5 | 72.00 MiB |
| PageReceiverMasks | 8 | 9 | 24.75 MiB |
| PageFlags | 6 | 6 | 8.00 MiB |

合计约 105 MiB/帧。物理阴影池的整池复制已经消除，不能再算成每帧 1～2 GiB。
表中按 copy extent 估算有效字节，不是显存分配量；资源名可能发生别名复用。
目前没有隔离每次 copy 的 GPU 时间，不能把所有 pass 间隙都归因于复制。

**较大改动：** 为页表/标记建立 buffer-only 的一致读写表示，或基于真正的写入脏状态
减少同步。必须覆盖 SRV/UAV、mip、资源别名和阶段间可见性，不宜直接关闭复制。

### 4. 稀疏同步进一步细化，收益优先级较低

当前两个 `FWebSyncVirtualShadowPoolCS` 转动时分别约 **0.26 + 0.32 = 0.58 ms**。
代码已经跳过不满足条件的页，但仍派发全部物理页并保守处理两个层。

可以试验脏页列表压缩、间接 dispatch，以及根据各层实际写入分别同步。
这些都会增加列表管理或状态维护成本，净收益必须另测。
需要覆盖新分配页、静态/动态合并、强制缓存、缓存失效和重新引用。
只有约半毫秒的整个同步通道成本，当前不应先做复杂重构。

### 5. Lumen 与 TSR 是整体帧率的下一阶段

开启 VSM、转动时，以下独立计算通道合计：

| 通道 | GPU 诊断耗时 |
| --- | ---: |
| Lumen Radiosity Distance Field Tracing | 1.28 ms |
| Lumen Screen Probe Trace Voxels | 1.31 ms |
| Lumen Reflection Trace Voxels | 0.93 ms |
| TSR Reject Shading | 1.18 ms |
| TSR Update History | 0.92 ms |

前三项约 3.52 ms，后两项约 2.10 ms。这不是 Lumen/TSR 的全部成本，
关闭 VSM 时这些通道也存在，因此优化它们提高的是两种模式的整体性能。

可研究 WGSL 转换后的循环、冗余读取和访存，以及经局部精度验证后的 f16/subgroup 变体。
当前这些热点 WGSL 未使用 f16/subgroups，设备支持某个能力并不代表开启后一定更快。
减少探针、降低反射质量、改 AA 或降分辨率属于画质档位，不能混入保持现有效果的默认优化。

## 当前不优先做

- 再重复打开已有的绑定缓存、动态 globals 复用、绑定计划、compute-pass 复用：
  当前正式包已经使用这些优化，GPU 诊断临时关闭 compute-pass 复用只是为了归属计时。
- 把长期帧率归因于首次编译：当前配对基准和最终诊断均没有预热 miss。
- 把 `default-O0` 链接参数理解为全部 C++ 未优化：已有 LLVM 单元主要为 O2。
  之前 final-link O2 有视觉回归，参见 `UE58_WEB_BUILD_OPTIMIZATION_AUDIT.md`。
- 盲目调线程数或内存分配器：本轮主线程大量等待，RHI allocation 栈约 0.5%，证据不支持优先级。
- 为了帧率再次关闭 VSM、Lumen、VT，或更改实际渲染分辨率。

## 验证与复现

新增工具：

- `tests/web-platform/diagnostics/probe-vsm-remaining-costs.cjs`
- `tests/web-platform/diagnostics/summarize-vsm-remaining-costs.cjs`

探测器每次只启动一个浏览器，复用已有缓存目录；以下命令必须依次执行。
tag 目录必须不存在。CPU 默认为转动，`--phase=standing` 可独立采静止。
工具在内存中注入诊断代码，最后校验包清单哈希未变。

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/diagnostics/probe-vsm-remaining-costs.cjs --folder=villa-shadow-on-20261111-sparse --tag=vsm-costs-on-gpu-single-20261111 --kind=gpu
node tests/web-platform/diagnostics/probe-vsm-remaining-costs.cjs --folder=villa-shadow-off-20261111-sparse --tag=vsm-costs-off-gpu-single-20261111 --kind=gpu
node tests/web-platform/diagnostics/probe-vsm-remaining-costs.cjs --folder=villa-shadow-on-20261111-sparse --tag=vsm-costs-on-cpu-turn-single-20261111 --kind=cpu
node tests/web-platform/diagnostics/probe-vsm-remaining-costs.cjs --folder=villa-shadow-off-20261111-sparse --tag=vsm-costs-off-cpu-turn-single-20261111 --kind=cpu
node tests/web-platform/diagnostics/summarize-vsm-remaining-costs.cjs --on-gpu=vsm-costs-on-gpu-single-20261111 --off-gpu=vsm-costs-off-gpu-single-20261111 --on-cpu=vsm-costs-on-cpu-turn-single-20261111 --off-cpu=vsm-costs-off-cpu-turn-single-20261111 --shader-root=tests/web-platform/build/web-project-triplex-virtual-desktop-cook/20261110-140727 --shader-root=C:/ue-web-cook-sparse/web-project-triplex-virtual-desktop-cook/20261111-155909 --copies=tests/web-platform/results/vsm-motion-sparse-gpu-20261111/result.json --out=tests/web-platform/evidence/vsm-remaining-costs-20261111.json
```

后续每个候选应单独 A/B，先通过目标 shader/资源正确性测试和同视角视觉比较，
再走正式发布收尾流程，使用固定转动/移动路线做无 profiler 的 ABBA 平均帧率与 1% Low 测试。
最终还需自由操作、缓存失效和设备丢失回归；本轮无错误不等于历史偶发设备丢失已经修复。
