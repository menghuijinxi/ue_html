# Web Low 帧统计修正与 PSO 长帧调查（2026-11-02）

本轮修正了实时面板的采样来源和窗口，并复现了首次转向时的严重长帧。证据支持优先处理首次使用的管线准备；尚不能把所有低帧都归因于 PSO。本轮没有实现 PSO 预编译，也不把面板数字改变作为性能提升。

## 统计口径

NVIDIA 的公开 FrameView 文档将 1% Low 定义为最慢 1% 帧的平均表现，并与百分位 1% FPS 区分。文档没有公开 NVIDIA App 面板的完整实时窗口实现，因此这里参考其定义，不宣称逐位复刻 App。

旧的未提交面板以页面 rAF 观察帧计数变化，保留 30 秒长窗口：会混入页面调度延迟、合并多帧，也会让旧卡顿长时间影响当前读数。尾部均值公式本身并不意味着显示 10 FPS 就一定算错。

新面板：

- FPS 使用 RHI owner 每次完成 viewport 提交的时间戳，显示最近 1 秒计数；1% Low 使用最近 5 秒、至少 100 个完整间隔。
- 对 N 个间隔取最大的 `ceil(N × 0.01)` 个，`Low = 1000 / 平均帧间隔毫秒`。单独显示 P99、最长间隔和帧时间曲线。
- 隐藏页面时清空并暂停，恢复时重新采样；提供重置。旧长帧会在 5 秒后退出实时 Low 窗口。
- “导出”保存最近 30 秒的逐帧间隔、管线创建事件，以及每 100 ms 的线程、IO、纹理流送、PSO 累计上下文。

这些是引擎提交间隔，不是 PresentMon/FrameView 的显示器实际呈现时间。异步管线 API 的事件记录调用起止，不能当成后台编译完成时刻。

## 原设置下的采样

Edge 有窗口运行，NVIDIA Lovelace，画布 2290×1288、场景内部 1484×835；原始出生位置，依次旋转 0/90/180/270/0 度，每个方向 5 秒，然后重复同一组方向。使用 `villa-binding-groups-v4` 的原 Cook、Wasm 和配置；仅替换网页诊断辅助脚本。

以下 Low 为各整段最慢 1% 的平均值，**不同于 HUD 的滚动 5 秒 Low**：

| 阶段 | 时长 | 平均提交 FPS | 整段 1% Low | 最长间隔 | 新图形 PSO |
| --- | ---: | ---: | ---: | ---: | ---: |
| 固定视角 | 30 秒 | 51.51 | 28.65 | 51.47 ms | 0 |
| 首次巡回 | 25 秒 | 72.45 | 18.04 | 361.85 ms | 15 |
| 重复巡回 | 25 秒 | 71.79 | 24.25 | 61.10 ms | 0 |

首次巡回的滚动 5 秒 Low 最低为 **6.11 FPS**，重复巡回最低为 **18.57 FPS**。首次阶段新增 6 个 shader module；重复阶段无新增 shader module。固定视角阶段没有新增管线或磁盘读取。这样已复现用户描述的“平均帧率尚可、Low 很差”，不能通过改统计掩盖。

原始文件位于 `tests/web-platform/results/`：

- `stutters-20261102-headed.json`：无 CPU 采样器的逐帧记录、首次/重复巡回和所有管线创建事件。
- `stutters-20261102-headed-chrome-trace.json`：固定视角的浏览器时间线。
- `stutters-20261102-tour.json` 与 `stutters-20261102-tour-chrome-trace.json`：另一次巡回的浏览器 GPU 进程和 CPU 采样时间线。
- `live-fps-20261102-v3.json`、对应截图和 `-export.json`：最终面板验证，固定视角 owner 计数约 53.39 FPS，显示 Low 29.85；移动段末 Low 38.07，无运行时错误。

自动测试用 Focus Emulation 防止测试窗口失去焦点后被浏览器调度降速。此前未启用它的有窗口测试约 24 FPS，不应作为正常前台性能结论。浏览器本轮 rAF 超过 300 Hz；代码使用 `emscripten_set_main_loop_arg(...,0,...)`，没有统一锁 60 FPS。

## 最长停顿发生在哪一层

第二次捕获中，首次巡回帧 2996 的提交间隔为 **410.31 ms**。GPU 进程 `CrGpuMain` 上对应的 `WebGPU → CommandBuffer::Flush → WebGPUDecoderImpl` 任务耗时 **391.15 ms**，线程 CPU 时间约 **389.72 ms**。任务范围为 Chrome trace 时间戳 `224772569341` 至 `224772960494` 微秒；帧标记为 `UE long frame 2996 410.3ms`，时间戳 `224773014187`。

15 个新 PSO 在此前数帧创建，JavaScript API 调用仅约 0.005–0.04 ms；因此只看 C++/JS 的 create API 用时会漏掉浏览器 GPU 进程的后续工作。这是 GPU 服务进程消耗 CPU 的任务，不是 GPU 着色器执行了 391 ms。该任务里还出现了 13 次 `DawnCachingInterface::CacheHit`，所以“浏览器完全没有缓存”也不准确。

固定视角的 20 秒时间线中 Minor GC 最长 1.71 ms、Major GC 最长 3.89 ms；并没有出现足以解释数百毫秒停顿的 JS GC。每帧约 54 个新 WebGPU Buffer 是后续优化候选，但本轮证据不足以把它判为严重 Low 的主因。

GPU 时间线尚未细分到 Tint / DXC / 原生驱动 PSO 创建函数，不能声称已经证明某一个编译阶段独占全部 391 ms。首次出现、随后 GPU 服务长任务、相同视角重复后停顿消失的组合证据，与首次管线编译/准备高度吻合。40–60 ms 的剩余波动仍待继续定位。

第二次捕获启用了 V8 CPU 采样，采样器启动本身产生约 0.5 秒开销；首次巡回前已结束该启动。该轮只用于定位，不用于宣传平均 FPS。后续捕获脚本已移除该自动 CPU 采样类别，保留 GPU 进程任务时间线。第一轮未启用 CPU 采样也出现了 361.85 ms 停顿。

## 与 UE 和 WebGPU 实现的对应

UE 的运行期 PSO 缓存仍在使用。当前后端缺少完整提前收集、异步预编译和可复用文件缓存接入：`GRHISupportsPSOPrecaching` 只随诊断参数开启；正常记录 `psoPrecaching=false`。此前单独开启诊断开关会触发创建 shader 的线程约束，不能直接把该开关当作修复。

WebGPU 规范明确：`createRenderPipeline()` 立即返回句柄，但实际创建并非同步完成；停顿可以推迟到首次 setPipeline / finish / submit。`createRenderPipelineAsync()` 在可以无额外编译延迟使用时才完成 Promise，适合提前准备。这与本次 API 很快、GPU 服务进程随后卡顿的现象一致。

优先实现方向是复用 UE 的 PSO 收集/预缓存调度，把创建请求交给 WebGPU owner，在加载期间提前异步准备，再向 UE 报告完成；完整描述必须覆盖 shader、vertex layout、RT/depth format 和渲染状态。只提前加载 shader、只打开一个 cvar、或每次首次 draw 才异步创建，都不能保证避免首次使用等待。不能从 D3D12 直接搬运原生 PSO 二进制给 WebGPU。

类似实现方面，Three.js 的 `compileAsync` / `compileComputeAsync` 提供提前编译路径。three-gpu-pathtracer #889 报告了首帧同步 compute pipeline 编译导致长停顿，#893 已合入对应预热路径；该项目经验还指出预热必须匹配最终资源布局和实际 WGSL。它支持上述方向，但其性能数字不是本项目的验证结果。

## 验证与复现

最终测试包：`http://127.0.0.1:8765/build/villa-live-fps-v3/index.html`。运行时、Wasm、Cook、配置文件 SHA-256 与基线一致。面板验证覆盖真实场景、移动、原诊断 accessor 共存、JSON 下载、尾均值与 P99 区分、停顿保留及五秒后恢复。测试宿主没有真正将后台标签标记为 hidden，因此另行显式测试 visibility 事件处理器；不把它表述为已验证操作系统后台节流。

设置 `NODE_PATH` 指向本机带 Playwright 的依赖目录后执行：

```powershell
node tests/web-platform/verify-web-live-performance.cjs --folder=villa-live-fps-v3 --tag=live-fps-check
node tests/web-platform/capture-web-stutters.cjs --folder=villa-live-fps-v3 --tag=stutters-check --trace=tour
node tests/web-platform/analyze-web-stutters.cjs tests/web-platform/results/stutters-check.json tests/web-platform/results/stutters-check-chrome-trace.json
```

## 参考

- NVIDIA FrameView 用户指南：https://images.nvidia.com/content/geforce/technologies/frameview/frameview-2-0-user-guide-web-version.pdf
- WebGPU pipeline creation 规范：https://gpuweb.github.io/gpuweb/#pipeline-creation
- UE PSO Precaching：https://dev.epicgames.com/documentation/unreal-engine/pso-precaching-for-unreal-engine
- Three.js Renderer：https://threejs.org/docs/pages/Renderer.html
- 相似项目报告：https://github.com/gkjohnson/three-gpu-pathtracer/issues/889
- 相似项目合入实现：https://github.com/gkjohnson/three-gpu-pathtracer/pull/893
