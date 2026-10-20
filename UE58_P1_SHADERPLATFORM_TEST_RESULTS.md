# UE5.8 独立 Web ShaderPlatform / DDPI 测试

测试日期：2026-10-14。目标 `html` 分支固定提交 `396c9f059903aed5fec78ecd3d437a40c6415368`，版本 5.8.3；主机 Editor、材质翻译器和 ShaderCompileWorker 使用安装的 5.8.0，CL/BuildId `55116800`。

## 1. 本轮结果

隔离 Editor 和 Worker 已同时识别两个独立、非 preview 的 Web ShaderPlatform。真实 GlobalShader 编译环境使用 `SP_WEBGPU_SM5`，真实材质图、LocalVertexFactory 与 Mobile BasePass 编译环境使用 `SP_WEBGPU_ES31`。这推进了上一轮仅注册 Web ShaderFormat、借用原生平台环境的测试。

| 平台 | 静态枚举 | ShaderFormat | FeatureLevel | DDPI 属性哈希 |
| --- | ---: | --- | --- | ---: |
| SP_WEBGPU_ES31 | 46 | SF_WEBGPU_ES31 | ES3_1 | 196076591 |
| SP_WEBGPU_SM5 | 47 | SF_WEBGPU_SM5 | SM5 | 689280822 |

两端核对平台名、枚举、格式双向映射和 DDPI 能力。能力配置关闭 GPUScene、manual vertex fetch、typed-buffer SRV、Nanite、Lumen、RayTracing、bindless、mesh shader 和 wave 等未接通路径。它目前是编译样本的能力配置，不是完整浏览器能力协商，也不表示所有 SM5 渲染功能可用。

| 检查 | 结果 |
| --- | --- |
| Worker 实际任务 | 79 个：63 个成功包，16 个明确不支持诊断 |
| 进程内输出与 Worker 输出 | 63 个包逐字节一致 |
| 原生反射 / UE ParameterMap / SRT / WGSL 绑定 | 全部通过 |
| 包头、magic、版本、长度损坏 | 252 个负向检查通过 |
| 平台名、枚举、DDPI 哈希、格式混用 | 252 个负向检查通过 |
| 缺少静态名字表 / 缺少 DDPI | 2 个检查按预期退出 1，未触发断言或 fatal |
| Worker 错误输入版本 / 格式版本 | 两批均返回预期 error code 3 / 2 |
| Chrome / Edge：两个页面、两个视口 | 8/8 通过，核验 9,243,648 个读回数值 |
| 原有 Worker 页面 / standalone 页面回归 | 各 8/8 通过 |

GlobalShader 每组 55 modules、50 pipelines、475,904 个数值；材质每组 8 modules、5 pipelines、31 次 draw、1,835,008 个数值。验证实际 Canvas 像素与页面宽度，无 GPU validation、pageerror 或 console error。浏览器为 Chrome 155.0.8059.40、Edge 155.0.4283.45；390×844 是 Windows 窄视口，不是移动设备实测。

16 个明确拒绝仍是 15 个原始 typed-buffer Clear 变体与 1 个数组层输出 VS。额外 Clear 降级使用此前验证的 StructuredBuffer 分支。Global 的 read_write RGBA32 storage texture 样本仍显式请求 `texture-formats-tier2`；材质仅请求默认 Device。

## 2. 静态名字表接入方式

只添加 DDPI 不能创造稳定的 `EShaderPlatform`：RHI 先消费 BuildSettings 导出的静态名字表，再按已有名字解析 DDPI。未知 DDPI section 会被跳过；`SP_CUSTOM_PLATFORM_*` 是 Editor preview 用途。

本轮采用可复现的隔离测试路径：

1. 检查安装版 Editor/Worker 的 `GStaticShaderNames`，保留原有 entries，并拒绝占用冲突的槽。当前两端的扩展 entries 为空，46、47 可用。
2. 调用安装 UBT 的真实 `UEBuildPlatform.AddPlatformStaticShaders`，生成 `RHIStaticShaderPlatformNames.gen.cpp` 和 `WebGPURHIShaderPlatform.h`。
3. 在工作区隔离目录分别编译 Editor/Worker 的静态表。BuildSettings 的其他 23 个函数转发到保留且 SHA256 一致的原版 DLL；版本、CL 和各自内存预留值保持原版值。
4. 在各自真实的本地 `Engine/Platforms/WebGPU/Config` 加入 DDPI，由现有 RHI 初始化映射。
5. 对两端运行真实编译任务，并从返回包核对 Web 枚举和 DDPI 属性哈希。

生成器脚本通过反射测试夹具调用生产方法；**没有注册完整 Web UBT factory、SDK 或 toolchain**。这里只重编译了静态名字表，没有完成 BuildSettings 全源码构建，也没有完成目标分支整引擎构建。其他主机模块仍为安装的 5.8.0。

Editor 隔离目录：`H:/ue_html/.tools/ue58-web-platform-host`。
Worker 隔离目录：`H:/ue_html/.tools/ue58-web-shader-worker`。

安装引擎、原始 Editor/Worker executable 和 `reference-engine` 工作区未修改。完整源码接入时，应由 Web `UEBuildPlatform` 的正常模块设置流程调用相同生成方法，并重新检查所有目标平台的静态槽分配。

## 3. 编译与缓存合约

对外 job 的 Target 保持 Web 枚举，生成 GlobalShader / 材质 / VF 环境时读取 Web DDPI。离线前端继续复用 Vulkan ShaderFormat 的 DXC/ShaderConductor，临时恢复其格式名，生成 SPIR-V 后转为 WGSL。DDPI `Language=Vulkan` 描述该离线前端；浏览器执行的是返回包中的 WGSL。

ShaderFormat 构造时显式初始化 DDPI，使 Worker 首次查询版本时具备相同的平台能力。测试曾发现 Worker 初始化顺序导致版本不匹配，现已修正并全量复现。

字节码 metadata 增加 `shaderPlatform`、`shaderPlatformEnum`、`shaderPlatformPropertiesHash`。格式版本混入 DDPI 属性哈希，DDC key 升级为 `PlatformMetadata2`；包头仍为原有 28-byte/schema 1，新增 JSON 字段兼容已有解码器。当前独立平台版本 ES31=`885374265`，SM5=`3003309877`。

浏览器 `source=platform` 使用同一个二进制解码器，逐包核对 manifest 预期的平台名、枚举、属性哈希和格式。对应 4 种错误配置各对 63 个包验证一次。原有 `source=worker` 与不带 source 的 standalone 路径保持独立。

`WebGPUShaderHost` 仍只承担主机格式发现，禁用 Cook、打包、Game 构建和运行时 SDK。DDPI 的 Web 平台也设置为 fake/disabled，避免把编译验证误报为可打包平台。工具 fingerprint 强制校验、完整 DDC/Cook 调度和资源能力 gate 仍需后续接入。

## 4. 复现

PowerShell，依赖和本机 VS 路径沿用此前测试：

```powershell
& H:/ue_html/tests/web-platform/build-ue-platform.ps1 -Engine H:/UE_5.8

$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
$env:P1_SHADER_SOURCE = 'platform'
$env:P0_SHADER_FEATURES = 'tier2'
$env:P0_BROWSER = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
$env:P0_RESULTS = 'ue-platform-chrome-results.json'
node H:/ue_html/tests/web-platform/run-browser.cjs ue-shaders ue-material
$env:P0_BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
$env:P0_RESULTS = 'ue-platform-edge-results.json'
node H:/ue_html/tests/web-platform/run-browser.cjs ue-shaders ue-material
node H:/ue_html/tests/web-platform/summarize.cjs
```

服务已在 8765 运行；重新启动使用 `tests/web-platform/serve.cjs`。新页面入口：

```text
http://127.0.0.1:8765/ue-material.html?source=platform
http://127.0.0.1:8765/ue-shaders.html?source=platform
```

旧 `build-ue-webformat.ps1` 会重建 stock 映射的 Worker 测试环境。需要重新跑独立平台编译时，先执行 `build-ue-platform.ps1` 恢复两端映射；已导出的浏览器产物互不覆盖。

| 文件 | 用途 |
| --- | --- |
| `tests/web-platform/generate-web-shader-map.ps1` | 调用 UBT 静态名字表生成器，检查槽冲突 |
| `tests/web-platform/buildsettings-map-probe.cpp` | 读取实际 DLL 静态表及原版函数返回值 |
| `tests/web-platform/build-static-platform-host.cjs` | 构建隔离 Editor/Worker 静态表与 DLL 转发 |
| `tests/web-platform/platform-extension/Config/DataDrivenPlatformInfo.ini` | 两个 Web 编译平台的能力配置 |
| `tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderPlatformProbe.cpp` | 映射、能力、属性哈希与初始化验证 |
| `tests/web-platform/build-ue-platform.ps1` | 从构建、两批任务到产物核对及缺配置检查 |
| `tests/web-platform/verify-web-platform-negatives.cjs` | 缺名字表、缺 DDPI 的干净失败验证 |
| `tests/web-platform/results/static-platform-host-build.json` | 生成器来源、DLL SHA256、实际静态表 |
| `tests/web-platform/results/ue-platform-build-results.json` | 79 个任务与包/平台解码负向检查 |
| `tests/web-platform/results/ue-platform-negative-results.json` | 缺配置测试 |
| `tests/web-platform/results/ue-platform-*-results.json` | 浏览器结果与截图 |

## 5. 剩余工作

本轮证明了独立 Web ShaderPlatform 的主机编译接入，当前网页仍是独立 WebGPU 测试程序。P1 的任意材质覆盖、完整能力策略及全源码主机集成仍未完成。

下一步进入 P2 的 Win64 WebGPURHI：用同一批 Worker 字节码实现 shader object、Uniform/resource table、texture/sampler、vertex/index、PSO、4 MRT、depth 和提交链；先让 UE RHI 命令驱动 Dawn，再接 StaticMesh/MeshDrawCommand。

之后才是 Web UBT/Core/ApplicationCore/Launch、WASM 引擎、真实 TargetPlatform、Cook/Stage/资源挂载，以及完整场景和网页 UI 桥接。没有使用像素流、付费 SDK，也没有拆除 UMG/Slate；实际 Web 编译问题仍按约定局部跳过。
