# UE 5.8 浏览器移植：源码参考与模块对应关系

调研日期：2026-10-13。目标引擎：用户 `html` 分支的 UE 5.8.3。

继续深入到实际接入方式的结果见 [UE58_WEB_INTEGRATION_DESIGN.md](H:/ue_html/UE58_WEB_INTEGRATION_DESIGN.md)：包括用户分支的 UBT 静态 Shader 注册、Windows ImportedRHI 入口、5.8 RHI 接口、离线 Shader 契约与分阶段验收。

约束：浏览器本地执行；不使用像素流；不购买商业 Web SDK；保留 UE 引擎运行时作为研究目标。

2026-10-14 更新：产品 UI 使用 HTML/CSS/TypeScript，网页与 UE 通过异步命令/事件桥交互。按用户澄清，保留引擎 UMG/Slate 依赖；UMG 若带来网页兼容问题，优先局部禁编译或降级，不投入大量时间修复，也不要求剔除整个模块。详细设计见接入文档第 9.4/9.5 节。

## 1. 本轮结论

上一轮把 UnrealWasm 放在过于中心的位置，参考范围不足。本轮扩展为 **20 项源码或测试参考**，覆盖 UE 平台、WebGPU 图形后端、Shader 编译、浏览器运行时、资源、音频与物理。

本轮新增浅克隆并检查 **16 个仓库**，其中 15 个纳入下面的源码参考；另一个 SlangWebGPU 示例未发现仓库顶层许可证，只作思路参考。SDL3 还直接检查了你 UE 5.8.3 源树中的 Emscripten 后端。

建议的主体组合：

```text
UE 4.27 HTML5：UBT/UAT、Core、Launch、ApplicationCore、打包与启动
                              +
DiligentCore WebGPU：资源、PSO、绑定、Draw/Dispatch、读回与交换链
                              +
Dawn / emdawnwebgpu：同一套 C/C++ WebGPU API 接入桌面与浏览器
                              +
UE 现有 HLSL/SPIR-V 编译链 + Tint：生成 WGSL 并处理资源反射
                              +
Godot Web 平台 / SDL3：事件循环、线程、输入、音频、资源预加载
```

**UnrealWasm 保留为 UE 5.8 附近版本的接口参考，不作为整个工程的唯一基础。**

这里的成熟度针对具体组件，不表示这些代码已经组合成可交付的 UE 5.8.3 网页平台。组件如何对应 UE、以及阅读优先级，属于本次源码核对后的工程判断。

## 2. 优先阅读的源码

### 2.1 SpeculativeCoder 的 UE 4.27 HTML5

- 说明与演示：<https://github.com/SpeculativeCoder/UnrealEngine-HTML5-ES3>
- 引擎分支：<https://github.com/SpeculativeCoder/UnrealEngine/tree/4.27-html5-es3>
- 本次读取提交：`c4e46c2d24c9e90241cef66db793731ed6aff479`。
- 许可范围：UE 源码许可；项目说明其作者改动免费可用。访问引擎分支需要 Epic GitHub 权限。

这是本轮优先级最高的 **UE 平台层参考**。本次读取的提交日期为 2026-09-18；`HTML5SDKInfo.cs` 配置 Emscripten **6.0.9**，不是只停留在早期 Emscripten 的静态样例。

值得提取的目录，均在 `Engine/Platforms/HTML5` 下：

| 路径 | 对 UE 5.8 移植的用途 |
| --- | --- |
| `Source/Programs/UnrealBuildTool/UEBuildHTML5.cs` | 平台注册、目标约束和构建环境 |
| `Source/Programs/UnrealBuildTool/HTML5ToolChain.cs` | C++ 编译、链接、响应文件和 Emscripten 参数 |
| `Source/Programs/AutomationTool/HTML5Platform.Automation.cs` | Cook 后的 Stage / Package / 部署流程 |
| `Source/Runtime/Core/Private/HTML5PlatformMemory.cpp` | WASM 内存与分配器接入 |
| `Source/Runtime/Core/Public/HTML5PlatformRunnableThread.h` | UE 线程接口到 pthread 的映射 |
| `Source/Runtime/ApplicationCore/` | 浏览器窗口、键鼠、触摸和游戏手柄 |
| `Source/Runtime/Launch/Private/LaunchHTML5.cpp` | 引擎启动与浏览器帧循环 |
| `Source/Runtime/OpenGLDrv/Private/HTML5OpenGL.cpp` | WebGL 后端的限制处理 |
| `Build/TemplateFiles/project_template.js` | PAK 下载、缓存、启动依赖与错误呈现 |

本次 HEAD 提交还调整了 PAK 加载和引擎启动的先后关系。它能补足 UnrealWasm 尚未证明的完整浏览器启动链参考。

边界：这是 UE4 / WebGL2。UE5 的平台接口、目标平台模块和 Chaos 已发生变化，旧文件必须逐项对照 5.8.3 接口，不能直接复制后宣称兼容。源码提交说明也明确 Niagara 仍有 SRV 相关问题。

本地入口：[HTML5ToolChain.cs](H:/ue_html/reference-ue427-html5/Engine/Platforms/HTML5/Source/Programs/UnrealBuildTool/HTML5ToolChain.cs)。

### 2.2 DiligentCore：完整 WebGPU 图形后端

- 引擎与浏览器示例入口：<https://github.com/DiligentGraphics/DiligentEngine>
- 实际图形代码：<https://github.com/DiligentGraphics/DiligentCore/tree/master/Graphics/GraphicsEngineWebGPU>
- 本次读取提交：`074060cfd1db73064d7a18cf40df86af6531520c`。
- WebGPU 源码许可：Apache-2.0。

这是本轮最值得补充到 **UE WebGPURHI** 设计中的参考：它提供完整图形抽象的 WebGPU 实现，而非只有三角形示例。

相对 `Graphics/GraphicsEngineWebGPU/src/` 的重点文件：

| 文件 | 用途 |
| --- | --- |
| `DeviceContextWebGPUImpl.cpp` | Draw、DrawIndexed、Indirect Draw、Compute、资源更新和拷贝 |
| `PipelineStateWebGPUImpl.cpp` | Graphics / Compute PSO 与 Pipeline Layout |
| `PipelineResourceSignatureWebGPUImpl.cpp` | Shader 资源签名和绑定布局 |
| `ShaderResourceCacheWebGPU.cpp` | Bind Group 与动态 Buffer Offset |
| `ShaderWebGPUImpl.cpp` | HLSL / SPIR-V / WGSL 路径与资源反射 |
| `BufferWebGPUImpl.cpp`、`TextureWebGPUImpl.cpp` | Buffer、Texture、View 与生命周期 |
| `SwapChainWebGPUImpl.cpp` | Surface、尺寸变化与呈现 |

对应测试位于 `Tests/DiligentCoreAPITest/src/WebGPU/`，包含绘制、Compute、清屏和原生资源包装等测试参考。

限制：这些是 Diligent 的接口，不是 UE 的 `FRHI*` 接口。优先借鉴其实现和测试，是否把 Diligent 作为 UE RHI 的依赖，需要另行评估抽象转换成本。不要把 Diligent 其他原生后端的能力列表当作 WebGPU 全部支持的功能。

进一步接入核对发现：这个提交的 Web 构建使用旧式 `USE_WEBGPU` 绑定，并将 Dawn 固定到 `db55f595741106be83b823a02ebdc58efbe997f1`；设备/读回回调与当前 emdawnwebgpu 的接口需要对齐。ShaderTools 还把 Tint 作为运行时依赖。因此目前更适合先用它做完整后端参考，通过独立 probe 决定是否整库接入，不能直接与最新 Dawn 混装后宣称可用。

本地入口：[DeviceContextWebGPUImpl.cpp](H:/ue_html/reference-diligent-core/Graphics/GraphicsEngineWebGPU/src/DeviceContextWebGPUImpl.cpp)。

### 2.3 GodotWebGPU：大型 C++ 引擎增加新图形驱动

- 分支：<https://github.com/dwalter/godotwebgpu/tree/webgpu-4.6.2>
- 驱动文档：<https://github.com/dwalter/godotwebgpu/blob/webgpu-4.6.2/drivers/webgpu/README.md>
- 本次读取提交：`f329e39ce8db7acaa5c9d6628a530fb769969228`。
- 许可：MIT；第三方组件另有各自许可。

它的参考价值在于 **已有引擎图形抽象如何映射 WebGPU 的差异**。

相对 `drivers/webgpu/` 的重点文件：

- `rendering_device_driver_webgpu.cpp`：资源、绘制、Compute、动态绑定和命令编码。
- `rendering_context_driver_webgpu.cpp`：GPUDevice 初始化与 Canvas Surface。
- `spirv_preprocess.cpp`：SPIR-V 预处理、Sampler 拆分、Push Constant 改写等。
- `rendering_shader_container_webgpu.cpp`：Shader 容器与转换。
- `tint_wrapper.cpp`：隔离 Tint C++20 接口。
- `pixel_formats_webgpu.h`：纹理格式映射。

驱动文档具体描述了 Push Constant 的环形缓冲模拟、Subpass 拆分、异步读回和绑定布局适配。它们与 UE 移植的难点有直接对应关系。

边界：社区 Beta，非 Godot 官方完成的全平台 WebGPU 实现；其 README 对 Windows/Linux 的验证仍列为 TODO，FAQ 以 Mobile Renderer 为当前工作路线。文档不同位置有更宽泛的能力表述，本次采用较保守的 FAQ 和 Known Limitations。性能数字未独立复现。

本地入口：[驱动说明](H:/ue_html/reference-godot-webgpu/drivers/webgpu/README.md)。

### 2.4 Dawn / emdawnwebgpu / Tint

- 源码：<https://github.com/google/dawn>
- 浏览器 C/C++ 桥接文档：<https://dawn.googlesource.com/dawn/+/refs/heads/main/src/emdawnwebgpu/pkg/README.md>
- 本次读取提交：`bf94d83239d665b6ec546b58c06bd4ec560ac3fa`。
- 主体许可：BSD-3-Clause，第三方文件单独确认。

三个组件各有用途：

| 组件 | 用途 |
| --- | --- |
| Dawn Native | 桌面上运行 WebGPU API，方便先验证 UE RHI |
| emdawnwebgpu | 将 WebGPU C/C++ API 接到浏览器 JavaScript WebGPU |
| Tint | 读取/处理 Shader IR，生成 WGSL，提供检查和反射工具 |

`src/emdawnwebgpu/pkg/README.md` 给出的集成方式是在编译和链接时使用 `--use-port=emdawnwebgpu`。UE 的 UBT 工具链可以参考其非 CMake 平台集成，而不是沿用旧的 `USE_WEBGPU` 示例。

重点代码：`src/emdawnwebgpu/`、`src/tint/lang/spirv/reader/`、`src/tint/lang/wgsl/writer/`。

边界：桥接库不会自动实现 UE RHI，也不会自动修复所有 UE Shader。文档将核心 C API 与 Dawn 专有接口 / C++ 包装的稳定程度区分开，实施时需固定版本。

本地入口：[emdawnwebgpu 接入说明](H:/ue_html/reference-dawn/src/emdawnwebgpu/pkg/README.md)。

### 2.5 Godot 官方 Web 平台与 SDL3

- Godot：<https://github.com/godotengine/godot/tree/master/platform/web>
- Godot 本次读取提交：`befe24c83135da887e534504874d1dcea4ed1f1c`；主体许可 MIT。
- SDL3：<https://github.com/libsdl-org/SDL/tree/main/src>
- SDL3 Emscripten 文档：<https://wiki.libsdl.org/SDL3/README-emscripten>；主体许可 zlib。

Godot 官方平台适合参考：

- `platform/web/web_main.cpp`、`os_web.cpp`：引擎与浏览器事件循环。
- `platform/web/js/engine/preloader.js`：启动资源预加载。
- `platform/web/audio_driver_web.cpp`：音频平台接口。
- `platform/web/js/libs/library_godot_audio.js`、`audio.worklet.js`：AudioWorklet 与浏览器音频桥接。

你 UE 5.8.3 源树已经包含 SDL3 的以下实现：

- `Engine/Source/ThirdParty/SDL3/SDL-gui-backend/src/video/emscripten/SDL_emscriptenevents.c`
- `Engine/Source/ThirdParty/SDL3/SDL-gui-backend/src/audio/emscripten/SDL_emscriptenaudio.c`
- `Engine/Source/ThirdParty/SDL3/SDL-gui-backend/docs/README-emscripten.md`

因此，应先研究已有 SDL3 如何接入新平台，减少从 UE4 SDL2 整体搬运的工作。SDL3 文档还明确说明浏览器主线程需要让出执行权，不能使用普通阻塞游戏循环。

## 3. 全部参考目录

下表的“验证”表示本次核对方式；“有样例”表示项目提供样例，本次没有实际运行。前三个 UE4 分支属于同一历史代码谱系，不能算作三个独立解决方案。

| # | 项目 | 重点解决的问题 | 验证与边界 |
| --- | --- | --- | --- |
| 1 | SpeculativeCoder UE 4.27 HTML5 | UE 平台、构建、打包、启动、PAK 缓存 | 源码；完整 UE4 路线，不能直接用于 UE5 |
| 2 | UnrealEngineHTML5 UE 4.24 | 平台扩展原始结构与社区文档 | 源码；更适合对照历史设计 |
| 3 | ufna UE-HTML5 / 4.27-html5_dev | UE4 平台移植差异、第三方库构建 | 源码；本次分支 HEAD 为 2022-01-18，SDK 3.0.0 |
| 4 | UnrealWasm | 接近 UE 5.8 的平台/RHI/Shader 接口 | 既有源码核查；5.8.2 研究快照，完整场景未完成 |
| 5 | DiligentCore WebGPU | 完整图形抽象后端、资源、PSO、绘制与测试 | 源码；优先图形参考，需要适配 UE RHI |
| 6 | bgfx | WebGPU 资源绑定、缓存与 Renderer 实现 | 源码；README 将 WebGPU 标为 Dawn Native only，不能声称浏览器交付已完成 |
| 7 | GodotWebGPU | 大型引擎映射 WebGPU、SPIR-V 预处理、读回 | 源码；社区 Beta，有演示，平台验证有缺口 |
| 8 | Dawn / emdawnwebgpu / Tint | C++ 浏览器图形桥接、桌面验证与 WGSL 转换 | 源码和官方文档；不是 UE 平台实现 |
| 9 | wgpu / Naga | 另一套 WebGPU 后端、Shader 翻译与验证 | 源码；Rust 实现，接入 UE 会增加工具链/FFI 成本 |
| 10 | Slang | HLSL 兼容输入、WGSL 生成与反射 | 源码；WGSL target 仍为实验性 |
| 11 | Emscripten | LLVM/WASM 工具链、线程、内存、文件系统 | 源码和文档；WasmFS 部分仍在发展，需固定 SDK |
| 12 | Godot 官方 Web 平台 | 主循环、输入、资源启动、AudioWorklet | 源码；成熟 Web 平台参考，不是 UE 插件 |
| 13 | SDL3 Emscripten 后端 | 窗口/输入/音频的 C/C++ 平台接入 | UE 自带源树和官方文档；必须处理浏览器循环 |
| 14 | Sokol | 较小的 WebGPU/WebGL 实现、Fetch 与应用入口 | 源码，有 WASM 样例；音频代码仍有旧 ScriptProcessor 路径 |
| 15 | rbfx / Urho3D 派生 | 完整 C++ 游戏引擎 Web 构建、虚拟文件系统 | 源码和示例文档；官方表当前 Web 为 WebGL2 |
| 16 | Filament | C++ PBR 渲染器、WebGPU 后端、WASM 构建与资产处理 | 源码和 Web 样例；WebGPU 默认关闭，浏览器集成需验证 |
| 17 | Magnum | 浏览器应用入口、事件、缩放、WebGL 封装 | 源码，有 EmscriptenApplication 测试 |
| 18 | Basis Universal | 浏览器纹理转码、压缩纹理格式选择 | 官方源码说明和 WASM 示例；需要 UE TextureFormat/Cook 适配 |
| 19 | JoltPhysics.js | 大型 C++ 物理库的 WASM、多线程与 SIMD | 官方源码说明和演示；不能直接替换 Chaos |
| 20 | WebGPU CTS | GPU API、Shader 和资源约束的测试样例 | 官方测试库；检查后端行为，不是引擎渲染实现 |

## 4. 辅助项目具体看哪里

### bgfx

仓库：<https://github.com/bkaradzic/bgfx>。主体许可 BSD-2-Clause。

重点：`src/renderer_webgpu.cpp`、`src/renderer_webgpu.h`、`examples/common/entry/entry_html5.cpp`。

已经检查到 Bind Group 创建/缓存、动态 Offset、WGSL ShaderModule 和 Emscripten 条件分支。其官方 README 仍只承诺 Dawn Native 的 WebGPU 后端，浏览器分支存在不等于已完成产品支持。适合借鉴算法与资源管理。

### wgpu / Naga

仓库：<https://github.com/gfx-rs/wgpu>。主体许可 MIT / Apache-2.0。

重点：`wgpu/src/backend/webgpu.rs`、`naga/src/front/spv/`、`naga/src/back/wgsl/`、`naga/tests/`。

可用来交叉检查 Tint 之外的 Shader 翻译结果，或借鉴资源验证。对主要为 C++ 的 UE 项目，第一轮优先 Dawn/Tint，可避免同时增加 Rust FFI 集成。

### Slang

仓库：<https://github.com/shader-slang/slang>。主体许可 Apache-2.0 WITH LLVM-exception。

重点：`source/slang/slang-emit-wgsl.cpp`、`docs/user-guide/a2-03-wgsl-target-specific.md`、`examples/reflection-api/`。

建议作为第二条 Shader 编译试验路线，与现有 HLSL → SPIR-V → Tint 链做相同 Shader 的比较。其 README 将 WGSL 明确标为实验性，目标能力文档列出了不支持的 Shader 类别，不应直接承诺任意 UE Shader 都能转换。

### Emscripten

仓库：<https://github.com/emscripten-core/emscripten>。主体为 MIT / NCSA 双许可。

重点：`src/settings.js`、`tools/ports/`、`system/lib/wasmfs/backends/fetch_backend.cpp`、`opfs_backend.cpp`、线程/AudioWorklet 测试。

本次主干中 `MEMORY64` 配置已被标注 deprecated，并推荐 `-m64` / `--target=wasm64`。它仍描述 native wasm64 与降低到 wasm32 的不同模式。应选择匹配的稳定 SDK 和 ABI，不能把不同年份示例中的参数混用。

WasmFS 的 Fetch、OPFS 实现是文件系统参考，不等于 UE IoStore 已能直接使用浏览器缓存。还需处理异步网络、同步 UE 文件接口、Worker 和数据寿命。

### Sokol

仓库：<https://github.com/floooh/sokol>。主体许可 zlib/libpng。

重点：`sokol_gfx.h`、`sokol_app.h`、`sokol_fetch.h`。

适合快速阅读 WebGPU 最小可用后端和异步资源加载。当前头文件说明使用 `--use-port=emdawnwebgpu`。`sokol_audio.h` 仍说明采用 ScriptProcessorNode，所以音频主体优先参考 Godot AudioWorklet 和 SDL3。

### rbfx

仓库：<https://github.com/rbfx/rbfx>。自身代码 MIT，第三方组件单独确认。

重点：`CMakePresets.json` 中 Web Emscripten 目标、`Source/Urho3D/IO/VirtualFileSystem.cpp`、`PackageFile.cpp`、`Core/WorkQueue.cpp`。

它提供 C++ 引擎的完整 Web 构建与示例，但引擎自称仍在开发中。本次确认 Web 支持表是 WebGL2；仓库包含 Diligent WebGPU 代码不构成 rbfx 已支持 WebGPU 的证据。

### Filament

仓库：<https://github.com/google/filament>。主体许可 Apache-2.0。

重点：`web/filament-js/CMakeLists.txt`、`wasmloader.js`、`filament/backend/src/webgpu/` 与 `build.sh`。

当前源码包含 `WebGPUDriver.cpp`、`WebGPUMemoryMappedBuffer.cpp`、`WebGPUPipelineCache.cpp`、`WebGPUDescriptorSet.cpp` 和 `platform/WebGPUPlatformWasm.cpp`。可参考绘制、读回、资源绑定、缓存与预先初始化 GPUDevice 的接入方式，优先级高于单纯的 WASM 加载示例。

`build.sh` 已包含本地构建 emdawnwebgpu 包并用于 WASM 的逻辑；但 WebGPU 默认关闭，帮助信息仍写有 “NOT functional atm”。本次没有实测其浏览器 WebGPU，因此将后端实现和既有 WebGL2 网页示例分别记录，不把源码存在当作成熟网页交付的证明。

其离线材质和纹理生产链也可用于 UE Shader Cook 的设计参考；不建议以替换 UE 材质系统作为当前任务。

本地入口：[WebGPUDriver.cpp](H:/ue_html/reference-filament/filament/backend/src/webgpu/WebGPUDriver.cpp)。

### Magnum

仓库：<https://github.com/mosra/magnum>。主体许可 MIT。

重点：`src/Magnum/Platform/EmscriptenApplication.cpp`、对应 `.h/.js`、`Platform/Test/EmscriptenApplicationTest.cpp`。

适合查浏览器窗口尺寸、事件、输入和主循环的清晰实现，作为 UE ApplicationCore 的交叉参考。

### Basis Universal、JoltPhysics.js、WebGPU CTS

- Basis：<https://github.com/BinomialLLC/basis_universal>；Apache-2.0；看 WASM 转码和 `webgl` 示例，评估网页纹理交付。
- Jolt：<https://github.com/jrouwe/JoltPhysics.js>；MIT；看 `Build/`、`Examples/` 与 WASM/SIMD/线程构建配置，用于 Chaos WASM 可行性测试的参考。
- CTS：<https://github.com/gpuweb/cts>；看 `src/webgpu/` 与 `src/webgpu/shader/`，验证设备约束、绑定、Shader 和错误处理。

这三项本轮核对的是官方说明和示例入口，没有安装或运行。Jolt 不作为自动替换 Chaos 的建议，Basis 不会自动适配现有 Cook 纹理。

## 5. 对应到你的 UE 5.8.3 源码

下面是实施范围映射，不是本次已经完成的代码改动。

| UE 模块或文件 | 优先参考 | 首个验证目标 |
| --- | --- | --- |
| UBT 平台与 ToolChain | UE4 HTML5、Emscripten、UnrealWasm | 基础 C++ 目标可编译链接 WASM |
| TargetPlatform Settings / Controls / Cook | UE4 TargetPlatform、UE5 现有平台结构 | 正确枚举网页目标和 Cook 格式 |
| UAT Stage / Package | UE4 AutomationTool | 可重现的网页产物与资源清单 |
| Core Memory / Process / TLS / Threads | UE4 HTML5、Emscripten、Godot | 对象分配、任务执行与 Worker 启动 |
| Launch / ApplicationCore | UE4 LaunchHTML5、Godot、SDL3、Magnum | 浏览器循环、键鼠、触摸、尺寸变化 |
| `RHI/Public/DynamicRHI.h`、`RHIContext.h` | Diligent、bgfx、GodotWebGPU | 创建资源、记录绘制、呈现真实 UE 帧 |
| VulkanShaderFormat / ShaderCompilerCommon | UE 现有编译链、Tint、Slang、Naga | WGSL 编译、反射与资源绑定一致 |
| RenderCore Shader Library | UE 自身 ShaderCodeArchive + Shader 容器参考 | Cook 的 Shader 被新 RHI 正确加载 |
| IoDispatcher / IoStore / PakFile | UE 自身 IO、UE4 加载器、WasmFS、rbfx | Cook 内容加载、缓存、错误恢复 |
| AudioMixer | UE 现有 AudioMixerSDL、SDL3、Godot | WebAudio 输出、启动与暂停恢复 |
| Chaos | Emscripten、Jolt WASM 构建经验 | 基础碰撞和刚体测试，仍保留 Chaos |
| TextureFormat / Texture Cook | UE 原有纹理管线、Basis | 浏览器设备支持的格式与转码路径 |

你源树中可确认存在的入口：

- `Engine/Source/Runtime/RHI/Public/DynamicRHI.h`
- `Engine/Source/Runtime/RHI/Public/RHIContext.h`
- `Engine/Source/Developer/VulkanShaderFormat/Private/VulkanShaderCompiler.cpp`
- `Engine/Source/Runtime/RenderCore/Private/ShaderLibrary/ShaderCodeArchive.cpp`
- `Engine/Source/Runtime/Core/Private/IO/IoDispatcher.cpp`
- `Engine/Source/Runtime/Core/Private/IO/IoStore.cpp`
- `Engine/Source/Runtime/Linux/AudioMixerSDL/Private/AudioMixerPlatformSDL.cpp`
- `Engine/Source/Runtime/Experimental/Chaos/Chaos.Build.cs`

这些入口通过 Git 文件树核对；不表示其浏览器移植已完成。

## 6. 实施判断与推荐顺序

### 更适合长期的主体方向

建立自己掌握源码的 UE Web 平台，采用 **Emscripten + WebGPURHI + 离线 WGSL Cook**。优先以 Diligent 为完整图形后端参考、GodotWebGPU 为差异适配参考，UE4 HTML5 负责平台和启动链。

建议先在桌面 Dawn Native 下开发和测试 WebGPURHI，然后使用 emdawnwebgpu 进入浏览器。这样可以分别定位 UE RHI 映射错误和 WASM/浏览器运行错误；这一步是工程建议，不是现成 UE 集成。

第一轮 Shader 链建议保留 UE 的 HLSL 生成和已有 SPIR-V 编译经验，接入 Tint；Slang 与 Naga作为对照，验证具体 Shader 和反射结果后再决定主链。

### 可并行评估的启动路线

**UE5 Mobile Renderer + WebGL2** 可以参考现有 OpenGLDrv 与 UE4 HTML5，以较小的功能范围测试完整启动链。

但 WebGL2 的能力不能等同于 UE5 OpenGL ES3.1 所用全部能力。计算着色器、SRV/UAV 依赖和现代 Renderer 特性需要逐项判断，不能把这个方向描述为所有 UE5 功能的免费替代方案。

如果真实项目必须使用这些能力，WebGPU 是更合适的主体研发方向。先跑通基础场景，并不等于放弃高级特性，而是让后续问题可单独定位。

### 每个阶段保留明确验收证据

1. **构建与平台**：固定工具链/ABI；链接 WASM；引擎启动到 World；线程和内存测试通过。
2. **基础渲染**：真实 UE Mesh、基础材质、纹理、深度、实例化和尺寸变化。
3. **Shader 与资源**：反射、Uniform 布局、绑定编号和 Compute/Indirect Draw 分别核对。
4. **场景运行**：蓝图 Tick、网页 UI 消息桥、音频、Chaos、资源缓存和实际插件；UMG 仅处理实际阻塞点，优先局部禁用并保留必要依赖。
5. **高级渲染**：按项目需求验证 GPUScene、Niagara、Nanite、Lumen；根据具体 API、Shader 和设备限制记录支持范围。

完整后端还需要处理异步初始化/读回、Texture 格式、对齐、绑定数量和 Device Lost 等问题。用设备能力和差分测试证明功能，避免仅靠配置开关把尚未实现的能力标为支持。

## 7. 本地快照

新快照都是浅克隆、稀疏检出的阅读材料，未下载完整第三方依赖；不能把这些目录直接当作已配置的构建环境。

| 本地目录 | 分支 | 本次 HEAD |
| --- | --- | --- |
| `reference-ue427-html5` | `4.27-html5-es3` | `c4e46c2d24c9e90241cef66db793731ed6aff479` |
| `reference-ue424-html5` | `4.24.3-html5-1.39.18` | `6e6a8ef05447808ab6d6ee7692927579b8b5dff5` |
| `reference-ufna-html5` | `4.27-html5_dev` | `5497571e7ae3dbf7230bab1e3bf77dfdc408669b` |
| `reference-diligent-core` | `master` | `074060cfd1db73064d7a18cf40df86af6531520c` |
| `reference-bgfx` | `master` | `e4f704ab1267054d30e05de8f39b79b6d5c913c0` |
| `reference-godot-webgpu` | `webgpu-4.6.2` | `f329e39ce8db7acaa5c9d6628a530fb769969228` |
| `reference-dawn` | `main` | `bf94d83239d665b6ec546b58c06bd4ec560ac3fa` |
| `reference-emscripten` | `main` | `0bb26c10d3cd7d9327cf95c1d1cf8fd1252ea3bb` |
| `reference-slang` | `master` | `07cfeed8a3564e3855fde1ca8df449eba9e88c19` |
| `reference-wgpu` | `trunk` | `eddf0b4c8f2c50b7895ad26ee946401e563cdd32` |
| `reference-godot` | `master` | `befe24c83135da887e534504874d1dcea4ed1f1c` |
| `reference-sokol` | `master` | `5e94d1291fea504ed911090338cf35bd9ef49a06` |
| `reference-rbfx` | `master` | `156d8d0917d4bde1f8751d746ee96ca7aa741813` |
| `reference-filament` | `main` | `764fe6cac9bdb4ba24d3d852344dfa04a5f70f75` |
| `reference-magnum` | `master` | `a816a15a4a8dd227734b66a529a8ccd3c26b570f` |

既有 `reference-unrealwasm` 继续保留，详见前一轮报告。

另检查 `eliemichel/SlangWebGPU`：它提供 Host Shader 工具与 WASM 两阶段构建的示例，但本次顶层文件树未发现许可证，README 也明确是缺少纹理绑定等功能的 proof of concept，因此不纳入可直接复用源码的主清单。其本地目录为 `reference-slang-webgpu`。

## 8. 其他来源入口

- UE 4.24 社区文档：<https://github.com/UnrealEngineHTML5/Documentation>
- UE 4.24 引擎：<https://github.com/UnrealEngineHTML5/UnrealEngine/tree/4.24.3-html5-1.39.18>
- ufna 跟踪：<https://github.com/ufna/UE-HTML5>
- ufna 引擎：<https://github.com/ufna/UnrealEngine/tree/4.27-html5_dev>
- UnrealWasm：<https://github.com/SamG-Coder/UnrealWasm>
- Emscripten 线程：<https://emscripten.org/docs/porting/pthreads.html>
- Emscripten 文件系统：<https://emscripten.org/docs/api_reference/Filesystem-API.html>
- Slang 示例，只作思路参考：<https://github.com/eliemichel/SlangWebGPU>

本轮完成源码与文档调研，没有修改引擎实现，没有编译 UE 或运行这些样例，也没有产生或推送 Git 提交。
