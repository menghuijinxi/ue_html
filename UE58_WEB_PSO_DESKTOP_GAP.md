# 桌面与 WebGPU 首次 PSO 卡顿差距调查

后续已补齐相同 HLSL、相同 Edge DXC DLL 的原生对照，详见 [相同着色器编译耗时](UE58_WEB_SAME_SHADER_COMPILE.md)。三轮 DXC 累计中位数为浏览器 557.63ms、原生 598.57ms，90/90 输出 shader hash 一致；未发现浏览器内 DXC 对相同输入编译数倍变慢。该受控对照强制编译全部 30 阶段，不能与本文正常缓存路径的 16/17 次编译直接比较。本文缓存容量与跨页复用结论属于已有调查，不是新的优化收益。

2026-11-05，UE 5.8，Edge 156.0.4314.58，Windows / RTX 4090。使用上轮 v70 同一个 WASM、Cook 和画质，关闭 PSO 预缓存，保留 Game 本地时钟、有效遮挡历史与 priority 唤醒。没有修改运行时、项目配置或默认开关。

## 已确认的原因

本场景 Web 首次转向确实发生了昂贵的运行期 DXC 编译。桌面路径的 HLSL→DXIL 通常已在编辑器 shader 编译或 Cook 阶段完成，而当前 Web Cook 输出 WGSL 源码，浏览器还要解析、生成 HLSL 并用 DXC 生成 DXIL，再创建驱动 PSO。仅关闭 PSO 预缓存，不会撤销桌面端已经完成的 shader 编译。

因此，“相同复杂度的着色器在 Web 上是否编译得更慢”需要区分两件事：本轮确认 Web 在运行期仍做一段桌面通常已完成的编译；没有测得相同 HLSL、相同 DXC 版本和选项下两端编译器本身的速度比。不能把整段 200ms 长帧解释为单个着色器编译耗时。

| 阶段 | 本地 D3D12 路径 | 当前 WebGPU 路径 |
| --- | --- | --- |
| 编辑器编译 / Cook | DXC 输出 DXIL，运行时读取字节码 | HLSL→SPIR-V→WGSL，运行时仍是源码 |
| shader 交给图形后端 | 原生 shader 字节码 | WGSL 解析、验证、Tint 生成 HLSL、DXC 编译 |
| PSO 创建 | 驱动创建，可能复用 Pipeline Library / 驱动缓存 | 还要完成上述 shader 阶段，再创建驱动 PSO |
| 首次实际需要状态 | 未完成则 UE 异步依赖仍需等待 | 同样需要等待，且当前 UE 请求最多三路并行 |

本地源码依据：

- `reference-engine/Engine/Source/Developer/Windows/ShaderFormatD3D/Private/D3DShaderCompilerDXC.cpp`：调用 DXC，读取 `DXC_OUT_OBJECT` 到 `OutDxilBlob`。
- `reference-engine/Engine/Source/Runtime/D3D12RHI/Private/D3D12Shaders.cpp`：`InitShaderCommon` 从 shader code 读取原生字节码。
- `reference-engine/Engine/Source/Runtime/D3D12RHI/Private/Windows/WindowsD3D12PipelineState.cpp`：先尝试 `Library->LoadPipeline`，缺失时再 `Device->CreatePipelineState`。库是否启用及是否命中取决于运行配置，不能假设每次桌面创建都免费。
- `tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat/Private/WebGPUShaderFormat.cpp`：Cook 的 Tint 输出为 WGSL。
- `tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp`：读取 WGSL 并通过 `WGPUShaderSourceWGSL` 创建模块。

[微软 shader bytecode 文档](https://learn.microsoft.com/en-us/windows/win32/api/d3d12/ns-d3d12-d3d12_shader_bytecode) 与 [Dawn 编译实现](https://github.com/google/dawn/blob/main/src/dawn/native/d3d/ShaderUtils.cpp)支持上述机制。上游 main 仅用于解释路径；本机是否实际调用 DXC 由下面的 Edge trace 直接验证。

## 真实转向中的编译成本

为正常性能测试工具增加可选 trace 和真实描述符导出。trace 只在进入正式转向前开启，不采集 CPU profiler；有 trace 的帧时间不替代上轮无 trace 的四轮性能结果。

一次真实 UE 转向新增 15 个 graphics PSO、10 个 shader module。浏览器内部追踪观察到：

| scope | 次数 | 跨线程累计耗时 | 最大单次 |
| --- | ---: | ---: | ---: |
| PSO 后台初始化 | 15 | 346.16 ms | 72.76 ms |
| 其中 shader 编译路径 | 30 | 334.63 ms | 70.73 ms |
| 其中 DXC 编译 | 16 | 308.39 ms | 66.16 ms |
| 其中 Tint HLSL 生成 | 16 | 20.39 ms | 4.03 ms |
| 新 shader module 创建 | 10 | 15.36 ms | 3.94 ms |

DXC 约占后台管线初始化累计耗时的 **89.1%**；实际记录的 DXC 线程 CPU 时间为 306.14 ms，接近其 308.39 ms scope 耗时，支持这里存在真实编译计算，而非全部由回调排队构成。各行是嵌套 scope，不能相加；线程之间并行，累计耗时也不等于墙钟时间。

最多三项 PSO 初始化同时运行。15 项任务从第一项开始到最后一项结束跨越约 222.31 ms，实际任务执行区间的并集约 134.61 ms，二者差值还包含任务间空隙，不能全部归于编译器。这个带详细 trace 的长帧约 247ms，不能与上轮无 trace 的 205.28ms 直接比较收益。相同方向重复巡游没有新增 PSO，也没有 DXC 调用。

这证明当前卡顿同时受编译任务本身和请求依赖链影响。异步把编译移到后台，但刚转向就需要同一批新状态，相关命令仍不能提交。Web 的 GPU 所属 Worker 还必须返回事件循环交付完成回调；桌面分支允许在命令翻译中先执行较早命令，再在用到 PSO 处等待，当前 Web 为避免自等待而在翻译前等待整份命令列表，能重叠的工作也不同。

## 脱离 UE 后同批请求仍然慢

从实际首次转向导出相同 15 个请求、15 个完整管线描述和所需 23 个 WGSL 模块，总计 320129 字符，保留原设备 features、limits、布局及状态。模块总数包含初始镜头已用过的 shader，因而多于这次转向新增的 10 个模块。

在独立 Worker 重放，没有 UE、Wasm、场景渲染、资源 IO 或 pthread 代理。先用 `getCompilationInfo()` 等待模块解析/验证，再以三并发创建管线；它不代表 DXIL 已准备完成。每轮新开浏览器、创建新 device，保留浏览器与驱动缓存。

| 普通浏览器，沿用完整场景 profile | 第一轮 | 第二轮 |
| --- | ---: | ---: |
| 模块等待 | 21.85 ms | 21.63 ms |
| 管线阶段 | 142.63 ms | 144.53 ms |
| DXC 次数 | 17 | 17 |
| DXC 跨线程累计耗时 | 337.81 ms | 340.45 ms |
| Tint HLSL 生成累计耗时 | 25.41 ms | 26.20 ms |
| 模块准备、布局和管线合计 | 167.15 ms | 168.84 ms |

管线初始化累计耗时约 389.48 / 392.94 ms，扣除其嵌套 shader compile scope 后约 20.10 / 19.98 ms。这个余量仍含其他初始化和缓存处理，不能称为纯驱动创建时间。这里不需要 UE 就能复现大部分等待，排除了将全部问题归于引擎唤醒或代理回调的解释。

## 相同代码在缓存命中时可以很快

又使用一个全新的普通浏览器 profile，只运行这批 15 个真实请求，未添加任何浏览器启动参数。每轮关闭并重新打开浏览器，保持同一 profile，在退出前留出两秒供缓存保存。

| 普通浏览器，仅小批请求的 profile | 首次填充 | 重启第二轮 | 重启第三轮 |
| --- | ---: | ---: | ---: |
| 管线阶段 | 235.63 ms | **11.13 ms** | **11.42 ms** |
| DXC 次数 | 28 | **0** | **0** |
| 模块、布局、管线合计 | 272.43 ms | 24.00 ms | 24.20 ms |
| GPU 端 WebGPU 缓存 | 825880 B / 61 条 | 相同 | 相同 |

相同请求、代码、设备限制，在成功复用缓存后可以不调用 DXC。本轮首次填充只保证专用 profile 新建，没有清空系统/驱动全局缓存，不能称为彻底冷启动。

与之对应，完整场景 profile 的两轮 GPU 端缓存都为 **6288255 B / 445 条**，接近此前调查的 6MiB 容量，而两轮仍实际调用了 17 次 DXC。结合此前完整场景容量实验，当前数据支持缓存压力是跨次运行仍需重新编译的重要原因；本轮没有给每个具体 shader 的缓存键做逐条淘汰追踪，不能把所有未命中都断言为同一个原因。泛化的 `CacheHit` 事件不能代替 DXC 次数或具体管线命中证据。

另一个单独诊断采用进程内 GPU / 较大缓存，首次约 242.50ms，重启后约 11.66 / 11.51ms，DXC 同样归零；这些特殊参数没有加入产品页面，也不作为普通浏览器收益。普通小批 profile 已证明不必依靠这些参数才能正确命中。

[Chromium 的内存缓存实现](https://github.com/chromium/chromium/blob/main/gpu/command_buffer/service/memory_cache.cc)维护 LRU 并按容量淘汰；[Dawn 的 shader 缓存路径](https://github.com/google/dawn/blob/main/src/dawn/native/d3d12/ShaderModuleD3D12.cpp)未命中时执行 HLSL 生成和编译。磁盘有记录、某次出现通用 CacheHit，都不保证需要的 shader 编译结果可被此次创建取到。

## 结论和优化方向

桌面体验较平稳可以由已有 shader 字节码、当前会话已创建的对象及驱动缓存共同解释。编辑器禁用 PSO 预缓存，并不等于转动视角时从 HLSL 源码重新编译全部 shader。桌面端在 shader/驱动缓存未就绪时也可能卡顿；本轮没有复现用户当时编辑器会话，更没有证明桌面永远无此问题。

当前优先目标应是减少运行期重复 DXC 编译，确认真实用到的 shader/布局是否产生多余编译变体，以及改善必要编译与命令执行的重叠。单纯更换异步 API 已不能移除这些计算；不增加发现到使用的提前量，依赖这些 PSO 的帧仍需等待。[标准 WebGPU 的 shader 模块接口](https://www.w3.org/TR/webgpu/#dictdef-gpushadermoduledescriptor)接收 WGSL，网页不能直接上传预编译 DXIL 或修改浏览器内部缓存容量，相关优化需要继续在现有接口约束内验证。

本轮没有开启 PSO 预缓存，没有降低画质，也没有将实验异步路径设为默认。引擎与产品运行时代码无修改，仅增加诊断采集和分析。

## 复现和证据

汇总和原始文件 SHA256：`tests/web-platform/evidence/pso-desktop-gap-20261105.json`。完整原始 JSON、trace 和导出的真实 shader corpus 位于忽略目录 `tests/web-platform/results/`。

```powershell
# 先设置 Playwright NODE_PATH。每次使用新的 tag。
node tests/web-platform/probe-web-runtime-pso.cjs --folder=villa-runtime-async-pso-v70 --tag=pso-detail-new --modes=async --hold=1 --warmup=5 --trace=true --capture-corpus=true
node tests/web-platform/analyze-web-runtime-pso-detail.cjs pso-detail-new
node tests/web-platform/benchmark-web-pso-corpus.cjs --corpus=tests/web-platform/results/pso-detail-new-1-async-corpus.json --tag=pso-replay-new --concurrency=3 --rounds=3 --profile=pso-small-new --module-fence --browser-trace --settle-cache-ms=2000
node tests/web-platform/analyze-web-runtime-pso-detail.cjs pso-replay-new
```

新的 Dawn 详细 scope 位于 `gpu.dawn` 分类，旧 `disabled-by-default-gpu.dawn` 只有外围任务，遗漏真正的 DXC/Tint scope。工具同时记录两者。较大的 GPU service trace 使用逐行解析，避免 V8 单字符串长度上限。本文所有浏览器编译数字均为诊断数据，不能替代无探针的性能验收。
