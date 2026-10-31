# TriplexHouseVilla 默认视角性能捕获（2026-10-31）

本轮完成诊断工具和实测，供下一步决定优化方向。没有修改项目、画质开关、正式运行时或引擎代码，也没有逐提交进行 CPU 优化 A/B。原有 Game / Draw / RHI 的独立 Worker 已在调用栈中确认，但存在明显的串行等待和 RHI 提交开销。

## 直接查看

- [最终复核报告](http://127.0.0.1:8765/results/performance-capture-spawn-final.html)：DPR 1.25，修正 GPU 捕获为从一个呈现边界到下一个呈现边界。**完整帧 GPU 数据以此报告为准。**
- [较慢条件的早期报告](http://127.0.0.1:8765/results/performance-capture-spawn-dpr125-full.html)：原始出生视角，CSS 1863×1030、DPR 1.25。可复核 CPU 及 RHI API 数据。
- [DPR 1 早期报告](http://127.0.0.1:8765/results/performance-capture-spawn-window-separated.html)：同一出生视角，另一个捕获时段。包含三线程 CPU 火焰图、热点、RHI API 数量和 pass 编码时间。
- 原始文件保存在 `G:/UE_HTML/ue_html/tests/web-platform/results/`，报告内有下载链接。每个完整捕获包含 18 个 Worker 的 `.cpuprofile`、浏览器 trace JSON、报告 JSON、独立 HTML 和现场截图。

HTML 可以直接用浏览器打开；原始下载链接需要同目录的文件。当前 8765 服务提供报告和资源。网页正式入口仍是 `http://127.0.0.1:8765/build/triplex-project-distance-fields-threads/index.html`。

## 帧率及条件

所有测试均为可见 Edge，保持原始出生相机 `(410.736, -478.059, 156.648)`、pitch 0、yaw 89.999，启动后至少 90 个游戏帧再测。计数使用 **RHI 完成呈现次数 / 实际墙钟时长**。没有用游戏 Tick 回调数代替显示帧数。GPU 适配器报告 NVIDIA / Lovelace。

| 结果文件后缀 | CSS / DPR | 实际内部渲染 → 输出 | 未采样基线 FPS | API/pass 计时 FPS | CPU+浏览器录制 FPS |
| --- | --- | --- | ---: | ---: | ---: |
| `spawn-window-separated` | 1863×1030 / 1 | 1381×777 → 1832×1031 | 26.22 | 17.62 | 19.36 |
| `spawn-dpr125`（仅基线） | 1863×1030 / 1.25 | 1484×835 → 2290×1288 | 12.23 | — | — |
| `spawn-dpr125-full` | 1863×1030 / 1.25 | 1484×835 → 2290×1288 | 11.98 | 8.30 | 12.49 |
| `spawn-720p`（仅基线） | 1280×720 / 1 | 1280×720 → 1280×720 | 10.32 | — | — |
| `spawn-dpr1-repeat`（仅基线） | 1863×1030 / 1 | 1381×777 → 1832×1031 | 16.70 | — | — |
| `spawn-final`（最终复核） | 1863×1030 / 1.25 | 1484×835 → 2290×1288 | 16.04 | 11.40 | 15.97 |

未采样指未启用 CPU 采样和逐 API 计时，页面仍加载诊断 hook，并启用适配器支持的可选 timestamp-query。探针不是零开销。内部渲染尺寸由原有项目/运行时选择，表中的 DPR 是测试浏览器的显示条件，不是项目画质修改。

720p 那次的一秒区间最低 7.89 FPS；DPR 1.25 的仅基线捕获最低 9.74 FPS。已经复现明显的低帧率。**相同 DPR 1 的重复结果也有较大波动，不能仅凭这些跨时段样本断言 DPR 导致了倍数差异。** 机器负载、运行时状态与编译预热的贡献尚未隔离。

此前约 42 FPS 的测试使用客厅内固定相机和 1280×720，与本次出生点不同。用户桌面截图的 147 FPS、GPU 4.05 ms、1601 draws 也尚未与本次严格匹配相机、渲染分辨率和可见内容，所以不作为精确 A/B 倍率。

## 已确认的损耗点

### 1. Draw 在已经就绪的回读路径中等待整个 RHI 执行锁

两组完整捕获的 Draw 采样栈均出现：

```text
FDeferredShadingSceneRenderer::Render
  GPUMessage::FSystem::BeginMessageScope
    GPUMessage::FSystem::PollMessages
      FRHIGPUBufferReadback::Lock
        FDynamicRHI::LockStagingBuffer_RenderThread
          FRHICommandListImmediate::StallRHIThread
            pthread_mutex_lock → futex_wait
```

DPR 1 中该停顿约占 Draw 完整采样窗口 **60.4%**，DPR 1.25 中约 **72.6%**。这是互斥等待，不是 Draw 线程在计算阴影耗时相同的比例。

最终复核同一路径仍占约 **55.0%**，跨时段结论一致。

源码相互印证：

- `.tools/ue58-web-build-host/Engine/Source/Runtime/RenderCore/Private/GPUMessaging.cpp:131` 的 `PollMessages` 在 `IsReady()` 后调用 `Lock`。
- 同一构建源的 `Runtime/RHI/Private/RHICommandList.cpp:2364`：`GRHISupportsMultithreading` 为 false 时，即使 fence 已就绪，也会使用 `FScopedRHIThreadStaller`。
- `Runtime/RHI/Public/RHIGlobals.h:114` 的 `SupportsMultithreading` 默认 false；Web RHI 没有将其启用。
- `tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp:3027` 的 staging lock/unlock 还会同步代理到 GPU owner。

因此“独立 RHI 线程存在”和“RHI 对所有资源访问都支持并发”是两件事。不能直接把全局多线程能力设为 true；需要针对已完成 readback 的 CPU 快照和生命周期实现安全的无全局停顿访问。

Draw 还有 `RHICreateSamplerState → emscripten_proxy_sync → futex_wait`：两组分别约 **10.9% / 3.4%**。该创建函数当前主要保留 CPU 描述，实际 WebGPU sampler 在 `ResolveSampler` 才生成，值得审查代理和缓存。

### 2. RHI 大量重复绑定，WASM/JS 桥接和绑定组解析昂贵

默认视角两组每帧约有：

| 操作 | 每帧数量范围 |
| --- | ---: |
| `drawIndexed` | 5173～5208 |
| `setVertexBuffer` | 25795～25945 |
| `setIndexBuffer` | 5175～5210 |
| `setBindGroup` | 7937～7988 |
| `createBindGroup` | 260～293 |
| `writeBuffer` / `createBuffer` | 约 496 / 41 |
| `queue.submit` | 12 |

RHI 调用栈中 `SetDrawBindings` 的不同调用位置合计约占完整采样窗口 **57.8% / 60.3%**，其中 `CreateGroups` 约 **26.7% / 25.3%**，是包含关系。`_wgpuRenderPassEncoderSetVertexBuffer`、`bigintToI53Checked`、JS `setVertexBuffer`、分配器和绑定解析均可直接看到。

最终复核分别为 **57.1% / 26.9%**。

`WebGPUDynamicRHI.cpp:3290` 每次 draw 都重新遍历顶点流、解析组并设置绑定；indexed draw 另行设置 index buffer。已有缓存减少部分资源创建，但没有完整的 encoder 当前状态去重。这是保持相同图像进行优化的直接候选。

### 3. 阴影放大 CPU 编码负担，GPU 也有需要拆分的耗时

每帧四个目标标为 `WholeSceneShadowmap` 的 render pass，共约 **3927 次 indexed draw**，占直接 indexed draw 约 75%。名称来自目标纹理，不等于完整 UE RDG 事件名；四个 pass 的具体灯光/级联归属还需引擎 scope 标记确认。

在开启 API 计时的阶段，这些 pass 的 CPU begin/end 区间合计约 **29.6 / 63.2 ms 每帧**，是主要编码热点。**这些数值含诊断开销，不能当成未采样下的原生 Draw/RHIT 毫秒数。**

最终复核该目标仍有四个 pass、3928 次 draw，API 计时阶段 CPU 编码约 **44.7 ms/帧**。

最终复核在关闭 CPU 采样和 API 逐项计时后，从完整呈现边界捕获 GPU 时间戳：

- 三个单帧 GPU pass 合计 **16.65、15.60、15.93 ms**，首个 pass 到末个 pass 的跨度 **65.67、63.18、76.48 ms**。
- 每帧约 303～305 个 render/compute pass、4990～4994 次直接 draw，时间轴中有很长的 pass 间空档。
- 两个采样帧的 `ShadowMaskTexture` 区间分别约 **11.80 / 11.34 ms**，另一个帧的计算 pass 约 **10.29 ms**，计算 pass 的完整 UE 名称尚未映射。它们是需要继续复核的 GPU 耗时，不能直接认定全部帧时间都耗在 CPU。
- 四个 `WholeSceneShadowmap` pass 的 GPU 合计各约 **0.20 ms**，相对其 CPU 编码负担很小。

早期两个报告中约 3～5 ms 的 GPU 数据是在未严格对齐呈现边界的捕获下得到的，**不作为完整帧 GPU 结论**。最终工具已修正为在下一次呈现时启动查询，再在后一次呈现时结束。

GPU 空档符合 CPU 不能连续喂满 GPU 的现象；浏览器调度、其他进程的 GPU 竞争也可能贡献空档，尚未隔离。合计只覆盖 render/compute pass，不覆盖所有 copy 和间隔；时间戳区间可能包含 GPU 调度等待，不能直接当成硬件占用率。该证据支持优先处理 CPU 提交/同步，同时继续拆分长阴影遮罩/计算区间，不能据此给出最终帧率承诺。

另外，Web `DataDrivenPlatformInfo.ini:24` 的 SM5 路径仍声明 `bSupportsGPUScene=false`，RHI 也没有启用 parallel RHI execute。这可能影响批处理及并行能力，但尚未证明它们各自造成多少 draw 增量。不能靠直接修改能力标记来验证。

## 建议下一步的顺序

1. 对 encoder 内不变的 vertex/index/bind group 状态去重，减少 `CreateGroups` 的解析、临时分配和重复设置。先保持视角及所有项目设置不变做 A/B，并核对画面、移动、距离场及资源释放。
2. 在 Web RHI 实现已完成 staging readback 的安全 CPU 访问，避免 `GPUMessage` 无谓暂停整个 RHI；同时审查 sampler 描述创建的同步代理。验证线程生命周期和压力运行。
3. 统一桌面和 Web 的相机、内部渲染尺寸、预热时间，补桌面 Insights / GPU Visualizer 对照，再决定是否投入 GPUScene、实例化和并行命令翻译。
4. 为 Web compute 和 render pass 补齐 UE RDG 事件名称，复核完整帧中长阴影遮罩/计算区间，区分着色器执行与 GPU 调度等待。

这些是后续实施建议，本轮没有实施，等待用户判断。

## 重复捕获

先保持 8765 服务运行，然后在 PowerShell 执行：

```powershell
Set-Location G:/UE_HTML/ue_html
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/capture-web-performance.cjs --tag=review-spawn --width=1863 --height=1030 --dpr=1.25 --seconds=6
node tests/web-platform/verify-web-performance-report.cjs tests/web-platform/results/performance-capture-review-spawn.json
```

默认保留原始出生相机，默认使用可见 Edge。`--baseline-only --baseline-seconds=15` 只记录基线及一秒采样；`--camera=room` 才会显式切换旧的客厅诊断相机。不要同时启动多个使用同一测试浏览器配置的捕获。`profile-web-cpu.cjs` 也补充了 `--spawn`、尺寸、DPR、预热参数和采样外基线，便于旧数据的条件复核。

捕获分成基线、API/pass 计时、CPU+浏览器录制、GPU 单帧四段，分别显示开销。CPU profile 是约 1 ms 间隔的统计采样，包含 idle、等待和采集控制阶段；父子耗时不可相加。极少数 V8 原始负采样间隔在图形展示中按零处理，原始文件保留；前两组累计分别 26 / 67 微秒，最终复核 2223 微秒，占约 7 秒窗口不足 0.04%。验证要求该影响小于采样窗口的 0.1%。

打开 HTML 后切换线程、选择窗口和时间滑块，悬停/点击查看函数全名，热点框可筛选 `SetDrawBindings`、`PollMessages`、`StallRHIThread`，支持导出 PNG。原始浏览器 trace 或单个 `.cpuprofile` 都可导入 Chrome/Edge 的 Performance 面板，通过 Bottom-up / Call tree 进一步看调用关系。[Chrome 官方说明](https://developer.chrome.com/blog/profiling-cpu/)

当前 Web 构建 `UEBuildWeb.cs:36` 设置 `bEnableTrace=false`、`bForceEnableTrace=false`，因此不能声称已有可打开的 Unreal Insights `.utrace` 或完整 UE scope / task 依赖图。若需要编辑器同款事件精度，需另行接通 Web 的 Trace 采集、下载及命名事件。[Epic Timing Insights](https://dev.epicgames.com/documentation/en-us/unreal-engine/timing-insights-in-unreal-engine)

## 验证与版本

三组完整捕获均有 Game、Draw、RHI 实际线程栈（线程 ID 2 / 14 / 1），18 个 Worker profile 数据完整、浏览器 trace 可解析、三个 GPU 时间戳帧有效，无捕获到的页面异常或 WebGPU validation 错误。最终组另外修正了 GPU 帧的完整边界。报告已在 Edge 验证三线程切换、时间缩放、函数筛选、GPU 帧切换和 PNG 下载，并检查截图。诊断结果是短时捕获，不替代移动与长时间稳定性验收。

引擎仍为 `db3999522`，无本轮改动。正式包 WASM SHA-256 仍为 `cddb7ed5daa1948e718d35dd2ee8f947345ea2faee69255a8c92975547853223`，配置文件仍为 `b130a60d69483856772c2dc588b696ad55c5f687f7b4fcc60137a09c91a6c77b`。`performance-capture-spawn-window` 是早期合并采样原型，计时阶段未分离，应使用上述 `-separated` / `-full` 结果。
