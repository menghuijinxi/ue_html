# UE5.8 WebGPUShaderFormat 与 ShaderCompileWorker 测试

测试日期：2026-10-14。目标分支固定为 `396c9f059903aed5fec78ecd3d437a40c6415368`，版本 5.8.3；实际编译器和 Worker 使用安装的 UE 5.8.0，BuildId/CL `55116800`。

## 1. 结论

已实现主机 `IShaderFormat` 插件，让 WGSL 与反射/资源表 metadata 成为正式 `FShaderCompilerOutput::ShaderCode` 输出；原始 ShaderCompileWorker 加载独立格式 DLL，通过实际任务文件编译并返回该字节码。浏览器直接解析 Worker 返回的二进制包，执行真实 UE GlobalShader 和材质/VF Shader。

| 测试集 | Worker 任务 | 成功字节码 | 明确的不支持返回 |
| --- | ---: | ---: | ---: |
| GlobalShader | 71 | 55 | 16 |
| Material + LocalVertexFactory | 8 | 8 | 0 |
| 合计 | 79 | 63 | 16 |

63 个成功任务均核对：输入哈希、输出哈希、频率、版本、UE ParameterMap、原生反射、资源表、WGSL 反射与 WGSL SHA256。与进程内编译和既有独立转换结果一致。16 个拒绝是 15 个 typed-buffer Clear 原始变体和 1 个数组层输出 VS；相应诊断通过 Worker 返回，没有伪装成成功。

完整复现脚本已从构建到两批 Worker 任务和产物对比执行通过。后续接入 `WebGPUShaderHostTargetPlatform`，删除手工格式版本和输入哈希适配，再次完整复现及 Chrome/Edge 8/8 Worker 浏览器测试通过；既有 standalone 页面上一轮的 8/8 回归保持通过。

Chrome 155.0.8059.40 与 Edge 155.0.4283.45，分别运行两个页面的 1280×900、390×844 视口，8/8 通过。GlobalShader 每组 55 modules、50 pipelines、475,904 个读回数值；材质每组 8 modules、5 pipelines、31 次 draw、1,835,008 个读回数值。8 组共核验 9,243,648 个数值，页面与 canvas 实际像素均通过，无 GPU validation/page/console error。窄屏仍是 Windows 视口测试。

这验证了 P1 的 ShaderFormat/Worker 接口及主机格式注册，不代表 UE 场景已经打包到网页。后续已完成独立 Web ShaderPlatform/DDPI 的隔离主机验证，见 [独立平台测试报告](H:/ue_html/UE58_P1_SHADERPLATFORM_TEST_RESULTS.md)。完整 P1、生产 Web 运行时平台/TargetPlatform、Win64 WebGPURHI、WASM 引擎和 Cook/Stage 尚未完成。

## 2. 模块接入

插件位置：`H:/ue_html/tests/ue-shader-host/Plugins/WebGPUShader`，模块 `WebGPUShaderFormat`。

支持格式 `SF_WEBGPU_ES31`、`SF_WEBGPU_SM5`；前端借用原生 Vulkan ShaderFormat 的输入修改、预处理、DXC/ShaderConductor 编译。传入原生后端的临时 Input 恢复为对应 Vulkan 格式，Web 格式标识保留在对外任务与输出中。

处理顺序：

1. 反序列化 Vulkan shader header、`FShaderResourceTable` 与 SPIR-V。
2. 使用 SPIRV-Reflect 保存入口、group/binding、类型、UB 成员偏移、大小、padding、数组/矩阵 stride。
3. 保存 UE ParameterMap、实际使用的 UniformBuffer resource entries 与 SRT token streams/layout hashes。
4. 用 ShaderConductor `--strip-reflect` 移除反射扩展，再调用固定 Dawn 包中的 Tint 和 tint_info。
5. 模块内部核对 WGSL descriptor 位置/类型、UB 分配和活动成员布局、UE 参数分配；失败返回编译错误，成功生成版本化字节码。

材质的资源表 token 对照继续由既有材质审计验证，导出脚本还逐项核对 Worker metadata 与这套基准。当前 UB 检查覆盖平坦成员/数值数组，嵌套成员明确拒绝，未宣称任意材质或所有资源类型均受支持。

模块版本由原生编译器版本、字节码 schema 与固定 Tint release 标识组成；后续独立平台接入增加 `PlatformMetadata2` 标识，并在平台映射可用时混入 DDPI 属性哈希。DDC key 同步升级。环境变量 `WEBGPU_TINT_DIR` 必须指向本测试固定包。工具与编译器文件的 SHA256 记录在 `results/ue-webformat-build-results.json`。正式集成仍应加入工具 fingerprint 校验，避免替换工具后沿用旧缓存版本。

## 3. 字节码协议

小端头部共 28 bytes，7 个 uint32：

| 字段 | 内容 |
| --- | --- |
| 0 | Magic `0x53475057`，字节为 WPGS |
| 1 | Schema = 1 |
| 2 | HeaderBytes = 28 |
| 3 | UE shader frequency |
| 4 | ShaderFormat version |
| 5 | UTF-8 metadata JSON byte count |
| 6 | UTF-8 WGSL byte count |

头部后是 metadata 和 WGSL，不包含主机指针。UE 的 packed resource counts 作为原有 optional attachment 保留；浏览器文件只导出 ShaderCode 主体，排除 optional trailer。

主机 `UE::WebGPUShader::Decode` 与浏览器 `WebShaderCode.decode` 均检查 magic/schema/边界。浏览器额外核对 metadata 与头部的频率/版本一致、UTF-8 有效、编译器绑定检查标记，以及 manifest 的预期版本。

63 个包各执行截断头、坏 magic、坏版本、坏长度 4 个负向测试，共 252 个。

## 4. Worker 与真实协议

安装版 UBT 明确拒绝 Program target。本测试以 Editor target 的 UBT 参数生成 include/toolchain 配置，再单独编译 Program flavor DLL，链接安装引擎已有的 `ShaderCompileWorker-*` 导入库。导入表没有 `UnrealEditor-*` DLL。

运行目录为 `H:/ue_html/.tools/ue58-web-shader-worker/Engine/Binaries/Win64`。复制安装的 Worker executable、模块和运行时依赖；新增 WebGPUShaderFormat DLL/manifest 条目。原始 Worker executable SHA256 与副本一致。安装引擎和目标 Git 工作区未修改。

真实流程使用 RenderCore 导出的 `FShaderCompileWorkerUtil::WriteTasks/ReadTasks`、Worker 进程、批量任务与共享环境/参数结构序列化：

- 输入协议 33，输出协议 31。
- 任务外层为 Worker 支持的 Zlib 压缩帧，预处理源码保留 UE 自身的压缩格式。
- 两批正常任务返回 Worker error code 0。
- 两批各测试一次错误输入版本，返回 `BadInputVersion` = 3。
- 两批各测试一次错误格式版本，返回 `BadShaderFormatVersion` = 2。
- 输入哈希在官方反序列化时也执行校验；该实现随后清空验证字段，探针从原始返回流记录校验值。
- 输出头中的 FileSize 是最后一个完整任务写入位置，可能不包含末尾 pipeline header；按官方读取规则校验，不能误要求等于文件总长。

**主机格式注册已完成：**插件新增 `WebGPUShaderHostTargetPlatform`，通过项目 `Config/DefaultEditor.ini` 的 `[CustomTargetPlatforms] +ModuleName=WebGPUShaderHost` 自动发现。模块返回 `FTargetPlatformMerged` 和独立 settings/controls，提供两个 Web 格式及 `WebGPUShaderFormat` module hint。项目 `DefaultDeviceProfiles.ini` 提供主机编译 profile，继承 Windows 的主机 LOD 配置；它不是浏览器设备能力配置。

探针现在从 `TargetPlatformManager.FindShaderFormat` 获取格式，核对 `FindTargetPlatformWithSupport("ShaderFormat", WebFormat)` 指向该主机平台。`PreprocessShader(Job)` 自始使用 Web 格式，由 UE 完成源码裁剪/压缩及 `GetInputHash`；再由官方 `CompileShader` 解压并编译。原生完整预处理源码仍作为基准逐项比较，63 个输出与既有转换结果一致。删除了探针的 `NativeHash` 包装、`InputHash`/`bInputHashSet`/`Input.Hash` 手工赋值。

`WriteTasks` 的版本表现在自行包含两个 Web 格式。有效任务正文原样保留，只有负向测试修改输入/格式版本；外层仍采用 Worker 支持的 Zlib 帧以保持内存 archive 的 FName 序列化方式。没有向版本表手工新增条目。主机注册初次验证时的缓存版本 ES31=`1858284474`、SM5=`1251911449`；后续平台 metadata 变更已提升版本，以最新 manifest 为准。两端版本继续由官方流程核对。

**运行平台边界：**`WebGPUShaderHost` 仅注册主机 Shader 编译器，没有注册独立 Web `EShaderPlatform`。71 个 GlobalShader 仍借用 `SP_VULKAN_SM5` 的环境，8 个材质/VF Shader 仍借用 `SP_VULKAN_PCES3_1` 的环境。主机平台明确返回 `CanCookPackages=false`、`Packaging=false`、`SupportsBuildTarget(Game)=false`、`IsSdkInstalled=false`；导出脚本核对这四项，避免把发现编译格式误报为可打包平台。默认 Cook、DDC 调度的端到端集成尚未验证。

当前 Worker DLL 的构建是安装引擎条件下的测试路径，尚未在目标 5.8.3 全源码 ShaderCompileWorker target 上编译。所有实际 Worker 任务通过，为这批接口/布局提供运行证据，但不能扩展为整引擎 ABI 证明。

## 5. 复现与产物

完整构建/编译/对比：

```powershell
& H:/ue_html/tests/web-platform/build-ue-webformat.ps1 -Engine H:/UE_5.8
```

浏览器：

```powershell
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
$env:P1_SHADER_SOURCE = 'worker'
$env:P0_SHADER_FEATURES = 'tier2'
$env:P0_BROWSER = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
$env:P0_RESULTS = 'ue-webformat-chrome-results.json'
node H:/ue_html/tests/web-platform/run-browser.cjs ue-shaders ue-material
$env:P0_BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
$env:P0_RESULTS = 'ue-webformat-edge-results.json'
node H:/ue_html/tests/web-platform/run-browser.cjs ue-shaders ue-material
node H:/ue_html/tests/web-platform/summarize.cjs
```

材质页：`http://127.0.0.1:8765/ue-material.html?source=worker`。
Global 页：`http://127.0.0.1:8765/ue-shaders.html?source=worker`。
不带 source 参数的既有 standalone 页面仍可执行。

材质只请求默认 device features；Global Clear 的 read_write RGBA32 storage texture 仍请求 tier2。ShaderFormat 尚未替 Web TargetPlatform 完成能力 gate、资源格式变体与整体渲染策略。

| 文件 | 用途 |
| --- | --- |
| `tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat/Private/WebGPUShaderFormat.cpp` | 正式 ShaderFormat 输出、反射和绑定检查 |
| `tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderHostTargetPlatform/Private/WebGPUShaderHostTargetPlatform.cpp` | 主机格式提示、官方发现与运行平台能力边界 |
| `tests/ue-shader-host/Config/DefaultEditor.ini` / `DefaultDeviceProfiles.ini` | 自定义主机平台发现及必要的 DeviceProfile |
| `tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderWorkerProbe.cpp` | 任务协议、独立进程、基准/哈希校验 |
| `tests/web-platform/build-worker-module.cjs` | Worker flavor DLL、隔离运行目录、依赖校验 |
| `tests/web-platform/prepare-worker-artifacts.cjs` | 基准合约/WGSL 比较、字节码负向检查 |
| `tests/web-platform/web-shader-code.js` | 浏览器与 Node 共用字节码解码器 |
| `tests/web-platform/build/ue-{full,material}/worker/` | 任务输入输出、editor/worker 字节码和 worker-results |
| `tests/web-platform/build/ue-{full,material}-worker/` | 浏览器直接消费的字节码、manifest、材质数值文件 |
| `tests/web-platform/results/ue-webformat-*-results.json` | 两个浏览器的 8 组结果 |

## 6. 后续接入顺序

主机格式注册和版本/哈希适配移除已经完成。后续独立 Web ShaderPlatform/DDPI 已在隔离 Editor/Worker 中验证：真实 UBT 生成静态表，分别编译替换隔离副本的静态表，其他 BuildSettings 函数转发到原版。79 个任务和 Chrome/Edge 8/8 通过，原有两套页面回归通过。该测试仍不是全源码平台构建，详细限制见 [独立平台报告](H:/ue_html/UE58_P1_SHADERPLATFORM_TEST_RESULTS.md)。

下一步用同一批 bytecode 建立 Win64 WebGPURHI 的 shader object、binding/UB、texture/sampler、vertex/index、PSO、4 MRT、depth 与提交链。先证明 UE RHI 命令的执行，再让 StaticMesh/MeshDrawCommand 接管目前探针提供的网格和 Uniform。

独立 ShaderPlatform 已核对的源码路径如下：

1. `UEBuildPlatform.AddPlatformStaticShaders` 在源码引擎生成 `BuildSettings` 的 `RHIStaticShaderPlatformNames.gen.cpp` 和 `RHI` 的 `<Platform>RHIShaderPlatform.h`。Web 平台需为 ES31/SM5 分配未占用的静态槽，并让主机 Editor 与 ShaderCompileWorker 同时生成名字表。
2. `FStaticShaderPlatformNames` 消费生成表，建立平台名、`SP_WEBGPU_*` 与 `SF_WEBGPU_*`；`ShaderFormatNameToShaderPlatform` 才能把 Web 格式映射到这些枚举。
3. `DataDrivenShaderPlatformInfo.Initialize` 使用 `ParseShaderPlatform` 查找已存在的名字，未知 `[ShaderPlatform ...]` 只记录警告并跳过。`SP_CUSTOM_PLATFORM_*` 在这里用于 Editor preview，不能仅写 DDPI 就作为稳定的 Cook/Worker 运行时枚举。
4. 安装版已有的 BuildSettings/RHI/RenderCore DLL 不会因项目插件重新生成这张表。本次后续测试只在工作区隔离副本中编译生成表，实现两端映射验证；生产接入仍需要 Web UBT 平台正常注册和源码引擎主机模块构建。

上述生成入口也已核对目标 5.8.3 fork 的 `UEBuildPlatform.cs:1498` 与 `DataDrivenShaderPlatformInfo.cpp`；没有直接覆盖安装引擎 DLL 或修改目标分支。

之后落实 Web UBT/Core/ApplicationCore/Launch、TargetPlatform、Cook/Stage、资源挂载及完整场景。当前网页仍是独立 WebGPU 测试程序，不是 UE Scene Runtime。没有像素流或付费组件；UMG/Slate 依赖未改动，继续按实际 Web 阻塞点局部跳过问题代码。
