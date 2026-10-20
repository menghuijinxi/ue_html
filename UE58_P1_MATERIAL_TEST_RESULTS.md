# UE 5.8 浏览器移植 P1 材质测试结果

测试日期：2026-10-14。

**真实 UE 材质图 → LocalVertexFactory/Mobile BasePass → SPIR-V → WGSL → 浏览器索引网格渲染已通过。** 此轮覆盖两个 Unlit 材质、两个 VF profile、8 个 VS/PS Shader。Chrome/Edge 桌面和窄屏四组测试全部通过。

这是一条独立网格探针，尚未接入 UE 的 StaticMesh 资源加载、MeshDrawCommand、WebGPURHI 或完整游戏 Runtime。不能把本结果作为“UE 场景已经打包进网页”的证据。P1 完整阶段仍未完成。

## 1. 输入与版本

| 项目 | 本轮实际使用 |
| --- | --- |
| 目标 html 分支 | `396c9f059903aed5fec78ecd3d437a40c6415368`，5.8.3 |
| 材质/编译主机 | 安装的 UE 5.8.0，CL 55116800 |
| 原生 ShaderFormat | `SF_VULKAN_ES31`，`SP_VULKAN_PCES3_1` |
| VertexFactory | 注册的 `FLocalVertexFactory` |
| Shader 类型 | `TMobileBasePassVSFNoLightMapPolicy`、`TMobileBasePassPSFNoLightMapPolicy` |
| Tint | Dawn `v20261009.190412` |
| Chrome | 155.0.8059.40 |
| Edge | 155.0.4283.45 |
| 浏览器 Device | 默认 features/limits，未请求 tier2、未使用实验开关 |

目标 Shader 快照包含 1,191 个 `.usf/.ush/.h` 文件。1,173 个安装文件在统一 CRLF/LF 后与 Git blob 相同，18 个不同文件从目标提交的本地 Git blob 中提取，全部校验通过。编译时重映射 `/Engine` 指向这份快照，并清空 Shader 文件缓存。

本批材质的保守 include 闭包包含 188 个文件，全部属于已校验目标输入。其中包括之前有版本差异的 `GpuSkinCommon.ush` 和 `SkinningDefinitions.h`。

**C++ 材质翻译器、generated Material/Uniform 数据、Shader 注册/permutation 环境与 ShaderConductor/DXC 仍来自 5.8.0 主机。** 不能据此宣称 5.8.3 分支的 C++ 编译器或整个引擎已经验证。

## 2. 编译链路

```text
UMaterial + UMaterialExpressionVectorParameter / TextureSampleParameter2D
  → UpdateCachedExpressionData：建立材质图资源引用
  → FMaterialResource::CacheShaders(None)：翻译材质图，生成 Material.ush
  → Pending MaterialShaderMap 编译环境与 CompilationOutput
  → LocalVertexFactory / Mobile BasePass ModifyCompilationEnvironment
  → GlobalBeginCompileShader + Vulkan IShaderFormat
  → UE ShaderCode 反序列化：Vulkan Header / ResourceTable / SPIR-V
  → SPIRV-Reflect：保存原始绑定和 Uniform 布局
  → ShaderConductor --strip-reflect
  → Tint WGSL + tint_info
  → 绑定合约核对 → WebGPU pipeline / drawIndexed / GPU 读回
```

主机通过 `-AllowCommandletRendering` 初始化实际渲染资源。此前 `NullRHI` 的完整 Uniform 求值遇到空共享采样器；开启主机渲染解决测试上下文问题，无需修改引擎或删改 UMG。

颜色参数 `WebColor` 默认值为 `(0.125, 0.5, 0.75)`。另用测试 RenderProxy 覆盖为 `(0.75, 0.25, 0.125)`。两份数据都由真实 `FUniformExpressionSet::FillUniformBuffer` 求值，仅保存 Numeric Preshader 部分：

- `UnlitColor.uniform.bin` / `UnlitColor.override.uniform.bin`：各 32 bytes。
- `UnlitTexture.uniform.bin`：16 bytes。
- RHI 资源指针保留在主机；浏览器从已审计资源表建立 texture/sampler 绑定。

纹理 Shader 来自真实 UE 纹理参数节点。测试纹理在浏览器创建为 2×2 RGBA8 调色板，并使用 nearest/repeat sampler；未验证 Cook 后纹理文件的解码和上传。

## 3. 两个 VF Profile

| Profile | 实际编译与资源 |
| --- | --- |
| Native mobile | 使用原本的移动 Vulkan VF 环境，`BatchedPrimitive` UBO；instance index 选择 Primitive 记录 |
| Web vertex input | 局部关闭 primitive scene data、instance culling、manual fetch、SpeedTree wind、GPU skin passthrough；使用 `Primitive` UBO 和普通顶点输入 |

Web profile 只在隔离编译 Job 中设置这些 define，未改目标 Shader 文件。Native profile 同时通过，因此本批材质不要求先禁用整个 GPUScene 模块。

`BatchedPrimitive` 的测试装填按 UE `GPUScene.cpp` 移动布局实现，32 个 float4 为一条记录；`Primitive`、`View` 则按 SPIR-V 反射的成员偏移装填。它们尚未由真正 WebGPURHI 的 Uniform/资源表接口生成。

## 4. 绑定合约

8/8 Shader 均验证：

- native entry、descriptor 数量、group/binding、resource type 不变。
- UE ParameterMap 的 Uniform buffer index 与 SPIR-V/WGSL 对应。
- 有效 Uniform 成员 offset 不变，最小大小不超过 UE 分配。
- Tint 可用 `@size` 吸收矩阵后的空洞；接受值必须处于原始 `size..paddedSize` 范围。
- 材质纹理/采样器由序列化 `FShaderResourceTable` token stream 回溯到真实 `FUniformResourceEntry`；无未解释资源。
- 材质 Numeric Uniform 文件足以覆盖 Shader 所需大小。

纹理 PS 的实际绑定为 group 1：

| binding | UE 名称 |
| --- | --- |
| 0 | `View` |
| 1 | `Material` |
| 2 | `Material_Texture2D_0` |
| 3 | `Material_Texture2D_0Sampler` |

本批 Uniform 仅包含平坦成员和数值数组；嵌套结构的递归合约、更多资源类型仍需另外验证，转换脚本会明确拒绝未审计的嵌套布局。

## 5. 浏览器执行

每组运行均验证 8 个 module、创建 5 个 pipeline、执行 31 次 draw，并核验 **1,835,008 个 GPU 读回数值**。28 个独立渲染测试对 64×64 的 4 个 RGBA8 MRT 全部像素进行核对；31 次 draw 包含额外深度遮挡 draw 与最终 canvas。

测试项：

- uint16/uint32 `drawIndexed`。
- 真实材质参数默认值和 RenderProxy 覆盖数据。
- 2×2 纹理 UV 与四个已知颜色。
- `View.PreExposure`。
- 模型 scale/translation、视图平移和投影 scale。
- LWC position high 与 view high 抵消、低部分平移。
- Native profile 的非零 instance index。
- reversed-Z：较近物体先画，较远物体后画，结果保留较近颜色。
- MRT 0 为目标材质颜色，其余三个输出为零。
- canvas 四象限真实像素和页面宽度检查。

| 浏览器 | 视口 | 结果 |
| --- | --- | --- |
| Chrome | 1280×900 | PASS |
| Chrome | 390×844 | PASS |
| Edge | 1280×900 | PASS |
| Edge | 390×844 | PASS |

均无 pageerror、console error 或 GPU validation error。窄屏是 Windows 浏览器视口，不是移动设备实测。

已重新运行上一批 GlobalShader 编译/转换及四组浏览器回归：55 个可转换 module、50 个 pipeline、每组 475,904 个数值继续通过；16 个原始转换拒绝仍按原有分类保留。

## 6. 本轮实现与下一步

源码和复现命令见 [测试说明](H:/ue_html/tests/web-platform/README.md)。测试入口：

```text
http://127.0.0.1:8765/ue-material.html
```

本轮增加材质 commandlet、目标 Shader 快照生成、WGSL/资源表合约脚本和浏览器材质运行测试。安装引擎和 `reference-engine` html 分支没有修改；UMG/Slate 依赖未改动。

下一步仍应完成 P1 的主机 `WebGPUShaderFormat` 接口和 ShaderCompileWorker 协议，再进入 P2：

1. 让转换结果成为 ShaderFormat 的正式输出，保存布局/资源表 metadata 与版本化 Web 字节码，验证 SCW 序列化。
2. 在 Win64 WebGPURHI 中实现这批已验证的 Uniform、texture/sampler、vertex/index、4 MRT、深度和 PSO 接口，用同一批 Shader 建立回归。
3. 使用 UE 的 StaticMesh/MeshDrawCommand 绘制小场景，替换测试程序提供的顶点和 Uniform。
4. 随后接 Web UBT、Core/ApplicationCore/Launch、TargetPlatform、Cook/Stage 与资源挂载。

此轮尚未覆盖 DefaultLit 光照、阴影、WPO、透明、骨骼、Nanite/Lumen、音频或完整 Blueprint Runtime。UMG 如在 Web 平台出现实际阻塞，按之前约定局部跳过该问题代码。

2026-10-14 后续进展：已实现主机 WebGPUShaderFormat，并让原始 ShaderCompileWorker 返回 8 个材质/VF 字节码；浏览器直接消费二进制包，四组材质测试继续通过。主机 `WebGPUShaderHostTargetPlatform` 随后接通官方格式发现、预处理/输入哈希和 Worker 版本表，删除手工适配；全部材质编译与四组浏览器复测通过。接入边界和全量测试见 [ShaderFormat 测试报告](H:/ue_html/UE58_P1_SHADERFORMAT_TEST_RESULTS.md)。

独立平台接入后，材质缓存、翻译与 VF/BasePass 环境使用 `SP_WEBGPU_ES31=46` 的 Web DDPI；8 个包的枚举与能力哈希由 Editor/Worker 和浏览器共同核对，四组材质浏览器测试通过。隔离主机实现与源码构建边界见 [ShaderPlatform 测试报告](H:/ue_html/UE58_P1_SHADERPLATFORM_TEST_RESULTS.md)。生产运行时平台/TargetPlatform、Cook 与 RHI 仍未完成。
