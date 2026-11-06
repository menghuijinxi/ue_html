# TriplexHouseVilla：渲染 pass 合并与命令回放分配对照

2026-11-06。**仍未达到浏览器、桌面平均帧率及 1% low 接近的目标。** 新增渲染合并静止收益很小，固定转向相对计算单项出现低帧回退，故不默认启用。本轮完成渲染 pass 合并、JS 回放数组复用、组合与固定路线实验；新开关均默认关闭。没有通过降低画质、改变 owner 帧驱动、放宽渲染提前量或丢弃异常窗口取得成绩。

## 普通采样

同机 i9-12900K / RTX 4090，可见 Edge 156，内部及输出 1280×720、TSR、GI/reflection method 0，阴影及 CSM 缓存开启。Web 使用 owner rAF、priority RHI wake、gpuahead=0；t.MaxFPS=0、VSync=0。浏览器自身呈现调度仍然存在。普通采样不运行 profiler、trace、GPU completion hook 或 PresentMon，逐组执行，与编译错开。

| 实验 | 关闭 FPS / 1% low | 开启 FPS / 1% low | 关闭 / 开启最长帧 ms | 判断 |
|---|---:|---:|---:|---|
| 仅渲染 pass 合并 | 100.49 / 38.63 | 89.36 / 33.57 | 43.20 / 65.12 | 不接受 |
| JS 回放数组复用 | 100.55 / 38.24 | 98.89 / 38.76 | 46.59 / 74.38 | 不接受 |
| 计算与渲染 pass 组合 | 100.39 / 38.34 | 104.23 / 44.18 | 46.59 / 45.08 | 仅保留实验 |
| 桌面 SM5 + CSM 缓存复测 | — | 234.49 / 182.37 | — / 6.39 | 未改桌面包 |

组合相对其同运行时关闭组，平均提升约 3.83%，1% low 提升约 15.25%，RHI 6.863→6.608 ms/帧。但相对本轮桌面仍有约 55.6% 的平均帧率差距、75.8% 的低帧差距。桌面本次高于上轮 204.48 / 159.87，表明运行间存在波动；两次都保留，不能只挑较慢桌面作比较。

另外补测相同新运行时仅开启计算复用，两个 45 秒窗口合并为 **103.84 / 42.41**，最长帧 48.35 ms。组合相对计算单项平均只高约 **0.37%**、1% low 高约 **4.19%**，不能把组合相对全关组的收益全部算作新增渲染合并贡献。这是顺序补测，尚非多轮配对的稳定收益证明。

渲染合并、数组复用均采用开启→关闭→关闭→开启，每窗 45 秒。渲染合并第一窗只有 77.03 / 29.38，第二窗 101.68 / 40.10；**两窗都计入**。随后观察到后台活动，但观察发生在第一窗结束后，不能据此断言该窗口受后台影响而删除结果。组合为连续两个 45 秒窗口，对照包括同运行时此前两个关闭窗口及组合之后的一个 45 秒复测，共三窗；这些不是三对独立配对试验。

全部从原始帧间隔重算，合并时不计跨窗口间隙。1% low 定义为最慢 ceil(N×1%) 个间隔均值的倒数。组合 90 秒内有 7 个 >33.33 ms 的间隔，对照 135 秒内有 16 个，不能直接按次数比较。未移除正常测量中的任何长帧。

## 具体差异与实现

1. **渲染 pass 合并。** UE RDG 原先只在 tiled GPU 条件下启用现成合并。本轮新增 `r.WebGPU.RDGMergeRenderPasses=0`，仅 Web 显式开启时使用 RDG 的附件、load/clear、资源依赖检查，没有伪报 tiled GPU。单项及组合中实际渲染 pass 约 276→245/帧，减少约 11%；剩余 pass 不能绕过清除、附件及非 raster 依赖边界强行合并。合并条件也影响 RDG async-compute 判定；当前 Web 的 `SupportsEfficientAsyncCompute` 本来为 false，并非通过关闭原有异步 GPU 路径提速。
2. **组合减少创建量但不等于同幅度提速。** 既有 `r.WebGPU.ReuseComputePass` 与新合并开关组合后，普通 compute pass 约 158→18，约 161 次 dispatch 和约 1350 次 draw 均保留。RHI 只减少约 0.255 ms/帧，说明 pass 创建并非全部瓶颈。
3. **回放数组分配。** `ueWGPUReplay` 原先每次都创建对象引用数组。试验通过 `__webReuseReplayScratch` 复用最多两个、每个最多保留 1024 槽的数组；嵌套回放使用独立数组，`finally` 清空引用，异常也不会留住 GPU 对象。实际预热后复用同一数组，分配下降没有转成吞吐收益，故开关保持关闭。它不消除浏览器 GPU 包装对象及 cppgc 成本。
4. **提交与等待不同。** 桌面日志确认 `r.FinishCurrentFrame=0`，`D3D12Viewport.cpp` 对应等待上一帧 GPU 完成再发下一次 frame event。Web 是 owner rAF 驱动 Game worker，单 owner 执行 RHI，浏览器另有合成背压。两种帧间隔不是物理呈现间隔；不能靠取消 owner 等待追平报表。
5. **输出及阴影工作量仍不同。** Web 使用稳定 backbuffer，在 owner 同一任务中获取 canvas 当前纹理、复制并提交；原生直接走 swapchain。Web 点光阴影逐六面绘制，中间深度纹理与复制也有额外成本。桌面本次约 1190 draw/帧、RHI 1.870 ms/帧；Web 约 1350 draw、RHI 6.608 ms。尚未量化这些差异各自占多少，不能将剩余时间全部归因于 JS 或 owner 通信。

源码位置：`reference-engine/Engine/Source/Runtime/RenderCore/Private/RenderGraphPrivate.{h,cpp}`、`RenderGraphBuilder.cpp`；`reference-engine/Engine/Platforms/Web/Build/WebGPUCommandStream.js`；`tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp`、`WebGPUViewport.cpp`；`reference-engine/Engine/Source/Runtime/D3D12RHI/Private/D3D12Viewport.cpp`；`reference-engine/Engine/Source/Runtime/Renderer/Private/ShadowDepthRendering.cpp`。

## GPU 完成与画面检查

GPU 完成专项独立于上述普通采样，每组 30 秒：

| 指标 | 同运行时关闭组 | 组合 |
|---|---:|---:|
| 尚未收到完成回调的帧峰值 | 4 | 3 |
| 提交到完成回调平均 ms | 13.92 | 13.33 |
| 提交到完成回调最大 ms | 33.68 | 28.27 |

这不是精确的 GPU 队列长度或 GPU 执行时间，回调也受 owner 事件循环延迟影响。该次没有看到积压恶化，不能推出所有路线都已平滑。

打包输入桥连续键鼠移动，各预热和采样 30 秒：

| 指标 | 同运行时关闭组 | 组合 |
|---|---:|---:|
| FPS / 1% low | 100.42 / 33.66 | 112.22 / 37.29 |
| 最长间隔 ms | 61.38 | 57.98 |
| 完成回调在途峰值 | 4 | 4 |
| 平均 / 最大完成通知延迟 ms | 13.38 / 58.28 | 12.01 / 42.74 |
| draw / 帧 | 1647 | 1335 |
| 实际采样行程 / 累计转向 | 2536 / 1618° | 2711 / 1675° |

**上述 FPS 差不能作为移动性能收益。** 实际路线不同，组合 draw 约少 19%，测试仅能说明该次连续键鼠移动没有崩溃、明显提交积压或页面观察停滞。页面观察/提交比约 0.9995 / 0.9950，依然不等于实际显示；两组均有接近 60 ms 的长帧。

为排除路线偏移，给已有 `probe-web-scheduling-motion.cjs` 增加分辨率参数，使用既有 C++ Game Tick 相机插值器做同一路线测试。启动/重置时才发 RPC，不逐帧注入页面相机。保持 owner 调度，场景及画质一致，汇总核对三组相机起终点误差小于 0.1。此测试绕过 Pawn 碰撞，不测键鼠延迟；三版本各跑一遍、每段 20 秒，是回退筛查，不是统计稳定性证明。

| 固定路线，FPS / 1% low | 两项关闭 | 仅计算复用 | 计算 + 渲染合并 |
|---|---:|---:|---:|
| 首次穿行 | 105.80 / 38.21 | 109.19 / 40.84 | 110.24 / 43.81 |
| 预热后平移 | 106.44 / 40.34 | 108.69 / 35.91 | 110.49 / 41.53 |
| 预热后转向 | 94.17 / 38.88 | 96.85 / 41.58 | 98.07 / 38.99 |
| 重复穿行 | 110.79 / 40.20 | 113.69 / 39.71 | 114.10 / 42.12 |

首次穿行分别新建 1 个 shader module 和 2 / 2 / 6 个 render pipeline，单列保留；后三段各组均无新建管线或 shader。静止低帧收益没有普遍延续到移动：转向中组合相对全关组低帧几乎持平，相对计算单项 **1% low 下降约 6.24%，最长帧 42.01→49.29 ms**，虽然平均 FPS 约高 1.27%。计算单项平移也有 75.94 ms 长帧，完整保留，不能选择最佳路线报整体收益。组合因此继续作为默认关闭的回退检查入口。

渲染合并单项及组合均完成右、后、左、室内、返回出生点五机位截图对照。人工复核未见明显新增材质、光照、阴影缺失；组合对照排除 HUD 后各通道平均绝对差为 0.44–1.19 / 255，包含时域效果，不是精确像素等价证明。相同相机和画质均断言核对。两组组合专项还通过 UE 原生纹理上传→复制→异步回读，验证安排在计时后。

对照图：`tests/web-platform/results/parity-pass-combined-tour-comparison-20261106.jpg`，左为关闭组，右为组合；原始截图和数值一并留存。

本轮桌面与 Web 相同出生视角也做了人工并排复核，未见明显整体明暗、材质或阴影缺失差异；见 `tests/web-platform/results/parity-pass-native-web-view-20261106.jpg`。这仅覆盖该静止视角，不构成所有效果或动态帧的像素等价验收。

## 公开资料核对

- [WebGPU 规范：资源使用域](https://gpuweb.github.io/gpuweb/#programming-model-resource-usages)规定 compute 每次 dispatch 为一个 usage scope，整个 render pass 则为一个 scope。因此本轮保留 RDG 依赖检查，不把计算 pass 的合并策略直接套到所有 render pass。
- [WebGPU 规范：当前 canvas 纹理](https://gpuweb.github.io/gpuweb/#dom-gpucanvascontext-getcurrenttexture)及[自动失效任务](https://gpuweb.github.io/gpuweb/#automatic-expiry-task-source)说明当前纹理可能在后续任务前失效；不能将它当作可跨 owner 任务持有的常驻 backbuffer。本轮没有冒险删除中间纹理。
- [Chrome：从 WebGL 到 WebGPU](https://developer.chrome.com/docs/web-platform/webgpu/from-webgl-to-webgpu)说明跨进程同步等待会产生流水线空洞。这支持把等待和编码成本分别测量，并不支持无界提前渲染。
- [Chrome 149–150：immediates](https://developer.chrome.com/blog/new-in-webgpu-149-150)提供减少小型动态参数 buffer/bind-group 管理的方向。之前本机功能探针已通过，但它涉及 UE shader ABI 与 Cook 改造，本轮没有把功能可用当作已有性能收益。

## 验证、证据及边界

完整正常 Engine Target 构建链接通过，使用 `D:/UE_5.8` 工具与本地构建覆盖；未修改 `H:/UE_5.8`。新增数组复用验证覆盖命令顺序与资源一致、嵌套回放隔离、异常清理、分配上限、释放 GPU 引用。真实页面采样没有运行期 GPU 校验错误、设备丢失或无法解释的管线失败。

桌面 CSV 和日志完整写出后仍有既有退出码 777003，保留 `cleanExit=false`，不称作完整生命周期通过。物理屏幕呈现尚未获得可靠的采集证据，本轮不宣称消除了体感卡顿。

汇总脚本：`node tests/web-platform/summarize-villa-pass-experiments.cjs`；证据：`tests/web-platform/evidence/villa-pass-experiments-20261106.json`。包含所有窗口、移动和 GPU 数据、源码/日志/截图/构建报告哈希，核对组合、计算单项、数组开关包的 Wasm、JS、Cook 完全相同。`pass=true` 表示相应检查执行通过，`performanceAccepted=false`、`physicalPresentationValidated=false` 保留。

实验入口：[本地性能回退检查](http://127.0.0.1:8765/villa-parity-test.html)。所有新开关默认关闭，测试入口仅供继续排查回退。

参考引擎本地提交：`a160b6134`。外围构建覆盖、采集工具、证据和测试页在主仓库单独提交，未推送远程。
