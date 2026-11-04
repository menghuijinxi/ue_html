# 脱离 UE 的 DX12 / WebGPU 绘制调用对照

2026-11-03，同机独立程序测试完成。浏览器 / WebGPU 调用链存在明显的 CPU 成本，WASM64 C API 路径的成本尤其突出；不能据此认定别墅场景的全部帧率差距都由浏览器造成。

测试不链接 UE，不加载别墅资源，不修改项目画质或线程设置。DX12、原生 Dawn、浏览器 JS、浏览器 WASM64 均由一个应用线程录制命令，未限制驱动及浏览器内部线程。原生 DX12 在这种条件下仍明显更快，因此它的优势并不只来自 UE 并行构建绘制命令。

## 最终结果

以下为三轮各自中位数再取中位数，单位 ms。每帧 3200 个 indexed draw；每个 draw 调用前切换管线、uniform bind group、顶点和索引缓冲区范围。所有对象都已创建并实际预热。

| 路径 | CPU 绘制循环 | CPU 前端总调用 | GPU 时间 | 每帧摊销墙钟（3 帧一批） |
|---|---:|---:|---:|---:|
| 原生 DX12 | 0.320 | 0.355 | 0.373 | 0.559 |
| 原生 Dawn / D3D12 | 0.655 | 1.494 | 0.393 | 1.620 |
| Edge WebGPU / JS | 0.530 | 0.545 | 0.393 | 3.462 |
| Edge WebGPU / WASM64 C API | 2.365 | 2.410 | 0.459 | 4.230 |

“CPU 绘制循环”只计 `drawIndexed` 和循环中的四次绑定调用。“CPU 前端总调用”计本帧创建编码器、开始通道、设置状态、绘制、结束通道、finish、submit 在调用线程上的耗时之和，每帧先相加再取中位数。

浏览器的前端 API 会把工作交给后台执行，原生 Dawn 的 `submit` 本身会执行较多后端工作。因此 **0.545 ms 和 1.494 ms 不能用来认定浏览器完整处理比原生 Dawn 快**。摊销墙钟包含后台处理、GPU、调度和完成通知；每提交三帧后统一等待，不能当作游戏帧时间或显示 FPS。CPU 总时间和 GPU 时间也不能直接相加，执行可能重叠。

在这组命令下，WASM64 的录制循环约为 DX12 的 **7.40 倍**、纯 JS 的 **4.46 倍**。原生 Dawn 已比直接 DX12 有明显额外成本，浏览器后台链路和 WASM64 桥接又增加了成本。原生 Dawn 与 Edge 内置 Dawn 版本不同，这些差额只能用于定位方向，不能逐项精确拆成“校验占多少、IPC 占多少”。

不同调用数量的同一切换场景：

| indexed draw 数量 | DX12 录制 | 原生 Dawn 录制 | JS 录制 | WASM64 录制 | DX12 摊销墙钟 | WASM64 摊销墙钟 |
|---|---:|---:|---:|---:|---:|---:|
| 1000 | 0.102 | 0.209 | 0.155 | 0.720 | 0.187 | 1.986 |
| 3200 | 0.320 | 0.655 | 0.530 | 2.365 | 0.559 | 4.230 |
| 10000 | 1.001 | 2.024 | 1.655 | 7.185 | 1.683 | 10.765 |

上表按证据中的精确值四舍五入；完整数值及每轮结果以 JSON 为准。10000 draw 时，GPU 时间也有差异：DX12 约 1.38 ms，浏览器约 1.77 ms。不能推广成“所有负载 GPU 时间都一样”。

## 复用命令与减少 draw 的实验

命令包中包含同样的 3200 次绘制和全部绑定切换，最终像素也与直接录制一致。

| 路径 | 每帧重录切换命令的 CPU 循环 | 复用命令包的 CPU 调用 | 重录摊销墙钟 | 复用摊销墙钟 | 一次建包成本 |
|---|---:|---:|---:|---:|---:|
| DX12 | 0.320 | 0.0059 | 0.559 | 0.454 | 1.294 |
| 原生 Dawn | 0.655 | 0.0004 | 1.620 | 0.908 | 0.680 |
| Edge JS | 0.530 | 小于计时分辨率 | 3.462 | 1.915 | 0.610 |
| Edge WASM64 | 2.365 | 0.005 | 4.230 | 1.942 | 2.680 |

WASM64 复用命令包后，摊销墙钟减少约 **54.1%**，对应这组测试吞吐约 **2.18 倍**。GPU 时间仍约 0.46 ms，省去的是部分 CPU 录制、接口桥接和后台命令处理。原生 Dawn 复用后 `submit` 中位数仍有约 0.73 ms，说明命令包不会消除所有后端成本。

这是**同一次运行、同一设备上的命令包复用**，与首次启动或刷新页面后的 PSO 缓存无关。建包计时单独记录，不包含在逐帧复用时间中。

另有两个控制场景：

- 只绑定一次，连续 3200 次 draw：DX12 / JS / WASM64 录制分别约 0.021 / 0.040 / 0.195 ms。实际瓶颈不能只根据 draw 数量判断，绑定和状态切换成本明显更大。
- 一次 indexed instanced draw、3200 个实例：把应用层 draw 调用数降到一次，作为批处理参考。此项保持相同几何重复数量，但没有前述每个 draw 的材质/绑定切换，不能等同替换复杂场景。

## 对 UE 优化的含义

1. 优先核对 UE 每帧真正发出的 API 调用数，包括 PSO、bind group、顶点/索引缓冲区绑定，而不仅是 draw 计数。对稳定状态省去重复调用，对稳定绘制序列评估 render bundle。
2. 对 WASM64 到 JS 的桥接做单独 CPU 剖析。本次同一浏览器、同一负载中，C API 路径比 JS 多约 1.84 ms 的录制时间。对象查找、64 位参数转换、调用边界都值得分别验证；目前尚未测出各函数的独立占比。
3. 将 UE 的绑定准备、资源同步、RHI 锁等待与这里的独立基线分开测量。独立测试没有剔除 UE 实际场景需要的工作，不能把 4.23 ms 直接从 UE 帧时间中相减。
4. 若接入命令包，需要正确处理资源生命周期、可见性、动态绑定和失效重建。只有命令序列可复用时，才能取得本次模式 2 的收益；尚未在 UE 中实现或验收这项收益。

本轮交付是独立对照程序和测量证据，没有把独立样例的收益报告为正式 UE 包的帧率提升。

## 负载与计时方法

- 两个预先创建的管线、64 个预先创建的 uniform bind group；对应 DX12 descriptor table。uniform、VB、IB 的槽位间隔为 256 字节。
- 每次 indexed draw 为一个三角形，3 个顶点、16 位索引。64×64 RGBA8 render target、1×1 scissor，无深度、混合、剔除；按固定颜色及交换颜色两个片元入口切换。
- 四种模式：只 draw；逐 draw 切换四种绑定；复用包含上述切换的命令包；一次 instanced draw。每种模式分别测 1000 / 3200 / 10000 的几何重复数量。
- 每个组合先执行 12 个预热帧，再计 60 个 CPU 样本。最多提交三帧后排空队列；DX12 使用三个 allocator，确认 GPU 完成后再重置。每帧只提交一个 command buffer。
- CPU 计时阶段不写 GPU 查询。随后另取 10 帧 timestamp-query；范围包含 render pass 的 clear。读回、等待和像素验证不进入 CPU 录制样本。
- 每个组合都实际读回输出像素：检查最终绑定对应的颜色，同时检查 scissor 外仍是 clear。三轮共 **144 个组合全部通过**。同一 DX12 二进制另开 debug layer 跑 12 个组合，错误与警告检查通过；性能采样关闭该层。
- 三轮顺序为 DX12→Dawn→JS→WASM、反向、正向。各路径串行测试；原生每次新进程，浏览器每次新进程和新 profile，独立 Worker 录制，无主线程 WebGPU 代理。
- 没有 canvas/present、`requestAnimationFrame`、垂直同步和 FPS 限制。测试的是持续提交下的 API 成本，不测输入、显示延迟或 1% Low。
- DX12 和 Dawn 使用 Release；WASM64 使用 `-O3 -fno-exceptions -sASSERTIONS=0`。最终 WASM 用 JSPI 等待异步回调，绘制循环无 Asyncify 插桩，也不通过定时器轮询队列。默认构建需支持 JSPI 的浏览器；可通过构建参数选择 Asyncify 另做兼容性测试。
- 正式采样未开启浏览器 tracing、CPU profiler 或 GPU 后端附加开关。WebGPU 的正常运行校验保留。短路径的 GPU 时间可能因时间戳量化为 0，不代表 GPU 没有执行。

DX12 使用优化 HLSL、WebGPU 使用等价 WGSL，源语言和编译器不同，并不承诺二进制指令完全相同。只有单个小通道，没有纹理采样、UE 材质、光照、遮挡剔除、流送、实际屏幕分辨率；结果是定位基线，不是复杂场景上限或最低帧率保证。

## 环境与证据

CPU：i9-12900K，系统可见 24 个逻辑处理器。GPU：RTX 4090，驱动 32.0.16.2101。Edge 156.0.4314.58。原生 Dawn 与 Emdawnwebgpu 固定为 `v20261009.190412`。浏览器使用 Playwright 默认启动参数，未追加 GPU/CPU 开关；追加参数为空、命令行查询不可用的原因和 CDP GPU 信息均在证据中。

每 5 秒检查后台进程，采样期间没有检测到游戏、UE 编辑器、ShaderCompileWorker 或编译器。仍有 TGitCache（峰值接近一个逻辑核）、Oopz、音乐等后台活动；本次没有关闭用户应用，也没有独占 CPU/GPU。三轮原始值均保留，不能视为无干扰实验室结果。

- 提交保存的汇总：[draw-api-20261103.json](tests/web-platform/evidence/draw-api-20261103.json)，含三轮数据、源文件/二进制哈希、构建配置、环境采样。
- 完整原始样本：`tests/web-platform/results/draw-api-final.json` 与 `draw-api-final-r*-*.json`（本地保留，results 不入 Git）。
- 独立 DX12 验证：`results/draw-api-final-validation.json` / `.log`。
- 另做浏览器 trace 诊断：`results/draw-api-browser-backend-trace.json`。记录到 Dawn client flush、GPU 进程 `HandleDawnCommands`、服务端返回等阶段；未把 tracing 耗时混入正式结果。CDP 的 ANGLE / D3D11 字段描述浏览器 GL 路径，不能据此判断 WebGPU 也使用 D3D11。此次 trace 没有暴露可直接核验的浏览器 WebGPU 后端枚举，因此这里只把原生 Dawn 明确标为 D3D12。

最初用于开发检查的 `preflight`、`release-v1/v2` 结果包含不同的命令包或 WASM 运行库配置，最终报告统一使用 `draw-api-final`。它们保留在本地，不与最终三轮混合统计。

## 复现

在 `G:\UE_HTML\ue_html` 运行。依赖工作区现有的 MSVC、Dawn、Emdawnwebgpu、Emsdk；构建脚本固定版本，不修改 UE 安装目录。

```powershell
./tests/web-platform/build-draw-api-benchmark.ps1
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
# 若 8765 没有已有服务，在单独终端启动：
node tests/web-platform/serve.cjs
# 在另一个终端运行，tag 每次使用新名称：
node tests/web-platform/benchmark-draw-apis.cjs --tag=draw-api-rerun --rounds=3
```

原生校验与环境监控可按照本轮方式另外运行：设置 `DRAW_API_DEBUG=1` 执行 `build/draw-api/Release/draw_d3d12.exe` 并传入结果路径，然后恢复变量，再测性能。`monitor-web-performance-environment.ps1` 的 `-Output`、`-StopFile` 接受结果与停止文件路径；停止文件出现后结束。汇总脚本要求同 tag 的 `-validation.json`、`.log`，可选读取 `-environment.jsonl`：

```powershell
node tests/web-platform/summarize-draw-apis.cjs tests/web-platform/results/draw-api-rerun.json tests/web-platform/evidence/draw-api-rerun.json
node tests/web-platform/inspect-draw-api-browser.cjs
```

汇总脚本会校验测试时的源文件和二进制 SHA-256，防止把后续修改与旧结果混用。

实现依据：[WebGPU render bundles](https://gpuweb.github.io/gpuweb/#render-bundles)、[微软 DX12 command list / bundle 与 allocator 复用规则](https://learn.microsoft.com/en-us/windows/win32/direct3d12/recording-command-lists-and-bundles)、[Emscripten 异步回调与 JSPI](https://emscripten.org/docs/porting/asyncify.html)。
