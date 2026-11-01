# TriplexHouseVilla：WebGPU 调用模型复核（2026-11-01）

项目设置与 Cook 内容保持原样。本轮从 WebGPU/Dawn 官方资料出发检查后端，不通过降低分辨率、阴影、距离场或材质质量获得性能收益。

## 调研结论与代码对应

1. [WebGPU PipelineLayout 规范](https://gpuweb.github.io/gpuweb/#gpupipelinelayout) 明确说明，同一显式 PipelineLayout 可用于多个管线，减少切换时内部资源重绑定。原实现为每个 PSO 新建布局，绑定组缓存也包含 PSO 身份，阻止相同布局与资源跨 PSO 复用。现在按排序后的全部布局字段驻留 BindGroupLayout，再按布局列表复用 PipelineLayout；绑定组键改为布局及资源，不再保留管线引用。哈希命中仍完整比较；GPU 对象引用、帧末淘汰及动态偏移保持。
2. [WebGPU Explainer：Buffer Mapping](https://gpuweb.github.io/gpuweb/explainer/#buffer-mapping) 说明 writeBuffer 包含额外复制；[内存模型](https://gpuweb.github.io/gpuweb/#memory-model) 说明浏览器跨进程及 staging 复制的来源。当前每帧数百次小常量上传可以合并。CPU 保存 1 MiB 页镜像，在页切换或 RHISubmitCommandLists 前只上传脏区，每次绘制仍使用不重叠的常量快照，保持原队列顺序。没有对使用中的 uniform buffer 同步映射或增加 GPU 等待。
3. [Dawn BindGroupTracker](https://dawn.googlesource.com/dawn/+/refs/heads/main/src/dawn/native/BindGroupTracker.h) 追踪布局兼容性、dirty 状态与动态偏移。UE 的 `D3D12UniformBuffer.cpp` 使用持久/瞬时 upload 分配并复制常量；WebGPU 没有等价的 CPU 可写常驻 uniform heap，因此复用引擎上层及分配思路，在 Web RHI 内适配队列上传。
4. [Emdawnwebgpu 官方说明](https://dawn.googlesource.com/dawn/+/refs/heads/main/src/emdawnwebgpu/pkg/README.md) 确认 C API 最终仍通过浏览器 JS WebGPU；多线程不会消除这些调用的参数转换及浏览器验证成本。当前确实有独立 Game、Render、RHI 线程，剩余 RHI 执行耗时不能简单归因于“线程未开启”。

布局独立创建本身合法，零碎 writeBuffer 也合法；这里修正的是不适合高 draw 数场景的调用方式，并非已经证明浏览器实现错误。规范建议常用、不常变的组放低编号，但调整 shader 组号需要重新 Cook 与更广泛验证，本轮未改。

## 隔离验证：布局共享

相同出生相机、CSS 1863×1030、DPR 1.25，内部 1484×835、输出 2290×1288、AA=2。至少运行 90 帧后额外预热 20 秒，测量 15 秒，A→B→B→A；编译与浏览器测试错开。

| 顺序 | dx-binding-v3 基线 | 共享布局 |
| --- | ---: | ---: |
| 1 | 32.224 FPS | — |
| 2 | — | 32.498 FPS |
| 3 | — | 31.945 FPS |
| 4 | 30.143 FPS | — |
| 总帧数/总测量时间 | 31.182 FPS | 32.222 FPS |

合计 +3.33%，但基线自身波动明显，不据此宣称明显解决性能问题。第一对测量的绑定组创建速率约 699→594 个/帧，缓存驻留 4524→3754（以各报告呈现帧和末尾 30 帧更新的累计计数估算）。原始报告：`tests/web-platform/results/webgpu-layout-abba.json`。

## 后续测量

合并上传的第二组固定视角对照为 33.310→33.638 FPS（+0.99%），并非主要瓶颈。常量页上传计数降至约每帧 3 次；纹理、顶点和其他资源的上传仍保留，不能把它理解为所有 writeBuffer 总计 3 次。报告：`tests/web-platform/results/webgpu-uploads-fixed-camera-abba.json`。

最初 `webgpu-uploads-abba.json` 中基线相机被外部输入改变，该组作废；后续捕获通过 CDP 忽略外部输入、模拟页面焦点，并逐秒核对相机坐标及角度。跨版本比较同时核对初始相机。`webgpu-bundles-trial` 中 Bundle 计数为 0，因为正式 Web 初始化沿用了旧 GlobalProbeMode 标记，该次也不能证明 Bundle 方案效果；已改为按实际 Web 平台选择并增加必须命中缓存的验收项。

本机有其他大型游戏同时运行，用户明确要求保持运行并注明干扰。后续使用后台 Edge；帧率和 A/B 幅度仅代表该次并发负载下的结果，不作为独占硬件的稳定性能或与桌面 147 FPS 的严格对比。

## Render Bundle 实验

[Apple WWDC25 官方说明](https://developer.apple.com/videos/play/wwdc2025/236/) 建议通过 Render Bundle 复用命令与验证。[GPUWeb #4104](https://github.com/gpuweb/gpuweb/issues/4104) 同时说明逐对象 Bundle 不保证在所有后端更快，必须测量重复状态及录制开销。

UE D3D12 的对照点是既有状态缓存、root signature 和 upload 分配；Bundle 复用属于 WebGPU 后端实验。

Web RHI 对 indexed draw 按完整管线、缓冲、绑定组及动态偏移、draw 参数和附件格式/只读约定缓存 Bundle；上层 UE 的任务、剔除及 draw 顺序不变。缓存拥有管线/缓冲引用和绑定组 handle；最多 16384 项，未使用的项帧末淘汰。新版只在完整键连续出现 3 帧后录制 Bundle，变化频繁的绘制使用原路径及已经解析好的绑定组。尚未录制的观察项仅保存键，不回放旧资源。常量仍为原来每次绘制的快照，GPU 更新内容由原队列上传决定，不能把动态偏移当作不变状态忽略。

累积的 Bundle 在视口、裁剪、Stencil 更改、遮挡查询边界、GPU 标记和 render pass 结束之前按原顺序执行。直接和 indirect draw 使用原路径，先执行待提交 Bundle 并重设管线。规范明确 executeBundles 会清空 encoder 的管线、vertex/index 和绑定组状态，缓存也相应清空。捕获器展开 Bundle 的逻辑 draw 计数，并将新录制的 API 成本与重放成本分开记录。

第一版实际缓存命中率约 82%，但测量窗口新增 104145 个 Bundle / 101 个呈现帧，频繁录制抵消了复用效果。完整采样的 RHI 线程仍有大量 CreateGroups、createRenderBundleEncoder、finish 和 GC 成本。记录在 `performance-capture-webgpu-bundles-v2.json/html`，不能据此启用默认优化。

稳定 3 帧后才录制的新版交错对照（后台 Edge、其他游戏保持运行）：

| 顺序 | 合并上传基线 | 稳定 Bundle 缓存 |
| --- | ---: | ---: |
| 1 | 12.977 FPS | — |
| 2 | — | 13.435 FPS |
| 3 | — | 13.114 FPS |
| 4 | 13.166 FPS | — |
| 总帧数/总测量时间 | 13.071 FPS | 13.274 FPS |

合计 +1.56%，没有足够证据说明它能解决目前的帧率差距。报告 `webgpu-bundles-v3-abba.json` 校验相机、内容/配置哈希与实际 Bundle 命中。**正式构建中 `r.WebGPU.RenderBundles` 默认 0**；保留实验实现和已打包的 `villa-webgpu-bundles-v3` 供复查，正式包使用布局共享、常量合并上传及 stencil reference 去重。项目配置文件没有写入任何实验开关。

目前可以确认的是，绑定组的整理、C API 到 JS 的转换和浏览器命令处理仍有较大成本；不能宣称线程未开启或已经定位到单个 WebGPU 非法调用，更不能将小幅改善描述成已解决性能问题。剩余方向需以同负载采样继续区分 C++ 描述整理与浏览器/驱动处理，避免继续用创建更多缓存对象代替实际降耗。

## 原生 Trace 与诊断开销

更新后的 Trace 目标成功构建，网页按钮及 RPC 各导出一份原生 `.utrace`。`webgpu-research-final-0.utrace` 经 UE 自带 UnrealInsights 无界面分析、导出和流式校验通过：22 个线程、457 个 timer、4,731,613 个事件，覆盖 8.056 秒；包含 GameThread、RenderThread、RHIThread 及 WebGPU 后端 scope。

其中 `WebGPU_SetDrawBindings` 累计 inclusive 3.551 秒，嵌套的 `WebGPU_CreateGroups` 为 1.924 秒，两者不能相加。浏览器采样也显示绑定组整理、setBindGroup、setVertexBuffer 和 C API 适配开销。该证据支持继续减少每帧绑定与命令整理次数；不能把所有时间归为浏览器验证，也不能据此宣称 GPU 没有工作。

首次最终捕获 `performance-capture-webgpu-research-final.json/html` 通过，采集 18 个 Worker、111,821 个浏览器事件及 3 帧 GPU pass 时间。未采样窗口 13.301 FPS、RHI 工作计时 61.097 ms/帧；CPU/浏览器采样窗口 11.474 FPS，API 插桩窗口 8.768 FPS。GPU pass 合计分别为 13.435 / 15.073 / 13.500 ms，**不包含 copy 与 pass 间隙，不能当作完整 GPU 帧时间或据此计算 GPU 利用率**。这些均是在后台 Edge、另一大型游戏保持运行条件下测得。

这次采样额外发现，Worker 的 `snapshot()` 占 RHI 线程统计采样时间约 11.41%。原逻辑每 100 ms 用 `Object.keys(globalThis)` 遍历整个引擎导出空间，再筛选少量诊断字段。现改为直接读取明确的诊断字段，更新频率和消息结构不变；它属于页面状态同步开销，UE 原生 scope 不会自动把它归入某个渲染阶段。后续捕获与移动测试单独验证此修改，不能用上述一次未配对的 FPS 推导收益。

修改前正式后端已通过两轮各 45 秒的移动、转向、跳跃、调整视口验证，呈现帧 2→472、3→494；无运行时/GPU 错误，重算验证约 2,970 万个描述项一致。三条物理线程独立，Bundle 命中/创建/驻留均为 0。

最终捕获 `performance-capture-webgpu-worker-snapshot-final.json/html` 已通过数据及实际图表交互验证：18 个 Worker、116,214 个浏览器事件、3 帧 GPU pass。原始 CPU profile 中 `snapshot()` 自身时间占比为 0.00214%，含子调用为 0.00714%；枚举热点已消除。最新未采样窗口为 **13.469 FPS、RHI 工作计时 61.375 ms/帧**，CPU/浏览器采样窗口 11.992 FPS、API 插桩窗口 9.041 FPS。GPU pass 合计 15.925 / 2.490 / 35.979 ms，存在明显波动。前后两次完整捕获不是交错 A/B，不能把 FPS 差值视为稳定收益，也不能将消除该热点描述为已解决整帧瓶颈。报告保存当前包的资源哈希及后台游戏干扰说明。

状态同步修改后另做 30 秒移动/转向/跳跃/调整视口验证：呈现帧 3→295，无运行时/GPU 错误；8,969,135 个绑定描述重算一致。实际 Worker 中原筛选逻辑可发现的 13 个诊断字段全部包含在新列表并已传至页面，无漏项。常见的后续按需诊断字段也保留在列表中。报告 `project-gameplay-webgpu-state-snapshot-final.json`；此回归用于功能验证，不作帧率测试。

## 交付标识

- 正式页：[TriplexHouseVilla](http://127.0.0.1:8765/build/triplex-project-distance-fields-threads/index.html)。默认 Bundle 关闭，项目设置及内容保持。
- 最终图表：[CPU 火焰图、浏览器时间线及 GPU pass](http://127.0.0.1:8765/results/performance-capture-webgpu-worker-snapshot-final.html)。原始 `.cpuprofile`、浏览器 trace 和 JSON 位于同一 results 目录。
- 原生 Trace 诊断页：[UE Insights 捕获](http://127.0.0.1:8765/build/villa-insights-candidate/index.html)。本轮已验证的 `.utrace` 为 `tests/web-platform/results/webgpu-research-final-0.utrace` 及 `-1.utrace`；原生 scope 录制发生在最后的 JS 状态枚举修改之前，编译的 Web RHI 后端相同。诊断页随后也同步了新的 Worker。
- 正式 WASM：`590b8c7a2fb5dbd44dbe1807d8913ff30e63fbca05864a95712065c10762056a`；Worker：`41ec1f29bb5593bb41eb4ccdfed90f62a0c6e1fca26d055e5b17ebc2eff01fe4`。
- 原配置 SHA256：`b130a60d69483856772c2dc588b696ad55c5f687f7b4fcc60137a09c91a6c77b`；原内容 SHA256：`033f3799994bcc70ba111d125c2839b1e18ccc5790abbbb06a595189c0fa986e`。正式及 Trace 包二者一致，内容为 3,324,293,364 字节。
- 正式构建日志 `web-engine-full-thread-20261101-130513.log`，SHA256 `40ad7dcb656ee6a618193f9197ac2bd4ebf66ce709eaf547114dbd6c0fc0ac87`；Trace 构建日志 `web-engine-full-thread-trace-20261101-131015.log`，SHA256 `900f8086d5d0a467eb24bc45412b3ea3e0d2195b36308ac538fa69c2186b01ba`，均成功。

结论边界：已修正可复用布局被拆散、常量零碎上传及诊断全局枚举的具体开销；布局和常量上传交错对照收益分别约 3.3% 与 1.0%，不应累加或外推。剩余主要证据仍指向每帧绑定整理和 WebGPU 命令桥接，独立线程已经启用。本轮没有达到目标帧率，亦未解决网页显存高于 PC 的历史问题；并发游戏运行时的测量不代表硬件独占表现。
