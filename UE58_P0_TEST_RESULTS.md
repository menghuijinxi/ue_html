# UE 5.8 浏览器平台首轮实测

日期：2026-10-14。UE 源码：`html` 分支，提交 `396c9f059903aed5fec78ecd3d437a40c6415368`，版本 5.8.3。

**本轮 P0 独立 GPU/ABI 测试通过，P1 已完成初步 Shader 冒烟测试。完整 UE 场景尚未运行，WebGPURHI 和 UE Web 打包平台尚未实现。**

所有测试均在本机执行。浏览器直接运行编译出的 WASM 或生成的 WGSL，没有像素流或收费 Web SDK。UMG/Slate 依赖保持原状，本轮没有屏蔽引擎代码。

## 1. 实际结果

| 测试 | 结果 | 实际覆盖 |
| --- | --- | --- |
| Win64 Dawn GPU | 通过 | D3D12/RTX 3070；纹理索引绘制、Uniform、Compute、copy/map、离屏目标尺寸变化 |
| Win64 ABI | 通过 | 8 字节指针/size_t、结构体布局、双线程原子计数 20000 |
| Chrome | 12/12 通过 | 4 种 GPU 变体 × 2 个视口，加 4 种 ABI 变体 |
| Edge | 12/12 通过 | 同上 |
| 原生/浏览器像素一致性 | 通过 | 16 次浏览器 GPU 运行的两幅离屏图像哈希，全部等于原生结果 |
| UE .usf → WGSL | 7 个入口成功，1 个拒绝 | Screen、Clear、structured-buffer compute、texture compute；typed-buffer compute 被拒绝 |
| WGSL 浏览器执行 | Chrome/Edge 各 2 个视口通过 | 显式开启 tier2 后，绑定/Uniform 布局、图像、Compute 读回和 Canvas 像素检查通过 |

GPU 变体：`gpu32`、`gpu64`、`gpu32-thread`、`gpu64-thread`。ABI 变体：`abi32`、`abi64`、`abi32-thread`、`abi64-thread`。

GPU 浏览器用例额外覆盖 Canvas surface 配置与尺寸变化。线程 GPU 变体使用 `-pthread -sPROXY_TO_PTHREAD=1` 与 OffscreenCanvas，由 Worker 执行同一份 C++ GPU 样本。

两个视口是 1280×900 和 390×844，均在 Windows 浏览器运行；没有测试手机硬件、Safari 或 Firefox。自动化使用浏览器默认 WebGPU 开关，没有启用 unsafe/experimental 特性。

原生和浏览器两次离屏读回的 64 位哈希：

```text
64×64，初始 Uniform：1520949467941970819
80×48，更新 Uniform：9494338676838987651
```

检查逐像素执行，允许 UNORM 量化差 1；Compute 逐元素核对 32 个结果。Canvas 截图另取四个象限检查像素，验证浏览器确实呈现了图像。读取哈希用字符串保存，避免 JavaScript Number 丢失 64 位整数精度。

汇总：[summary.json](H:/ue_html/tests/web-platform/results/summary.json)。完整结果：[Chrome](H:/ue_html/tests/web-platform/results/browser-results.json)、[Edge](H:/ue_html/tests/web-platform/results/edge-results.json)、[原生 GPU](H:/ue_html/tests/web-platform/results/native-webgpu.log)、[原生 ABI](H:/ue_html/tests/web-platform/results/native-abi.log)。

## 2. 固定工具链

| 部分 | 实测版本 |
| --- | --- |
| Emscripten | 6.0.9，提交 `4e4223852a0835923411059a3929907d7df1232e` |
| Dawn / emdawnwebgpu | 同一个 release `v20261009.190412`，提交 `c943ea32b614ff53e4fe410fc8f4968b6b8fe46d` |
| DXC | 官方 `v1.9.2609`，DLL 版本 1.9.2609.5 |
| Tint | 上述 Dawn release 中的主机工具 |
| 原生编译 | MSVC 19.51.36246.0 x64、VS 2026、CMake 4.2.3-msvc3 |
| GPU/驱动 | 原生 Dawn 确认为 NVIDIA RTX 3070 / D3D12，32.0.15.9621 |
| Chrome | 155.0.8059.40 |
| Edge | 155.0.4283.45 |

三个 release 压缩包已核对 GitHub asset 提供的 SHA256。完整哈希见 [toolchain-lock.json](H:/ue_html/tests/web-platform/toolchain-lock.json)。原生程序需要 `dxcompiler.dll` 与 `dxil.dll`，构建脚本将固定版本复制到 exe 同目录；缺失时实测 Device 创建失败。

浏览器没有返回可识别的 GPU 名称，本报告只将 RTX 3070 归属于已经明确识别的原生端，不据此声称浏览器已确认相同物理适配器。

## 3. ABI 与线程

测试结构体为 `uint8 + void* + uint64 + uint32`，下表只说明这个结构体的实测布局：

| 项目 | Win64 | wasm32 | wasm64 |
| --- | --- | --- | --- |
| sizeof(void*) | 8 | 4 | 8 |
| sizeof(size_t) | 8 | 4 | 8 |
| sizeof(struct) | 32 | 24 | 32 |
| alignof(struct) | 8 | 8 | 8 |
| pointer offset | 8 | 4 | 8 |
| uint64 offset | 16 | 8 | 16 |
| uint32 offset | 24 | 16 | 24 |

wasm32/64 的线程样本均成功创建 `std::thread`、执行原子累加并 join，计数均为 20000。浏览器主线程没有同步等待 GPU Promise；GPU 初始化与 map 通过回调和事件循环推进。

**后续优先把 wasm64 作为 UE 接入试验目标有实测依据**：它在本机两个浏览器中可以执行 GPU/线程测试，并且该样本的指针和布局更接近 Win64。不过还不能据此认定完整 UE ABI、所有第三方库、超过 4 GiB 内存或其他浏览器均已兼容。wasm32 保留为对照目标。

服务实测为 secure localhost、crossOriginIsolated，SharedArrayBuffer 可用。发布环境也需要满足线程运行要求，测试服务已经实现 COOP/COEP。

## 4. GPU 能力与设备限制

原生和两个浏览器报告的以下适配器能力一致：

| 能力 | 实测 |
| --- | --- |
| BC 压缩纹理 | 支持 |
| ETC2 / ASTC | 不支持 |
| shader-f16 / subgroups / timestamp-query / float32-filterable | 支持 |
| maxTextureDimension2D | Adapter 16384，默认 Device 8192 |
| maxBufferSize | Adapter 2 GiB，默认 Device 256 MiB |
| maxBindGroups | Adapter 4 |
| maxStorageBuffersPerShaderStage | Adapter 16 |
| maxSampledTexturesPerShaderStage | Adapter 48 |
| minUniformBufferOffsetAlignment | 默认 Device 256 |

这里的可选 feature 表示 Adapter 声明支持，P0 默认 Device 没有请求并逐项使用这些 feature。不能将“适配器支持”当成“UE 已实现”，也不能让 RHI 按 Adapter 上限分配、却仍使用默认 Device limits。

实际接入需要在初始化时确定 requiredFeatures/requiredLimits，校验申请后的 Device，并将限制反映到 UE 的格式表、能力开关和资源分配中。

## 5. Shader 冒烟测试

从固定提交逐字节提取 `.usf`，记录 SHA256，未修改这些原始文件：

| 原始文件 | 测试入口 |
| --- | --- |
| ScreenVertexShader.usf | Main |
| ScreenPixelShader.usf | Main、MainMipLevel |
| ClearReplacementShaders.usf | ClearVS、ClearPS、ClearCS 的 structured/texture/typed-buffer 分支 |

主机执行：DXC HLSL → Vulkan 1.1 SPIR-V → Tint WGSL → Tint JSON 反射。浏览器加载生成的 WGSL 并运行；不是浏览器在线运行 HLSL 编译器。

**这一组使用精简 include fixture。** `Common.ush` 只补足屏幕输出结构体、采样宏和简化 DrawRectangle；后者在此直接传入裁剪坐标。ComputeShaderUtils 的 wrapped-group 分支未开启。该测试没有执行 UE ShaderCompileWorker、完整 Common include、UE 参数解析器、材质 permutation、LocalVertexFactory 或 Cook，不能代表它们已兼容。

实测检查：

1. Screen PS 与 MipLevel PS：纹理/采样器绑定正确，64×64 全部像素符合输入纹理。
2. Clear VS/PS：Uniform 生效，64×64 全部像素符合清屏值，Canvas 呈现的截图也通过。
3. Structured-buffer ClearCS：Uniform 48 字节，成员偏移 0/16/32；只清除 `[4,32)`，未清除区域保持 0，逐元素验证。
4. Texture ClearCS：清除指定二维子区域，逐元素验证 `rgba32float` 读回；需要下面所述 tier2。
5. 反射检查：核对使用的 group/binding/resource type，不把未使用的 `MipLevel` 强行当成仍然存在的资源；与 UE 自身参数映射的联测尚未实现。

构建证据：[shader-build-results.json](H:/ue_html/tests/web-platform/results/shader-build-results.json)。运行证据：[Chrome tier2](H:/ue_html/tests/web-platform/results/shader-browser-tier2-results.json)、[Edge tier2](H:/ue_html/tests/web-platform/results/shader-edge-tier2-results.json)。

## 6. 已复现的障碍

### Typed Buffer

`RESOURCE_TYPE=0`，`RWBuffer<float4>`：

```text
DXC 成功
Tint 失败：SPIR-V capability 'SampledBuffer' is not supported
```

这项是已知拒绝测试，通过统计中的“预期拒绝”表示准确捕获了这个障碍，**不表示 Shader 转换成功**。原始日志在 `build/shaders/clear-typed-buffer-cs.log`。

后续 Web ShaderFormat/RHI 需要明确提供 typed-buffer 到 storage-buffer 的降级与访问适配，或禁用具体依赖该路径的功能。StructuredBuffer 分支已经通过本例，但尚未实现全引擎 typed-buffer 改写。

### 读写 Storage Texture

本例 `RWTexture2D<float4>` 转出 `texture_storage_2d<rgba32float, read_write>`：

| Device 请求 | 创建 Compute Pipeline | 实际读回 |
| --- | --- | --- |
| 默认 | 被 GPU 校验拒绝 | 无有效结果 |
| texture-formats-tier1 | 被 GPU 校验拒绝 | 无有效结果 |
| texture-formats-tier2 | 成功 | 清除范围与所有浮点值正确 |

Chrome/Edge 均通过 tier2 路径。Chrome 默认与 tier1 失败已额外复跑保留：[默认结果](H:/ue_html/tests/web-platform/results/shader-browser-default-results.json)、[tier1 结果](H:/ue_html/tests/web-platform/results/shader-browser-tier1-results.json)。

Web 平台不能无条件假定该能力可用。后续可选择显式要求 tier2，或在能够证明只写的 Shader 上由编译器降低访问权限，并同步调整 BindGroupLayout；本轮没有通过字符串替换伪造这项适配。

## 7. 当前状态与下一阶段

P0 独立样本完成。P1 只有冒烟测试完成，主机 WebGPUShaderFormat 尚未实现。Diligent 整库与直接 API 的成本对比也尚未实作，本轮验证的是 Dawn/emdawnwebgpu 直接 API 路径。

接下来的 P1 应先补齐 UE ShaderCompileWorker 的主机依赖与完整预处理环境，再按 Screen/Clear → LocalVertexFactory → unlit/mobile material 增加语料；实现并联测 UE 参数映射、绑定布局和资源降级元数据。之后再进入 P2 Win64 WebGPURHI。

没有开始全引擎 Web 编译，也没有修改用户引擎工作树。UMG 仍按用户要求：保留现有依赖，仅当 Web 上出现实际阻塞时对问题路径做局部禁编译或降级。

测试源码与复跑步骤：[README.md](H:/ue_html/tests/web-platform/README.md)。本地服务在 `http://127.0.0.1:8765/`，可切换 wasm32/64 和线程版本；`/shaders.html` 为 Shader 运行测试。
