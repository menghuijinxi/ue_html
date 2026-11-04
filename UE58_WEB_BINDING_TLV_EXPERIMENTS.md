# WebGPU 绑定重建与 TLV 单变量实验

2026-11-04，接续 [mimalloc 后的优化定位](UE58_WEB_POST_MIMALLOC_OPPORTUNITIES.md)。两个候选已实现并完成同包 ABBA：绑定计划平均 FPS **+0.77%**，TLV 级联共享 **+0.69%**。收益较小，Low 没有明确改善，严格像素对照仍未通过；两个开关继续默认关闭，本轮未验收为正式优化。

外围基于 `1c51548`，引擎基于 `f8843511d`；本轮 TLV 实现已本地提交为 `702f18cf9`。精确编译输入以证据中的源码 SHA-256 为准。

## 正常计时结果

每个实验独立使用 `control → candidate → candidate → control`，每次重新加载同一 WASM，启动完成后预热 15 秒、正常计时 20 秒。合并各自两次 control 和两次 candidate 的墙钟/帧数；1% Low 对合并后的提交间隔取最慢 `ceil(N×1%)` 个间隔的平均值再取倒数。没有将另一个实验的 control 混入比较。

| 单变量 | 基线 FPS | 实验 FPS | 变化 | 基线 / 实验 1% Low | 基线 / 实验 RHI ms/帧 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 绑定槽位计划 | 77.22 | 77.81 | +0.77% | 31.98 / 32.18 | 9.246 / 9.112 |
| TLV 级联共享 | 76.94 | 77.47 | +0.69% | 33.60 / 32.37 | 9.323 / 9.267 |

绑定的两次 candidate 为 78.00、77.63 FPS，对应 control 为 77.24、77.20。TLV 的 candidate 为 78.20、76.74，对应 control 为 77.09、76.79；TLV 的单次波动超过合并收益。绑定 Low 的 +0.63% 也不足以说明慢帧得到改善，TLV Low 为 -3.65%。

本轮只有各一组 ABBA，不能给出稳定的亚百分比收益结论。正常遮挡历史仍使 draw 数略有变化：绑定组 direct draw 约 3102 → 3088/帧，TLV 组约 3093 → 3084/帧；这些差异与当前很小的 FPS 变化同量级。camera、渲染配置和分辨率检查一致，没有以降低画质换取帧率。

可见 Edge 156.0.4314.58，2289×1287 CSS、DPR 1，内部 1484×835、输出 2289×1288，AA=4/TSR。Game/Render/RHI 独立，核心预算 4、任务 Worker 3，mimalloc、原 Cook、材质、阴影和距离场设置。沿用原线程基准关闭异步 PSO cache consolidation 的约定，两侧相同。没有开启预缓存、GPU fence、逐 draw 包装或 profiler 来测 FPS；所有 Worker CPU 采样均在正常计时和截图之后。

## 实验 A：绑定重建的固定槽位计划

开关 `r.WebGPU.BindingPlan=1`，默认 0。每条图形/计算管线第一次使用时整理 descriptor 槽位和动态 offset 的 binding 顺序，检查重复 binding。重建时按固定位置写入 scratch 数组，省去逐项 TSet 查询、重复项扫描和 offset 排序。保留原 descriptor 顺序及完整 cache key。

没有修改资源访问、Uniform 内容、TextureReference、跨帧释放或缓存失效规则，也没有把旧的命中快路径实验当成新收益。完整校验模式独立构造 reference 顺序，与计划生成的每个 descriptor 字段和动态 offset 比较。

正常计时每帧约 10163 个条目经计划装配，但实际重新准备的 descriptor 仍约 **5461 → 5448**，基本没有下降。RHI pump 墙钟减少约 0.134 ms/帧，FPS 增量不足 1%。后续仍需针对失效后 descriptor 的资源解析和不可变视图准备，而不是继续只优化数组装配。

八次计时之后的 CPU 栈全部保留并分析，`CreateGroups` 仍约占 RHI 采样 16–20%。这些是含子调用的短采样百分比，窗口内可能有调度停顿，不能按百分比直接换算每帧节省时间。

## 实验 B：TLV 逐灯参数与级联共享

开关 `r.WebGPU.TLVShareCascades=1`，默认 0。非批量灯在同一 RDG builder/view 内复用 DeferredLight、阴影及 Light Function 等与级联无关的准备结果；两级级联均有效时，用包含两套完整 RDG 参数的一个 pass 发出两个 dispatch。只触及单个级联的灯继续独立处理。

按原灯光顺序逐灯处理两个级联，保留每个光照体的 RGBA16F 累加顺序；没有跨帧缓存临时 RDG 引用。嵌套的两套参数向 RDG 完整声明纹理、buffer、Uniform 依赖。阴影采样、灯光衰减、体积分辨率、过滤和着色器均沿用原实现。

运行日志中不同时间点有 38–59 盏非批量灯，全部带 `ProjectedShadowInfo`，不能直接改走无阴影批量路径。两级有效的每盏灯由两个 RDG pass 改成一个，**两个 WebGPU dispatch 仍然保留**；这是 CPU 准备和 RDG 调度实验，没有实现一次 shader 内累加多灯。

| 正常计时每帧计数 | 基线 | TLV 共享 |
| --- | ---: | ---: |
| 重新准备绑定项 | 5452.21 | 5080.70 |
| 常量快照 | 688.31 | 643.73 |
| 因访问代次失效的绑定组 | 732.54 | 687.73 |
| 全帧 dispatch | 158.37 | 158.20 |

绑定项重建约减少 6.81%，常量快照约减少 6.48%；全帧 dispatch 仍约 158–159。RHI pump 墙钟仅减少约 0.056 ms/帧，Render 侧准备减少没有转化为明显的整帧收益。真正减少逐灯 dispatch 仍需设计兼容不同阴影资源的批量 shader，并核对 GPU 成本。

## 正确性与证据边界

完整 Web UBT 编译、链接和 WASM 结构验证通过。候选包 `villa-binding-tlv-experiments-v61` 复用 v59 的 `content.bin`、`content-files.json`、`config-files.json`，打包时逐项校验哈希；没有重新 Cook。

- 五个视角检查 control、binding、TLV 和组合模式。组合模式仅作正确性检查，不参与单变量 FPS 结论。
- 共完成 **9,786,853 次绑定组计划校验、40,640,103 次准备条目校验**；包含同帧反复参数更新、转向、纹理重新分配及窗口变化。
- 每个视角读取 6 张实际 3D 光照纹理，包含光照体和过滤中间资源。TLV、组合模式与已通过 reference 校验的 binding 模式，**30/30 回读哈希一致**。所有回读无 NaN/Infinity。与首次 control 的最大相对能量差约 `8.89e-7`，不宣称首次 control 位级相同。
- 64/256/64/1000 MiB 纹理预算往返触发实际 mip 释放和恢复，统计驻留字节从 2,256,976 恢复到 124,493,904；这不是进程 RSS 或驱动显存实测。窗口 960×540 → 1280×720 通过。
- 首次跨视角截图中仍有纹理加载和时序历史差异，原始失败比较保留。最终另行预热全部视角，在每个固定视角执行 control/binding/control/TLV/control/combined/control，检查驻留量一致，并把相邻 control 的时序变化保留为画面对照依据。
- 固定视角往返共 35 张截图。按预先设定的相邻 control 变化阈值，15 组候选比较中 13 组通过，binding 的一个视角及 combined 的一个视角未通过。control 之间的平均 RGB 差也可达 7.17/255，说明 `r.RenderTimeFrozen` 加固定机位不足以冻结全部时序历史。本轮保留原始差异和失败状态，没有放宽阈值以使结果通过；不能宣称最终画面像素一致。后续若继续推进候选，需要先建立可重复的时序/曝光/流送状态对照。
- 所有正常计时和最终正确性运行均未捕获 GPU validation、设备丢失、断言或崩溃。

三帧一组的独立 GPU timestamp 诊断波动明显；binding/组合模式还开启了昂贵的 descriptor reference 校验，CPU 供给节奏不同，因此不据此宣称 GPU 时间改善。没有重测 OS GPU 利用率，没有验证首次转向 PSO 卡顿或建立桌面同条件帧时间对照。

可携带汇总见 [binding-tlv-20261104.json](tests/web-platform/evidence/binding-tlv-20261104.json)，包含精确运行时/Cook/源码摘要、逐实验 control、计数、画面对比、GPU 样本和八次 CPU 栈分析。`experimentCompleted=true` 表示实验已完成，`pass=false` 保留严格图像门禁失败，`acceptedForDefault=false` 表示不启用为默认优化。完整逐帧时间、日志、截图、profile 和构建记录位于本机 `tests/web-platform/results/`。

## 复现

在 `G:/UE_HTML/ue_html` 执行，使用新标签及新输出目录，顺序运行，不与构建、采样分析或其他测试浏览器重叠。

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4
node tests/web-platform/package-web-runtime-experiment.cjs --baseline=villa-lumen-off-current-mimalloc-v59 --output=villa-binding-tlv-repeat --evidence=tests/web-platform/results/post-mimalloc-v59-profile-20261104.json
node tests/web-platform/probe-web-throughput-experiments.cjs --folder=villa-binding-tlv-repeat --tag=binding-tlv-repeat-correctness
node tests/web-platform/benchmark-villa-threading.cjs --folder=villa-binding-tlv-repeat --throughput=control,binding,binding,control,control,tlv,tlv,control --seconds=20 --warmup=15 --tag=binding-tlv-repeat-abba --profile-workers
node tests/web-platform/probe-web-throughput-images.cjs --folder=villa-binding-tlv-repeat --tag=binding-tlv-repeat-images
& 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' tests/web-platform/compare-throughput-images.py tests/web-platform/results/binding-tlv-repeat-images.json tests/web-platform/results/binding-tlv-repeat-image-comparison.json
node tests/web-platform/summarize-throughput-experiments.cjs --benchmarks=tests/web-platform/results/binding-tlv-repeat-abba.json --diagnostic=tests/web-platform/results/binding-tlv-repeat-correctness.json --images=tests/web-platform/results/binding-tlv-repeat-image-comparison.json --output=tests/web-platform/evidence/binding-tlv-repeat.json
```

独立切换测试 RPC：`WebLightingQualityTest(16, value)` 控制 binding plan，17 控制 TLV share，18 控制 descriptor reference 校验。普通页面默认三个开关均为 0；原有整组绑定缓存、storage descriptor 复用及 mimalloc 继续启用。
