# TriplexHouseVilla：平台逻辑对照与计算 pass 复用实验

2026-11-06。**仍未达到浏览器、桌面端平均帧率和 1% low 接近的目标。** 本轮实现并实测了 C++ WebGPU 计算 pass 复用，静止采样平均提升 3.06%、1% low 提升 8.25%，移动收益很小且最坏 GPU 完成延迟增加。保留为默认关闭的实验，测试页提供独立开关包，不作为已验收发布优化。

## 同条件结果

i9-12900K、RTX 4090、可见 Edge 156；内部与输出 1280×720、TSR、GI/reflection method 0，保留场景阴影、距离场及透明体积光。t.MaxFPS=0、VSync=0；Web 始终 owner rAF、priority RHI wake、gpuahead=0。正式计时不运行 CPU profiler、trace、PresentMon 或 GPU completion hook。

| 版本 | 平均 FPS | 1% low | P99 ms | 最长帧 ms | RHI ms/帧 |
|---|---:|---:|---:|---:|---:|
| Web 同运行时，复用关闭 | 103.09 | 39.52 | 18.03 | 46.41 | 6.686 |
| Web 同运行时，复用开启 | 106.24 | 42.77 | 14.68 | 48.46 | 6.431 |
| 桌面 SM5，CSM 缓存开启 | 204.48 | 159.87 | 6.02 | 6.83 | 2.118 |

Web 按开启→关闭→关闭→开启依次采集，每窗 45 秒；两次关闭窗共用一个已预热进程。合并原始帧间隔计算，不平均四个 FPS，也不纳入跨窗间隙。1% low 是最慢 ceil(N×1%) 个间隔的均值倒数。没有剔除长帧。关闭/开启分别有 13/12 个超过 33.33 ms 的帧；**正常采样最长帧没有改善**。

此前桌面未开 CSM 缓存为 195.76 / 157.15。本轮补齐相同缓存配置，桌面 draw 2521→1190、ShadowDepths draw 1926→616；Web 复用开关两组均约 1351 draw、161 dispatch。缓存也是桌面可用优化，不能把它全算作 Web 后端收益。新 Web 的平均帧率仍低约 48.0%，1% low 仍低约 73.2%。

这些是 UE/RHI 帧间隔，不是显示器扫描输出 FPS。原生 CSV 正常写完、日志关闭后仍出现既有退出码 777003，不能称为完整生命周期通过。

## 逻辑差异与本轮证据

| 环节 | 桌面 D3D12 | Web 当前实现 | 含义 |
|---|---|---|---|
| 命令录制与提交 | D3D12Submission.cpp 有独立提交线程、队列及批处理 | 单 GPU owner 解释 RHI 命令，Wasm→JS→浏览器 GPU 服务；RHI 并行执行关闭 | 两边不是相同 C++ 后端只换输出 API。相近 draw 下 Web RHI 仍约三倍用时 |
| 计算命令 | 原生命令列表连续记录 dispatch | 原先每次 dispatch 都创建、结束、释放 compute pass | 本轮普通 compute pass 约 158→18/帧，保留全部 dispatch；独立 ClearStorageUAV pass 不合并 |
| 点光阴影 | 原生支持单 pass 点光路径 | ShadowDepthRendering.cpp 的 Web 路径逐六个立方体面绘制 | 相同阴影效果仍有不同工作量；不能只用 shader 功能名断言两边代价相同 |
| 帧驱动 | UE 游戏循环与原生呈现/线程协调 | Game 请求 owner rAF，再由 owner 回发 Game worker；浏览器另有合成背压 | 等待不能简单删掉；本轮未改帧驱动，也未增加预取帧 |
| 资源回收 | 原生对象和驱动生命周期 | 额外存在 JS GC、Blink cppgc 和浏览器 GPU 对象 | 需要同时看长帧、队列、完成延迟，不能只看吞吐 |
| 编译配置 | 原生工具链 | 本轮 BrowserDynamicRHI 等实际 rsp 为 -O2；最终链接仍保留既有设置 | 不是整个 Web RHI 用 -O0。历史最终链接优化曾出现画面错误，不能直接启用报收益 |

关键代码：`tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp`，`tests/ue-web-smoke/Source/UEWebEngine/Private/UEWebEngine.cpp:1525`，`reference-engine/Engine/Source/Runtime/D3D12RHI/Private/D3D12Submission.cpp`，`reference-engine/Engine/Source/Runtime/Renderer/Private/ShadowDepthRendering.cpp:1271`。

新的 owner 长帧采样中，正常诊断窗为 100.36 / 40.80，RHI setImmediate 交付排队 P99 约 0.03 ms；稳定期没有新增 PSO，纹理流送 pending=0。单独 25 秒 trace 中有 20 帧超过 18 ms，其中 14 帧与超过 4 ms 的 cppgc sweep 重叠。7 次 Major GC 为 3.53–5.54 ms，31 次 Minor GC 累计 63.8 ms。trace 自身会扰动长帧，尤其首次密集 sweep；这些是相关性证据，不能把每个卡顿全部归因于 GC，也不能将 trace 阶段 81 ms 最长帧当作正常基线。

## 实现与验证

新增 `r.WebGPU.ReuseComputePass`，默认 0。相邻直接/间接 dispatch 共用一个 compute pass；切换 pipeline 时重新绑定所需 groups、清空多余 slots。复制、渲染 pass、清除、查询解析、调试标记及 command encoder finish 前结束计算 pass。增加实际 opened/reused 计数，避免仅看到设置值却没有走新路径。

完整正常 Engine Target 编译链接通过；四个正常采样窗与两组 GPU 完成采样均无运行期 GPU 校验错误、设备丢失或未知管线失败。GPU 采样结束后额外执行 UE 原生纹理上传→复制→异步回读，24 字节图案校验两组通过，不混入计时。静止开关截图人工对照未见新增缺失；排除 HUD 后 RGB 平均绝对差约 0.342/0.345/0.438（0–255），仍不能据此证明动态阴影全程正确。

| GPU 完成专项（30 秒，独立于正常采样） | 关闭 | 开启 |
|---|---:|---:|
| 在途帧峰值 | 4 | 4 |
| 平均完成延迟 ms | 13.66 | 13.36 |
| 最大完成延迟 ms | 36.26 | 31.34 |

| 连续移动专项（30 秒） | 关闭 | 开启 |
|---|---:|---:|
| FPS / 1% low | 102.54 / 35.44 | 103.35 / 35.90 |
| 最长帧 ms | 56.43 | 45.98 |
| GPU 在途峰值 | 4 | 4 |
| GPU 完成平均 / 最大 ms | 13.02 / 39.21 | 13.06 / 45.32 |
| draw / 帧 | 1579 | 1608 |

两组均通过打包输入桥持续键鼠移动，行程约 2513/2515，转向累计约 1635/1644 度。实际轨迹与 draw 有差异，移动结果只作为回退检查，不能声称固定路线性能提升；特别是开启组最大 GPU 完成延迟更差。页面“观察帧”也不等于物理呈现验证。

## 网上方案核对

- [WebGPU 规范：资源使用域](https://gpuweb.github.io/gpuweb/#programming-model-resource-usages)：每次 compute dispatch 是独立 usage scope，render pass 则整体为一个 scope。这支持本轮相邻计算派发复用；不能据此直接把所有渲染 pass 拼起来。
- [Chrome：从 WebGL 到 WebGPU](https://developer.chrome.com/docs/web-platform/webgpu/from-webgl-to-webgpu)：GPU 驱动位于独立进程，同步等待会造成流水线空洞。本轮保留异步回读，GPU completion 仅用于专项测量，没有逐帧同步阻塞来美化低帧。
- [Chromium RenderingNG 架构](https://developer.chrome.com/docs/chromium/renderingng-architecture)：worker、compositor、Viz 分属不同阶段，提交完成与呈现并非同一事件。查阅的 [Chromium worker rAF 源码快照](https://chromium.googlesource.com/chromium/src/+/78c3f601c9b3851be1810f3c3f885167a134b6af/third_party/blink/renderer/core/animation_frame/worker_animation_frame_provider.cc) 也展示了 OffscreenCanvas 在途过多时推迟回调的设计；该快照不是本机 Edge 精确修订号，不能当作本机调用栈证明。
- [Chrome 149–150：immediates](https://developer.chrome.com/blog/new-in-webgpu-149-150)：小型动态参数可直接传入 encoder，减少 uniform buffer/bind-group 管理。本机 Edge 实测 `immediate_address_space`、`setImmediates`、64 字节上限可用，GPU 计算回读 [21,24,27,30] 正确。尚未改变 UE shader ABI 或 Cook，**没有宣称这项已带来收益**；大块灯光常量仍需 buffer。
- [Epic：Movable Light](https://dev.epicgames.com/documentation/en-us/unreal-engine/movable-light-mobility-in-unreal-engine)：动态阴影代价随受影响网格与三角形增加。缓存和减少重复编码值得继续处理，但关闭阴影、减少灯光或降低分辨率不属于本轮等价优化。
- [Emscripten 优化说明](https://emscripten.org/docs/optimizing/Optimizing-Code.html)：编译与最终链接优化是不同阶段。已核对真实 rsp；历史链接优化画面问题见 `UE58_WEB_BUILD_OPTIMIZATION_AUDIT.md`，不重复启用有已知回退的设置。

后续有依据的方向是减少重复阴影/渲染 pass 编码、针对小常量评估 immediates，以及继续拆解 owner rAF 与 GC 造成的长帧。RDG 原有渲染 pass 合并受 tiled-GPU 条件控制；需要独立验证资源使用域和阴影正确性，不能靠伪报 tiled GPU 能力直接开启。

## 复现与交付

测试入口：[本地性能回退检查](http://127.0.0.1:8765/villa-parity-test.html)。两个主入口为同运行时的复用开/关；保留上一轮候选、最初基线以及单独关闭 CSM 的入口。默认功能开关仍关闭。

证据汇总：`tests/web-platform/evidence/villa-compute-reuse-20261106.json`，通过 `node tests/web-platform/summarize-villa-compute-reuse.cjs` 重算。内含原始 CSV/JSON/截图哈希、两种 GPU 测量、移动结果、编译结果与限制。原始数据位于 `tests/web-platform/results/`。旧轮构建报告在重建前复制到 `parity-before-compute-reuse-build-20261106.json`，哈希与旧证据完全一致，避免覆盖后丢失旧构建身份。

构建：`build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4`。没有修改 `H:/UE_5.8`，没有改动桌面包，没有使用本地 Game 时钟，没有以降低画质或提前渲染更多帧换取成绩。
