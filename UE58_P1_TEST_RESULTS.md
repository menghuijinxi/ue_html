# UE 5.8 浏览器移植 P1 测试结果

后续材质图与 LocalVertexFactory 测试已完成，见 [P1 材质测试结果](H:/ue_html/UE58_P1_MATERIAL_TEST_RESULTS.md)。本文件保留 GlobalShader 批次的验证范围；该批次已在材质接入后重新回归通过。

测试日期：2026-10-14。

本轮接通真实 UE GlobalShader 预处理、Vulkan 编译器参数处理、SPIR-V、Tint/WGSL、浏览器参数绑定和 GPU 读回。结果支持继续开发 Web ShaderFormat；P1 完整阶段尚未完成，也没有打包出 UE 浏览器场景。

## 1. 结果与版本边界

| 项目 | 实测结果 |
| --- | --- |
| 原始注册 Shader | 56 个，全部 UE 原生编译成功 |
| 原始 Shader 直接转 WGSL | 40 个，全部绑定合约核对通过 |
| 原始 Shader 拒绝 | 15 个 typed-buffer Clear + 1 个数组层输出 VS |
| Clear 降级实验 | 额外 15 个，全部转换、参数合约和 GPU 读回通过 |
| Shader module | 每次浏览器运行校验 55 个 |
| Pipeline | 每次运行创建 50 次；覆盖绘制、compute、Canvas |
| 数值核验 | 每次 475,904 个，四组共 1,903,616 个 |
| 浏览器 | Chrome 155.0.8059.40、Edge 155.0.4283.45 |
| 视口 | 两浏览器各 1280×900、390×844，4/4 通过 |
| GPU validation / JS 错误 | 最终通过的四组均为 0 |
| 输入源码闭包 | 47 个文件，全部匹配目标分支 Git blob |

安装的编译主机为 `H:/UE_5.8`，版本 **5.8.0-55116800+++UE5+Release-5.8**。目标 fork 固定为 **5.8.3** 的提交 `396c9f059903aed5fec78ecd3d437a40c6415368`。

按 CRLF→LF 后的 Git blob SHA1 校验，安装 Shader 树有 1173 个文件匹配，18 个不匹配或不可用。**本批实际依赖闭包的 47 个文件全部匹配**。生成的 Uniform include、平台定义、C++ Shader 注册信息及编译器二进制仍来自 5.8.0，不能把它们当作 5.8.3 的完整构建证明。LocalVertexFactory 后续使用的 `GpuSkinCommon.ush` 属于差异文件，需要补齐目标内容后再验证。

本轮调用的是 Editor commandlet 内的真实 `IShaderFormat`，没有验证 ShaderCompileWorker 的跨进程输入/输出协议。Dawn/Tint 沿用 P0 锁定的 `v20261009.190412`；HLSL 编译使用 UE 内置 ShaderConductor/DXC，编译器 DLL 的 SHA256 已记录，不能把独立 DXC 1.9.2609 当作此轮编译器版本。

## 2. 实际接通的链路

```text
UE 注册的 FGlobalShaderType / permutation 0
  → ShouldCompilePermutation + SetupCompileEnvironment
  → GlobalBeginCompileShader
  → UE 平台定义、生成的 Uniform include、完整 Common.ush
  → Vulkan IShaderFormat PreprocessShader / CompilePreprocessedShader
  → UE ParameterMap + FVulkanShaderHeader + FShaderResourceTable + 原生 SPIR-V
  → SPIRV-Reflect 保存名字、descriptor、成员偏移
  → ShaderConductor/SPIRV-Tools --strip-reflect
  → Tint → WGSL + tint_info JSON
  → 核对 UE 参数、原生反射、WGSL 反射
  → 按 UE ParameterMap 写 Uniform，按反射绑定资源
  → Chrome/Edge GPU 实际执行、copy/mapAsync 读回、Canvas 截图
```

没有使用 P0 的精简 Common fixture，没有手写替代 WGSL，也没有靠删除出错的 Shader 源码来制造成功。预处理输出由 UE 自身进行死代码消除，因此保存的 HLSL 可以很短；输入仍然是完整 UE 环境。

测试工程仅生成 `tests/ue-shader-host` 内的项目模块。安装引擎和目标 fork 没有源码改动，没有提交或推送。

## 3. 参数绑定的实测合约

UE Vulkan 的参数索引不能统一解释成 WebGPU binding。本批核对并执行了以下映射：

| Shader / 参数 | 实际 Web 绑定或内存位置 |
| --- | --- |
| FScreenVS / DrawRectangleParameters | group 0、binding 0，48 字节 |
| PosScaleBias / UVScaleBias / InvTargetSizeAndTextureSize | 0 / 16 / 32 字节 |
| FScreenPS / InTexture、InTextureSampler | group 1、binding 0 / 1 |
| FScreenPSMipLevel / `$Globals`、InTexture、Sampler | group 1、binding 0 / 1 / 2 |
| MipLevel | `$Globals` 内偏移 0，UE 分配 16 字节、值占 4 字节 |
| Compute Clear / `$Globals`、ClearResource | group 0、binding 0 / 1；无 Uniform 的 Zero 变体资源在 binding 0 |
| ClearValue / MinBounds / MaxBounds | 常见偏移 0 / 16 / 32，scalar 变体值占 4 字节 |
| ClearReplacementPS / ClearValue | group 1、binding 0 |

松散值参数的 `BaseIndex` 是 Uniform 字节偏移；资源参数的 `BaseIndex` 是绑定位置；UniformBuffer 参数使用 `BufferIndex`。测试按参数类型区分处理，并与原生 SPIR-V 和 WGSL 对照。

Tint 最小结构大小可以小于 UE 预留的尾部对齐，例如单个 `MipLevel`。测试允许这个合法差异，但要求每个有效成员 offset/size 不变、UE 分配足够大。55 个成功转换 Shader 都通过核对。

## 4. 浏览器执行覆盖

- 六个 ScreenPS：普通采样、MipLevel、alpha 反转、sRGB、sRGB+Mip、2D array slice，64×64 全像素验证。
- 三组 Clear VS/PS：完整清屏、矩形边界、Depth 变体搭配 Zero PS，全像素验证；这里只确认 Depth 变体能编译执行，没有验证深度附件写入或遮挡行为。
- 25 个原始 Compute：结构化缓冲区，2D、2D array、3D storage texture，float / sint / uint / scalar / float4，带边界和无边界、Zero 输出。
- 15 个 Clear 降级 Compute：包含 scalar/vector、float/sint/uint、Zero、Bounds 和 LargeBuffer。
- LargeBuffer 分配 16384 个元素，带 Bounds 的变体以 `[128,2,1]` 展开；无 Bounds 使用普通一维 dispatch，按编译后的 64 线程组计算。
- Canvas 呈现由转换后的 UE Clear VS/PS 绘制，截图四点像素为 `[64,127,191,255]`，无空白或水平布局溢出。

`TScreenVSForGS_false_` 和 `FClearUAVRectsPS` 本轮只校验 Shader module，没有单独执行对应 pipeline。窄屏测试是 Windows 桌面浏览器视口，不是移动设备实测。

## 5. 已处理与未处理的障碍

### Google 反射扩展

真实 UE SPIR-V 带 `SPV_GOOGLE_hlsl_functionality1` 等反射扩展，Tint 原样读取会拒绝。先保存 UE ParameterMap 和 SPIRV-Reflect，再运行官方 `--strip-reflect` 优化 pass，转换成功。原生字节码保留为 `.native.spv`，剥离后的字节码为 `.spv`。

这项处理属于编译管线，可在主机 Web ShaderFormat 里固定实现。

### Typed Buffer：Clear 范围内的降级

15 个原始 Clear 使用 `RWBuffer`，Tint 拒绝 `SampledBuffer` capability。新增实验仅对这些已知 Clear Shader 设置：

```text
RESOURCE_TYPE = 4
THREADGROUPSIZE_X = 64
```

UE Shader 已有的分支生成 `RWStructuredBuffer`，不需要文本改写。所有降级变体的 ParameterMap 与原变体相同，资源位置不变，仅 descriptor 从 storage texel buffer 变成 storage buffer。GPU 读回全部通过。

LargeBuffer 原配置为 512 线程；实验使用 64，后续 RHI 必须使用**编译后的 workgroup size**计算 group count，并同步区分 wrapped/普通 dispatch。本轮仅实现测试器里的调度，没有改动 UE C++ 的 Clear 调用。

降级成立的范围为本批同类型、同 stride 的 Clear。它不覆盖任意 typed SRV/UAV、格式重解释、分量转换、3 分量结构布局或跨 Shader 共享资源的兼容性；不能直接作为整个 typed-buffer 系统的替代。

### 数组层输出：仍然拒绝

`TScreenVSForGS_true_` 使用 `SV_RenderTargetArrayIndex`，原生 SPIR-V 带 `SPV_EXT_shader_viewport_index_layer`，Tint 拒绝。该路径保留为已知拒绝。

后续需要 Web 平台能力门控及逐 layer/face 渲染等调用侧适配。删除这个输出本身会改变语义，本轮没有这样处理，也没有实现分层多 pass。

### 读写 Storage Texture：仍需能力门控

本批 RGBA32Float/Uint/Sint 转换为 read_write storage texture。显式请求 `texture-formats-tier2` 后全部成功；默认 Device 有 15 项被 GPU validation 拒绝，其余绘制/计算测试仍执行并留有记录。

正式 Web ShaderFormat/RHI 要提供明确 capability gate，或由编译器证明仅写之后改为 write-only 并同步布局。当前没有无条件改写访问权限。

## 6. 证据与复跑

| 证据 | 文件 |
| --- | --- |
| 输入源码、18 个差异文件 | [source verification](H:/ue_html/tests/web-platform/results/ue-shader-source-verification.json) |
| 原生结果、SPIR-V 反射、UE ParameterMap | [UE host results](H:/ue_html/tests/web-platform/build/ue-full/ue-host-results.json) |
| 转换、绑定合约、DLL SHA256 | [shader build results](H:/ue_html/tests/web-platform/results/ue-full-shader-build-results.json) |
| Chrome 最终通过 | [Chrome results](H:/ue_html/tests/web-platform/results/ue-full-chrome-results.json) |
| Edge 最终通过 | [Edge results](H:/ue_html/tests/web-platform/results/ue-full-edge-results.json) |
| 默认 Device 拒绝 | [default results](H:/ue_html/tests/web-platform/results/ue-full-chrome-default-results.json) |
| 修正 LargeBuffer 调度前的记录 | [dispatch failure](H:/ue_html/tests/web-platform/results/ue-full-chrome-dispatch-failure-results.json) |
| P0 harness 回归 | [regression results](H:/ue_html/tests/web-platform/results/p1-harness-regression-results.json) |
| 汇总与复跑 | [summary](H:/ue_html/tests/web-platform/results/summary.json)、[README](H:/ue_html/tests/web-platform/README.md) |
| 编译主机实现 | [commandlet](H:/ue_html/tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp) |
| 浏览器真实参数绑定 | [runtime](H:/ue_html/tests/web-platform/ue-shader-runtime.js) |

本地测试页：`http://127.0.0.1:8765/ue-shaders.html`。

## 7. 下一项验收

先补齐目标分支的差异 include，再加入 LocalVertexFactory、生成的 Material.ush、unlit/mobile material 和实际网格输入。确认其依赖、uniform/resource table、纹理采样与基础材质语义，再把当前编译实验整理为可注册、可缓存、可供 Cook 使用的 WebGPUShaderFormat。

之后进入 Win64 WebGPURHI 和 Web UBT/Runtime/Cook。当前独立浏览器测试不能代替完整 UE scene 的运行证明。

UMG/Slate 按已确认要求继续保留依赖；本轮未出现需要处理的 UMG 阻塞，没有改动任何 UMG 源码。
