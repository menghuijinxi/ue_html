# WASM64 WebGPU 调用桥接优化

2026-11-03：独立测试已将 WASM64 完整 CPU 前端调用从 **2.455 ms 降到 0.605 ms**，纯 JS 为 **0.550 ms**。录制循环已接近 JS，计入末批回放、finish 和 submit 后仍高约 **10%**，尚未完全达到 JS 的总成本。

接入 UE 后，同包四轮 A/B 的别墅平均帧率 **51.83 → 55.12 FPS（+6.34%）**，1% low **27.79 → 32.30 FPS（+16.22%）**。这是一次有效的局部优化，距离桌面端性能仍有较大差距。

测试页：[villa-command-stream-v36](http://127.0.0.1:8765/build/villa-command-stream-v36/index.html)。页面默认启用动态命令流，项目 Cook、画质和线程设置按原包使用。

## 根因与对照

原路径每个绑定调用都会经过 WASM64 C API → JS 包装器 → 浏览器 WebGPU。生成的包装器对指针、offset、size 等多个 i64 参数执行 BigInt 范围检查和 Number 转换，再通过指针索引表找 JS 对象。

例如 SetVertexBuffer 有 pass、buffer、offset、size 四次此类转换。相同的工作在纯 JS 中直接使用对象和 Number。生成规则可在工作区 Emscripten `src/jsifier.mjs` 的 `handleI64Signatures` 和最终生成 JS 中复核，单独关闭 ASSERTIONS 不会去掉这条 ABI 转换路径。

保持原 WASM 二进制、相同命令数量和输出，分别替换桥接环节，3200 draw 的录制循环约为：

| 实验 | CPU 录制循环 |
|---|---:|
| 原始 C API | 2.38 ms |
| 对象表换成普通对象 | 2.38 ms |
| 对象表换成 Map | 2.34 ms |
| 仅将 checked BigInt 转换替换为 Number | 1.50 ms |
| C++ 校验范围，热调用使用 f64 参数接口 | 1.18 ms |
| 每帧写入命令流，JS 批量调用 | 0.525 ms |
| 纯 JS | 0.530 ms |

这些是不同诊断构建的结果，不能把每项差额直接解释为互不重叠的成本。`number-*` 是刻意去掉范围检查的诊断实验，**未用于正式 RHI**。仅调整对象表效果很小，保留为排除依据。

## 实际实现

UE 仍负责构建 FRHICommandList、准备管线和绑定、决定绘制顺序。本次在 WebGPURHI 的 C API 调用处增加传输层：C++ 将本帧 pipeline、group、VB、IB 和 draw 参数写入线性内存，JS 分批读取并调用相同的浏览器 WebGPU 方法。

命令每帧重新生成，适用于变化的可见性和动态参数。没有复用前一帧的绘制结果，也不依赖 PSO 预缓存或 render bundle 命中。

- 每批最多 32768 个 f64 字、384 个资源租约、4096 个动态偏移元素；容量到界时按原顺序同步回放。每个实际调用线程按需分配约 256 KiB 命令区。
- 每批对唯一 pipeline/group/buffer 保留 C API 引用，回放完成后释放；dynamic offsets 在调用时复制，避免 UE 复用临时数组后参数改变。
- JS 一次解析该批的资源指针，批内使用紧凑索引；常见五调用序列合并解码，但仍发出全部五个 WebGPU 调用。
- viewport、scissor、stencil、查询、debug marker、executeBundles、pass end、finish、submit 等边界先回放，保持状态和操作顺序。间接绘制亦支持。
- 超过 JS 精确整数范围的 uint64 参数、超大动态偏移数组等回退到原 C API；`WGPU_WHOLE_SIZE` 保留 undefined 的原始语义。浏览器正常校验保留。
- `-WebGPUImmediateCalls` 是启动 A/B 入口。网页参数经入口程序显式传入 UE 命令行；启动日志确认实际模式，测试会检查，避免参数无效时比较同一路径。

实现位于 `WebGPUCommandStream.h`、平台 JS 库 `WebGPUCommandStream.js`，由现有 Emdawn UE port 链接。f64 单调用原型仅供独立实验，未叠加到正式 RHI。

## 独立正式结果

使用原测试的相同负载：每 draw 切换 pipeline、bind group、VB 和 IB，全部对象预建并预热。三轮中位数再取中位数，单位 ms。完整 CPU 前端逐帧相加 setup、draw、finish、submit 后取中位数，**包含最后一批回放**。

| 3200 indexed draws | 绘制循环 | 完整 CPU 前端 | 三帧一批摊销墙钟 |
|---|---:|---:|---:|
| 原始 WASM64 | 2.410 | 2.455 | 4.213 |
| 动态命令流 | 0.525 | 0.605 | 3.500 |
| 纯 JS | 0.530 | 0.550 | 3.464 |

完整 CPU 前端减少约 75.4%，相对 JS 的额外差距缩小约 97.1%。完整处理吞吐仍受浏览器后台、GPU 和完成通知影响，墙钟改善约 16.9%；不能从录制循环的倍数推导游戏 FPS。

1000 draw 时，命令主要在 pass end 回放，所以 drawLoop 约 0.03 ms 不能当作总成本。所有数量和四种模式的每轮原始值见证据；短 GPU 样本仍有时间戳量化，本轮 GPU 时间未作为改进依据。

独立正式测试共 3 路径 × 3 轮 × 12 组合，**108 个组合像素检查通过**。另一次有插桩的验证逐 pass 记录原生 WebGPU 方法数量和参数顺序哈希：原始与新路径各 984 个性能负载 pass 一致。插桩结果不用于性能数值。

动态命令流另外先执行 GPU 边界检查：提前释放 C API 资源、动态偏移数组立即复用、401 个 group 导致资源表分批、两种融合序列、普通/索引/两类间接绘制、whole-size、scissor 外像素。10k draw 负载覆盖命令区分批。均通过输出像素读回和正常 GPU 错误检查。

## 别墅同包 A/B

使用同一个 `villa-command-stream-v36` WASM，按立即调用 → 命令流 → 命令流 → 立即调用运行。每轮至少完成 90 帧后再预热 15 秒，采样 20 秒。完整线程模式：Game、Draw、RHI 独立，默认报告 4 核、3 个 UE 任务工作线程。

可见 Edge、CSS 2289×1287、DPR 1；实际输出 2289×1288，内部 1484×835，AA=4（TSR）。相机、项目设置与输出尺寸由脚本逐轮比较。PSO 显式批量预缓存关闭；没有画质开关实验。

四轮均使用已有 `-WebThreadingTest=full` 基准入口，它同时关闭异步 PSO 缓存合并以稳定线程对照；两组一致。普通测试页没有添加该基准参数，因此用户普通运行与本表还存在这项测试条件差异。六视角检查和另采的 RHI 性能栈使用普通默认页面。

| 项目 | 立即调用 | 动态命令流 |
|---|---:|---:|
| 两轮合并 FPS | 51.830 | 55.119 |
| 1% low | 27.795 | 32.303 |
| P99 帧间隔 | 28.500 ms | 26.085 ms |
| 超过 33.33 ms 的间隔 | 12 / 2072 | 7 / 2203 |
| 每帧 RHI 工作时间，两轮均值 | 15.017 ms | 13.980 ms |

逐轮 FPS 为 50.868 / 55.091 / 55.146 / 52.793。保留所有轮次，没有挑选最高值。绘制与遮挡结果仍随运行略变，逐轮 workload 记录在证据中，未声称逐 draw 完全相同。1% low 取整段采样最慢 1% 间隔的平均值再取倒数，和页面 HUD 的近五秒窗口不同；这些是 RHI 完成帧统计，不是显示器扫描输出测量。

另开默认包进行六个相机位置/朝向切换、回到出生视角并持续渲染，未记录到 GPU 校验错误、设备丢失或崩溃。默认视角 A/B 截图已人工检查，画面一致；这不是长期稳定性或全项目画质验收。

## 剩余热点

在恢复出生视角后，单独对 RHI 所在 Worker 采样约 6.08 秒。该采样不进入上述 FPS：

| 栈中包含的路径 | 占采样时长 |
|---|---:|
| SetDrawBindings | 28.87% |
| CreateGroups | 24.58% |
| 分配/释放路径 | 12.22% |
| 互斥锁实际 futex 等待 | 7.51% |
| 其中分配路径下的互斥等待 | 3.54% |
| 新 JS 动态命令回放 | 7.99% |
| idle | 21.21% |

这些是包含子调用的墙钟栈采样，**存在重叠，不能相加**。分配路径也包含等待，不能全部解释成计算成本。没有把此表等同于整帧占比或全机 CPU 利用率。

绑定准备现在比动态命令回放更值得继续调查：核查 CreateGroups 的重复资源遍历、已缓存绑定组的检查成本、临时 TArray 分配和共享分配器锁，寻找能正确复用准备结果的范围。继续减少每次 WASM→JS 调用仍可优化，但独立负载只剩约 0.055 ms 的差距，无法靠这部分单独补齐桌面端帧率。

## 参考与证据

查看了 [wasm_webgpu 实现](https://github.com/juj/wasm_webgpu/blob/main/lib/lib_webgpu.js) 的轻量绑定和 memory64 转换处理，以及 [Godot WebGPU 分支的实际驱动](https://github.com/hesperus-claude/godotwebgpu/blob/webgpu-4.6.2/drivers/webgpu/rendering_device_driver_webgpu.cpp) 对重复 VB/IB/group 绑定的缓存。该分支的 [命令流研究笔记](https://github.com/hesperus-claude/godotwebgpu/blob/webgpu-4.6.2/webgpu_notes/COMMAND_STREAM_RECORDER_PERF_OPTIM.md) 也提出批量跨越 WASM/JS 的方向；所查驱动仍直接调用 wgpu*，不能将笔记的预估当作已实现收益。本次实现和结论由自己的同负载对照验证。

- 入 Git 汇总：[draw-bridge-20261103.json](tests/web-platform/evidence/draw-bridge-20261103.json)，包含构建/源码哈希、各轮结果、验证、环境采样、RHI 栈摘要。
- 本地原始样本：`results/draw-bridge-final-v2.json`、`draw-bridge-api-equivalence-v2.json`。
- UE A/B：`results/villa-command-stream-v36-abba.json`，六视角及 profile：`results/villa-command-stream-v36-view-check*`。
- Runtime 构建、打包证据：`results/web-engine-full-thread-build-results.json`、`villa-command-stream-v36-package.log`；保留原 Cook 的 `d175ae4ae` Renderer 快照。
- v35 首次 A/B 在采样前发现测试参数未传入 UE，已拒绝作为结果；编译时的 UE `ensure` 宏冲突也已通过重命名修正。正式结果只用 v36。

环境与前轮一致：i9-12900K、RTX 4090、Edge 156.0.4314.58。正式采样未运行 UE/游戏/编译器，保留用户的 TGitCache、Oopz、音乐等后台活动；微测试一轮原始路径较慢，仍纳入三轮统计。结果包含干扰，不是独占机器的测量。

## 复现

在工作区根仓库运行；先保留原始构建，再构建命令流版本。若已有 `baseline-6a81d23`，使用已保存的原始文件即可，不覆盖旧证据。

```powershell
./tests/web-platform/build-draw-api-benchmark.ps1
New-Item -ItemType Directory tests/web-platform/build/draw-api/baseline-retest
Copy-Item tests/web-platform/build/draw-api/draw-wasm.js,tests/web-platform/build/draw-api/draw-wasm.wasm,tests/web-platform/build/draw-api/build-config.json tests/web-platform/build/draw-api/baseline-retest
./tests/web-platform/build-draw-api-benchmark.ps1 -CommandStream
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
# 需已有 serve.cjs 提供 8765 服务。
node tests/web-platform/benchmark-draw-bridge.cjs --tag=bridge-retest --rounds=3 --variants=baseline,original,js --baseline-build=baseline-retest
node tests/web-platform/benchmark-draw-bridge.cjs --tag=bridge-verify --rounds=1 --variants=baseline,original --baseline-build=baseline-retest --validate-calls

node tests/web-platform/benchmark-villa-threading.cjs --folder=villa-command-stream-v36 --tag=villa-bridge-retest --bridge=immediate,stream,stream,immediate
node tests/web-platform/verify-villa-command-stream.cjs --folder=villa-command-stream-v36 --tag=villa-bridge-views --profile-owner
node tests/web-platform/analyze-villa-threading-cpu.cjs tests/web-platform/results/villa-bridge-views-owner
```

`profile-draw-bridge.cjs` 用于另一次独立 CPU 采样诊断；需要函数名时先加 `-ProfilingNames` 构建。其结果与正常计时分开。`summarize-draw-bridge.cjs` 接受微测试、UE A/B、视角检查、API 校验四个 JSON 路径及输出路径，会核对正式微测试源码/二进制和 UE 包的哈希。
