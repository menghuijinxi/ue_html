# Lumen 支持对关闭项目的影响与新版分配器对照

2026-11-04。外围仓库起点 `56214cf`，引擎起点 `f8843511d3`。本轮不迁移插件目录，不改变原项目的渲染设置；`G:/UE_HTML/TriplexHouseVilla` 的 GI、反射和虚拟阴影均为 0，距离场保持开启。

## 区分两类关闭 Lumen 的包

旧 `villa-native-metadata-v57` 保留此前项目设置和完整 Cook，但它内置的平台能力表也是 `bSupportsLumenGI=false`。因此只把最新 RHI 放进这个包，可以检查旧包的运行时回归，却不能覆盖“平台支持 Lumen、项目关闭 Lumen”的新 Cook 情况。

本轮准备以下对照，正式 FPS 与构建、Cook、打包及内存观察器串行：

| 组别 | A | B | 可回答的问题 |
|---|---|---|---|
| 旧 Cook 的运行时回归 | v57 原生元数据 + mimalloc | v58 新增 Lumen 后端 + mimalloc | 同一 Cook、同一配置下，后端新增逻辑是否有额外开销 |
| 当前完整包 | v57 旧包 | v59 新 Cook、最新完整 Renderer + mimalloc | 当前实际重新打包后的项目整体表现；包含平台准入、Shader 和半透明光照路径变化 |
| 当前完整包的分配器 | v59 dlmalloc | v59 mimalloc | 最新路径下，更换底层分配器是否仍有收益 |

v58 的三个 Renderer 兼容文件沿用旧 Cook 对应的 `d175ae4ae` 快照，其余最新 Lumen RHI、RenderUtils 和 Renderer 修改均编译。v59 不使用这三个历史文件覆盖，采用当前完整源码及新的 Lumen 平台准入。不能把 v59 与 v57 的全部差异归因于 Lumen 开关本身。

## 构建与隔离

两类分配器均保持 UE 的线程安全平台声明，不重新增加外层代理锁。每组分配器实际链接的 C++ 源码、定义、编译参数和 417 个对象字节全部相同；仅最终 C 分配器链接不同。mimalloc 保留 UE 的 C++ new/delete 入口，未启用分配计数插桩。优化级别、SIMD、最终链接和 LTO 由实际 response 文件单独核验。

为保留两个最终链接结果，新增运行时快照及可指定构建报告的打包入口；打包器继续验证源码、对象和产物哈希。原包及失败日志保留。

当前 Renderer 首次构建失败，原因为增量脚本更新了 `TranslucentLighting.cpp`，却保留历史对照的旧 `WebShaderPlatform.h`。已在 Renderer 快照选择前同步当前公共头文件，显式指定旧 RendererRevision 时仍由对应快照覆盖。此处只修正构建输入的一致性，未修改渲染算法或项目配置。

## 验证结果

本机 Edge 可见窗口、2289×1287 CSS、DPR 1，内部渲染 1484×835、TSR=4，默认出生点。每次页面至少运行 90 帧，再预热 15 秒、测量 20 秒。UE 核心预算 4、Task Worker 3，Game、Draw、RHI 三个物理线程独立。画质、相机与项目设置均自动核验，未启用 PSO 预缓存。

| 对照 | 控制组 FPS / 1% low | 实验组 FPS / 1% low | 平均 FPS 变化 |
|---|---:|---:|---:|
| 同一旧 Cook，旧后端 → 新 Lumen 后端，均 mimalloc | 81.54 / 34.16 | 80.03 / 33.28 | −1.85% |
| 完整新包，首轮 ABBA | 77.55 / 27.44 | 75.56 / 31.41 | −2.56%，旧版重复值波动过大 |
| 完整新包，反序 BAAB 复测 | 79.65 / 33.54 | 74.55 / 29.90 | **−6.41%** |
| 最新完整包，默认 dlmalloc → mimalloc | 58.21 / 24.79 | 75.83 / 29.92 | **+30.27%** |

1% low 的定义为 `1000 / 最慢 1% 帧间隔的算术平均值`。各版本的两个 20 秒测量窗口合并计算；不是把 UI 刚加载时的样本一直累计进去。

同 Cook 的新版运行时两次为 80.02、80.05 FPS，旧版为 82.42、80.67 FPS；尚未发现新增 Lumen 后端带来大幅固定开销，但不能据此证明零开销。完整新包首轮的旧版从 84.08 变到 71.02 FPS，异常波动原因未查明，该组及环境日志完整保留；没有只保留较高的旧版样本。为此补做反序复测：新版 74.00、75.09 FPS，旧版 80.34、78.96 FPS。复测支持完整新版在本视角存在约 6.4% 回退，1% low 下降约 10.8%；不把首轮不稳定数据用于给出精确回退结论。

分配器 ABBA 的默认版本为 58.17、58.25 FPS，mimalloc 为 76.48、75.17 FPS。mimalloc 的平均帧率收益约 30.3%，1% low 提升约 20.7%，每帧 RHI 工作时间由 12.67 ms 降到 9.58 ms，降低约 24.4%。**最近的 RHI 与原生元数据优化后，mimalloc 仍有明显收益，应保留。** 这是完整渲染负载的实际收益，分配器导致的帧率变化也会改变遮挡可见性和每帧绘制数，不能解释为纯 malloc 微基准。

代价是本轮初始测量时 mimalloc 的 Wasm 线性内存容量约 1450.6 MiB，默认分配器约 864.3 MiB。此值包含增长策略和保留空间，不能等同于活跃分配、进程 RSS 或 GPU 显存；本轮没有对两者做同等 RSS 测量。

## 回退线索与边界

新 Cook 的项目 GI=0、反射=0，Web SM5 的 Lumen 能力为 true。真实 Cook 清单中注册的 186 类 Lumen 全局 Shader 的编译变体数均为 0。运行时四个视角的最终 GI/反射方法仍为 0，GPU 资源观察器的存活资源标签中也没有 Lumen 项。资源标签检查并非完整 GPU 内存归因，但与项目准入早退及 Shader 裁剪结果一致。

完整新版每帧计算调度约从 66.45 增至 159.17，RHI 工作时间约从 9.09 ms 增至 9.76 ms。源码中 `UsesComputeTranslucencyLightingVolume()` 对桌面 Web 始终返回 true；`SupportsTranslucencyLightingVolume()` 因而让过去不支持分层体积渲染时会退出的 TLV 注入、过滤与历史路径开始执行。这些半透明光照功能独立于项目是否开启 Lumen，不能因为 GI=0 就认为它们不会运行。

正式测量结束后，复用已有观察器，分别抓取三个独立 GPU 帧：旧版 67 次 compute，新版 175、175、144 次；compute 的 GPU 通道时间平均约 1.68 → 2.01 ms，begin/end 范围内的 CPU 编码时间约 0.45 → 0.96 ms。全部通道 GPU 时间平均为 4.54 → 4.43 ms，没有显示整帧 GPU 时间明显增长。这些只有三个插桩样本，时间戳存在量化，通道总和不包括复制和间隙；不代替正式 FPS，也不足以排除其他 GPU 瓶颈。计算管线缺少名称，本轮不能给出 TLV 单独占用的精确时间。

因此，**TLV 逐灯计算注入及其 CPU 准备/调度是当前优先调查线索**。v58 保留旧 TLV 兼容文件时差距较小，v59 恢复完整 TLV 后新增大量 compute，这两点相互支持；但本轮没有修改项目设置、关闭 TLV 或重写算法，尚未用单独隔离实验证明全部回退均由 TLV 导致。

## 正确性与记录

- v58、v59 各完成六视角检查；v58 另完成四组窗口尺寸/DPR 检查。截图已查看，玄关照明、材质、距离场阴影仍存在；不宣称全场景逐像素一致。
- dlmalloc 新包实际移动约 157.1 cm、转向约 36.4°，17369453 个绑定项校验通过，GPUScene、资源表和独立 Game/Draw/RHI 线程通过；原生元数据 DOM 加载数为 0。
- 独立内存诊断运行至 3182 帧，三次视角切换无错误。所有上述测试均未出现 GPU 校验错误、页面异常或崩溃，不替代长时间稳定性验收。
- 16 个正式测量窗口共对应 63 个环境样本，没有游戏、构建或 Cook 进程。音乐、聊天等用户后台程序保持运行，偶有少量 CPU 活动，已随报告记录。
- 原项目 `DefaultEngine.ini` 哈希始终为 `408f1f254531be628c9d285b7ca65ef17a81c90d9dac1dcfcd56f2a82b326183`，包内配置逐字节相同。

人工对照页面：

- [最新完整包 + mimalloc](http://127.0.0.1:8765/build/villa-lumen-off-current-mimalloc-v59/index.html)
- [最新完整包 + 默认分配器](http://127.0.0.1:8765/build/villa-lumen-off-current-dlmalloc-v59/index.html)
- [旧版基线](http://127.0.0.1:8765/build/villa-native-metadata-v57/index.html)

这些网页均正常使用项目设置；同时打开多个运行页面会干扰人工性能比较。

## 复现入口

所有命令在 `G:/UE_HTML/ue_html` 运行。原项目复制时使用 `prepare-web-project.cjs --project=G:/UE_HTML/TriplexHouseVilla/TriplexHouseVilla.uproject --id=lumen-off-v59 --project-settings`；随后用 `cook-web-engine.ps1 -Engine D:/UE_5.8 -Mode WebGPU-SM5 -Scene Project -Project <隔离副本.uproject> -Map /Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla -UseProjectSettings -ReportId lumen-off-v59 -SkipBuild` 完整 Cook。先构建相同版本的本地 RenderCore、Renderer 及 Cook 插件模块，安装版引擎保持只读。

运行时用 `build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4` 构建，mimalloc 版本增加 `-Mimalloc`。只有 v58 增加 `-RendererRevision d175ae4ae`；v59 不传这个参数。每次构建后先用 `snapshot-web-runtime-build.cjs` 保存产物，再运行 `audit-web-allocator-pair.cjs` 比较真实对象字节，最后用 `--build-report=...` 指定打包使用的快照。

正式帧率依次运行以下命令；需要已安装 Playwright 并启动端口 8765 的 `serve.cjs`，标签不得与既有报告重名：

```powershell
node tests/web-platform/benchmark-villa-threading.cjs --folders=villa-native-metadata-v57,villa-lumen-off-mimalloc-v58,villa-lumen-off-mimalloc-v58,villa-native-metadata-v57 --tag=lumen-off-v58-runtime-abba
node tests/web-platform/benchmark-villa-threading.cjs --folders=villa-native-metadata-v57,villa-lumen-off-current-mimalloc-v59,villa-lumen-off-current-mimalloc-v59,villa-native-metadata-v57 --different-cook --tag=lumen-off-v59-runtime-abba
node tests/web-platform/benchmark-villa-threading.cjs --folders=villa-lumen-off-current-dlmalloc-v59,villa-lumen-off-current-mimalloc-v59,villa-lumen-off-current-mimalloc-v59,villa-lumen-off-current-dlmalloc-v59 --tag=lumen-off-v59-allocator-abba
node tests/web-platform/capture-lumen-off-passes.cjs
node tests/web-platform/benchmark-villa-threading.cjs --folders=villa-lumen-off-current-mimalloc-v59,villa-native-metadata-v57,villa-native-metadata-v57,villa-lumen-off-current-mimalloc-v59 --different-cook --tag=lumen-off-v59-runtime-repeat-baab
node tests/web-platform/summarize-lumen-off-allocator.cjs
```

汇总程序读取固定命名的本轮报告，并在 FPS 窗口结束后重新核验产物哈希、项目配置、分配器构建输入和环境监测记录。原始日志保存在本机 `tests/web-platform/results/`，可携带的摘要保存在 `tests/web-platform/evidence/lumen-off-allocator-20261104.json`。
