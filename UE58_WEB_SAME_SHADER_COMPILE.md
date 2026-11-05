# 相同着色器在浏览器与原生 DXC 中的编译耗时

2026-11-05。直接比较相同 HLSL 的编译成本。缓存容量和跨页面复用率是此前已确认的问题，本轮不以重新验证缓存容量作为优化发现。

## 实测结论

同一台 i9-12900K / RTX 4090 / 621.01 机器，Edge 156.0.4314.58。三个浏览器与原生交错配对，以下采用三轮中位数：

| 相同输入、相同 DXC DLL | 浏览器 GPU 进程 | 原生 Windows 进程 |
| --- | ---: | ---: |
| 30 次 DXC 编译累计耗时 | **557.63 ms** | **598.57 ms** |
| 最重的 PS，索引 23 | **64.23 ms** | **68.15 ms** |
| 次重的 PS，索引 15 | 38.70 ms | 41.04 ms |
| 重 VS，索引 24 | 35.35 ms | 37.48 ms |

没有测到浏览器内 DXC 对相同 HLSL 编译数倍变慢。约 7% 的差异没有进一步归因，不作为浏览器更快的普遍结论。两边都存在真实的几十毫秒编译计算。

本对照刻意串行执行，并关闭 Dawn blob cache 和 GPU shader disk cache，保证两边实际编译全部 30 个阶段，其中有 23 份不同 HLSL。**557ms 是受控批次的累计编译时间，不是游戏的一帧，也不等于上轮真实转向的 16 次 DXC 编译。** 强制关闭缓存后出现的相同输入重复编译，不能当成正常路径存在重复编译漏洞的证据。

原生端直接运行相同 DXC，未运行 UE 编辑器。这次回答的是“同一个着色器放到浏览器外编译需要多久”，没有将它冒充为编辑器实测帧时间或 UE 原始 HLSL 的编译时间。Web 的 WGSL/Tint 生成 HLSL 与原始桌面 UE HLSL 可能不同，减少转换后代码的编译复杂度仍值得单独调查。

## 输入与计时校验

使用上轮真实首次转向导出的 15 个 graphics PSO，保留 WGSL、布局、设备 features/limits 和渲染状态。corpus：`runtime-pso-detail-async-20261105-1-async-corpus.json`，SHA256 `36fb4978d632aa5d9ac5716b423e35dd86873a715a77432013590226af14e59a`。

独立导出轮启用 Dawn `dump_shaders`，得到 30 个 VS/PS 阶段实际送入 DXC 的 HLSL、入口、shader model 和反汇编 shader hash。该轮不用于性能结论。提取只移除 Dawn 日志包裹的两个换行，保留源码自身换行。

原生通过 `LoadLibraryExW` 直接加载 Edge 自带的 **1.9.2609.0** `dxcompiler.dll`，没有用另一份同版本号 DLL 代替。路径 `C:/Program Files (x86)/Microsoft/Edge/Application/156.0.4314.58/dxcompiler.dll`，SHA256 `4400daf60bd7fc84ca250bf843906dedac5ad4872bc532ceeae4e844bde032bd`。

目标均为 `vs_6_8` / `ps_6_8`，同一隔离入口。原生使用 `-T`、`-E`、`-opt-disable structurize-loop-exits-for-unroll`、`/Gis`、`/O3`、`/Zpr`、`-HV 2018`，与 [Dawn 参数构造](https://github.com/google/dawn/blob/main/src/dawn/native/d3d/ShaderUtils.cpp)对应。导出的标志严格检查为 row-major、IEEE strictness、O3。另以 `-HV 2021` 编译全部输入，30/30 shader hash 仍相同，批次约 600ms；这些输入不足以仅凭 hash 区分两种语言模式，日志未直接暴露该隐藏开关。

三轮原生输出 **90/90 DXIL shader hash** 与浏览器一致。这是 shader hash 校验，没有比较浏览器二进制容器的每个字节。正式浏览器计时关闭 shader dump，通过 `gpu.dawn` trace 提取 `CompileShaderDXC`；原生计 `Compile`、`GetStatus` 和 `GetResult`，读取文件、DLL 加载、校验及 DXIL 写出均在单次计时之外。

每轮浏览器新进程、新 device，串行请求 PSO。分析程序验证每份 PSO 恰有两个按顺序出现的 DXC scope，核对进程、线程和包含关系，再逐项配对。这个映射不能直接套用到并发 trace。计时前 GPU 各 engine 最大占用约 9%，无并行构建或 benchmark；CPU 未固定核心和频率，详细 trace 有开销，小比例差异未归因。

## 各轮结果与额外工作

| 轮次 | 浏览器 DXC | 原生 DXC | 浏览器 15 PSO 整体完成 |
| --- | ---: | ---: | ---: |
| 1 | 554.15 ms | 598.57 ms | 613.46 ms |
| 2 | 557.63 ms | 603.52 ms | 616.44 ms |
| 3 | 557.96 ms | 593.69 ms | 619.59 ms |

浏览器 Tint HLSL 生成累计中位数 **34.58ms**，约为管线阶段的 5.6%。PSO 初始化 scope 扣除嵌套 shader compile scope 后，中位数 **14.28ms**；该余量还含初始化、缓存和驱动工作，不能称为纯驱动创建时间。嵌套 scope 不能相加。

DXC 约占受控串行管线阶段的 90.5%。在“不改变生成代码、相同编译器/选项、仍须现场编译相同输入”的条件下，仅优化代理、回调、Tint 或 PSO 外围无法消除这部分计算。最重 PS 单次约 64ms；如果第一次发现时本帧就必须使用其正确结果，单靠异步 API 无法把依赖它的首次帧稳定到 16.7ms。

这不是整体 FPS 或帧时间的严格下限：任务可并行，可能命中缓存，可有提前量，生成代码也能改变。它给出当前输入的编译成本基线，用于区分必要计算与额外排队。

## DXIL 已就绪后的原生 PSO 创建

读取上述 DXIL，按捕获的顶点格式、渲染目标、混合、深度/模板、多采样和光栅状态构造 D3D12 管线，只计 `CreateGraphicsPipelineState`，没有 DXC 或 HLSL 转换。

| 原生 15 个管线，串行累计 | 第一次 | 同进程第 2 次 | 同进程第 3 次 |
| --- | ---: | ---: | ---: |
| 首次运行该诊断根签名 | **397.63 ms** | 14.01 ms | 6.30 ms |
| 重启进程 1 | **9.62 ms** | 6.64 ms | 6.53 ms |
| 重启进程 2 | **9.40 ms** | 6.96 ms | 7.02 ms |

首次最重调用 **80.11ms**。驱动持久缓存保留，没有清空全局驱动缓存，不能称为彻底冷启动。重启后降至约 9–10ms，符合首次驱动工作被缓存后减少。

该诊断用兼容的描述符表覆盖所需寄存器，**未逐字重建 Dawn 或 UE 根签名**，未提交绘制、未验画面。它是“DXIL 已就绪但驱动仍可能首次编译”的独立成本样本，不能把 398ms 或 9ms 当成 UE 原管线精确耗时，也不能与浏览器已暖驱动状态直接计算加速比。

本地 UE `D3D12PipelineState.cpp` 创建管线描述时直接取 `Shader->GetShaderBytecode()`。关闭 PSO 预缓存不等于清空已编译 shader：桌面可从字节码开始，网页当前却可能先做 WGSL → Tint HLSL → DXIL。编辑器转向更稳可由剩余工作不同解释；本轮没有复现用户那个编辑器会话。

## 两个术语的含义

“重复 DXC”包括：相同源码因缓存未命中再次编译；同一 WGSL 因布局、入口、跨阶段接口或后端选项产生不同 HLSL，分别编译。后一种不一定冗余。缓存容量不足的已有结论仍有效，本轮未证明消除某个变体就能提升正常场景 FPS。

“必要编译与渲染重叠”指新 PSO 后台编译时，让已就绪工作继续准备或提交，减少 GPU 空转。实验 Web 路径在整份命令列表翻译前等 PSO 依赖，以免 GPU owner Worker 同步等结果、而完成回调又必须回到该 Worker，造成自等待。桌面分支在使用点记录等待，允许较早命令先翻译；**先翻译不自动等于已经提交 GPU**，真正收益需要测提交边界和 GPU 时间线。

后续若改进重叠，应测等编译期间实际多提交了多少已就绪工作、GPU 空隙减少多少。首次可见且必须使用的新材质仍要有明确处理方式；丢绘制、替代材质、预先发现都会改变约束，不能悄悄混入本轮对照。

## 复现与证据

逐 shader 三轮数据、源码/DLL SHA256、原生 PSO 样本在 `tests/web-platform/evidence/same-shader-compile-20261105.json`。大体积原始导出和 trace 在忽略目录 `tests/web-platform/results/`。

```powershell
# 使用现有 Playwright NODE_PATH、8765 静态服务；tag 必须全新。
node tests/web-platform/benchmark-web-pso-corpus.cjs --corpus=tests/web-platform/results/runtime-pso-detail-async-20261105-1-async-corpus.json --tag=same-input-export-new --concurrency=1 --rounds=1 --profile=same-input-export-new --module-fence --dump-hlsl --disable-blob-cache --disable-cache
node tests/web-platform/diagnostics/extract-dawn-hlsl.cjs --log=tests/web-platform/results/same-input-export-new-0-hlsl.log --output=tests/web-platform/results/same-input-export-new

# 在 x64 VS 开发者终端构建；无替换浏览器 DLL 或引擎文件。
cl.exe /nologo /O2 /EHsc /std:c++20 /I .tools/dxc-v1.9.2609/inc tests/web-platform/diagnostics/benchmark-same-dxc.cpp /Fo:tests/web-platform/results/benchmark-same-dxc.obj /Fe:tests/web-platform/results/benchmark-same-dxc.exe /link ole32.lib

# 交错重复 i=1、2、3，文件前缀 bench-new 保持一致。
node tests/web-platform/benchmark-web-pso-corpus.cjs --corpus=tests/web-platform/results/runtime-pso-detail-async-20261105-1-async-corpus.json --tag=bench-new-browser-serial-1 --concurrency=1 --rounds=1 --profile=bench-new --module-fence --disable-blob-cache --disable-cache --browser-trace
tests/web-platform/results/benchmark-same-dxc.exe "C:/Program Files (x86)/Microsoft/Edge/Application/156.0.4314.58/dxcompiler.dll" tests/web-platform/results/same-input-export-new 2018 1 1 tests/web-platform/results/bench-new-native-serial-1.json tests/web-platform/results/bench-new-dxil
# 三对完成后：
node tests/web-platform/diagnostics/analyze-same-shader.cjs --inputs=tests/web-platform/results/same-input-export-new --prefix=tests/web-platform/results/bench-new --compiler="C:/Program Files (x86)/Microsoft/Edge/Application/156.0.4314.58/dxcompiler.dll" --output=tests/web-platform/results/bench-new-analysis.json

# 可选的 DXIL 就绪原生驱动样本。
node tests/web-platform/diagnostics/prepare-native-pso.cjs tests/web-platform/results/runtime-pso-detail-async-20261105-1-async-corpus.json tests/web-platform/results/same-shader-native-descriptors.h
cl.exe /nologo /O2 /EHsc /std:c++20 /I tests/web-platform/results tests/web-platform/diagnostics/benchmark-native-ready-pso.cpp /Fo:tests/web-platform/results/benchmark-native-ready-pso.obj /Fe:tests/web-platform/results/benchmark-native-ready-pso.exe /link d3d12.lib dxgi.lib dxguid.lib
tests/web-platform/results/benchmark-native-ready-pso.exe tests/web-platform/results/bench-new-dxil tests/web-platform/results/bench-new-ready-pso.json 3
```

已完成输入提取、两项原生构建、三轮交错计时、90 次 hash 断言及已就绪 DXIL 管线创建。运行时、默认调度、画质和 PSO 预缓存配置无修改。
