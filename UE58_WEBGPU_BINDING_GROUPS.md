# WebGPU 整组绑定候选与阴影合批实测

2026-11-02。整组绑定快速路径已实现，正确性校验通过，但四轮正常帧率 **50.32 → 50.40 FPS（+0.17%）**，本轮没有获得显著性能提升。阴影诊断确认 UE 自动合批已经工作；主要浏览器绘制及状态绑定数量没有下降。

## 正常性能结果

使用同一个 `villa-binding-groups-v4` Wasm 包，通过后端诊断接口按关／开／开／关切换 `r.WebGPU.BindingGroupCache`。每轮独立启动 Edge，原始出生视角，预热 20 秒，正常测量 15 秒。1863×1030、DPR 1.25；记录的内部渲染尺寸 1484×835、输出尺寸 2289×1287，四轮一致。摄像机和项目设置逐轮断言一致。

| 后端整组缓存 | 第一次 FPS | 第二次 FPS | 汇总 FPS | RHI 工作 ms/帧 |
| --- | ---: | ---: | ---: | ---: |
| 关闭 | 50.93 | 49.70 | 50.32 | 15.126 |
| 开启 | 51.06 | 49.74 | 50.40 | 14.991 |

汇总按呈现帧数和实际时间计算。RHI 降约 0.135 ms/帧，正常帧时间约 19.874 → 19.841 ms。差异不足以证明有实用帧率收益，也没有达到用户的性能目标。这里比较同包开关，不是与上一版运行时的四轮对照。

环境监控覆盖验证开始到捕获结束的 131 个样本，没有发现 `cod` 游戏、编辑器、ShaderCompileWorker、clang 或链接器进程。系统和普通后台应用继续运行；此记录不能排除调度及频率波动。原始结果见 [四轮数据](tests/web-platform/results/binding-groups-v4-toggle-abba.json)、[环境记录](tests/web-platform/results/binding-groups-v4-environment.jsonl)。

## 修改了什么，以及为什么收益小

在 PSO 中保留每组准备结果；资源绑定、UB 内容、静态 UB、globals、访问状态或纹理引用目标变化后重新准备。命中发生在绑定项解析、描述符组装和缓存比较之前。快照只在同帧复用，跨帧重新获取，避免借用已淘汰的组指针或过期的 SingleFrame UB 页。手动顶点读取的特殊格式组继续使用完整路径。

这延续 [Diligent 按组 dirty 更新](https://github.com/DiligentGraphics/DiligentCore/blob/f1a3a110e43337d46d691b3a55e911eb695499f9/Graphics/GraphicsEngineWebGPU/src/DeviceContextWebGPUImpl.cpp#L226) 与 [Babylon 提前返回整组缓存](https://github.com/BabylonJS/Babylon.js/blob/1b26881f8120797f5726b4aa23eaa16e62c479fe/packages/dev/core/src/Engines/WebGPU/webgpuCacheBindGroups.ts#L98) 的方向；UE 的资源表、MeshDrawCommand 和 GPUScene 继续负责上游资源与绘制逻辑。

| 正常计数器，次/帧 | 关闭 | 开启 |
| --- | ---: | ---: |
| 整组准备快路径命中 | 0 | 3252.97 |
| 仍需准备的绑定项 | 4702.67 | 4709.59 |
| 逐项复用的绑定项 | 21436.53 | 4622.81 |
| 两类绑定项处理合计 | 26139.20 | 9332.41 |
| 创建资源组 | 77.28 | 76.54 |

绑定项处理数量下降约 **64.30%**，主要省掉已经缓存好的描述符逐项解析和复制；仍需准备的绑定项几乎相同。整个组没变时可以跳过 CPU 准备，但它没有减少 UE 的绘制数或浏览器实际状态提交。不能把命中数直接换算成节省的毫秒数。

独立 API 插桩窗口也显示相同限制：

| 浏览器 API，次/帧 | 关闭 | 开启 |
| --- | ---: | ---: |
| setVertexBuffer | 7967.01 | 7980.25 |
| setIndexBuffer | 2232.13 | 2235.11 |
| setBindGroup | 1398.54 | 1400.28 |
| createBindGroup | 81.84 | 80.58 |
| drawIndexed | 2988.49 | 2994.07 |
| drawIndexedIndirect | 86.00 | 86.83 |
| submit | 12.01 | 12.01 |

两个插桩窗口的帧边界、遮挡反馈可能不同，少量数量波动不能解释成场景质量改变。正常 FPS 与插桩分开测量。

5 秒 CPU 采样中，CreateGroups 包含时间约 8.50/7.17 ms/帧，但分别包含一次 **753/724 ms** 长样本间隔。将这些间隔单独列出后，其余样本约 5.17/4.18 ms/帧；SetDrawBindings 约 8.48/7.59 ms/帧，顶点 buffer C API 桥接约 1.93/2.07 ms/帧。包含时间相互重叠，剔除长间隔也不能得到精确计时或帧率收益。单独正常窗口曾得到 49.70/53.02 FPS，更说明不能用两次短捕获代替四轮结论。

GPU 三帧 pass 合计分别为 4.85/4.13/4.13 ms 和 4.78/4.92/4.06 ms；不含复制和间隙，不等于完整 GPU 帧时间。证据继续指向 RHI 中的绘制准备与浏览器编码开销，但不能将某一个函数宣布为全部瓶颈。

## 阴影诊断的新结果

新增限量诊断 `r.Web.ShadowSubmissionProbe`，记录灯光 ID、级联、缓存模式、尺寸和实际缓存开关；调用 UE 原有 `FParallelMeshDrawCommandPass::SetDumpInstancingStats()` 获取合并前后统计。诊断默认关闭，不用于正常 FPS 测量。

原始出生视角、首次完整诊断帧：

| 阴影提交 | 合并前 MeshDrawCommand | 合并后状态桶 |
| --- | ---: | ---: |
| 方向光，级联 0 | 1460 | 545 |
| 方向光，级联 1 | 1661 | 629 |
| 方向光，级联 2 | 807 | 266 |
| CSM 合计 | **3928** | **1440** |
| 局部光合计，34 个提交 | **529** | **524** |

CSM 命令合并约 63.34%，这是引擎已经提供的 GPUScene/实例合批效果，不能计为本轮新增收益。与先前浏览器测得约 1439 次 CSM draw/帧相符。局部光这批命令几乎不能合并，仍需细分它们的网格、材质和 shader bindings；不能只凭这些统计认定它们是重复工作。

运行值已确认：`r.Shadow.CSMCaching=0`，`r.Shadow.CacheWholeSceneShadows=1`。CSM 的 mode=3，即 Uncached；局部光日志出现 mode=0（只画 movable caster）和 mode=1（静态缓存更新），已有 UE 局部光缓存路径。CSM 缓存当前关闭，因此没有 CSM 缓存失效事件可分析；局部光的逐原因失效记录尚未补全。

RenderDepth 阶段的输入数组已移入 pass，因此日志里的 `cachedCommands=0`、`dynamicElements=0` **不能作为 caster 数量**；以上数值来自引擎 cleanup 时输出的正式实例统计。阴影统计也是命令设置统计，并非 GPU 时间或浏览器逐次调用统计。

引擎本地提交：`ac7696be5`。构建脚本也修正了 `-SkipHostPreparation` 时本地 ShadowDepthRendering 覆盖文件未同步的问题，并将源文件和覆盖文件加入构建哈希审计；没有写入安装引擎目录。

## 正确性、包和证据

- 完整线程构建、链接和 Wasm 校验通过，446 项构建源文件哈希与当前文件一致。
- 45 秒真实移动、转视角、跳跃和缩放的完整重算校验通过：**5,900,717 次整组结果一致、38,137,791 次已准备描述符一致**，无记录到的断言、WebGPU validation error、device loss 或崩溃。
- 另一次 45 秒正常快路径移动通过，帧推进到 2073。四轮正常性能和两次性能捕获也完成。
- 人工核对缓存关／开画面；第一对截图 RGB 平均绝对差 0.00015/255。后一对为 0.867，两个关闭组截图之间也有 0.884 的运行差异，因此不宣称全部截图逐像素相同。
- 纹理引用更换、UB 内容变更和访问状态有失效分支，但本轮移动记录没有触发 `groupTextureMisses`。没有专门复现同帧 texture reference 更换，不能把上述场景校验视为覆盖所有资源生命周期。

独立候选入口：[TriplexHouseVilla 候选包](http://127.0.0.1:8765/build/villa-binding-groups-v4/index.html)。运行时复用已测 Cook 的 content/config，哈希一致，没有新 Cook，也没有项目画质覆盖。候选包默认开启整组缓存，可用后端接口关闭；保留为可测量的候选，当前不宣称解决了性能问题。

构建与打包审计：[build](tests/web-platform/results/villa-binding-groups-v4-build.json)、[package](tests/web-platform/results/villa-binding-groups-v4-package.json)。前期 v1 缺少阴影覆盖，v3 的诊断曾因 Render 线程修改控制台变量触发线程断言，均不计通过；v4 改为 Game 线程发请求、Render 线程维护计数，以上结果全部来自 v4。

可检查的捕获：[关闭缓存报告](tests/web-platform/results/performance-capture-binding-groups-v4-off-profile.html)、[开启缓存报告](tests/web-platform/results/performance-capture-binding-groups-v4-on-profile.html)。JSON 和旁边的 `.cpuprofile`、browser trace 保存了原始数据，RHI、Render、Game worker 均被捕获。汇总见 [analysis.json](tests/web-platform/results/binding-groups-v4-analysis.json)。

重算汇总：

```powershell
node tests/web-platform/analyze-web-binding-groups.cjs --images
```

需要现有 Node 环境中的 pngjs；不加 `--images` 可跳过截图统计。脚本只读保存的结果，记录输入 SHA256，不运行浏览器。

## 剩余工作的优先级

下一项有直接依据的目标是减少浏览器实际绘制和绑定调用：让稳定 draw 的 Render Bundle 在昂贵准备前命中，或单独验证批量桥接；两者需要分别测量。继续优化约 0.3 ms/帧的资源表解析或已缓存的描述符复制，预期空间有限。

阴影侧应继续比较同条件 DX 捕获，并细查局部光的 caster、shader bindings 和缓存失效。CSM 缓存属于当前项目运行配置的选择，不能当作 Web 缺失功能直接打开来报告后端优化收益。本轮尚未实现提前 Bundle 重放、批量桥接或补全 DX 对照。
