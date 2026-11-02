# 局部光开关定位（2026-11-02）

关闭局部光后，默认出生视角四轮对照从 **52.77 FPS 提升到 82.74 FPS（+56.79%）**，正常 RHI 工作从 **14.29 降到 9.22 ms/帧**。局部光相关工作是当前的重要性能瓶颈；关闭后仍有约 12.09 ms 的整帧耗时。

## 对照方法

使用现有 `villa-binding-groups-v4` 同一个 Wasm 包，复用已有 `WebProjectLightingTestMode` 引擎诊断接口。Mode 2 临时隐藏原来可见的局部光组件，Mode 0 恢复原始可见性。没有新增引擎禁用逻辑，没有重打包或重 Cook，没有修改项目文件。

隐藏范围包括点光、聚光、矩形光，照明和动态阴影一起移除。方向光、SkyLight、已烘焙 lightmap、预计算反射捕获继续保留。因此测试衡量局部光及其相关工作的总成本，尚不能将收益全部归因于局部阴影。

四轮顺序为 **原始可见性／关闭／关闭／原始可见性**，每轮独立启动 Edge headless，预热 20 秒、正常测量 15 秒。每次结束调用 Mode 0 恢复；结果断言接口已返回原始模式。AO、反射模式、阴影质量分别保持原值 -1、0、5。摄像机、项目设置、内部和输出渲染尺寸逐轮断言相同。

1863×1030，DPR 1.25；内部渲染 1484×835，输出 2289×1287，抗锯齿方式为 2。整组绑定快路径和 GPUScene 均沿用候选包的既有状态。

## 正常性能

| 局部光 | 第一次 FPS | 第二次 FPS | 汇总 FPS | 整帧 ms | RHI 工作 ms/帧 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原始可见性 | 52.69 | 52.86 | **52.77** | 18.95 | 14.29 |
| 关闭 | 81.23 | 84.25 | **82.74** | 12.09 | 9.22 |

整帧减少约 **6.86 ms（36.22%）**，RHI 工作减少约 **5.07 ms（35.48%）**。线程工作会重叠，不能用两个差值相减求 Game 或 Render 的节省。

正常计数器还显示 uniform GPU 快照从约 501 降到 155 次/帧，仍需准备的绑定项从约 4713 降到 2144 次/帧。这次直接移除了一批工作，与上一轮仅跳过已缓存描述符的效果不同。

## 浏览器调用与阴影变化

下面来自两个独立的 5 秒 API/pass 插桩窗口。开启捕获 201 帧，关闭捕获 297 帧。

| 每帧浏览器工作 | 原始可见性 | 关闭局部光 |
| --- | ---: | ---: |
| 全部 draw 调用 | 3125.38 | 2296.04 |
| 阴影深度 draw | 2041.40 | 1439.28 |
| setVertexBuffer | 7973.50 | 6107.99 |
| setIndexBuffer | 2233.59 | 1630.95 |
| setBindGroup | 1399.37 | 830.83 |
| setPipeline | 648.36 | 275.15 |
| createBindGroup | 80.87 | 71.36 |

减少约 **829 次 draw/帧（26.54%）**，其中约 **602 次是阴影深度绘制，占减少绘制的 72.60%**。这是绘制数量占比，不能当作 CPU/GPU 时间占比。

| pass 标签 | 开启：pass / draw 每帧 | 关闭：pass / draw 每帧 |
| --- | ---: | ---: |
| WholeSceneShadowmap（方向光 CSM） | 4 / 1439.22 | 4 / 1439.28 |
| ShadowDepthAtlas | 70.02 / 486.76 | 0 / 0 |
| WebCubeShadowFace | 6.03 / 84.42 | 0 / 0 |
| CachedShadowDepthMap | 3 / 31 | 0 / 0 |
| ShadowMaskTexture | 87.39 / 129.58 | 4 / 6 |
| SceneColor | 66 / 291.18 | 9 / 231.20 |

局部光相关深度与遮罩提交实际消失，方向光 CSM 几乎一致，因此确认不是只改变灯光显示而继续支付同样的阴影工作。SceneColor 包含对同一目标的多个阶段，不能将其中全部 draw 都视为局部光。

关闭后 CSM 占剩余 draw 的约 **62.69%**；它的插桩 CPU pass 墙钟约为 5.89 ms/帧，开启时约 5.95 ms/帧。说明 CSM 和其绑定编码仍是剩余工作中的重点。该墙钟包含 C++/Wasm/浏览器编码，受插桩影响，不等同于 GPU 时间，也不能从正常帧时间直接扣除。

GPU 三个采样帧的 pass 时间合计：开启 **4.92 / 6.95 / 6.49 ms**，关闭 **2.56 / 2.75 / 2.69 ms**。GPU 工作也减少，但这些只包含 timestamp 覆盖的 pass，不含复制和间隙，不能当作完整 GPU 帧时间。性能图同时保存了 Game、Render 和 RHI 的 CPU 火焰图。

## 捕获与结论边界

正常 FPS 与 API/pass、CPU、GPU 插桩分段测量，性能结论使用上面的四轮数据。浏览器 pass 名称通常来自渲染目标，不等同于完整的 UE GPU Visualizer 事件名；pass 的 CPU 墙钟还包含 C++ 编码和插桩开销。

六次运行均未记录运行时错误、WebGPU validation error 或 device loss，退出前恢复模式检查通过。环境的 86 个进程样本没有发现大型游戏、编辑器、shader 编译器或链接器；测试期间仍有 TGitCache、任务管理器等普通后台活动。未将后台活动完全隔离，也没有进行新的同条件 DX 对照。

本轮证明默认视角下局部光相关成本很高，尚未区分点光、聚光、矩形光各自成本，也未单独测量“保留局部照明、只关闭局部阴影”。下一步可用该对照把局部阴影生成与投射、直接光照和绑定准备分开定位；不能把临时关灯作为保持原画质的后端优化。

## 证据与复现

- [四轮正常对照](tests/web-platform/results/local-lights-20261102-abba.json)
- [汇总及输入 SHA256](tests/web-platform/results/local-lights-20261102-analysis.json)
- [局部光开启的性能图与 CPU 火焰图](tests/web-platform/results/performance-capture-local-lights-20261102-on-profile.html)
- [局部光关闭的性能图与 CPU 火焰图](tests/web-platform/results/performance-capture-local-lights-20261102-off-profile.html)
- [关闭后的画面](tests/web-platform/results/performance-capture-local-lights-20261102-abba-1-candidate-scene.png)
- [环境进程记录](tests/web-platform/results/local-lights-20261102-environment.jsonl)

正常包入口继续使用 [TriplexHouseVilla](http://127.0.0.1:8765/build/villa-binding-groups-v4/index.html)。本轮实验各次结束均恢复局部光，正常包的启动设置未改变。

```powershell
node tests/web-platform/compare-web-rhi-adaptation.cjs --baseline=villa-binding-groups-v4 --candidate=villa-binding-groups-v4 --tag=local-lights-new-run --headless --warmup-seconds=20 --local-lights-abba
node tests/web-platform/capture-web-performance.cjs --folder=villa-binding-groups-v4 --tag=local-lights-new-run-off-profile --headless --warmup-seconds=20 --dpr=1.25 --seconds=5 --local-lights=off
node tests/web-platform/analyze-web-local-lights.cjs --prefix=local-lights-20261102
```

前两条需要现有 Node 环境的 Playwright、运行中的 8765 本地服务器；捕获结束会恢复灯光。最后一条只分析保存结果。新实验应使用新的 tag 保留旧证据。
