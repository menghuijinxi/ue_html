# UE 5.8 Web UBT 与 WASM Runtime 接入

日期：2026-10-20。

## 当前进度

**2026-10-20 第四十九轮：未用场景 Uniform 默认资源已排除，浏览器实际分配 SceneDepthZ。** Chrome/Edge 均越过 GetDefaultSkinningParameters 的 Raw Buffer 错误，新增四个 Web 分支只清零蒙皮、GPUScene、ViewData 与 VSM 默认参数，保留注册及其他平台正文。`verify-web-scene-uniform-defaults.cjs` 通过；真实地图 BeginPlay、NullRHI 各 10 Tick。WebGPU 尚无完成 Tick，停止于 RDG 的转换创建校验，深度纹理 1、深度 pass 0，不能视为场景通过。

新增 `iterate-web-engine.ps1` 按编译器、响应、对象、日志及 Clang 依赖哈希复用对象。同输出响应去重，修正 Unity 分组混用；SystemTextures 补 Web 显式 LogRenderer 头。最终诊断链接 34 个受审计对象中本次编译 1、复用 33，5,998 个依赖哈希核验，415 项链接通过。日志 `web-engine-webgpu-link-20261020-214349.log`；先前重复符号和缺头失败保留，没有采用忽略重复符号的链接选项。新增可选 scene=1 验收入口加载已 Cook 的 Cube/EmissiveMeshMaterial 和相机，当前因 Init 尚未返回而没有运行，截图验收仍失败。完整正常 Web UBT、版本一致性、网格实际像素仍待验证。

本地 Git 已建立两个独立仓库：`reference-engine` 的 html 分支保存引擎源码，根仓库保存外围源码/脚本/文档。中文基线提交分别为 609c90f7b、58b5a83；后续按验证批次本地提交，不推送。

以下为历史检查点。

**2026-10-20 第四十八轮：RenderCurve 与 Nanite 默认资源阻塞已越过，当前推进到骨骼蒙皮默认回调。** 本轮只在 Web 排除最小静态网格路径不用的初始化，没有移植毛发、Nanite、骨骼动画或 Raw/Structured Buffer。完整 Runtime、场景首帧仍未通过。

| 本轮检查 | 结果与边界 |
| --- | --- |
| RenderCurve | 保留扩展及 Scene Uniform 注册；Web 扩展启用条件返回 false，默认参数清零，不创建曲线 Raw Buffer。新增两个分支，共 8 行；忽略行尾形式后，移除分支恢复安装版完整正文 |
| Nanite | Web 的材质与 ownership 默认回调各清零参数，不创建 Raw/Structured Buffer；各新增 4 行。保留注册与已有 DoesRuntimeSupportNanite 检查，两种 Web Shader 平台 bSupportsNanite=false；其他平台正文保留 |
| 诊断链接修复 | 首次重编 Nanite 单元后出现 MaterialUsesVertexInterpolator_RenderThread 符号缺失；重编原有 MaterialShared.cpp 的 Engine.32 后解决，没有新增替代函数或修改材质逻辑。保留失败报告和日志 |
| 最终 WASM | 28 个实际单元重编，415 项诊断链接通过，日志 web-engine-webgpu-link-20261020-210831.log；包括 Renderer.7、Renderer.18 和 Engine.32。全部响应、源码、对象、日志与最终输入哈希核验；仍非完整正常 Web Engine UBT |
| 平台及 ABI | 准备脚本加入三个覆盖文件，安装版只读。ApplicationCore 正常构建及 Chrome/Edge 四组窗口/DPR 共 68 项再次通过；WASM64 marker ABI 双浏览器修复前/后共 4 组重新通过 |
| 浏览器推进 | 实际重编/双浏览器先越过 RenderCurve，随后越过 Nanite 材质默认 Raw Buffer；各阶段旧失败单独保存。最终 Chrome/Edge 都加载真实 /Game/WebMinimal 并 BeginPlay，NullRHI 各完成 10 个有效 Tick |
| GPU 证据 | 两浏览器各 6 个 ShaderModule、1 条图形管线、2 个启动清屏 pass/2 次 draw、23 个命令缓冲，队列完成、无 GPU validation；35 张纹理/107 mip/9,454,164 字节读回一致。实际深度分配/pass 仍为 0，硬件 Init 未返回、完成 Tick 为 0 |
| 当前准确阻塞 | Skinning/SkinningSceneExtension.cpp:226 的 GetDefaultSkinningParameters 经 FExtensibleUniformBufferBase::GetBufferGeneric 创建 Raw Buffer SRV，被现有 RHI 限制拒绝。两浏览器调用栈一致，旧 RenderCurve/Nanite 栈已消失 |
| 最终回归 | 原 40 项及双浏览器三轴、材质条件、payload、FIFO、静态绑定、二维/系统纹理、默认资源、Canvas、breadcrumb、深度、局部雾、新 RenderCurve/Nanite 验证、同二进制 PSO 对照与 ES31 汇总通过。材质实际作业 838 global/211 material/114 LocalVF，0 失败 |
| 沿用证据 | 共享 RHI、Shader/Cook 配置本轮未改；既有正常原生构建、18 项深度、完整 RHI 43 draw/5 dispatch/1,344,520 值、二维/视口/静态/Unlit 和两套真实地图 Cook/Stage 沿用有效哈希核验，没有记成本轮重跑 |

新增 `verify-web-render-curve-defaults.cjs`，先记录修复前失败，再检查 Web 分支、注册/消费条件、桌面正文、实际重编对象及两浏览器越过旧栈；ES31 汇总要求此检查通过。当前 `renderCurveDefaultsExcluded=true`、`naniteDefaultsExcluded=true`、`renderCurveDefaultBlocked=false`、`skinningDefaultBlocked=true`，阶段 true 不能代替 Runtime 或 completeUEScene。

复现：设置下方 NODE_PATH，运行 `probe-web-engine-webgpu.cjs --incremental --es31`，当前预期非零且失败于上述 Skinning 默认回调。刷新 Shader/材质/纹理/平台验证及 `probe-web-pso-consolidation.cjs` 后，运行 `verify-web-scene-depth.cjs`、`verify-web-local-fog-defaults.cjs`、`verify-web-render-curve-defaults.cjs`，最后运行 `verify-web-es31-runtime-integration.cjs`。`*-before-render-curve-defaults-20261020.json`、`*-before-nanite-defaults-20261020.json` 保留旧失败，`web-engine-webgpu-link-results-before-material-symbol-20261020.json` 保留链接符号失败，`round48-*-before.log` 保留新增检查的失败记录。

下一步仅排除最小 Web 路径不用的蒙皮默认资源，并核对扩展启用条件与消费者；不移植骨骼动画。之后验收实际深度附件、首帧和连续 Tick，再推进单静态网格/Texture2D/Unlit、相机/HTML UI，以及完整正常 Web Engine UBT 与 5.8.3/5.8.0 版本一致性。

以下为历史检查点。

**2026-10-20 第四十七轮：未用局部雾及 BasePass 默认资源阻塞已越过，推进到场景 Uniform 的 RenderCurve 默认 Raw Buffer。** 本轮没有扩展雾、DBuffer、Cube、数组纹理或毛发功能。两浏览器仍为 0 个完成 Tick，真实深度附件尚未分配，场景首帧未通过。

| 本轮检查 | 结果与边界 |
| --- | --- |
| 局部雾默认入口 | LocalFogVolumeRendering.cpp 两个入口仅在 Web 清零参数/视图数据，实例数为 0，深度起始距离 FLT_MAX；不创建数组、Typed/Raw Buffer 或间接绘制默认资源。原有局部雾绘制能力检查保留，半分辨率默认关闭 |
| Shader 与消费方 | Cook 两端 r.SupportLocalFogVolumes 都为 0，6 类局部雾 Shader 的变体数都是 0；审计 MobileBasePass、MobileFog、MobileShadingRenderer 的参数引用和已有绘制能力检查。没有启用雾或补充对应 Shader |
| BasePass DBuffer/阴影 | 在配置关闭 DBuffer 时使用清零参数，保留 `check(!IsUsingDBuffers(...))`，意外启用仍明确报错。未用阴影数组默认值设空，普通二维阴影资源保留；Web 两种 Shader 平台关闭 MobileMultiView，Shader 仅在该分支采样数组 |
| BasePass 反射/调试 | 清零当前 Unlit 不用的反射参数，避免注册已排除的黑色 Cube；调试 QuadOverdraw 与遮挡反馈默认 UAV 设空。现有遮挡反馈 Shader 两类变体均为 0；没有补 Cube、反射或调试渲染功能 |
| 源码保留 | 局部雾文件本轮仅新增 9 行；移除两个 Web 分支精确恢复上一轮原始 SHA256，保留原有策略。BasePass 仅新增 18 行；移除四个 Web 分支后与安装版完整正文一致。准备脚本加入 BasePass 覆盖，安装版保持只读 |
| 最终 WASM | 25 个实际单元重编、415 项诊断链接通过，日志 `web-engine-webgpu-link-20261020-203126.log`。包括局部雾 Renderer.10 与 BasePass/移动 Renderer.16；全部源码、响应、对象、日志及最终链接输入哈希核验通过。仍非完整正常 Web Engine UBT |
| ApplicationCore | 准备脚本变化后重新正常构建，20 个 ApplicationCore 对象；Chrome/Edge 各桌面与窄窗口、DPR 1/2 共 68 项重新通过 |
| 原生与 Cook | 本轮共享 RHI、Shader/Cook 配置未变，沿用上一轮正常原生构建、18 项深度检查、完整 RHI 43 draw/5 dispatch/1,344,520 值和二维/视口/静态/Unlit 回归，通过来源及产物哈希核验；未将其写成本轮重跑。两套 Cook 也沿用有效产物：ES31 164 包/329 文件/51,161,232 字节，NullRHI 326 文件/19,955,961 字节 |
| 浏览器推进 | 三次实际重编/双浏览器运行依次越过局部雾默认数组、DBuffer 默认数组、反射 Cube 注册；初始失败和中间失败均单独保存。最终两浏览器真实 `/Game/WebMinimal` BeginPlay，NullRHI 各 10 个有效 Tick |
| 最终 GPU 证据 | Chrome/Edge 各 6 个 ShaderModule、1 条图形管线、2 个 pass/2 次启动清屏 draw、23 个命令缓冲，队列完成，无 GPU validation；各 35 张/107 mip/9,454,164 字节读回一致。实际 SceneDepthZ 分配与深度 pass 计数仍为 0，不算场景首帧 |
| 当前准确阻塞 | `RenderFullDepthPrepass → BuildMeshRenderingCommands → FInstanceCullingManager::SetDummyCullingParams → FExtensibleUniformBufferBase::GetBufferGeneric → RenderCurve::GetDefaultRenderCurveSceneParameters → GetDefaultByteAddressBuffer`。HairStrands/RenderCurveSceneExtension.cpp 的默认回调即使实例数为 0 仍创建 Raw Buffer，触发当前 BufferSRV 限制；这不是本轮旧局部雾错误复发 |
| 最终回归 | 原 40 项 Shader 与双浏览器三轴、材质条件、payload、FIFO、静态绑定、二维/系统纹理、默认资源、Canvas、breadcrumb、新局部雾/BasePass 检查、同二进制 PSO 对照与 ES31 汇总重新通过。WASM64 标记独立正反例沿用未变来源和有效产物；完整 Runtime、硬件 Init 返回和连续 Tick 仍未通过 |

新增 `verify-web-local-fog-defaults.cjs`，分别先复现局部雾、DBuffer 和反射 Cube 的旧失败，再要求实际 Engine 越过它们，并核验平台能力、已有 Cook 变体、源码保留及真实链接对象。当前阶段字段为 `localFogDefaultsExcluded=true`、`basePassArrayDefaultsExcluded=true`、`basePassOptionalDefaultsExcluded=true`、`localFogArrayDefaultBlocked=false`、`renderCurveDefaultBlocked=true`。阶段 true 不代表完整 Runtime 或 completeUEScene。

复现：设置下方 NODE_PATH 后，运行 `probe-web-engine-webgpu.cjs --incremental --es31`；当前预期非零，准确失败是上述 RenderCurve 默认 Raw Buffer。刷新既有 Shader/材质/纹理/平台检查及 `probe-web-pso-consolidation.cjs`，再运行 `verify-web-scene-depth.cjs`、`verify-web-local-fog-defaults.cjs`，最后运行 `verify-web-es31-runtime-integration.cjs`。`*-before-local-fog-defaults-20261020.json`、`*-before-basepass-array-defaults-20261020.json`、`*-before-basepass-reflection-defaults-20261020.json` 保存实际失败和匹配链接；`round47-*-before.log` 保存新增检查在修复前的失败。

下一步仅核对并排除 Web 未用的 RenderCurve 默认场景 Uniform 回调资源，保留注册接口和其他平台行为；不移植毛发或 Raw Buffer 功能。之后继续验收实际深度附件、首帧与连续 Tick，再做单静态网格/Texture2D/Unlit、相机/HTML UI，以及完整正常 Web Engine UBT 与版本一致性。

以下为历史检查点。

**2026-10-20 第四十六轮：SceneDepthZ 格式阻塞已修复，原生真实深度/模板读回通过；浏览器推进到局部雾默认资源。** 本轮只接入基础深度附件，并排除两处最小 Unlit 路径不用的资源初始化。浏览器地图仍为 0 个完成 Tick，尚未进入实际深度 render pass。

| 本轮检查 | 结果与边界 |
| --- | --- |
| 深度格式 | PF_DepthStencil 映射到基础 WebGPU 格式 Depth24PlusStencil8，注册深度/模板格式能力，退出临时 RHI 后恢复宿主原始记录。支持单 mip、单采样深度附件，不仅修改 Supported 标志 |
| 实际视图 | 组合视图用于附件，深度采样使用 Depth24Plus/DepthOnly，模板读取使用 Stencil8/StencilOnly；校验 float/uint 类型、格式别名、资源状态与 ShaderResource 标志 |
| 渲染通道 | 根据 UE ExclusiveDepthStencil 分别处理深度与模板的只读状态、清值和 load/store。模板比较/写入管线、MSAA、深度拷贝和 mip 链仍未支持 |
| 新增原生验证 | recorded/bypass 各 9 项，共 18 项通过。真实 UE 纹理/PSO/通道完成 reversed-Z 遮挡、第二个只读通道、深度 0.75 与模板清值 37 的 GPU 读回；同时检查非法格式、缺少附件用途、多采样拒绝及宿主格式恢复。修改前两模式均明确失败于格式注册，保留失败产物 |
| 综合探针 | 此前卡在深度格式的完整原生 WebRHIProbe 重新通过：43 次 draw、5 次 dispatch、1,344,520 个值，包含深度写入到只读转换后遮挡保持。报告 `build/ue-rhi-depth-full/rhi-results.json` |
| 最小排除 | SceneTextures.cpp 仅 Web 将三个未用的移动数组默认值设空；去掉三个分支后与安装版正文一致。LightGridInjection.cpp 仅 Web 使用已有清零构造初始化 dummy forward-light 参数，避免未用的 Raw/Structured 灯光缓冲；去掉该分支精确恢复之前源码哈希，没有增加这些功能 |
| 原生与窗口回归 | 正常 Win64 模块构建，二维 232 项/20 dispatch/1,680 值、视口 72 项/143,976 通道值、静态绑定 38 项、空 UniformBuffer 8 项，以及静态 View/直接绑定各 19 次 Unlit 绘制/1,114,112 通道值均通过。准备脚本变化后，ApplicationCore 正常构建和四组浏览器输入/DPR 共 68 项重新通过 |
| 最终 WASM | 24 个实际单元重编、415 项诊断链接通过，日志 `web-engine-webgpu-link-20261020-195843.log`。包括实际 SceneTextures 的 Renderer.28 和 LightGridInjection 的 Renderer.9；全部源码、输入和产物哈希核验通过。仍非完整正常 Web Engine UBT |
| Cook/Stage | 本轮未重新 Cook，复核既有两套 Cook 的源码/产物哈希有效。继续使用真实 `/Game/WebMinimal`：ES31 164 包、329 文件、51,161,232 字节；NullRHI 326 文件、19,955,961 字节；1,049 个作业及 834 个归档 Shader 的既有验证保留 |
| 双浏览器 | Chrome/Edge 都加载真实地图并 BeginPlay，NullRHI 各 10 个有效 Tick。WebGPU 各 6 个 ShaderModule、1 条图形管线、2 个 pass/2 次 draw、23 个命令缓冲，队列完成且无 GPU validation；35 张/107 mip/9,454,164 字节读回一致。启动清屏不是场景首帧 |
| 当前准确阻塞 | `InitLocalFogVolumesForViews → SetDummyLocalFogVolumeForView → GetZeroUIntArrayDummy → RegisterExternalTexture`，在 `RenderGraphValidation.cpp:182` 因 `ExternalPooledTexture.IsValid()` 失败。没有局部雾实例时仍会执行 dummy 初始化，但 Web 已不创建该数组默认资源。原深度格式、移动数组默认创建、占位灯光缓冲错误均已越过 |
| 未完成验收 | RDG 在资源分配/执行前停下，观察到的 SceneDepthZ 实际分配数与深度 pass 数均为 0；硬件 Init 尚未返回，完成 Tick 为 0。不能把原生深度通过或格式错误消失写成浏览器深度通道、网格或场景首帧通过 |
| 最终阶段回归 | 原 40 项 Shader 与双浏览器三轴回归、材质条件、payload、FIFO、静态绑定、二维/系统纹理、默认资源、Canvas、WASM64 标记正反例、PSO 同二进制对照和 ES31 汇总全部通过。阶段报告 true，完整 Runtime 与 completeUEScene 仍为 false |

新增 `verify-web-scene-depth.cjs`：审计修改前失败、当前 18 项原生检查、完整 RHI 探针、实际重编/链接对象、桌面源码保留，以及双浏览器真实 GPU 调用。报告分别输出 `sceneDepthFormatBlockerResolved=true`、`browserDepthAllocated=false`、`browserDepthPassStarted=false`、`localFogArrayDefaultBlocked=true`，不将阶段通过等同于场景通过。

复现：先运行 `probe-web-system-textures.ps1` 和 `probe-web-static-uniforms.ps1` 正常构建/验证原生后端，再重编当前 24 个响应并诊断链接。设置下方 NODE_PATH 后执行 `probe-web-engine-webgpu.cjs --incremental --es31`，当前预期非零且停在上述局部雾调用栈；执行 `verify-web-marker-abi.cjs`、`probe-web-pso-consolidation.cjs`、既有 Shader/材质/纹理/平台核验后，运行 `verify-web-scene-depth.cjs`，最后运行 `verify-web-es31-runtime-integration.cjs`。`*-before-scene-depth-20261020.json`、`*-before-mobile-scene-arrays-20261020.json`、`*-before-dummy-forward-light-20261020.json` 保留本轮推进边界，`build/ue-rhi-depth-repro` 保留原生失败。

下一步只在 Web 排除未使用的局部雾默认初始化，并同步核对消费方，不实现雾或数组功能。随后验收浏览器实际深度附件、场景首帧与连续 Tick，再加入单个静态网格、普通 Texture2D/Unlit、相机及 HTML UI；最后验收完整正常 Web Engine UBT 和 5.8.3/5.8.0 版本一致性。

以下为历史检查点。

**2026-10-20 第四十五轮：真实最小地图已打包并在双浏览器 BeginPlay，呈现状态和空 UniformBuffer 已修复。** 本轮仍以 WebGPU 地图首帧为未完成验收项。此前缺失地图后产生的 NullRHI 回调计数不再作为有效运行证据。

| 本轮检查 | 结果与边界 |
| --- | --- |
| 呈现转换 | WebGPURHI 启动声明 `GRHIGlobals.NeedsExtraTransitions=true`，使用 UE 原有 Slate 最终转换。保留 `RequireAccess(...Present)`；修复前后的浏览器记录分别停在 Present 断言和后续 RHITick |
| 每帧入口 | 实现 RHITick；原生处理设备事件，浏览器由返回 JavaScript 事件循环处理回调，不同步等待 GPU |
| 真实地图 | 新 WebMinimalMap Commandlet 生成 `/Game/WebMinimal`，两种 Cook 使用同一份已审计源地图。源地图不放置场景网格，运行时仍使用内置 GameModeBase/DefaultPawn |
| Cook/Stage | ES31 164 包，329 个挂载文件，51,161,232 字节；NullRHI 326 文件，19,955,961 字节。新增地图未改变 1,049 个 Shader 作业清单；Global 仍为 91 映射/726 Shader，项目 108 Shader |
| 严格运行规则 | 在 BeginPlay 委托输出实际 World 包名、BeginPlay 与退出状态；Init 返回后再次核对。Tick 前后检查退出请求，发现退出即停止计数。双浏览器 NullRHI 已真实加载地图并完成 10 个 Tick、文件缓存检查 |
| 空 UniformBuffer | 遵循 UE 的先无内容创建、后更新语义。创建时不伪造常量数据，保留资源槽；实际绑定的常量尺寸检查和 UniformView 限制不变。recorded/bypass 新增共 8 项创建、更新快照及 Primitive 资源槽检查通过 |
| 最小渲染排除 | Web 不执行 GPU 调试消息、SSS/Specular/Toon Profile 更新、VSM 默认 Raw Buffer 初始化及天空反射 Cube 更新；View 参数同步排除 Profile、IES 与 Glint 数组消费。没有增加数组、Cube、Raw Buffer 或高级光照实现 |
| 桌面与既有改动 | MobileShadingRenderer 的四个 Web 编译条件去除后与安装版正文完全一致。SceneRendering 去除本轮三个条件后恢复上一轮精确 SHA256，保留已有 SMAA、编辑器合成和单采样策略 |
| 原生回归 | 正常 Win64 模块构建、二维 232 项/20 dispatch/1,680 值、视口 72 项/143,976 通道值、静态绑定 38 项和两种绑定的 Unlit 像素回归均通过。视口测试使用与 Slate 一致的 Unknown→Present，并确认转换前 Present 访问仍被拒绝 |
| 最终构建 | 23 个实际单元重编、415 项诊断链接通过，日志 `web-engine-webgpu-link-20261020-183228.log`。本轮加入 Renderer.16；RenderCore.3 仍逐项核对保留编译证据与实际链接对象，不计作本轮重编 |
| 浏览器 GPU 回归 | Chrome/Edge 各创建 6 个 ShaderModule、1 条图形管线、2 个 render pass/2 次 draw，提交 23 个命令缓冲；队列完成检查通过，无 GPU validation。各 35 张/107 mip/9,454,164 字节读回一致。这些启动清屏提交不是项目场景首帧 |
| 当前准确阻塞 | 真实地图 BeginPlay 后，在 Init 内主动重绘时进入 `FMinimalSceneTextures::InitializeViewFamily`，创建 `SceneDepthZ` 被 `GPixelFormats[Desc.Format].Supported` 拒绝：`DepthStencil` 不支持。两浏览器仍为 0 个完成 Tick，硬件 Init 尚未返回；这是首个真实场景渲染路径，与上一轮缺失地图后的 Init 返回分开记录 |
| 最终阶段回归 | 原 40 项 Shader 历史证据、双浏览器三轴实际 WGSL 回归、材质条件、Shader payload、FIFO、静态绑定、二维/系统纹理、默认资源、Canvas、标记 ABI、PSO 对照与 ES31 阶段汇总通过。ApplicationCore 因准备脚本哈希变化重新正常构建，四组浏览器 DPR/窗口输入共 68 项重新通过 |

关键入口：`prepare-web-minimal-map.ps1`、`WebMinimalMapCommandlet.cpp`、`cook-web-engine.ps1`、`stage-web-engine.cjs`、`probe-web-engine-webgpu.cjs --incremental --es31`。地图成功与硬件 Init 返回分开报告：LoadMap 会在 Init 内主动重绘，BeginPlay 成功后仍可能在 Mobile Renderer 失败。

本轮失败轨迹分别保留为 `web-engine-webgpu-es31-results-before-rhi-tick-20261020.json`、`-before-empty-uniform-20261020.json`、`-before-mobile-message-20261020.json`、`-before-mobile-profiles-20261020.json`、`-before-mobile-vsm-20261020.json`、`-before-profile-consumer-20261020.json`、`-before-view-array-fallback-20261020.json`、`-before-mobile-sky-reflection-20261020.json`。当前 `web-engine-webgpu-es31-results.json` 仍为 false；`web-es31-runtime-integration-results.json` 的阶段通过不代表 Runtime 或 completeUEScene 通过。

下一步只聚焦最小场景必需的深度附件接入：核对 UE 深度格式能力声明、深度视图与模板需求，以及后端已有 Depth32Float 路径的语义；用既有 reversed-Z 用例和实际浏览器验证，不能仅修改 Supported 标志就宣称完成。之后验收 WebGPU 地图首帧和连续 Tick、单个 Unlit 网格及相机、HTML UI 交互，最后验收完整正常 Web Engine UBT 构建与版本一致性。数组纹理、材质层、UMG 产品界面和高级光照仍不扩展。

以下为历史检查点。

**2026-10-20 第四十四轮：PSO 合并阻塞已越过，实际 WebGPU 的 FEngineLoop::Init 已返回。** Web 配置选择 UE 现有同步 PSO 合并路径；同一 WASM、同一内容包在 Chrome/Edge 中切换一个 CVar，开启异步均复现原保护，关闭后均越过。随后仅在既有 Web GPUScene 能力关闭时排除灯光上传调用，临时世界销毁不再请求 GPUScene.LightData。未删除缓存保护、修改原子操作或增加 Structured/Raw Buffer 支持。

| 本轮检查 | 实测结果 |
| --- | --- |
| PSO 原因 | 源码显示无工作线程时任务内联执行；FTaskTagScope 默认不覆盖已有游戏线程标记，两层合并选同一缓存索引，计数可嵌套到 -2，内层退出得到 -1 而触发保护。此解释来自源码语义与浏览器单变量对照，未直接读取私有计数器；不宣称原子操作存在缺陷 |
| 最小接入 | WebEngine.ini 和 Cook 最小配置设置 r.pso.EnableAsyncCacheConsolidation=0。PipelineStateCache.cpp 与安装版完全一致；调度/线程标记源码与本轮修复前哈希一致 |
| GPUScene | FScene::UpdateLights 的单独灯光上传调用使用既有 SupportsGPUScene(GetShaderPlatform()) 判断。Web 跳过，普通平台仍调用；实际临时世界销毁日志确认排除 |
| Init 返回 | 两浏览器输出 P3_ENGINE_READY：shaderPlatform=46、featureLevel=1、shaderCount=834、activeGPUSceneEnabled=false。首次 Tick 已进入，但尚无完成的 Tick |
| 当前阻塞 | 首次 Tick 的 Slate → EndDrawingViewport → RequireAccess：Resource access mismatch: current=0x1000 requested=0x2，仍为 0 完成帧。不能把 Init 返回算作连续 Engine Tick |
| 内容缺口 | 继承的 /Engine/Maps/Templates/OpenWorld 不在当前最小 Cook 包中，StartGameInstance.MapNotFound 已请求退出；这是独立问题。旧 NullRHI 的回调计数也不代表地图成功加载 |
| 构建范围 | 22 个实际单元重编、415 项诊断链接，日志 web-engine-webgpu-link-20261020-173027.log；新增 Renderer.26，RenderCore.3 仍核验此前有效对象。完整正常 Web Engine UBT 与版本一致性未验收 |
| Cook 验证修正 | 校验模式增加 UE 原生 -noshaderddc，防止整个 ShaderMap 的 DDC 命中绕过逐作业记录；保留 DebugValidateJobCache=1 和 JobCacheDDC=0。先前命中缓存且无 inventory 的 Cook 记录单独保留，不作为本轮重编证据 |
| 最终 Cook/Stage | web-engine-webgpu-es31-cook-20261020-173811.log，163 包、0 失败；1,049 个真实作业全部 WGSL 与原记录一致，838 Global/211 材质/114 LocalVertexFactory。834 个归档 Shader 的哈希/映射/未压缩尺寸保留；327 文件、51,157,974 字节。NullRHI 也重新标准 Cook/Stage，324 文件、19,952,703 字节 |
| 浏览器 GPU 回归 | 各 2 个 ShaderModule、1 条图形管线、2 个 render pass/2 次 draw、25 次队列提交/25 个命令缓冲，纹理审计前队列完成，无 GPU validation；11 条标记、2 次后缓冲获取。各 35 张/107 mip/9,454,164 字节读回完全一致 |
| 回归范围 | 新 PSO 核验和全部当前阶段汇总通过；原 40 项历史证据及双浏览器三轴实际 Shader 回归重新通过。原生 RHI 本轮未改，沿用上一轮正常构建、二维/视口/静态绑定/Unlit 和独立 ApplicationCore/标记正反例的有效哈希证据，没有将其写成本轮重新执行 |

新增 `probe-web-pso-consolidation.cjs` 和 `verify-web-pso-consolidation.cjs`，前者在同一实际 Engine 中做异步/同步对照，检查挂载的配置字节和引擎应用 CVar 的日志；后者核验保护未改、实际链接单元、GPUScene 排除与 Init 返回。修复前完整报告保存为 `*-before-pso-sync-20261020.json`，关闭异步但尚未排除灯光上传的失败保存为 `web-pso-consolidation-probe-results-before-gpu-scene-lights-20261020.json`。

复现顺序：`cook-web-engine.ps1 -Mode WebGPU-ES31 -ValidateShaderJobCache` → `cook-web-engine.ps1 -Mode NullRHI-only` → 两种 `stage-web-engine.cjs` 模式。链接使用上轮 21 个响应加 `Renderer/Module.Renderer.26.cpp.o.rsp`。设置 NODE_PATH 后先执行 `probe-web-engine-webgpu.cjs --incremental --es31`（预期非零，Init 返回而首个 Tick 失败），再执行 `probe-web-pso-consolidation.cjs` 与 `verify-web-pso-consolidation.cjs`。刷新 Shader/FIFO/静态绑定/纹理/默认资源/Canvas/原 40 项/材质条件/breadcrumb 后执行 `verify-web-es31-runtime-integration.cjs`，本轮阶段汇总 true、完整 Runtime false、completeUEScene false。

下一步定位首次 Tick 的后缓冲 RTV → Present 状态衔接，并 Cook/配置真实最小地图，消除 MapNotFound；随后验收连续 Tick、单 Unlit 网格、相机/HTML UI 与完整正常 Web UBT。本轮未扩展数组、材质层、UMG 或高级灯光。

以下为历史检查点。

**2026-10-20 第四十三轮：真实 Cook 归档已完成首次浏览器 Shader 创建和清屏 draw 提交。** Chrome、Edge 均越过 Oodle、UE Shader 附加数据和默认光栅状态三个阻塞，各创建 2 个 ShaderModule、1 条图形管线、执行 1 次 CanvasClear draw；15 个真实命令缓冲提交后，队列完成检查通过，无 GPU validation。**仍为 0 Engine 帧，未验证清屏像素、物理呈现或 Unlit 场景首帧。**

| 本轮检查 | 实测结果 |
| --- | --- |
| Web 压缩策略 | 仅 WebGPUShaderFormat 的 ModifyShaderCompilerInput 设置 CompressionFormat=NAME_None，缓存键增加 Uncompressed1。Payload schema/formatVersion 不变；沿用 UE 原有未压缩归档分支，不增加浏览器 Oodle 解码器，不修改安装版压缩实现 |
| 实际 Cook | 正常 Win64 插件构建和标准 ES31 Cook 成功，163 包，0 转换失败；保留完整 JobCache 校验并禁用作业 DDC。1,049 个作业名称和全部 WGSL 与上一轮逐一一致：838 Global、211 材质，其中 114 个 FLocalVertexFactory |
| 全归档核验 | Global 91 个映射/726 个 Shader，项目 36 个映射/108 个 Shader，834 条均未压缩。Shader 哈希、频率、未压缩尺寸、映射哈希及映射内有序引用全部与原压缩归档一致；逐条解析 Web 头部、元数据、WGSL 和 UE 可选数据，并检查 Metadata 副本一致 |
| 体积代价 | Global 归档从 2,885,533 增至 24,782,089 字节，项目归档从 576,974 增至 5,930,892 字节。仍为 327 个 staged 文件，总计从 23,907,500 增至 51,157,974 字节；本轮先保留真实未压缩路径，传输体积优化另行处理 |
| UE 封装读取 | 共享 RHI 兼容独立原始 packet 和 UE 附加数据封装，严格校验正文长度、尾部尺寸、每项附加数据边界；频率、平台/DDPI、元数据和资源绑定检查保留。原生 recorded/bypass 共 16 项正反例通过，包括空附加数据、负/越界尾部、内容越界、错误频率及截断 |
| 默认光栅状态 | UE 清屏的 TStaticRasterizerState 默认允许 MSAA，但实际 NumSamples=1；去掉重复拒绝 bAllowMSAA 的条件，保留单采样和其他光栅/深度/混合限制。两个原生命令模式都用默认许可状态跑既有真实绘制和像素对照，通过；未添加 MSAA 功能 |
| 原生和历史回归 | 当前正常 Win64 UBT、二维 232 项/20 次 dispatch/1,680 个值、视口 72 项/143,976 通道值、静态绑定 38 项以及两种绑定各 19 次 Unlit 绘制/1,114,112 通道值重新通过。原 40 项历史问题和双浏览器三轴 Shader 回归重新通过 |
| WASM 证据 | 首次 22 单元重编、后一次 21 单元重编，最终 415 项诊断链接通过，日志 web-engine-webgpu-link-20261020-171209.log。RenderCore.3 沿用本轮首次重编，Canvas 验证器另核对其响应、源码、对象、日志及最终链接对象哈希；不能视为完整正常 Web Engine UBT |
| 浏览器回归 | 各 640×360 BGRA8、2 次后缓冲获取、4 条 GPU 标记；各 35 张二维纹理/107 mip/9,454,164 字节读回一致。NullRHI 各 10 帧和文件缓存通过；既有 ApplicationCore 68 项与标记 ABI 正反例证据通过哈希核验，观察脚本未改动 |
| 当前准确阻塞 | RHIAsyncCacheConsolidation → FScopeVerifyDecrement 析构，PipelineStateCache.cpp:1797：Consolidate was hit while Get/SetPSO was running。此时真实清屏已提交；具体调度重入、缓存索引或计数语义原因尚未确诊，不能直接删掉保护检查 |

新增 `node tests/web-platform/verify-web-shader-payload.cjs`，其报告 `web-shader-payload-results.json` 和阶段汇总均为 true；完整 `web-engine-webgpu-es31-results.json` 仍为 false。`*-before-uncompressed-shaders-20261020.json` 保存旧压缩 Cook/运行结果，`web-engine-webgpu-es31-results-before-shader-attachments-20261020.json` 保存封装失败，`*-before-single-sample-raster-20261020.json` 保存管线校验前的证据。

复现：`cook-web-engine.ps1 -Mode WebGPU-ES31 -ValidateShaderJobCache` → `stage-web-engine.cjs --es31` → `verify-web-global-archive.cjs`；RHI 变化后运行 `probe-web-system-textures.ps1` → `probe-web-static-uniforms.ps1`，重编实际 Web 链接单元。设置 NODE_PATH 后执行 `probe-web-engine-webgpu.cjs --incremental --es31`，预期返回非零并报告 pipeline-cache-consolidation-guard；刷新 Shader payload、FIFO、静态绑定、二维/系统纹理、默认资源、Canvas、原 40 项和材质条件、breadcrumb 报告，最后运行 `verify-web-es31-runtime-integration.cjs`。

下一步只定位 PSO 缓存合并保护：核对 Web 单线程任务执行、缓存线程索引和原子计数，优先评估 UE 已有同步合并路径，保留缓存一致性检查。之后验证 Init 返回和连续 Engine Tick，再做单 Unlit 网格、相机/HTML UI 与完整正常 Web UBT。没有扩展数组纹理、材质层、UMG 或高级光照。

以下为历史检查点。

**2026-10-20 第四十二轮：首次 Canvas 视口结束与窗口区域查询已接通，当前进入 Shader 归档解压。** Chrome、Edge 均越过上一轮 VSync 断言和随后暴露的 `GetFullScreenInfo`，现在明确停在 `FShaderCodeArchive::CreateShader` 的 Oodle 解压。两浏览器仍为 0 Engine 帧、0 次 draw，尚未创建 WebGPU Shader。

| 本轮检查 | 实测结果 |
| --- | --- |
| 浏览器 FIFO | 只在 Web 接受调用方 bLockToVsync=false，实际 surface 仍固定 FIFO，由浏览器控制呈现时机；原生 VSync 断言、原生 wgpuSurfacePresent 和共享资源状态检查保留，未修改 Slate 调用方或 Emdawn SDK |
| 实际视口结束 | 两浏览器各执行一次 P3_VIEWPORT_END：requestedVSync=false、present=true、ended=1、skipped=0、submitted=11，返回前后缓冲引用已清理。只是 RHI 后端结束，不算物理屏幕呈现或场景首帧 |
| GPU 证据 | 到当前失败点，各调用 GPUQueue.submit 14 次、14 个命令缓冲；在纹理审计读回之前调用 onSubmittedWorkDone，均通过。实际 GPU API 计数为 ShaderModule=0、管线=0、renderPass=1、draw=0、dispatch=0；清屏 pass 已开始，但未完成着色绘制 |
| Canvas 区域 | FWebWindow 实现 GetFullScreenInfo，沿用既有单 Canvas 虚拟显示坐标：原点 0,0，尺寸为 CSS 像素，不申请浏览器全屏。未初始化返回 false，独立 Program 检查；已初始化每帧与 FDisplayMetrics 核对 |
| ApplicationCore | 正常 Web UBT Program 构建通过、20 个 ApplicationCore 对象。Chrome/Edge 各桌面/窄窗口、DPR 1/2 共 68 项检查通过，新增 CSS 区域与缩放检查；窄窗口 DPR2 为 358×360 CSS，缩放后为 320×180 CSS，后缓冲按 DPR 处理 |
| 原生回归 | 当前 Win64 正常 UBT、二维纹理 232 项/20 次 dispatch/1,680 个值、隐藏 HWND 视口 72 项/143,976 通道值重新通过；静态绑定 38 项、静态 View/直接绑定各 19 次 Unlit 绘制、各 1,114,112 通道值重新通过 |
| WASM 构建 | 最终 22 个实际链接单元重编、415 项诊断链接通过，日志 web-engine-webgpu-link-20261020-164553.log。完整正常 Web Engine UBT、5.8.3/5.8.0 版本一致性仍未验收 |
| 浏览器回归 | 各 640×360 BGRA8、两次后缓冲获取、四条 GPU 标记（新增 CanvasClear）；各 35 张二维纹理/107 mip/9,454,164 字节读回一致，无 GPU validation。NullRHI 各 10 帧及文件缓存通过 |
| 材质与证据 | 原 40 项历史证据及 Chrome/Edge 三轴回归重新通过；当前 838 Global/211 材质/114 FLocalVertexFactory 作业证据通过。WASM64 标记未修复/修复正反例重新运行通过。未重新 Cook，沿用 163 包、327 文件、23,907,500 字节 |
| 当前准确阻塞 | FCanvas::Clear → DrawClearQuadMRT → TOneColorVS → FShaderMapResource_SharedCode → FShaderCodeArchive::CreateShader → DecompressShaderWithOodle；日志明确 Web does not support Oodle-compressed data。不能把它误报为原 40 项编译错误、GPU 管线错误或场景出帧 |

新增 `node tests/web-platform/verify-web-browser-fifo.cjs`；`web-browser-fifo-results.json` 核验修复前 VSync/窗口查询记录、原生回归、ApplicationCore 68 项、实际 Engine 的提交/队列完成和后缓冲清理。`capture-web-canvas.cjs` 只转发原始 GPU 调用并计数；完成检查使用真实设备队列，发生在审计纹理读回之前。完整浏览器启动报告 false，阶段汇总 true 的范围仍严格限制为已验证的接口和归档阻塞。

复现顺序：`probe-web-system-textures.ps1` → `probe-web-static-uniforms.ps1`；更新本地 WebApplication.cpp 镜像后，设置 WEB_EMSDK_ROOT/EM_CONFIG，运行 `probe-web-application-target.cjs` → `verify-web-application.cjs`；最终诊断链接沿用上一轮 22 个实际响应。设置下方 NODE_PATH 后执行 `probe-web-engine-webgpu.cjs --incremental --es31`，再执行新增 FIFO、静态绑定和既有二维/默认资源/材质阶段检查；Canvas 观察脚本变化后须重新运行 `verify-web-marker-abi.cjs`，随后运行 `verify-web-breadcrumb-abi.cjs` 和 `verify-web-es31-runtime-integration.cjs`。`*-before-browser-fifo-20261020.json` 与 `web-engine-webgpu-es31-results-before-canvas-bounds-20261020.json` 保留本轮前后两个失败边界。

下一步只处理 Web Shader 归档格式：优先调查 Cook/归档能否输出未压缩或免费压缩格式，并使运行时按真实格式读取；保留 Shader 哈希和平台校验，不能跳过 Shader 或伪造解压成功。之后才验证实际 RHI Shader 创建、Unlit 场景首帧、相机/HTML UI 和完整正常 Web UBT。没有新增数组纹理、材质层、UMG 或高级光照功能。

以下为历史检查点。

**2026-10-20 第四十一轮：RDG 静态 UniformBuffer 绑定已接通，实际 Engine 推进到首次视口呈现入口。** Chrome、Edge 均执行 `RHISetStaticUniformBuffers`，日志为 `batch=1 count=0 slots=16`，随后到达 `EndDrawingViewport`。当前准确阻塞为首次 Slate 呈现的 `Args.bLockToVsync=false` 与后端仅支持 FIFO/VSync 的约束不符。两浏览器仍为 0 Engine 帧，不能把空 RDG 绑定或进入呈现函数算作场景绘制/呈现成功。

| 本轮检查 | 实测结果 |
| --- | --- |
| 共享实现 | 整批绑定会替换并清空旧状态，单槽支持替换/清空；上下文持有强引用，释放绑定和关闭设备时清理。直接常量和资源表成员共用 Uniform 解析入口 |
| 槽位规则 | 根据 Shader 布局哈希查询 UE 运行时注册元数据，不把 Cook 的静态槽编号当作运行时编号；检查 Static/Shader 标志、布局哈希及双重绑定。带 ShaderBindingLayout 的新版绑定方式仍明确拒绝 |
| 原生绑定回归 | recorded/bypass 各 19 项，共 38 项：空绑定、替换、直接回退、Static-only 缺失、布局错误、非法槽、双重绑定和引用释放全部通过；两模式原有全局 RHI 检查也通过 |
| 实际材质 GPU 回归 | 静态 View 与直接绑定各 19 次 UnlitColor/UnlitTexture 绘制，各检查 1,114,112 个通道值；包括投影、世界原点、曝光、参数更新和资源生命周期。静态路径解析 38 次；两套默认图像逐字节一致，无 GPU validation |
| 测试入口边界 | 新增 -WebMaterialOnlyProbe，在已有临时全局 RHI 环境单独执行材质用例；测试工具在该环境使用 UE 的正常 Transition。旧综合 -WebRHIProbe 在深度格式 Supported 检查处失败，未将它计入本轮通过项，也未扩展深度功能来绕过它 |
| 原生回归 | 当前正常 Win64 UBT 构建成功；二维纹理 232 项/20 次 dispatch/1,680 个值，隐藏 HWND 视口 72 项/143,976 个通道值重新运行通过 |
| WASM 构建 | 22 个实际链接单元重编，包含全部 6 个 WebGPURHI 单元，415 项诊断链接通过，日志 web-engine-webgpu-link-20261020-162025.log；完整正常 Web Engine UBT 仍未验收 |
| 浏览器回归 | 各 640×360 BGRA8 Canvas、一次后缓冲获取、三条真实 GPU 标记；各 35 张二维纹理/107 mip/9,454,164 字节读回一致；NullRHI 各 10 帧及文件缓存通过，GPU validation 为 0 |
| 范围与剩余 | 原 40 项 Shader 历史证据和双浏览器三轴用例重新回归通过；当前 838 Global/211 材质/114 FLocalVertexFactory 作业证据通过，本轮未重新 Cook。未扩展数组纹理、材质层、UMG 或高级光照。字节码解压与实际 RHI Shader 创建、Unlit 场景首帧、相机/HTML UI、完整正常 Web UBT/版本一致性仍待验证 |

新增复现入口：先运行 `./tests/web-platform/probe-web-system-textures.ps1` 正常构建当前原生 RHI，再运行 `./tests/web-platform/probe-web-static-uniforms.ps1`。设置下方 NODE_PATH 后执行 `node tests/web-platform/probe-web-engine-webgpu.cjs --incremental --es31`、`node tests/web-platform/verify-web-static-uniforms.cjs`，以及下方既有阶段回归命令。新增 `web-static-uniforms-native-results.json` 和 `web-static-uniforms-results.json` 审计源文件、原生 DLL、Shader 夹具、日志、实际图像、Web 重编对象和双浏览器记录。`*-before-static-uniforms-20261020.json` 保留修改前历史记录。

静态绑定验证报告 true 只覆盖上述边界；完整浏览器启动报告继续保持 false。下一步核对首次 Slate 呈现的 VSync 来源与 Web 固定 FIFO 的接入方式，并保留非浏览器后端的校验。

以下为历史检查点。

**2026-10-20 第四十轮：已越过 LTC 默认纹理和 WASM64 GPU 调试标记阻塞，实际获取 Canvas 后缓冲。** Chrome、Edge 均从原来的 `GGX.LTCAmp` 推进到 RDG 执行，实际接收两条 GPU breadcrumb；Engine 仍为 0 帧，当前准确阻塞为 `RHISetStaticUniformBuffers` 未实现。

| 本轮检查 | 实测结果 |
| --- | --- |
| LTC 范围 | 仅 Web 不创建矩形灯光/BSDF 的 GGX 与 sheen LTC 默认纹理，设置初始化完成标记；SystemTextures.cpp 本轮只加 5 行。完整桌面初始化、安装版文件和六份原 LTC 资源均保留，没有补 PF_G16R16F |
| LTC 使用方 | 审计 SceneRendering.cpp 的 IsValid 检查和三项 OrBlack2DIfNull，以及现有黑纹理默认值。当前尚无场景实际走过该回退，不能据此宣称支持矩形灯光或 Lit 材质 |
| WASM64 根因 | Emdawn 的两个 InsertDebugMarker 生成签名缺失，WGPUStringView 地址以 BigInt 进入 Number 地址运算。补两条 vpp 元数据，未改 SDK 和共享 C++ breadcrumb 实现 |
| 可重复接入 | 新增 Web/Build/emdawnwebgpu-ue.port.py，在原 Emdawn 的签名表之后加载 WebGPUStringViewABI.js；顺序必要，因为原签名表会删除此前的 WebGPU 签名。正常 Target 和诊断链接均选择该 port，不手改生成 JS |
| 独立 ABI 回归 | Chrome/Edge 的 before 版本均复现 BigInt 错误；fixed 版本分别向真实命令编码器、渲染通道发送定长截断、中文 UTF-8、空字符串，共 6 条标记，真实清屏提交及队列完成通过，无验证错误 |
| 实际 Engine | 两浏览器各 configure 一次 640×360 BGRA8 Canvas、获取一次真实后缓冲，并收到 RenderGraphExecute - Slate 和其 SubmitBufferUploads 两条标记；无 GPU validation，不能把获取后缓冲计作呈现或 Engine 帧 |
| 构建 | 18 个实际链接单元重编、415 项诊断链接通过，最终日志为 web-engine-webgpu-link-20261020-155536.log；完整正常 Web Engine UBT 仍未通过验收 |
| 回归 | 各 35 张二维纹理、107 mip、9,454,164 字节读回一致；NullRHI 各 10 帧及缓存检查通过。ApplicationCore 四组输入/DPR 共 60 项重新运行通过；既有原生二维 232 项和隐藏 HWND 72 项/143,976 通道值的产物及来源审计通过，本轮未重建原生 RHI |
| 材质与 Cook | 原 40 项历史产物及双浏览器贴花三轴回归通过；当前材质条件与 838 Global/211 材质/114 FLocalVertexFactory 作业证据通过。本轮未重新 Cook，沿用 163 包、327 文件、23,907,500 字节的已审计产物 |
| 当前阻塞 | FRDGBuilder::Execute → SetStaticUniformBuffers → WebGPURHI 未实现入口，发生在游戏窗口的首次 Slate 绘制；两浏览器均 0 帧。不是原 40 项转换错误复发 |

新增复现入口：

```powershell
./tests/web-platform/build-web-marker-abi.ps1
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/verify-web-marker-abi.cjs
node tests/web-platform/probe-web-engine-webgpu.cjs --incremental --es31
node tests/web-platform/verify-web-texture2d.cjs
node tests/web-platform/verify-web-debug-defaults.cjs
node tests/web-platform/verify-web-ltc-defaults.cjs
node tests/web-platform/verify-web-breadcrumb-abi.cjs
node tests/web-platform/verify-web-canvas-viewport.cjs
node tests/web-platform/verify-web-material-completion.cjs
node tests/web-platform/verify-web-material-policy.cjs
node tests/web-platform/verify-web-system-textures.cjs
node tests/web-platform/verify-web-es31-runtime-integration.cjs
```

完整浏览器探针保持 false、非零退出；新增 LTC、ABI 及阶段汇总报告的 true 只覆盖各自已验证的边界。`*-before-ltc-defaults-20261020.json` 与 `web-engine-webgpu-es31-results-before-breadcrumb-string-20261020.json` 保留修复前历史记录。独立 ABI 用例还实际运行未修复与修复版本，均核验本轮构建产物。

本轮 18 个响应为 `tests/web-platform/build/web-system-textures-unity.cpp.o.rsp`，以及 Web/wasm64/UEWebEngine/Development 下的 `WebGPURHI/BrowserDynamicRHI.cpp.o.rsp`、`WebGPURHI/BrowserViewport.cpp.o.rsp`、`GeometryCollectionEngine/Module.GeometryCollectionEngine.2.cpp.o.rsp`、`ApplicationCore/Module.ApplicationCore.cpp.o.rsp`、`UEWebEngine/UEWebEngine.cpp.o.rsp`、`Launch/Module.Launch.cpp.o.rsp`、`SlateCore/Module.SlateCore.3.cpp.o.rsp`、`RenderCore/Module.RenderCore.3.cpp.o.rsp`、`RenderCore/Module.RenderCore.5.cpp.o.rsp`、`Renderer/Module.Renderer.28.cpp.o.rsp` 和 `Engine/Module.Engine.{23,24,46,50,53,56,65}.cpp.o.rsp`。传入 `link-web-engine-webgpu.ps1 -ModuleCompileLog web-engine-texture2d-modules.log -RecompileResponses`；真实链接成员和产物哈希均审计，Renderer helper 保留既有 unity 成员。

下一步处理 RDG 必需的静态 UniformBuffer 槽位绑定和生命周期，复用已有 UniformBuffer/资源表路径，不能用空实现把绑定错误隐藏。随后仍有免费字节码打包/解压路径、实际 RHI Shader 创建、单静态网格 Unlit 首帧、相机与 HTML UI，以及完整正常 Web Engine UBT/版本一致性待验收。UMG/Slate 依赖仍保留，未增加数组纹理、材质层或高级光照功能。

以下为历史检查点。

**2026-10-20 第三十九轮，15:10：实际 wasm64 Engine 已接通 Web 窗口与 Canvas WebGPU 视口配置。** Chrome、Edge 均传入非空窗口标识、640×360、非全屏、PF_B8G8R8A8，并实际调用浏览器 `GPUCanvasContext.configure`。完整 Engine 仍为 0 帧；当前进入 Slate 绘制时的引擎相关系统纹理初始化，卡在 `GGX.LTCAmp` 的 PF_G16R16F。

| 本轮检查 | 实测结果 |
| --- | --- |
| 修改前复现 | 双浏览器实际请求为 window=0、640×360、fullscreen=true、format=18；不能只归因于空句柄，三项都需修正 |
| 单 Canvas 窗口 | FWebWindow 初始化前句柄为空，初始化后返回该窗口的稳定不透明标识；RHI 仍用 #canvas 创建真正的浏览器 surface，没有把该指针当 HWND；Web 平台声明支持窗口模式，入口明确 -windowed |
| 显示格式 | Web 启动在 RHI 初始化时显式选择现有 8 位后缓冲设置；实际请求和配置为 BGRA8，保留后端对非法窗口、尺寸、全屏、格式的拒绝；不把 10 位请求伪装成 8 位资源 |
| Emdawn 差异 | 当前固定版本的 wgpuSurfaceGetCapabilities 未写 usages 字段，网页实际返回 0；仅 Web 不使用这一未提供的字段推断读回能力。浏览器实际 configure/getConfiguration 确认 RenderAttachment\|CopySrc=17，原生能力检查保持原状 |
| 实际浏览器 | 两浏览器各配置一次 #canvas，BGRA8、opaque、640×360、DPR=1，设备与传入设备一致；无 GPU validation。当前 surface acquisition 为 0，不把 configure 当成绘制或呈现 |
| ApplicationCore 回归 | 正常 Web UBT Program 构建通过，20 个 ApplicationCore 对象；Chrome/Edge 各桌面/窄窗口、DPR 1/2 共 4 组、60 项检查通过，稳定窗口标识每帧检查，键鼠/焦点/HTML 输入、尺寸/DPI、销毁和停止正常；不是手机实机测试 |
| 原生回归 | 当前共享 RHI 正常 UBT 构建通过；二维标量/格式 232 项检查通过。独立隐藏 HWND 视口两模式共 72 项检查、143,976 个通道值通过，保留非法参数拒绝、缩放、跳帧/恢复和像素读回；原生呈现不算网页 Engine 帧 |
| WASM 构建证据 | 重编实际链接的 ApplicationCore/Launch 合并单元、SlateCore、RenderCore、Renderer、受平台属性影响的 Engine 单元和 RHI/入口，共 18 个单元；415 项诊断链接。新增检查拒绝将未在链接输入中的单文件产物计为当前重编，完整正常 Web Engine UBT 仍未通过 |
| 资源/已有证据 | 两浏览器各 36 张二维纹理、108 mip、9,486,932 字节实际读回一致，含推进后新上传的 GGX.LTCMat；NullRHI 各 10 帧和缓存检查、原 40 项历史产物及当前材质条件回归通过；本轮未重新 Cook |
| 新阻塞 | FSlateApplication::Tick → DrawWindows → InitializeEngineDependentTextures → GGX.LTCAmp，64×64、PF_G16R16F；视口已创建，但尚无后缓冲获取、实际 RHI Shader 创建或 Engine 首帧 |

新增验收：

```powershell
$env:WEB_EMSDK_ROOT='H:/ue_html/.tools/emsdk'
$env:EM_CONFIG='H:/ue_html/.tools/emsdk/.emscripten'
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-application-target.cjs
node tests/web-platform/verify-web-application.cjs
node tests/web-platform/probe-web-engine-webgpu.cjs --incremental --es31
node tests/web-platform/verify-web-canvas-viewport.cjs
```

视口验收还读取 `web-canvas-native-viewport.log` 与 `build/ue-rhi-canvas-viewport/viewport-rhi-results.json`：当前隔离 UnrealEditor-Cmd 用既有 `-run=WebShaderProbe -WebViewportRHIProbe -WebShaderDirectory=H:/ue_html/tests/web-platform/build/ue-platform-full-worker -Output=H:/ue_html/tests/web-platform/build/ue-rhi-canvas-viewport -nullrhi -norhithread -unattended -nosplash -nop4 -NoSound` 运行，日志通过 `-abslog` 指定。最终刷新顺序为完整探针 → 二维/调试默认资源/原材质检查 → 材质条件与系统纹理检查 → 视口验收 → 阶段汇总。完整探针保持 false 和非零退出；视口/阶段报告的 true 只覆盖各自已通过的检查。

`capture-web-canvas.cjs` 转发真实浏览器调用并读取实际配置，未模拟 GPU 返回值。修改前窗口三项错误和 Emdawn usage 断言分别保存在 `web-engine-webgpu-es31-results-canvas-repro-20261020.json`、`web-engine-webgpu-es31-results-surface-usage-repro-20261020.json`，明确为历史记录。

下一步先检查矩形灯光/BSDF 的 LTC 初始化在当前 ES3.1 Unlit 目标中的使用方，能局部排除就排除，不为启动无条件补齐整套高级光照格式。随后仍需免费可用的字节码解压/打包路径、真正的 RHI Shader 创建和静态网格 Unlit 首帧、相机与网页 UI。UMG/Slate 依赖仍保留；完整正常 Web UBT 与 5.8.3 全源版本一致性仍未验收。

以下为历史检查点。

**2026-10-20 第三十八轮，14:39：系统纹理初始化和引擎默认资源加载已越过，推进到游戏窗口/Canvas 视口创建。** Chrome、Edge 均不再卡在 `BlackArrayDummy`；实际 WebGPU Engine 仍为 0 帧，当前校验失败为 `viewport-window-or-dimensions-invalid`。

| 本轮检查 | 实测结果 |
| --- | --- |
| 未用功能范围 | 仅 Web 不初始化 BlackArrayDummy、ZeroUIntArrayDummy、GreenDummy、ZeroUIntArrayAtomicCompatDummy 及立方体占位引用；不以二维纹理冒充数组。RDG 原有 TryRegisterExternalTexture 可接受空的外部纹理，必需的二维模板 SRV 保留 |
| 必需二维格式 | 补齐 R32_UINT、RGBA8_UINT、RGBA16F、R16_UINT、PF_R8 与 RG8 的二维创建、初始化/写锁和严格标量绑定检查；没有扩展这些格式的三维功能。PreintegratedGF 使用 UE 已有 RG8 回退，不依赖额外纹理格式扩展 |
| 后续旁路 | 浏览器实测先到 PerlinNoise3D 的 RHIUpdateTexture3D，再到 UEngine::InitializeObjectReferences 加载 Landscape 权重数组；仅 Web 跳过这两项未用初始化，没有实现三维更新或通用数组纹理 |
| 引擎改动 | SystemTextures.cpp 增加 21 行、UnrealEngine.cpp 增加 4 行 Web 条件；完整桌面源码逐字还原检查通过，安装版两个文件 SHA256 不变，工作区覆盖一致 |
| 真实 GPU 读回 | Chrome/Edge 各 35 张二维纹理、107 个 mip、9,454,164 字节，逐级与 CPU 上传字节一致，两浏览器读回一致；GPU validation 均为 0。包括整数零值、模板、半浮点深度/灰色、Sobol、ASCII、RG8 预积分和普通默认资源 |
| 原生回归 | 正常 UBT 构建 WebGPURHI 通过；recorded/bypass 两模式新增 112 项二维格式/类型/非法 sRGB/数组/三维边界检查全部通过；含既有测试共 232 项检查、20 次计算派发、1,680 个值比较，GPU validation 为 0 |
| 构建记录 | 重编 Renderer 系统纹理、共享 RHI、LevelSet 调试 Actor 与引擎默认加载单元，415 项增量链接通过；UBT 新旧 unity 分组不同，Renderer 诊断单元明确保留旧 34 号单元的 8 个 include，未伪称全量正常 Web UBT 通过 |
| 既有证据 | NullRHI 两浏览器各 10 帧及缓存检查通过；原 40 项历史成功产物、双浏览器贴花三轴、当前 DBuffer 条件和库接入阶段检查重新通过；本轮未重新 Cook，沿用 163 包、327 文件、838 Global/211 材质作业的审计产物 |
| 当前阻塞 | UGameEngine::CreateGameWindow → SWindow::SetWindowMode → FSlateRHIRenderer → RHICreateViewport，窗口句柄/尺寸校验失败；系统纹理和 UEngine 默认引用阶段已越过，尚无真实 Engine 首帧 |

本轮入口：

```powershell
./tests/web-platform/probe-web-system-textures.ps1
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-engine-webgpu.cjs --incremental --es31
node tests/web-platform/verify-web-texture2d.cjs
node tests/web-platform/verify-web-debug-defaults.cjs
node tests/web-platform/verify-web-material-completion.cjs
node tests/web-platform/verify-web-material-policy.cjs
node tests/web-platform/verify-web-system-textures.cjs
node tests/web-platform/verify-web-es31-runtime-integration.cjs
```

原生入口只构建/测试当前共享 RHI，不能替代 WASM 链接。增量重编使用 `link-web-engine-webgpu.ps1 -ModuleCompileLog web-engine-texture2d-modules.log`，`-RecompileResponses` 依次为 `tests/web-platform/build/web-system-textures-unity.cpp.o.rsp` 和 Web/wasm64/UEWebEngine/Development 下的 `WebGPURHI/BrowserDynamicRHI.cpp.o.rsp`、`GeometryCollectionEngine/Module.GeometryCollectionEngine.2.cpp.o.rsp`、`Engine/Module.Engine.65.cpp.o.rsp`。响应、实际输入成员、编译日志和链接对象均由报告审计，正常 UBT 全量构建仍需独立验收。

`web-system-textures-results.json` 与阶段汇总为 true；完整启动报告仍为 false、非零退出、WebGPU 0 帧。修改前系统数组和 Landscape 数组的浏览器记录分别以 `-before-system-textures-20261020.json`、`-before-engine-defaults-20261020.json` 留存，标记为历史证据；原数组资产仍挂载，不是通过删包避开初始化。读回只验证存储字节和初始化，不等于新格式采样/过滤或实际 Shader 执行已通过。

下一步接好 Web 窗口与 Canvas 视口的句柄、尺寸和窗口模式。当前 `FWebWindow` 尚未覆盖 `GetOSWindowHandle`，但本轮没有把它当成已完成的根因修复；先用实际参数和浏览器视口结果验证。随后仍需免费可用的压缩字节码接入、实际 RHI Shader 创建、单静态网格/Unlit 首帧、相机和网页 UI。完整正常 Web UBT 与目标 5.8.3 全源版本一致性仍未验收。

以下为历史检查点。

**2026-10-20 第三十七轮，14:06：已在 Web 排除 LevelSet 调试 Actor 的默认资源加载，Chrome、Edge 均越过 VolumeToRender。** 两浏览器到达 `ObjectSystemReady` 和 `FSystemTextures::InitializeCommonTextures`，实际 WebGPU Engine 仍为 0 帧；当前阻塞是系统无条件创建的 `BlackArrayDummy`，尚未扩展数组纹理功能。

| 本轮检查 | 实测结果 |
| --- | --- |
| 调用链复现 | 浏览器错误栈上限提高到 100；两浏览器在修改前均显示 ProcessNewlyLoadedUObjects → CreateDefaultObject → AGeometryCollectionRenderLevelSetActor 构造 → LoadObject → UVolumeTexture::PostLoad → FTexture3DResource，确认不是 BufferVisualization 初始化 |
| 最小修改 | 仅 PLATFORM_WEB 在该调试 Actor 构造中不加载 VolumeToRender 与 M_VolumeRenderSphereTracePP，两个引用置空、调试后处理禁用；保留类、组件和模块依赖，没有补 RGBA16F 体纹理 |
| 安装版隔离 | 原 GeometryCollectionEngine 为指向安装版的目录联接，先改成工作区本地副本再应用覆盖；prepare-web-core-host.ps1 支持重建这一覆盖，PowerShell 语法检查通过；安装版文件 SHA256 不变，移除 Web 分支后完整源码与安装版逐字一致 |
| 构建 | Module.GeometryCollectionEngine.2.cpp 重编成功，415 项增量链接通过；未重新 Cook，仍使用上一轮已审计的 163 包、327 文件及 838 Global/211 材质成功产物 |
| 运行推进 | 两浏览器均记录调试默认资源排除，越过 ObjectSystemReady；原 VolumeToRender 资源仍实际装入虚拟文件系统，未通过删包掩盖加载问题 |
| GPU/缓存回归 | 两浏览器各 12 张二维纹理、54 个 mip、7,487,500 字节读回一致，比上一轮新增 BlackDummy 的 4 字节；GPU validation 均为 0；NullRHI 各 10 帧，文件缓存通过 |
| 既有证据 | 原 40 项历史成功产物、双浏览器贴花三轴读回、当前 DBuffer/Cook 条件、材质作业差异及库接入汇总重新检查通过 |
| 当前阻塞 | BlackArrayDummy，dimension=1、PF_B8G8R8A8、1×1×1，调用链为 PostInitRHI → InitializeSystemTextures → InitializeCommonTextures；后续同类还有 ZeroUIntArrayDummy 与 GreenDummy，尚未修改 |

新增入口：

```powershell
node tests/web-platform/verify-web-debug-defaults.cjs
```

`web-debug-defaults-results.json`、二维纹理和库接入阶段报告均为 true；完整探针 `web-engine-webgpu-es31-results.json` 保持 false 和非零退出，WebGPU 0 帧。新报告独立保存了修改前的双浏览器完整调用栈；旧二进制未保留，明确不把这些记录描述成当前重新执行旧二进制。

下一步核对系统数组占位资源的编译与使用路径，优先在 Web 禁用已关闭功能的初始化，不移植通用数组纹理。已发现 BlackArrayDummy 的主要使用方为 Nanite/Lumen/TSR 和带有效性判断的光照图占位，ZeroUIntArrayDummy 用于本就关闭的局部雾；还需检查通用 RDG 系统纹理注册及二维整数/浮点占位资源，不能直接把二维纹理替代数组。随后仍需免费可用的压缩字节码接入、实际 RHI Shader 创建、单静态网格/Unlit 首帧、相机及网页 UI；完整正常 Web UBT 和 5.8.3 全源版本一致性尚未验收。

以下为历史检查点。

**2026-10-20 第三十六轮，13:50：默认贴花材质缺少 FDeferredDecalMobilePS 的阻塞已修复，两浏览器均已越过。** Cook 和运行时的 DBuffer 条件已实测一致，完整性检查保持不变。WebGPU Engine 仍为 0 帧，新的阻塞是 `/Engine/EngineDebugMaterials/VolumeToRender` 的 10×10×10、RGBA16F 体纹理初始化。

| 本轮检查 | 实测结果 |
| --- | --- |
| 根因实测 | 相同 r.Mobile.DBuffer=0，修复前原生 Cook 得到 DBuffer=true、注册 Web 设置数为 0，浏览器得到 false；原生宿主沿用了桌面 DBuffer 掩码 |
| 设置注册 | 原生 Cook 自定义入口改为 WebCook，配套 WebCookTargetPlatform 与 WebCookTargetPlatformSettings；设置模块拥有设置对象，Controls/合并平台共享它；管理器按正常模块命名发现设置，真实目标和冻结布局仍为 Web/wasm64 |
| 深度路径 | 显式设置 r.Mobile.DBuffer=0、r.Substrate=0、r.Mobile.EarlyZPass=1；首个注册修复后的试 Cook 暴露 5 个移动阴影 subpass/InputAttachmentIndex 失败，完整深度预通道使其恢复普通深度读取，没有移植 subpass 或扩大着色器功能 |
| 当前实际 Cook | v13，20261020-133852；838 个 Global、211 个材质作业全部重新转换，163/163 包、退出 0、0 错误、13 警告；逐作业 DDC 关闭、全作业校验保留，设置的 host/target 值一致 |
| 变体差异核对 | 完整材质映射标识保留；仅移除 3 个 DBuffer 专用贴花变体，新增 FDeferredDecalMobilePS；985 个保留作业的 WGSL 完全相同，其中含全部 838 个 Global；其余 63 个变化只出现在移动 BasePass/贴花像素类型 |
| 普通静态网格范围 | 当前 FLocalVertexFactory 为 114 个作业，比上一轮少一个 DBuffer 专用 MeshDecalsEmissivePS；82 个 WGSL 不变，32 个像素作业随 DBuffer 条件重编，不把它们描述成原样保留的 115 项 |
| 当前暂存/库 | ES3.1 为 327 文件、23,907,500 字节；Global 库仍 726 个唯一 Shader，项目库为 108 个；NullRHI 重新 Cook/Stage 为 324 文件、19,952,703 字节 |
| 浏览器实测 | Chrome、Edge 均输出 DBuffer=false、fullDepthPrepass=true，与 Cook 清单一致；缺失 Mobile 贴花/默认材质错误消失，继续到 UVolumeTexture/FTexture3DResource 创建；两浏览器 GPU validation 均为 0，实际仍 0 帧 |
| 纹理/NullRHI 回归 | 两浏览器各 11 张二维纹理、53 个 mip、7,487,496 字节逐级 GPU 读回相同；NullRHI 各 10 帧，文件缓存检查通过 |
| 原 40 项证据 | 当前 Cook 中 7 种被排除工厂仍无作业，原生 3 组共 24 个工厂检查重跑通过；原 Emissive 变体已不再选用，保留上一轮成功 Cook 的完整证据并重新执行双浏览器三轴测试；报告明确标记 historical，不冒充本轮仍编译该变体 |
| 构建边界 | 新原生设置模块及 Shader 宿主正常 UBT 构建通过；修正共享纹理锁检查在 MSVC 下的有符号比较；浏览器入口和共享 RHI 重编/415 项增量链接通过。完整正常 Web UBT、目标 5.8.3 全源一致性仍未验收 |

本轮复现/验收入口：

```powershell
./tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-ES31 -ValidateShaderJobCache -SkipBuild
node tests/web-platform/stage-web-engine.cjs --es31
./tests/web-platform/cook-web-engine.ps1 -Mode NullRHI-only -SkipBuild
node tests/web-platform/stage-web-engine.cjs
./tests/web-platform/probe-web-material-policy.ps1
./tests/web-platform/probe-web-vertex-factories.ps1
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-engine-webgpu.cjs --incremental --es31
node tests/web-platform/verify-web-texture2d.cjs
node tests/web-platform/verify-web-material-completion.cjs
node tests/web-platform/verify-web-material-policy.cjs
node tests/web-platform/verify-web-es31-runtime-integration.cjs
```

`web-material-policy-results.json` 为 true，包含前后原生探针、完整作业差异、真实浏览器推进证据；库/纹理阶段汇总仍为 true。完整探针 `web-engine-webgpu-es31-results.json` 仍为 false，并返回非零，当前错误为 `VolumeToRender dimension=2 format=10 extent=10x10 depth=10`。WASM 调用栈为 UVolumeTexture/FTexture3DResource，此处不能误记成体积渲染目标或已实现的体纹理路径。

下一步先核对该 EngineDebugMaterials 体纹理的调试材质加载链，优先仅在 Web 排除最小场景不用的初始化；不直接扩展体渲染、数组纹理或材质层。随后仍需验证免费可用的 Shader 字节码解压/创建方案、单静态网格/Unlit 首帧、相机及网页 UI。原有 Oodle 压缩库仅已打开，解压/实际 RHI Shader 创建尚未验收。

以下为历史检查点。

**2026-10-20 第三十五轮，12:26：普通二维纹理的尺寸查询、创建和逐 mip 写入已接入，真实 GPU 读回通过。** 原来的 `RHICalcTexturePlatformSize` 阻塞已越过；Chrome、Edge 都推进到默认材质完整性检查。实际 WebGPU Engine 仍为 0 帧，现在缺少 `DefaultDeferredDecalMaterial` 的 `FDeferredDecalMobilePS`，没有跳过完整性检查。

| 本轮检查 | 实测结果 |
| --- | --- |
| 必要接口 | 实现纹理尺寸估算与 RHIComputeMemorySize；支持普通二维 RGBA8/BGRA8、sRGB BGRA8 和字体所需的线性 R8，以及写入锁/解锁上传；尺寸和对齐返回的是描述符估算，不是浏览器驱动实际显存分配 |
| mip 上限 | 由浏览器设备的二维尺寸上限计算并受 UE 上限约束；原来固定为 1 的启动值已移除，NumOfNonStreamingMips 警告消失；32×32 默认图完整上传 6 级，1024×1024 默认漫反射完整上传 11 级 |
| 真实 UE 资源 | WhiteSquareTexture、GradientTexture0、Black、RobotoDistanceField_PageA、两张默认网格贴图、DefaultDiffuse 均通过原有 UTexture2D 创建/锁定上传路径；前置二维默认资源也保留 |
| GPU 验证 | 每浏览器 11 张二维纹理、53 个 mip、7,487,496 字节；从实际 C++ 调用的 WebGPU 原生纹理复制到缓冲，再异步 map 读回；每个 mip 的 SHA256 与上传 CPU 字节相同，两浏览器结果相同，GPU validation 为 0 |
| 验证边界 | 浏览器观察器转发原 GPU 调用，仅保留句柄和上传字节用于读回；已验证存储字节，尚未验证 sRGB 采样/过滤、多 mip SRV、流式加载或后续区域更新；数组、立方体及原有体纹理功能没有扩展 |
| C++ 构建 | WebGPURHI 6 个 UBT 模块动作通过；最后重编 BrowserDynamicRHI/BrowserTransitions 并完成 415 项增量链接，完整正常 UBT 构建仍未验收；没有重跑 Cook 或改动 Shader 编译范围 |
| 已有回归 | 原 40 项再次核验通过（39 项明确排除、1 项修复）；838 个 Global、213 个材质、115 个普通静态网格作业的既有成功产物和当前源文件哈希有效；贴花两浏览器三轴读回通过；NullRHI 各 10 帧，文件缓存验证通过 |
| 当前阻塞 | 两浏览器均在 DefaultDeferredDecalMaterial 完整性检查失败；实际 Cook 作业含 FDeferredDecalPS/Emissive，未含 FDeferredDecalMobilePS，而运行时要求后者。原因尚未确认，下一步比较两端 DBuffer/Substrate 等条件与初始化顺序，不能将其记为修复完成 |

新增验收：

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-engine-webgpu.cjs --incremental --es31
node tests/web-platform/verify-web-texture2d.cjs
node tests/web-platform/verify-web-material-completion.cjs
node tests/web-platform/verify-web-es31-runtime-integration.cjs
```

`web-texture2d-results.json` 与库/纹理阶段报告为 `pass=true`；实际引擎探针仍为 `pass=false`、`startupBlocker=default-material-shader-map-incomplete`、0 帧，探针保留非零退出码。Cook/Stage 沿用已审计的 `20261020-114357`、163 包/327 文件；本轮不把缓存产物冒充重新编译。原 40 项的回归通过不等同于本次新发现的运行时材质完整性问题已解决。

下一步先统一 Cook 和运行时的默认材质变体条件，再验证无收费依赖的 Shader 字节码解压/创建方式，最后推进单静态网格/Unlit 首帧、相机和网页 UI。当前仍无场景可交付；Oodle 字节码解压、RHI Shader 创建、完整正常 UBT 与目标 5.8.3 全源一致性均未验收。

以下为历史检查点。

**2026-10-20 第三十四轮，11:58：浏览器已统一 ES3.1，并实际打开 Global 和项目材质库，Global 映射加载已越过。** Chrome、Edge 均从原来的 SM5 缺库推进到对象和普通贴图资源初始化。当前 WebGPU Engine 仍为 0 帧，首个阻塞为 `RHICalcTexturePlatformSize` 未实现，不再是缺库或冻结布局不匹配。

| 本轮检查 | 实测结果 |
| --- | --- |
| 平台和特性级别 | UBT 正式生成 Web/46 和 Web/47 注册项；浏览器 RHI 工厂、入口和特性级别映射均使用 ES3.1/46、SF_WEBGPU_ES31，原生独立 RHI 样本保留 SM5 分支 |
| Cook/运行设置 | 网页运行配置与成功 Cook 的 17 项渲染设置逐项相同；补齐 ES3.1 平台资料，没有增加可选功能 |
| 实际 Cook | `20261020-114357`；冻结布局进入缓存键后，838 个 Global 和 213 个材质作业全部重新转换，163/163 个包、退出 0、0 错误、13 警告；逐作业 DDC 关闭，全作业校验保留 |
| 实际暂存 | 327 个文件、24,042,244 字节；重复的两个 Metadata 库经哈希比对后不装入；保留真实映射、Global 库和项目库，项目库由 UEShaderHost 文件名映射为 UEWebEngine |
| 冻结内存布局 | 修正 Cook 的最大字段对齐描述为 4294967295、Freezing_bAlignBases=false（允许复用基类尾部）；两浏览器实际输出 flags=1、pointerBytes=8；保留引擎的兼容性和类型校验，不修改二进制映射 |
| 顶点资源 | 将已有“省略未使用位置/切线/UV SRV”的 Web 条件同时覆盖 ES3.1；保留普通顶点流，前置 RHI 资源初始化通过 |
| 文件缓存修正 | 单线程内联任务原来在回调返回前清理请求；仅 Web 改为 ReadRequest/SizeRequest 返回后回收。两浏览器各完成 3 个句柄、387 个块读取、3 个跨块读取、25,362,483 字节比对与释放；去掉 3 个 Web 条件块后，桌面代码与安装版源码完全相同 |
| 引擎实际库加载 | 两浏览器均打开 Global 库（726 个 Shader）和 UEWebEngine 库（125 个 Shader），越过现有 CompileGlobalShaderMap/VerifyGlobalShaders 调用并到达 PreObjectSystemReady；该阶段证据来自日志顺序与未修改的启动调用链 |
| 原 40 项回归 | 再次通过；ABI 改变材质映射哈希后，按完整变体集合与 WGSL 内容建立一对一映射，保留同名材质映射的数量；115 个普通静态网格作业 WGSL 与原成功作业相同，贴花两浏览器三轴读回通过 |
| 实际构建 | 隔离 Web UBT 编译、8 个模块动作、RHI.1、Engine.43/45、Core.2 和入口重编/415 项链接通过；安装版原生构建输入哈希保持不变 |
| 浏览器边界 | NullRHI 各 10 帧、0 页面错误；WebGPU 库接入阶段通过，普通 WhiteSquareTexture 初始化在 RHICalcTexturePlatformSize 明确报错，0 帧；未验证压缩字节码解压、实际 RHI Shader 创建或场景绘制 |

新增复现入口：

```powershell
node tests/web-platform/stage-web-engine.cjs --es31
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-engine-webgpu.cjs --incremental --es31
node tests/web-platform/verify-web-material-completion.cjs
node tests/web-platform/verify-web-es31-runtime-integration.cjs
```

最新入口报告为 `web-es31-runtime-integration-results.json`：`pass=true` 仅表示本轮库接入阶段通过。浏览器完整运行报告 `web-engine-webgpu-es31-results.json` 仍为 `pass=false`、`completeUEScene=false`。旧 SM5 浏览器报告及第三十三轮大汇总属于历史检查点，本轮没有把它们冒充当前 ES3.1 全功能回归。

下一步仅补齐普通二维纹理启动所需的尺寸/内存查询、创建与上传接口；随后检查 Oodle 压缩字节码的可运行打包方式及 RHI Shader 创建，再用一个静态网格、普通二维纹理/Unlit 材质和相机跑第一帧。原有库仍含 Oodle 数据，打开库不等于已解压；不扩展骨骼、粒子、地形、数组纹理或材质层。完整正常 UBT 构建、5.8.3 全源版本一致性、地图和网页 UI 集成仍未验收。

以下为历史检查点。

**2026-10-20 第三十三轮，11:21：原来的 40 个材质转换失败全部处理完，最小默认资源 ES3.1 Cook 首次完整通过。** 新缓存键 v11 下实际重编译 838 个 Global 作业和 213 个材质作业，全部成功；163/163 个包完成，退出码 0，日志为 0 错误、13 警告。完整 UE WebGPU 场景仍为 0 帧，尚未进行 ES3.1 引擎库加载或普通地图绘制。

| 本轮检查 | 实测结果 |
| --- | --- |
| 原 40 项逐项对应 | 39 个来自最小场景不用的 7 种骨骼/布料、粒子、Landscape 顶点工厂，在提交任务前明确排除；1 个贴花像素 Shader 修复后实际重编通过 |
| 排除范围 | 7 种工厂共退出 72 个旧材质作业，包含上述 39 个旧失败和 33 个旧成功；没有把排除项记为修复或编译成功 |
| 保留范围 | 原 115 个 FLocalVertexFactory 作业全部重新编译成功；除声明的工厂和下述雾深度生成外，前后作业集合完全一致，无新增作业 |
| 贴花修复 | 仅 Web 分支将边界 clip 移到材质采样之后，保留隐式纹理导数的统一控制流；Chrome/Edge 各执行原 Cook WGSL，三轴裁剪各核验 48 个颜色值，错误 0 |
| 原生工厂对照 | 桌面、单独 Web 目标、带 Web 标志的其他目标共三组、24 项回调检查通过；普通静态网格始终保留，另外 7 种仅在单独 Web Cook 中排除 |
| 体积雾宿主 ensure | 复用已关闭的体积雾能力，补齐 FGenerateConservativeDepthBufferCS 的编译和使用条件；Global 839→838，其余 1,509 个类型和 16 项设置不变；不再触发参数 ensure，安装版 DLL/源码差异没有被篡改 |
| 实际 Cook | `20261020-111016`，仍为原六个入口包，逐作业 DDC 关闭、全作业校验保留；329 个产品文件、27,641,783 字节，0 转换失败 |
| 实际构建 | 隔离原生 RenderCore 8 个动作、格式/探针 5 个动作通过；WASM 的 Engine.33、RenderCore.6、RenderCore.3、Renderer.4 单元编译及链接通过；安装版引擎输入哈希未改变 |
| 既有回归 | 两浏览器缓冲/真实间接派发、纹理更新及拒绝对照、96 个色调映射模块、捕获/阴影读回、两个资源专用材质及 13 个错误绑定对照均通过；策略和汇总证据通过 |
| Global 库结构 | 91 个 ShaderMap、729 个引用、726 份 Oodle 压缩字节码；映射 332,361 字节、库 2,883,752 字节；尚未在 WASM 中解压、反序列化或加载 |
| 当前浏览器 | Chrome/Edge 的 NullRHI 各 10 帧、0 页面错误；WebGPU 设备和前置资源初始化通过，仍因 SM5 Global 库缺失而 0 帧 |
| SM5 对照 | `20261020-111636` 仍失败，记录的首个失败为 FWriteToSliceGS 的 SPIR-V Layer；首个失败受调度顺序影响，不能据此认定旧 FDeferredLightPS 已修复 |
| 汇总状态 | `evidenceVerified=true`、`materialRegressionVerified=true`、`webgpuES31ShaderCookVerified=true`；整体 `pass=false`，完整正常 UBT 构建及 WebGPU Engine Tick 未通过 |

新增入口：`probe-web-vertex-factories.ps1` 和 `verify-web-material-completion.cjs`。最新逐项证据为 `tests/web-platform/results/web-material-completion-results.json`，实际 Cook 为 `web-engine-webgpu-es31-cook-results.json`。旧 `web-material-cook-results.json` 是上一轮的诊断重放记录，不代表当前失败数；原始记录及本轮前快照保留。

下一步按已通过的 ES3.1 路线统一 WASM 的平台编号、Shader 格式与特性级别，接入真实 `GlobalShaderCache-SP_WEBGPU_ES31.bin` 和 `ShaderArchive-Global-SF_WEBGPU_ES31-SP_WEBGPU_ES31.ushaderbytecode`，验证解压及引擎反序列化；随后仅用一个静态网格、普通二维纹理/Unlit 材质和相机输入跑出第一帧，再接网页 UI。不继续扩大骨骼、粒子或地形等可选功能。

以下为历史检查点。

**2026-10-20 第三十二轮，10:48：Cook 推进到实际材质编译，修复两个普通静态网格材质绑定失败；完整场景仍为 0 帧。** 本轮围绕材质 Cook 阻塞开展对照测试，没有新增功能移植或排除。逐作业 DDC 关闭后，保留 `DebugValidateJobCache=1` 的情况下不再触发原生缓存 `Job` 断言。此设置目前由独立重放脚本传入，未修改引擎缓存实现，也未把原先默认验证路径当作已修复。

资源表生成代码会为只剩纹理/采样器的材质补充 `Material` UniformBuffer 参数，即使常量已全部被优化掉。原绑定检查要求同名常量缓冲描述符，误拒绝了这种合法情况。新增分支核对资源表位、布局哈希、流偏移和结束标记、槽位、成员索引、类型、绑定位置及所有存活描述符；无效映射和缺失的普通参数仍拒绝。Shader 格式缓存键更新为 v10，WGSL 本身没有改写。

| 本轮检查 | 实测结果 |
| --- | --- |
| 缓存对照，`20261020-102034` | 相对上一轮仅关闭逐作业 DDC，保留全作业校验；未出现 `Job` 断言，推进到材质后因默认材质失败退出 3 |
| 修复后实际 Cook，`20261020-103643` | 原六个入口包、1,510 个 Global 类型、839 个变体和 16 项渲染设置均保留；最高日志为已 Cook 131 包、余 32 包，随后默认 WorldGridMaterial 失败，退出 3 |
| Global 转换 | 839 个独立作业全部重新转换通过，0 失败；没有新增排除 |
| 材质转换 | 285 个独立作业，245 成功、40 失败；80 条重复失败诊断对应 40 个独立失败 |
| 与缓存对照比较 | 42 个材质独立失败减少为 40 个；精确恢复两个 FLocalVertexFactory 作业，剩余失败集合与原集合减去这两项完全相同，无新增失败 |
| 普通静态网格范围 | 本次实际记录 115 个 FLocalVertexFactory 独立作业，全部转换成功；不等同于完整材质集或引擎绘制验证 |
| 原生绑定正反例 | 直接调用生产 C++ 校验函数，两个原失败输入被接受，13 个错误资源表/参数配置均被拒绝，共 15 项 |
| 新增浏览器 GPU 验证 | Chrome、Edge 各执行原深度及阴影像素 Shader，混合透明/不透明纹理，核验深度保留/写入及颜色保留/写入；各两个用例、24 个读回值，错误 0 |
| Shader 代码保持 | 两个作业在新 Cook 中重新生成，WGSL 哈希与原失败目录相同；失败来自绑定元数据检查，不是 Shader 数学改写 |
| 主机参数根因 | 新只读 Commandlet 从实际 Renderer DLL 导出的字段名为 `ConservativeDepthTextureSize`，偏移 24；同机源码/Shader 使用 `ConservativeDepthFillSize`，确认源码与二进制不一致；新 Cook 仍出现 ensure，未修复 |
| Global 文件 | 映射 333,357 字节，库 2,894,719 字节；92 个 ShaderMap、730 引用、727 个压缩 Shader 的结构检查通过，尚未解压/反序列化/加载 |
| 主机 C++ | 五个明确的编译/链接动作通过，更新 Shader 格式模块和探针 DLL；输出均在工作区，安装引擎未修改；这不是完整正常 UBT 构建 |
| 既有回归 | 两浏览器缓冲各 34 用例/18,757 值和 29 次间接派发，纹理各 6 用例/11,063 值及四项拒绝检查，96 个色调映射模块，捕获/阴影各 10 模块、四用例/256 值均通过 |
| 原生 RenderCore / WASM | 本轮未修改这些运行时代码，沿用原有编译/链接证据，415 个链接输入及 287 份源文件哈希重验通过 |
| SM5 首错，`20261020-104529` | 3,714 个待编译变体，FDeferredLightPS 的 switch fallthrough 首错，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 各 10 帧、0 页面错误；WebGPU 设备及前置资源初始化通过，仍缺匹配 SM5 Global 库、0 帧 |
| 汇总 | `evidenceVerified=true`、`materialResourceOnlyBindingRegressionVerified=true`；完整材质回归和整体验收仍为 false |

剩余 40 个材质失败中，39 个是骨骼/布料、粒子或 Landscape 顶点工厂的 `SampledBuffer`，另一个是默认延迟贴花像素 Shader 转换。它们本轮仍在编译，没有伪造成功或用空 Shader 代替。下一步按最小普通静态网格场景约束编译与消费者，不扩展这些可选能力；主机 ConservativeDepth 的未用体积雾路径也应优先复用既有禁用策略，避免迁就混合版本 DLL 扩展功能。

新增 `probe-web-material-cache.ps1`、`build-web-material-host.ps1`、`replay-web-material-cook.ps1`、`verify-web-resource-only-uniform.cjs` 和只发布真实重放结果的 `publish-web-material-cook.cjs`。主报告现在引用实际材质 Cook，并明确区分 Global 与材质作业；现有 GPU、策略、库结构和汇总检查均已刷新。前轮 17 份报告保留为 `-before-material-host-20261020-1021.json`；首次读回测试遇到非精确清屏色的 8 位舍入差异，报告单独保留为 `web-resource-only-uniform-results-clear-color-rounding-20261020-1041.json`，改用精确清屏色后通过，15 项原生检查按输入/结果/日志哈希复用。

**仍待完成：材质 Cook 的最小编译范围、主机参数不一致、实际库命名接入、Cook/WASM 平台统一和真实地图验证。** 暂无可交付的 UE 网页场景。后续还须验证库解压和映射加载、普通 Unlit 静态网格地图、相机、输入及 HTML UI。UMG/Slate 保留依赖，遇到 Web 问题局部禁编译；原生 5.8.0 与目标 5.8.3 混合、浏览器仍 SM5、`fullNormalUBTBuildVerified=false` 等边界保持。以下为历史检查点。

## 2026-10-20 第三十一轮检查点

**2026-10-20 第三十一轮，10:15：ES3.1 Global Shader 转换失败 2→0，首次生成 Global 映射和共享字节码库；完整 Cook 仍失败。** 本轮只修改两个 Shader 的 Web 数值分支，不增加功能、不排除作业、不修改 C++。移动场景捕获显式读取未归一化法线，再做带长度下限的归一化，避免前向渲染无 GBuffer 时归一化零向量；屏幕阴影上采样将无穷深度上限改为最大有限 float。其他平台保留原代码。**零法线输出是原本缺失数据的有限零值，不代表前向渲染新增了法线捕获能力。**

| 本轮检查 | 实测结果 |
| --- | --- |
| ES3.1 完整作业校验，`20261020-100507` | 839 个独立作业全部转换通过，0 个失败、0 条转换失败诊断；Cook 退出 3 |
| 编译范围 | 1,510 个类型的变体数、839 个变体及 16 项设置与上一轮完全相同，新增排除为 0 |
| 两项数值修复 | 两个旧失败本轮重新转换，相关八个旧成功保留；10 个模块在两浏览器检查通过 |
| 新增实际 GPU 回归 | 每浏览器四个用例、256 个 float 读回值通过；覆盖零法线、双边深度权重、常量阴影及无有效邻点；最大误差约 `3.69e-8`，GPU 错误为 0 |
| Global 映射产物 | `Engine/GlobalShaderCache-SP_WEBGPU_ES31.bin`，333,357 字节；仅哈希保存，尚未反序列化验证 |
| Global 字节码产物 | `ShaderArchive-Global-SF_WEBGPU_ES31-SP_WEBGPU_ES31.ushaderbytecode`，2,891,378 字节；内容目录与元数据目录副本哈希相同 |
| 库结构 | 版本 3，92 个 ShaderMap、730 个 Shader 引用、727 份去重字节码；索引、预加载范围、连续数据范围及资产元数据/日志计数相符 |
| 库验证边界 | 727 份均为 Oodle 压缩字节码；本轮未解压、未验证 Shader payload、未验证 UE 加载，不将文件存在视为完整库成功 |
| Global 参数检查 | `FGenerateConservativeDepthBufferCS` 出现 `ConservativeDepthFillSize` 不在 C++ 参数结构中的 ensure；没有当作通过 |
| 材质阶段 | 编译 Widget 默认材质时在原生 `ShaderCompilerJobCache.cpp:1981` 触发 `Job` 断言；日志统计材质 Cook 数为 0 |
| 既有 GPU 回归 | 每浏览器缓冲 34 用例、18,757 值及 29 次真实间接派发；纹理 6 用例、11,063 值及四个旧产物拒绝检查；96 个色调映射模块均通过 |
| C++ 构建及链接 | 本轮无 C++ 修改，未重复构建；沿用上一轮产物，415 个链接输入、287 份链接源文件及既有编译产物哈希重新核验通过 |
| SM5 首错检查，`20261020-101059` | 3,714 个待编译变体，首错 `FDeferredLightPS` 的 SPIR-V switch fallthrough，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 设备及前置资源初始化通过，仍缺匹配的 SM5 Global 库、0 帧、各一个页面错误 |
| 汇总 | `evidenceVerified=true`；`pass=false`，真实 WebGPU 场景仍为 0 帧 |

独立 Shader 快照的受审计覆盖从 10 份增加为 12 份，安装目录源文件哈希未变。新增 `verify-web-finite-capture-shadow.cjs` 与 `verify-web-global-archive.cjs` 分别验证真实 Cook Shader 的 GPU 输出及原生归档结构。上一轮 14 个报告及 Shader 快照报告共 15 份，以 `-before-finite-capture-shadow-20261020-1008.json` 保留。策略核验和汇总核验首次执行通过；两个报告递归共 1,411 处文件哈希核验通过。历史排除独立保留，本轮两个修复按实际转换/GPU 输出计入；纹理基线缺席的 108 个旧失败精确对应 102 个排除、四个间接参数修复及本轮两个数值修复。

**当前剩余：转换阶段已通过，下一步转向主机参数/材质 Cook、库加载和场景。** 优先定位 `ConservativeDepthFillSize` 的主机参数不匹配及材质作业缓存断言，UMG 继续保留依赖，其 Web 问题只作局部跳过，不开展完整移植。库的实际命名含 `SP_WEBGPU_ES31`，现有 Cook/Stage 预期文件名尚需按引擎实际规则接入；不能靠改名将 ES3.1 库给 SM5 使用。之后统一 Cook 与 WASM 的平台、特性级别及格式配置，验证库解压、映射反序列化、加载、普通 Unlit 静态网格地图、相机、输入和 HTML UI。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false` 和 512 线程组设备协商边界保留。NullRHI 内容沿用有效的 324 文件、19,952,703 字节 Cook/Stage，浏览器循环本轮已重验。SM5 4,395 作业仍为历史扫描，当前 3,714 仅首错检查；首错顺序变化不证明其他 SM5 问题修复。下文为历史检查点。

## 2026-10-20 第三十轮检查点

**2026-10-20 第三十轮，09:58：同步关闭 Web 点光源立方体阴影缓存复制，独立转换失败 3→2。** `TScreenVSForGS` 只在该复制路径使用，普通全屏顶点为另一个入口。本轮复用已有 `SupportsOnePassPointLightShadows`，限制两个分层/几何顶点变体及立方体复制 GS/PS；原生 Cook 按文件和入口精确识别，不排除共用的整个 `ScreenVertexShader.usf` 或 `CopyShadowMaps.usf`。ES3.1 两个当前启用的变体退出，包含一个旧分层顶点失败和一个旧像素成功；排除不计为修复，没有移植立方体阴影。

直接调用 `CopyCachedShadowMap` 且请求立方体阴影时，在读取缓存、注册图资源和查询 Shader 前报 Fatal。去掉这一个新增保护块后，整个复制函数与安装版一致；二维及滚动复制分支和对应 Shader 声明未改。普通 `FScreenVS`、二维复制和滚动复制三个作业本轮重新转换通过，六份声明/普通全屏实现文件核验通过。**立方体复制拒绝和普通阴影复制的真实 GPU 执行均未验证；原生 Engine/Renderer 仍为安装版，本轮新增消费者只在 WASM 编译。**

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过，受检安装版输入哈希未变 |
| WASM 构建 | RenderCore.3 和 Renderer.30（阴影深度及缓存复制）重编、增量链接通过 |
| 链接及源文件证据 | 415 个链接输入及 287 份源文件哈希核验通过，六份安装版/隔离副本声明与普通全屏实现核验通过 |
| ES3.1 完整作业校验，`20261020-095446` | Cook 退出 3；839 个独立作业：837 个转换通过、2 个失败；4 条失败诊断 |
| 精确范围对照 | 两个类型少 2 个变体；其余 1,508 个类型的变体数及 16 项设置不变，无新增失败 |
| 排除项证据 | 一个分层顶点旧失败和一个立方体复制像素旧成功的输入、SPIR-V、WGSL/失败诊断保留核验 |
| 保留复制路径 | `FScreenVS`、`FCopyShadowMaps2DPS`、`FScrollingShadowMaps2DPS` 本轮重新转换通过 |
| 其他保留路径 | 普通 IES 更新 CS、41 个其他移动后处理、15 个普通/调制阴影投影、50 个 HZB 及两个单采样作业本轮重新转换通过 |
| 缓冲 GPU 回归 | Chrome/Edge 各通过 34 个用例、18,757 个值及 29 次真实间接派发，GPU 错误为 0 |
| 纹理/色调映射回归 | 每浏览器 6 个纹理用例、11,063 个值和四个旧读写纹理产物拒绝检查通过；96 个色调映射作业重新转换并通过模块检查 |
| SM5 首错检查，`20261020-095637` | 3,714 个待编译变体；首错仍为 FWriteToSliceGS 的 SPIR-V `Layer` builtin，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧、各一个页面错误 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

本轮前 14 个报告以 `-before-cube-shadow-copy-policy-20261020-0952.json` 后缀保留，原生及 WASM 日志时间戳均为 `20261020-095210`。策略核验首次执行通过；本轮两个对象及历史对象的编译证据、源文件和最终链接输入均核验通过。成功转换数减少一个，对应明确退出的立方体复制像素路径。纹理基线缺席的 106 个其他旧失败精确对应 102 个历史/本轮排除项及四个已 GPU 验证的间接参数修复项。SM5 4,395 作业仍为历史完整扫描，当前 3,714 仅首错检查，不代表其余 SM5 失败已恢复。

**当前剩余：2 个转换失败仍阻止 ES3.1 完整 Global Shader 库生成，真实 WebGPU 场景仍为 0 帧。** 分别是场景捕获 `FSceneCapturePS` 和屏幕阴影 `FScreenSpaceShadowsUpsamplePS`。下一步定位两项转换错误，按最小场景需要决定修复或同步限制编译与消费者，不扩展可选渲染功能。之后仍需统一 Cook/浏览器配置，生成并加载匹配 Global 库，验证普通 Unlit 静态网格地图、相机、输入和 HTML UI。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构及 512 线程组设备协商边界保留。NullRHI 内容沿用有效的 324 文件、19,952,703 字节 Cook/Stage，浏览器循环本轮已重验。下文为历史检查点。

## 2026-10-20 第二十九轮检查点

**2026-10-20 第二十九轮，09:48：同步关闭 Web GPU 粒子编译、运行能力和独立预缓存入口，独立转换失败 4→3。** `SupportsGPUParticles` 原来恒为 true，硬件查询也没有平台限制。本轮共享 Web 能力约束原生四个 GPU 粒子 Shader 文件及目标公共查询，WASM 运行查询先检查平台，再检查控制台和硬件条件。退出 10 个变体，包含一个 `FParticleTileVS` 的旧 `SampledBuffer` 失败和九个旧转换成功；排除不计为修复，没有移植 GPU 粒子。

现有 FX 初始化、Tick、模拟调度、GPU 发射器和 sprite 资源创建沿用公共硬件查询。全局粒子 PSO 收集在查询 Shader 前退出；向量场调试网格在资源/网格准备前退出，边界线绘制保留。粒子曲线纹理跳过 Web 分配，添加曲线返回空分配；直接模拟、创建发射器、更新 sprite 资源或注入曲线时明确报 Fatal，避免访问已禁用的 Shader。系统记账、销毁、释放和曲线提交实现保留。**CPU 粒子代码未改且未运行验证；WebGPU 旁路、控制台强制启用及 GPU 粒子资产 Cook 未验证。原生 Engine 仍为安装版，目标 GPU sprite/向量场材质编译条件尚未完成原生资产验证。**

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过，受检安装版输入哈希未变；原生 Engine/Renderer 仍为安装版 |
| WASM 构建 | RenderCore.3、Engine.36（FX/曲线）、Engine.37（模拟/模块）及 Engine.57（向量场）重编、增量链接通过 |
| 链接及消费者证据 | 415 个链接输入、281 份源文件哈希核验通过；八份安装版/隔离副本声明及消费者文件核验通过 |
| ES3.1 完整作业校验，`20261020-094434` | Cook 退出 3；841 个独立作业：838 个转换通过、3 个失败；6 条失败诊断 |
| 精确范围对照 | 仅十个类型少 10 个变体；其余 1,500 个类型的变体数及 16 项设置不变，无新增失败 |
| 排除项证据 | 一个粒子顶点旧失败及九个模拟/注入/调试旧成功的输入、SPIR-V、WGSL/失败诊断保留核验 |
| 保留路径 | 普通 IES 更新 CS、41 个其他移动后处理、15 个普通/调制阴影投影、50 个 HZB 及两个单采样作业本轮重新转换通过 |
| 缓冲 GPU 回归 | Chrome/Edge 各通过 34 个用例、18,757 个值及 29 次真实间接派发，GPU 错误为 0 |
| 纹理/色调映射回归 | 每浏览器 6 个纹理用例、11,063 个值和四个旧读写纹理产物拒绝检查通过；96 个色调映射作业重新转换并通过模块检查 |
| SM5 首错检查，`20261020-094634` | 3,718 个待编译变体；本次首错 FWriteToSliceGS 的 SPIR-V `Layer` builtin，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧、各一个页面错误 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

本轮前 14 个报告以 `-before-gpu-particle-policy-20261020-0944.json` 后缀保留，原生及 WASM 日志时间戳均为 `20261020-094204`。策略核验首次执行通过；四个本轮对象及历史对象的编译证据、源文件和最终链接输入均核验通过。成功转换数减少九个，对应明确退出的可选 GPU 粒子路径。纹理基线缺席的 105 个其他旧失败精确对应 101 个历史/本轮排除项及四个已 GPU 验证的间接参数修复项。SM5 4,395 作业仍为历史完整扫描，当前 3,718 仅首错检查；没有将其余 SM5 失败视为修复。

**当前剩余：3 个转换失败仍阻止 ES3.1 完整 Global Shader 库生成，真实 WebGPU 场景仍为 0 帧。** 分别是阴影分层复制顶点 `TScreenVSForGS<true>`、场景捕获 `FSceneCapturePS` 和屏幕阴影 `FScreenSpaceShadowsUpsamplePS`。下一步核对阴影分层复制与最小场景的关系，同步限制不用的编译与消费者，必要捕获/屏幕路径才修复。之后仍需统一 Cook/浏览器配置，生成并加载匹配 Global 库，验证普通 Unlit 静态网格地图、相机、输入和 HTML UI。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构及 512 线程组设备协商边界保留。NullRHI 内容沿用有效的 324 文件、19,952,703 字节 Cook/Stage，浏览器循环本轮已重验。下文为历史检查点。

## 2026-10-20 第二十八轮检查点

**2026-10-20 第二十八轮，09:32：同步关闭 Web 虚拟纹理页表编译、能力查询和直接使用入口，独立转换失败 6→4。** 最小场景已设置 `r.VirtualTextures=0`，但页表的两个顶点和六个像素类型原来仍参与编译。本轮共享 `SupportsVirtualTexturing` 同时约束原生文件策略、两组页表 Shader 模板和公共 Shader 平台查询；纹理构建使用的目标设置查询也对 Web 返回关闭。退出的 8 个变体包含两个旧 `SampledBuffer` 失败和六个旧转换成功，排除不计为修复，没有移植虚拟纹理。

移动/桌面渲染的虚拟纹理更新选择和运行时 VT 场景扩展沿用公共能力判断；VT 系统的启动与记账保留。直接绕过查询进入页表资源初始化、纹理分配、更新准备或更新提交时，在分配或 Shader 查询前报 Fatal，避免留下不可更新的页表。原有资源释放和更新结束实现与安装版一致。**普通纹理路径未修改；实际 WebGPU 虚拟纹理旁路、不受支持的 VT 资产拒绝和 VT 资产 Cook 均未验证，普通场景纹理绘制也尚未证明。**

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过，受检安装版输入哈希未变；原生 Engine/Renderer 仍为安装版 |
| WASM 构建 | RenderCore.3 和 Renderer.38（含页表及 VT 系统消费者）重编、增量链接通过，415 个链接输入哈希核验通过 |
| ES3.1 完整作业校验，`20261020-092752` | Cook 退出 3；851 个独立作业：847 个转换通过、4 个失败；8 条失败诊断 |
| 精确范围对照 | 仅八个类型少 8 个变体；其余 1,502 个类型的变体数及 16 项设置不变，无新增失败 |
| 排除项证据 | 两个页表顶点旧失败和六个页表像素旧成功的输入、SPIR-V、WGSL/失败诊断保留核验 |
| 消费者与资源生命周期 | 八份安装版/隔离副本声明和消费者文件核验通过；释放及更新结束实现未改 |
| 保留路径 | 普通 IES 更新 CS、41 个其他移动后处理、15 个普通/调制阴影投影、50 个 HZB 及两个单采样作业本轮重新转换通过 |
| 缓冲 GPU 回归 | Chrome/Edge 各通过 34 个用例、18,757 个值及 29 次真实间接派发，GPU 错误为 0 |
| 纹理/色调映射回归 | 每浏览器 6 个纹理用例、11,063 个值和四个旧读写纹理产物拒绝检查通过；96 个色调映射作业重新转换并通过模块检查 |
| SM5 首错检查，`20261020-092932` | 3,729 个待编译变体；本次首错 FDeferredLightPS 的 SPIR-V switch fallthrough，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧、各一个页面错误 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

本轮前 14 个报告以 `-before-vt-page-table-policy-20261020-0927.json` 后缀保留，原生及 WASM 日志时间戳均为 `20261020-092528`。策略核验首次执行通过；本轮两个对象及既有对象的编译证据、最终链接输入和源文件哈希均已核验。成功转换数减少六个，对应明确退出的页表像素路径。纹理基线缺席的 104 个其他旧失败精确对应 100 个历史/本轮排除项及四个已 GPU 验证的间接参数修复项。SM5 4,395 作业仍为历史完整扫描，当前 3,729 仅首错检查；首错顺序变化不证明旧失败恢复。

**当前剩余：4 个转换失败仍阻止 ES3.1 完整 Global Shader 库生成，真实 WebGPU 场景仍为 0 帧。** 分别是粒子顶点 `FParticleTileVS`、阴影分层复制顶点 `TScreenVSForGS<true>`、场景捕获 `FSceneCapturePS` 和屏幕阴影 `FScreenSpaceShadowsUpsamplePS`。下一步优先核对粒子和阴影分层复制的实际能力与消费者，未用功能同步跳过，必要路径才修复。之后仍需统一 Cook/浏览器配置，生成并加载匹配 Global 库，验证普通 Unlit 静态网格地图、相机、输入和 HTML UI。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构及 512 线程组设备协商边界保留。NullRHI 内容沿用有效的 324 文件、19,952,703 字节 Cook/Stage，浏览器循环本轮已重验。下文为历史检查点。

## 2026-10-20 第二十七轮检查点

**2026-10-20 第二十七轮，09:20：同步跳过 Web 移动遮挡反馈编译及资源初始化，独立转换失败 8→6。** 该优化默认关闭，但两个像素 Shader 仍无条件参与移动平台编译，转换报 `EarlyFragmentTests` 不支持。本轮通过共享 `SupportsOcclusionFeedback` 限制文件策略、两个 Shader 类型、视图状态初始创建及按需初始化。即使运行时启用 `r.OcclusionFeedback.Enable`，Web 两处初始化入口也不接收该资源；未用路径排除不计为修复，没有移植遮挡反馈。

没有仅在 `InitRHI` 内返回后留下“已初始化”的假状态：两处创建入口首先检查平台能力，直接绕过入口初始化或绘制则在资源/Shader 准备前报 Fatal。按需路径在条件不满足时保留释放；原有释放、反馈范围、读取及批次辅助实现未改。移动绘制调用方检查 `IsInitialized`，反馈缓冲默认 nullptr。普通 HZB/硬件查询选择保留，**未证明这些路径已在 WebGPU 场景运行，也未实际验证控制台强制开启时的旁路。**

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过，受检安装版输入哈希未变；原生 Engine/Renderer 仍为安装版 |
| WASM 构建 | RenderCore.3、Renderer.26（视图状态）、Renderer.27（遮挡）、Renderer.29（可见性）重编及增量链接通过 |
| ES3.1 完整作业校验，`20261020-091612` | Cook 退出 3；859 个独立作业：853 个转换通过、6 个失败；12 条失败诊断 |
| 精确范围对照 | 仅两个类型少 3 个变体；其余 1,508 个类型的变体数及 16 项设置不变，无新增失败 |
| 排除项证据 | 两个遮挡反馈像素旧失败和一个顶点旧成功的输入、SPIR-V、WGSL/失败诊断保留核验 |
| 保留路径 | 普通 IES 更新 CS、41 个其他移动后处理、15 个普通/调制阴影投影、50 个 HZB 及两个单采样作业本轮重新转换通过 |
| 缓冲 GPU 回归 | Chrome/Edge 各通过 34 个用例、18,757 个值及 29 次真实间接派发，GPU 错误为 0 |
| 纹理/色调映射回归 | 每浏览器 6 个纹理用例、11,063 个值和四个旧读写纹理产物拒绝检查通过；96 个色调映射作业重新转换并通过模块检查 |
| SM5 首错检查，`20261020-091826` | 3,737 个待编译变体；本次首错 FGPUMorphNormalizeCS 的 `SampledBuffer`，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | 复测 NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧、各一个页面错误 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

本轮前 14 个报告以 `-before-occlusion-feedback-policy-20261020-0915.json` 后缀保留，原生及 WASM 日志时间戳均为 `20261020-091323`。策略核验首次执行通过；四份本轮对象和历史对象的编译证据、最终链接输入哈希及八份安装版/隔离副本声明和消费者文件均核验通过。成功转换数减少一个，对应明确退出的反馈顶点路径。纹理基线缺席的其他旧失败精确对应 98 个历史/本轮排除项及四个已 GPU 验证的间接参数修复项。SM5 4,395 作业仍为历史完整扫描，当前 3,737 仅首错检查；首错顺序变化不证明 Layer 等旧失败恢复。

本地 8765 服务重启，页面及 COOP/COEP 响应头检查通过。首次 Engine 浏览器检查的 Edge NullRHI 已完成 10 帧，但有一次 `ERR_NO_BUFFER_SPACE` 资源加载错误；失败报告保留为 `web-engine-webgpu-results-network-resource-error-20261020-0917.json`，Cook 结束后的完整浏览器复测通过 NullRHI 检查，无需修改引擎或放宽断言。

**当前剩余：6 个转换失败仍阻止 ES3.1 完整 Global Shader 库生成，真实 WebGPU 场景仍为 0 帧。** 虚拟纹理页表两个，粒子顶点、阴影分层复制顶点 `TScreenVSForGS<true>`、场景捕获和屏幕阴影各一个。这里的分层复制顶点并非普通全屏绘制 Shader；下一步核对虚拟纹理、粒子和该阴影路径的编译能力与消费者，未用功能同步跳过，必要路径才修复。之后仍需统一 Cook/浏览器配置，生成并加载匹配 Global 库，验证普通 Unlit 静态网格地图、相机、输入和 HTML UI。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构及 512 线程组设备协商边界保留。NullRHI 内容沿用有效的 324 文件、19,952,703 字节 Cook/Stage，浏览器循环本轮已重验。下文为历史检查点。

## 2026-10-19 第二十六轮检查点

**2026-10-19 第二十六轮，21:12：同步跳过 Web 地形纹理输出及 IES 调试，独立转换失败 12→8。** 地形这三个失败属于运行时高度图/权重图输出到纹理的功能，并非普通地形绘制或仅编辑器功能。本轮不移植该输出功能；`SupportsLandscapeTextureCapture` 同时约束原生文件策略、三个目标 Shader 类型、公共输出入口和渲染线程消费者。三个公开包装入口仍返回 bool，进入公共实现后在资源分配及渲染入队前返回 false；直接渲染/Shader 帮助函数调用在准备资源前明确报错。

IES 调试和普通 atlas 更新共用 `IESAtlas.usf` 及 `MainCS`，因此原生 Cook 按 **Shader 类型名和文件名** 精确识别 `FIESAtlasDebugInfoCS`，不排除整个文件。目标调试 Shader 和两个调试入口共用 `SupportsIESAtlasDebug`，在启用 ShaderPrint 和分配资源前退出；普通两个更新 Shader 声明及 `UpdateAtlasTexture` 与安装版一致，普通 CS 本轮重新转换通过。**没有增加 IES、纹理数组或地形支持；普通地形绘制未修改但也未验证，IES 普通更新只证明转换通过，旁路均未在真实 UE WebGPU 场景执行。**

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过，受检安装版输入哈希未变；原生 Engine/Renderer 仍为安装版 |
| WASM 构建 | RenderCore.3、Renderer.8（IES 管理器）、Landscape.1 重编与增量链接通过；Landscape 已转为工作区独立副本 |
| ES3.1 完整作业校验，`20261019-210705` | Cook 退出 3；862 个独立作业：854 个转换通过、8 个失败；16 条失败诊断 |
| 精确范围对照 | 仅四个类型少 7 个变体；其余 1,506 个类型的变体数及 16 项设置不变，无新增失败 |
| 排除项证据 | 三个地形重采样旧失败、一个 IES 调试旧失败，以及三个地形合并/通道打包旧成功均保留并核验；排除不计为修复 |
| 保留路径 | 普通 IES 更新 CS、41 个其他移动后处理、15 个普通/调制阴影投影、50 个 HZB 及两个单采样作业本轮重新转换通过 |
| 缓冲 GPU 回归 | Chrome/Edge 各通过 34 个用例、18,757 个值及 29 次真实间接派发，GPU 错误为 0 |
| 纹理/色调映射回归 | 每个浏览器 6 个纹理用例、11,063 个值及四个旧读写纹理产物拒绝检查通过；96 个色调映射作业重新转换并通过模块检查 |
| SM5 首错检查，`20261019-210908` | 3,737 个待编译变体；首错 FWriteToSliceGS 的 SPIR-V `Layer` builtin，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧、各一个页面错误 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

本轮前 14 个报告以 `-before-landscape-ies-policy-20261019-2054.json` 后缀保留，原生日志为 `native-rendercore-20261019-205721.log`，WASM 编译及链接日志为 `web-engine-webgpu-link-20261019-205721.log`。策略核验首次执行通过；三份本轮对象及历史对象的编译证据和最终链接输入哈希均已核验，四份地形/IES 声明文件安装版及隔离副本核验通过。纹理基线中缺席的其他旧失败精确对应 96 个历史/本轮排除项和四个已 GPU 验证的间接参数修复项。成功转换作业减少三个，对应明确退出的可选地形纹理输出路径。SM5 4,395 作业仍为历史完整扫描，当前 3,737 只检查首错，不证明其余失败恢复。

**当前剩余：8 个转换失败仍阻止 ES3.1 完整 Global Shader 库生成，真实 WebGPU 场景仍为 0 帧。** 遮挡反馈和虚拟纹理页表各两个，粒子顶点、屏幕顶点、场景捕获及屏幕阴影各一个。下一步先核对遮挡反馈、虚拟纹理和粒子路径的实际能力及消费者，最小场景未用部分同步限制；必要的屏幕顶点等路径才修复。之后仍需统一 Cook/浏览器配置，生成并加载匹配 Global 库，验证普通 Unlit 静态网格地图、相机、输入和 HTML UI。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构及 512 线程组设备协商边界保留。NullRHI 内容沿用有效的 324 文件、19,952,703 字节 Cook/Stage，浏览器循环本轮已重验。下文为历史检查点。

## 2026-10-19 第二十五轮检查点

**2026-10-19 第二十五轮，20:45：同步跳过 Web 调试/编辑器图元合成及 HMD 畸变，独立转换失败 15→12。** 最小场景不需要这些叠加和头显效果；共享 `SupportsCompositePrimitives`、`SupportsHMDDistortion` 同时约束原生 RenderCore 文件策略、目标 Shader 条件、调试/编辑器合成开关、桌面/移动 HMD 后处理序列及专用全局顶点声明初始化。本轮四个类型共退出 6 个变体，其中 3 个旧失败、3 个旧成功，排除不计为修复，没有移植调试叠加或 VR。

调试及编辑器合成入口在 Web 平台返回禁用，直接绕过条件调用时在资源准备前报 Fatal，避免引用被排除的 Shader 或返回未写入的深度。HMD 两个直接入口在访问 XR 系统前进入旁路：保留场景颜色；若有指定颜色输出，则沿用 `AddDrawTexturePass` 拷贝。HMD 顶点声明跳过 Web 初始化，原有安全释放保留。三个声明头文件的安装版/隔离副本共 6 份文件核验通过，既有移动调试绘制调用方继续使用公共开关。**编辑器专用 `AddEditorPrimitivePass` 受 `WITH_EDITOR` 保护，本轮仅源码核验；HMD 指定输出拷贝、顶点声明旁路和调试合成禁用尚未在实际 WebGPU 场景执行。**

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过，受检安装版输入哈希未变；原生 Engine/Renderer 仍为安装版 |
| WASM 构建 | RenderCore.3、Renderer.21（合成公共/调试实现、HMD 及后处理序列）、Renderer.28（场景开关）重编与增量链接通过 |
| ES3.1 完整作业校验，`20261019-204037` | Cook 退出 3；869 个独立作业：857 个转换通过、12 个失败；24 条失败诊断 |
| 精确范围对照 | 仅四个类型少 6 个变体；其余 1,506 个类型的变体数及 16 项设置不变，无新增失败 |
| 排除项证据 | 两个合成深度旧失败、一个 HMD 像素旧失败，以及两个合成像素/一个 HMD 顶点旧成功作业均保留并核验 |
| 保留路径 | 41 个其他移动后处理、15 个普通/调制阴影投影、50 个 HZB 作业及两个单采样作业本轮重新转换通过 |
| 缓冲 GPU 回归 | Chrome/Edge 各通过 34 个用例、18,757 个值及 29 次真实间接派发，GPU 错误为 0 |
| 纹理/色调映射回归 | 每个浏览器 6 个纹理用例、11,063 个值及四个旧读写纹理产物拒绝检查通过；96 个色调映射作业重新转换并通过模块检查 |
| SM5 首错检查，`20261019-204254` | 3,744 个待编译变体；首错 FWriteToSliceGS 的 SPIR-V `Layer` builtin，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧、各一个页面错误 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

本轮前 14 个报告以 `-before-composite-hmd-policy-20261019-2036.json` 后缀保留，当前 WASM 编译及链接日志为 `web-engine-webgpu-link-20261019-203741.log`。验证脚本核验本轮三个对象及既有 Engine/Renderer 对象进入最终链接；策略核验首次执行通过。纹理基线中缺席的其他旧失败精确对应 92 个历史/本轮排除项和四个已 GPU 验证的间接参数修复项。ES3.1 本轮成功作业减少三个，对应明确退出的合成/HMD 可选路径。配置比较中的 SM5 4,395 作业仍为历史完整扫描，当前 3,744 仅进行首错检查；未声称 SM5 其余失败已恢复。

**当前剩余：12 个转换失败仍阻止 ES3.1 完整 Global Shader 库生成，真实 WebGPU 场景仍为 0 帧。** 包括地形合并三个、遮挡反馈和虚拟纹理页表各两个，以及粒子、场景捕获、屏幕顶点、屏幕阴影和 IES 调试各一个。下一步优先核对地形合并与 IES 调试的实际用途及调用条件，最小场景未用路径同步限制编译和消费者，必要路径才修复。之后仍需统一 Cook/浏览器配置，生成并加载匹配的 Global 库，验证普通 Unlit 静态网格地图、相机、输入和 HTML UI。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构与 512 线程组设备协商边界保留。NullRHI 内容沿用有效的 324 文件、19,952,703 字节 Cook/Stage，浏览器循环本轮已重验。下文为历史检查点。

## 2026-10-19 第二十四轮检查点

**2026-10-19 第二十四轮，19:43：同步跳过 Web 粒子 GPU Radix/Bitonic 排序的编译、资源初始化和任务接收，独立转换失败 22→15。** 最小静态网格场景不需要粒子 GPU 排序；共享 `SupportsGPUSorting` 同时约束原生 RenderCore 文件策略、目标七个 Shader 条件、两个全局排序资源初始化及任务入口。本轮排除的 7 个变体全部为旧 `SampledBuffer` 失败，排除不计为修复，没有增加排序或 RHI 功能。

`FGPUSortManager::AddTask` 在分配缓冲前返回 false，Cascade 保留原有未排序粒子索引路径；渲染阶段的事件通知和清理保留。绕过管理器的直接排序调用会明确报 Fatal，避免把原始数据伪装成排序结果；排序自测在分配前返回 false。三个公共排序头文件和 Cascade 调用方的安装版/隔离副本共 8 份文件核验通过。当前目标禁用默认插件且最终链接不含 Niagara，**未验证 Niagara 的排序/剔除；资源初始化旁路和 Cascade 回退尚未在实际 WebGPU 场景执行。**

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过，受检安装版输入哈希未变；原生 Engine/Renderer 仍为安装版 |
| WASM 构建 | RenderCore.3、Engine.25（含 Radix、Bitonic 及排序管理器）重编与增量链接通过 |
| ES3.1 完整作业校验，`20261019-193512` | Cook 退出 3；875 个独立作业：860 个转换通过、15 个失败；30 条失败诊断 |
| 精确范围对照 | 仅七个类型少 7 个变体；其余 1,503 个类型的变体数及 16 项设置不变，无新增失败 |
| 排除项证据 | 七个旧排序失败诊断均保留并核验；没有成功转换作业被本轮排除 |
| 保留路径 | 41 个其他移动后处理、15 个普通/调制阴影投影、50 个 HZB 作业及两个单采样作业本轮重新转换通过 |
| 缓冲 GPU 回归 | Chrome/Edge 各通过 34 个用例、18,757 个值及 29 次真实间接派发，GPU 错误为 0 |
| 纹理/色调映射回归 | 每个浏览器 6 个纹理用例、11,063 个值及四个旧读写纹理产物拒绝检查通过；96 个色调映射作业重新转换并通过模块检查 |
| SM5 首错检查，`20261019-193835` | 3,755 个待编译变体；本次首错 FBuildPhysicsFieldClipmapCS 的 `SampledBuffer`，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧、各一个页面错误 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

本轮前 14 个报告以 `-before-gpu-sort-policy-20261019-1929.json` 后缀保留，当前 WASM 编译及链接日志为 `web-engine-webgpu-link-20261019-193132.log`。验证脚本核验两个本轮对象和既有 Engine.51/Renderer 对象进入最终链接；首次策略核验的一条调用方正则未容纳原有 `else` 块的尾部括号，修正后通过，无需改动或重编引擎。纹理基线中缺席的其他旧失败精确对应 89 个历史/本轮排除项和四个已 GPU 验证的间接参数修复项。配置比较中的 SM5 4,395 作业仍为历史完整扫描，当前 3,755 仅进行首错检查；首错顺序变化不证明旧 Layer 等失败已修复。

**当前剩余：15 个转换失败仍阻止 ES3.1 完整 Global Shader 库生成，真实 WebGPU 场景仍为 0 帧。** 包括地形合并三个、遮挡反馈/虚拟纹理页表/编辑器合成深度各两个，以及粒子、HMD、场景捕获、屏幕顶点、屏幕阴影和 IES 调试各一个。下一步优先核对编辑器合成深度、地形编辑及 HMD 等最小场景未用路径，编译与消费者一起限制；必要路径才修复。之后仍需统一 Cook/浏览器配置，生成并加载匹配的 Global 库，验证普通 Unlit 静态网格地图、相机、输入和 HTML UI。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构与 512 线程组设备协商边界保留。NullRHI 内容沿用有效的 324 文件、19,952,703 字节 Cook/Stage，浏览器循环本轮已重验。下文为历史检查点。

## 2026-10-19 第二十三轮检查点

**2026-10-19 第二十三轮，18:12：同步限制 Web 稀疏体积纹理更新的编译与流送能力，独立转换失败 25→22。** 两个更新 Shader 原来不检查平台能力；本轮共享 `SupportsSparseVolumeTextures` 同时约束原生 RenderCore 文件策略、目标两个编译条件和 `DoesPlatformSupportSparseVolumeTextures`。共退出 4 个变体，包含 3 个旧 `SampledBuffer` 失败及 1 个旧转换成功的页表更新作业。排除不计为修复，没有移植体积效果或扩展 RHI 格式。

原有 `UseSparseVolumeTextures` 读取公共平台能力，流送管理器初始化、注册、请求和更新等九处入口已经检查该函数。管理器本轮随 Engine.51 重新编译；其安装版/隔离副本及上传头文件共 4 份文件已核验。两个直接上传路径仅在派发前检查 Web 能力，保留前面的缓冲解锁和末尾无条件释放，避免跳过清理。**流送资源初始化旁路及上传解锁/释放尚未在实际 WebGPU 场景执行。**

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过，受检安装版输入哈希未变；原生 Engine/Renderer 仍为安装版，通过共享文件策略限制 Shader |
| WASM 构建 | RenderCore.3、Engine.51（含稀疏体积流送管理器及上传实现）重编与增量链接通过 |
| ES3.1 完整作业校验，`20261019-180721` | Cook 退出 3；882 个独立作业：860 个转换通过、22 个失败；44 条失败诊断 |
| 精确范围对照 | 仅两个类型少 4 个变体；其余 1,508 个类型的变体数及 16 项设置不变，无新增失败 |
| 排除项证据 | 三个旧失败诊断及一个旧成功作业的输入、SPIR-V、WGSL 均保留并核验 |
| 保留路径 | 41 个其他移动后处理、15 个普通/调制阴影投影、50 个 HZB 作业、单采样深度复制及独立颜色解析全部本轮重新转换通过 |
| 缓冲 GPU 回归 | Chrome/Edge 各通过 34 个用例、18,757 个值及 29 次真实间接派发，GPU 错误为 0 |
| 纹理/色调映射回归 | 每个浏览器 6 个纹理用例、11,063 个值及四个旧读写纹理产物拒绝检查通过；96 个色调映射作业重新转换并通过模块检查 |
| SM5 首错检查，`20261019-180956` | 3,762 个待编译变体；本次首错 FWriteToSliceGS 的 SPIR-V `Layer` builtin，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧、各一个页面错误 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

本轮前 14 个报告以 `-before-sparse-volume-policy-20261019-1803.json` 后缀保留，当前 WASM 编译及链接日志为 `web-engine-webgpu-link-20261019-180519.log`。验证脚本核验本轮两个对象进入最终链接；首次策略核验仍选取 SMAA 历史对象，补充上一轮调试显示重编对象的查找后通过，编译日志及本次链接输入哈希均核验，没有重编无改动对象。纹理基线中缺席的其他旧失败精确对应 82 个历史/本轮排除项和四个已 GPU 验证的间接参数修复项。配置比较中的 SM5 4,395 作业仍为历史完整扫描，当前 3,762 仅进行首错检查。

**当前剩余：22 个转换失败仍阻止 ES3.1 完整 Global Shader 库生成，真实 WebGPU 场景仍为 0 帧。** 包括 Radix/Bitonic 排序七个、地形合并三个、遮挡反馈/虚拟纹理页表/编辑器合成深度各两个，以及粒子、HMD、场景捕获、屏幕顶点、屏幕阴影和 IES 调试各一个。继续按最小场景需要核对编译和调用条件，未用功能同步跳过，必要路径才修复。之后仍需统一 Cook/浏览器配置，生成并加载匹配的 Global 库，验证普通 Unlit 静态网格地图、相机、输入和 HTML UI。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构与 512 线程组设备协商边界保留。NullRHI 内容沿用有效的 324 文件、19,952,703 字节 Cook/Stage，浏览器循环本轮已重验。下文为历史检查点。

## 2026-10-19 第二十二轮检查点

**2026-10-19 第二十二轮，18:00：同步限制 Web 灯光形状与 HDR 调试显示的编译、准备和调用，独立转换失败 29→25。** 最小场景不使用这两项调试显示；共享能力判断同步用于原生 RenderCore 文件策略和三个目标 Shader 类型。共退出 5 个变体，其中灯光形状顶点 Shader 的 3 个绑定描述失败、HDR 像素 Shader 的 1 个 `SampledBuffer` 失败，以及 1 个旧转换成功的灯光形状像素 Shader。排除不计为修复，没有增加调试功能或 RHI 格式。

灯光形状的视图状态更新、调试网格准备、全局顶点声明初始化和绘制入口同步受限；已有 LightGrid 收集入口仍读取公共视图状态判断。HDR 的桌面/移动后处理序列、照度计能力及直接 Pass 入口使用同一 Web 限制。直接调用时保留场景颜色，若指定输出目标则沿用 `AddDrawTexturePass` 完成拷贝。两个声明头文件和桌面调用方的安装版/隔离副本共 6 份文件审计通过。**调试资源初始化旁路及 HDR 指定输出拷贝尚未在实际 WebGPU 场景执行。**

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过，受检安装版输入哈希未变；原生 Renderer 仍为安装版，通过共享文件策略排除调试 Shader |
| WASM 构建 | RenderCore.3、Renderer.21（后处理序列）、Renderer.23（HDR 调试入口）、Renderer.36（灯光形状）重编及增量链接通过 |
| ES3.1 完整作业校验，`20261019-175719` | Cook 退出 3；886 个独立作业：861 个转换通过、25 个失败；50 条失败诊断 |
| 精确范围对照 | 仅三个类型少 5 个变体；其余 1,507 个类型的变体数及 16 项设置不变，无新增失败 |
| 排除项证据 | 四个旧失败诊断及一个旧成功作业的输入、SPIR-V、WGSL 均保留并核验 |
| 保留路径 | 41 个其他移动后处理、15 个普通/调制阴影投影、50 个 HZB 作业、单采样深度复制及独立颜色解析全部本轮重新转换通过 |
| 缓冲 GPU 回归 | Chrome/Edge 各通过 34 个用例、18,757 个值及 29 次真实间接派发，GPU 错误为 0 |
| 纹理/色调映射回归 | 每个浏览器 6 个纹理用例、11,063 个值及四个旧读写纹理产物拒绝检查通过；96 个色调映射作业重新转换并通过模块检查 |
| SM5 首错检查，`20261019-175905` | 3,766 个待编译变体；本次首错 FWriteToSliceGS 的 SPIR-V `Layer` builtin，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧、各一个页面错误 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

本轮前 14 个报告以 `-before-render-debug-policy-20261019-1752.json` 后缀保留，当前 WASM 编译及链接日志为 `web-engine-webgpu-link-20261019-175509.log`。验证脚本核验本轮四个对象的新哈希进入最终链接，上一轮天空大气及历史移动曝光、SMAA 编译证据继续有效。纹理基线中缺席的其他旧失败精确对应 79 个历史/本轮排除项和四个已 GPU 验证的间接参数修复项。配置比较中的 SM5 4,395 作业仍为历史完整扫描，当前 3,766 仅进行首错检查。

**当前剩余：25 个转换失败仍阻止 ES3.1 完整 Global Shader 库生成，真实 WebGPU 场景仍为 0 帧。** 包括 Radix/Bitonic 排序七个、稀疏体积纹理和地形合并各三个，以及其他后处理、调试和可选消费者。继续按最小场景需要核对编译和调用条件，未用功能同步跳过，必要路径才修复。之后仍需统一 Cook/浏览器配置，生成并加载匹配的 Global 库，验证普通 Unlit 静态网格地图、相机、输入和 HTML UI。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构与 512 线程组设备协商边界保留。NullRHI 内容沿用有效的 324 文件、19,952,703 字节 Cook/Stage，浏览器循环本轮已重验。下文为历史检查点。

## 2026-10-19 第二十一轮检查点

**2026-10-19 第二十一轮，17:47：同步限制 Web 天空大气的编译、资源准备和绘制入口，独立转换失败 32→29。** 网页配置原本已设置 `r.SupportSkyAtmosphere=0`；本轮共享 `SupportsSkyAtmosphere` 用于原生 RenderCore 的文件策略及目标九个 Shader 类型的编译条件。七个原来有作业的类型共退出 103 个变体，其中 3 个旧失败、100 个旧转换成功；另两个类型原来即为零。排除不计为修复，没有实现天空散射或扩展 RHI 格式。

公共运行判断、场景/视图 LUT 准备、LUT 生成及提交、内部/外部绘制、编辑器提示和调试入口同步受限。可选全局球面采样缓冲也跳过 Web 初始化。LUT 入口在返回前仍登记 `SceneRenderer`，保留后续提交的指针契约；场景注册和必要 uniform 记账保留。已有视图默认零标志、黑色纹理/缓冲绑定经源码审计，五个调用/声明文件的安装版及隔离副本共 10 份文件已核验。**这些入口、默认资源绑定及缓冲初始化旁路尚未在实际 WebGPU 场景执行。**

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过，受检安装版输入哈希未变；原生 Renderer 仍使用安装版，通过共享文件策略排除天空大气 Shader |
| WASM 构建 | RenderCore.3、Renderer.33（天空大气）重编及增量链接通过 |
| ES3.1 完整作业校验，`20261019-174151` | Cook 退出 3；891 个独立作业：862 个转换通过、29 个失败；58 条失败诊断 |
| 精确范围对照 | 仅七个类型少 103 个变体；其余 1,503 个类型的变体数及 16 项设置不变，无新增失败 |
| 排除项证据 | 三个旧失败诊断、100 个旧成功作业的输入、SPIR-V、WGSL 均保留并核验 |
| 保留路径 | 41 个其他移动后处理、15 个普通/调制阴影投影、50 个 HZB 作业、单采样深度复制及独立颜色解析全部本轮重新转换通过 |
| 缓冲 GPU 回归 | Chrome/Edge 各通过 34 个用例、18,757 个值及 29 次真实间接派发，GPU 错误为 0 |
| 纹理/色调映射回归 | 每个浏览器 6 个纹理用例、11,063 个值及四个旧读写纹理产物拒绝检查通过；96 个色调映射作业重新转换并通过模块检查 |
| SM5 首错检查，`20261019-174337` | 3,771 个待编译变体；本次首错 FWriteToSliceGS 的 SPIR-V `Layer` builtin，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧、各一个页面错误 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

本轮前 14 个报告以 `-before-sky-atmosphere-policy-20261019-1738.json` 后缀保留，当前 WASM 编译及链接日志为 `web-engine-webgpu-link-20261019-173952.log`。验证脚本核验本轮两个对象的新哈希进入最终链接，并继续核验历史移动曝光、SMAA 等编译对象。纹理基线中缺席的其他旧失败精确对应 75 个历史/本轮排除项和四个已 GPU 验证的间接参数修复项。配置比较中的 SM5 4,395 作业仍为历史完整扫描，当前 3,771 仅进行首错检查。

**当前剩余：29 个转换失败仍阻止 ES3.1 完整 Global Shader 库生成，真实 WebGPU 场景仍为 0 帧。** 包括 Radix/Bitonic 排序七个，稀疏体积纹理、地形合并、灯光形状调试各三个，以及其他后处理、调试和可选消费者。继续按最小场景需要核对编译和调用条件，未用功能同步跳过，必要路径才修复。之后仍需统一 Cook/浏览器配置，生成并加载匹配的 Global 库，验证普通 Unlit 静态网格地图、相机、输入和 HTML UI。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构与 512 线程组设备协商边界保留。NullRHI 内容沿用有效的 324 文件、19,952,703 字节 Cook/Stage，浏览器循环本轮已重验。下文为历史检查点。

## 2026-10-19 第二十轮检查点

**2026-10-19 第二十轮，17:32：同步限制 Web 移动自动曝光的编译与消费入口，独立转换失败 37→32。** 当前 `r.MobileHDR=0` 已使移动曝光不参与调度，但其 Shader 原有编译条件只检查移动平台。本轮共享 `SupportsMobileEyeAdaptation` 按 `PostProcessMobile.usf` 的四个入口精确限制五个类型，并同步用于目标编译条件及 `IsMobileEyeAdaptationEnabled`；同文件其他后处理不受影响。排除不计为修复，没有移植曝光直方图或扩展 RHI。

移动后处理序列及 `FViewInfo::UpdatePreExposure` 已读取该公共运行判断；后处理关闭曝光 Pass 时向色调映射传入空曝光缓冲，色调映射原有固定曝光逻辑继续保留。两个直接 Pass 入口也在创建资源或交换历史缓冲前返回。额外审计预曝光实现和移动输入/输出头文件的安装版/隔离副本共四份文件；预曝光实现本轮未重编，公共函数实现随 Renderer.22 重编进入链接。**固定曝光的实际 GPU 显示、直接调用旁路和真实场景消费者仍未验证。**

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过，受检安装版输入哈希未变；原生 Renderer 仍使用安装版，通过共享入口策略排除曝光 Shader |
| WASM 构建 | RenderCore.3、Renderer.22（移动后处理与曝光公共判断）重编及增量链接通过 |
| ES3.1 完整作业校验，`20261019-172822` | Cook 退出 3；994 个独立作业：962 个转换通过、32 个失败；64 条失败诊断 |
| 精确范围对照 | 五个类型各少一个变体，恰好排除五个旧曝光失败；其余 1,505 个类型的变体数及 16 项设置不变，无新增失败 |
| 共用文件保留路径 | `PostProcessMobile.usf` 其余 41 个变体全部本轮重新转换通过，覆盖 Bloom、景深等原有入口 |
| 其他保留路径 | 15 个普通/调制阴影投影、50 个 HZB 作业、单采样深度复制及独立颜色解析全部重新转换通过 |
| 缓冲 GPU 回归 | Chrome/Edge 各通过 34 个用例、18,757 个值及 29 次真实间接派发，GPU 错误为 0 |
| 纹理/色调映射回归 | 每个浏览器 6 个纹理用例、11,063 个值及四个旧读写纹理产物拒绝检查通过；96 个色调映射作业重新转换并通过模块检查 |
| SM5 首错检查，`20261019-173101` | 3,987 个待编译变体，曝光类型原本均为零；本次首错为稀疏体积纹理更新的 SPIR-V `SampledBuffer`，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧、各一个页面错误 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

本轮前 14 个报告以 `-before-mobile-exposure-policy-20261019-1726.json` 后缀保留，当前 WASM 编译及链接日志为 `web-engine-webgpu-link-20261019-172613.log`。验证脚本继续核验历史编译日志，并要求本轮 RenderCore.3、Renderer.22 新对象哈希进入最终链接；上一轮 SMAA 对象仍作为有效链接输入。纹理基线中缺席的其他旧失败精确对应 72 个历史/本轮排除项和四个已 GPU 验证的间接参数修复项。配置比较中的 SM5 4,395 作业仍为历史完整扫描，当前 3,987 仅进行首错检查。

**当前剩余：32 个转换失败仍阻止 ES3.1 完整 Global Shader 库生成，真实 WebGPU 场景仍为 0 帧。** 主要包括 Radix/Bitonic 排序七个、天空大气/稀疏体积纹理/地形合并各三个，以及后处理、调试和其他可选消费者。后续优先核对已关闭的天空大气及剩余路径的实际需要，未用功能同步跳过编译和调用，必要路径才修复。之后仍需统一 Cook/浏览器配置，生成并加载匹配的 Global 库，验证普通 Unlit 静态网格地图、相机、输入和 HTML UI。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构与 512 线程组设备协商边界保留。NullRHI 内容沿用有效的 324 文件、19,952,703 字节 Cook/Stage，浏览器循环本轮已重验。下文为历史检查点。

## 2026-10-19 第十九轮检查点

**2026-10-19 第十九轮，17:20：同步限制 Web SMAA 编译、后处理调度与纹理加载，独立转换失败 41→37。** 当前网页配置原本已关闭抗锯齿；共享 `SupportsSMAA` 同时用于原生 RenderCore 的四个 SMAA 文件策略、目标八个 Shader 类型的编译条件、桌面/移动后处理序列和查找纹理加载入口。仅跳过当前未启用的可选抗锯齿，没有修复其采样控制流或扩展 RHI。

`AddSMAAPasses` 自身在分配中间纹理及查找 Shader 前检查同一能力。若直接调用方指定 `OverrideOutput`，通过引擎已有 `AddDrawTexturePass` 将场景颜色写入目标；否则返回输入场景颜色，保留最终输出契约。**该旁路仅通过 WASM 编译和链接，尚未进行实际 GPU 执行；真实 WebGPU 场景仍为 0 帧。**

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过，受检安装版输入哈希未变；原生 Renderer 仍使用安装版，由共享文件策略限制 SMAA |
| WASM 构建 | RenderCore.3、Renderer.21（后处理序列）、Renderer.23（SMAA）、Renderer.28（纹理准备）重编与增量链接通过 |
| ES3.1 完整作业校验，`20261019-171613` | Cook 退出 3；999 个独立作业：962 个转换通过、37 个失败；74 条失败诊断 |
| 精确范围对照 | 八个类型共少 18 个变体，包含 4 个旧失败及 14 个旧转换成功作业；其余 1,502 个类型的变体数和 16 项设置不变，无新增失败 |
| 排除项证据 | 四个旧失败诊断及 14 个旧成功作业的输入、SPIR-V、WGSL 均保留并核验；排除项不计为修复 |
| 保留路径 | 15 个普通/调制阴影投影、50 个 HZB 作业、单采样深度复制及独立颜色解析全部本轮重新转换通过 |
| 缓冲 GPU 回归 | Chrome/Edge 各通过 34 个用例、18,757 个值及 29 次真实间接派发，GPU 错误为 0 |
| 纹理/色调映射回归 | 每个浏览器 6 个纹理用例、11,063 个值及 4 个旧读写纹理产物拒绝检查通过；96 个色调映射作业重新转换并通过模块检查 |
| SM5 首错检查，`20261019-171931` | 3,987 个待编译变体；本次首错 FWriteToSliceGS 的 SPIR-V `Layer` builtin，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧、各 1 个页面错误 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

本轮前 14 个报告以 `-before-smaa-policy-20261019-1714.json` 后缀保留，当前 WASM 编译及链接日志为 `web-engine-webgpu-link-20261019-171415.log`。验证脚本继续核验历史编译日志；已被本轮替换的 RenderCore.3、Renderer.28 要求当前对象编译成功且哈希进入最终链接。纹理基线中缺席的其他旧失败精确对应 67 个历史/本轮排除项和 4 个已 GPU 验证的间接参数修复项。配置比较中的 SM5 4,395 作业是历史完整扫描，当前 3,987 仅进行首错检查。

**当前剩余：37 个转换失败仍阻止完整 Global Shader 库生成。** 包括移动曝光 5 个、Radix/Bitonic 排序 7 个、天空大气/稀疏体积纹理/地形合并各 3 个，以及其他后处理、调试和可选消费者。后续继续按最小场景需要核对编译与入口，未用功能跳过，必要路径才修复。之后仍需统一实际 Cook/运行配置，生成并加载完整 Global 库，验证普通 Unlit 静态网格地图、相机、输入和 HTML UI。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构与 512 线程组设备协商边界保留。NullRHI 内容沿用有效的 324 文件、19,952,703 字节 Cook/Stage，浏览器循环本轮已重验。下文为历史检查点。

## 2026-10-19 第十八轮检查点

**2026-10-19 第十八轮，17:07：同步限制 Web OIT 三角形排序编译、索引分配与排序调度，独立转换失败 46→41。** 共享 `SupportsOITSortedTriangles` 用于原生 RenderCore 的 `OITSorting.usf` 文件策略及目标 `OIT::IsSortedTrianglesEnabled`。排序扫描、分配、写出三个 Shader 原有编译条件读取该公共开关，独立的排序调试 Shader 也补上同一 Web 限制。没有修复可选排序算法、修改普通透明混合或扩展 RHI 格式；排除作业不计为修复。

已有 `PrimitiveSceneInfo` 在公共开关允许时才分配并替换排序索引；移动和桌面渲染器也在该开关允许时才调用排序，`AddSortTrianglesPass` 自身再检查一次。目标 `OIT.cpp` 的新公共判断使 Web 保留原有网格索引并跳过排序调度。三个消费者的安装版/隔离副本共 6 个文件已核验哈希相同；消费者本轮没有重编，公共函数实现随 Renderer.19 重编进入最终链接。**普通透明材质绘制和这些入口在实际 WebGPU 场景中的执行仍未验证。**

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过，安装版受检输入哈希未变；原生 Renderer 仍使用安装版，通过共享文件策略限制排序 Shader |
| WASM 构建 | RenderCore.3、Renderer.19（含 OIT）重编及增量链接通过 |
| 链接记录补全 | 首次链接已通过，但未包含新增消费者审计；保留两个对象的编译报告，补充审计后用同一批对象再次链接通过，未重复编译 |
| ES3.1 完整作业校验，`20261019-170334` | Cook 退出 3；1,017 个独立作业：976 个转换通过、41 个失败；82 条失败诊断 |
| 精确范围对照 | 4 个类型共少 5 个变体，恰好排除 5 个旧 OIT 失败；其余 1,506 个类型和 16 项设置不变，无新增失败 |
| 保留路径 | 15 个普通/调制阴影投影作业、50 个 HZB 作业、单采样深度复制及独立颜色解析均本轮重新转换通过 |
| 缓冲 GPU 回归 | Chrome/Edge 各通过 34 个用例、18,757 个值及 29 次真实间接派发，GPU 错误为 0 |
| 纹理/色调映射回归 | 每个浏览器 6 个纹理用例、11,063 个值及 4 个旧读写纹理产物拒绝检查通过；96 个色调映射作业重新转换并通过模块检查 |
| SM5 首错检查，`20261019-170615` | 4,005 个待编译变体；本次首错 FDeferredLightPS/0 的 SPIR-V switch fallthrough，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧、各 1 个页面错误 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

本轮前 14 个报告以 `-before-oit-policy-20261019-1700.json` 后缀保留，两个对象的首次编译/链接记录保留为 `web-engine-webgpu-link-results-oit-compile-20261019-170112.json`，最终含消费者审计的链接日志为 `web-engine-webgpu-link-20261019-170403.log`。验证脚本核验首次编译对象进入最终链接、6 份消费者文件以及既有点阴影编译对象。纹理基线中缺席的其他旧失败精确对应 63 个历史/本轮排除项和 4 个已 GPU 验证的间接参数修复项。

**当前剩余：41 个转换失败仍阻止完整 Global Shader 库生成，真实 WebGPU 场景仍为 0 帧。** 后续继续核对移动曝光、SMAA、其余排序及后处理等作业的实际需要，未用功能同步限制编译与运行，必要路径才修复。之后仍需统一实际 Cook/运行配置，生成并加载完整 Global 库，验证普通 Unlit 静态网格地图、相机、输入和 HTML UI。普通阴影/透明绘制和场景消费者尚未验证；目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构与 512 线程组设备协商边界保留。NullRHI 内容沿用有效的 324 文件、19,952,703 字节 Cook/Stage，浏览器循环本轮已重验。下文为历史检查点。

## 2026-10-19 第十七轮检查点

**2026-10-19 第十七轮，16:53：同步限制 Web 单次点光源立方体阴影的编译、准备、分配与投影，独立转换失败 56→46。** 原生 Cook 按文件和 `MainOnePassPointLightPS` 入口精确限制，不整文件排除 `ShadowProjectionPixelShader.usf`；目标 `TOnePassPointShadowProjectionPS` 编译条件使用同一 Web 能力判断。10 个未启用的投影变体退出编译，排除不计为修复，没有实现立方体深度比较采样或扩展 RHI 资源格式。

`DoesRuntimeSupportOnePassPointLightShadows` 同步返回 Web 不支持；`CreateWholeSceneProjectedShadow` 在点光源初始化器进入后续准备前返回，`AllocateOnePassPointLightDepthTargets` 防止 SM5 条件绕过能力判断分配立方体深度，`RenderOnePassPointLightProjection` 防止查找已排除的 Shader。目标 `GetPlatformSupportedShadowDepthTypes` 只移除 `OnePassPoint` 位，保留普通方向光和聚光灯类型。原生 Cook 的 Renderer 仍为安装版，**该目标材质深度条件仅通过 WASM 编译，尚未进行实际材质 Cook 验证**。

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过，安装版受检输入哈希未变 |
| WASM 构建 | RenderCore.3、Renderer.30（阴影深度及投影）、Renderer.31（阴影准备）重编与增量链接通过 |
| ES3.1 完整作业校验，`20261019-164904` | Cook 退出 3；1,022 个独立作业：976 个转换通过、46 个失败；92 条失败诊断 |
| 精确范围对照 | 10 个类型各少 1 个变体，恰好排除 10 个旧点阴影失败；其余 1,500 个类型和 16 项设置不变，无新增失败 |
| 同文件普通阴影 | 保留的 15 个普通/调制阴影投影作业全部本轮重新转换，入口均为 `Main`；未执行实际阴影 GPU 绘制或场景调用 |
| 其他保留路径 | 50 个 HZB 作业、单采样深度复制及独立颜色解析全部重新转换通过 |
| 缓冲 GPU 回归 | Chrome/Edge 各 34 个用例、18,757 个值、29 次真实间接派发通过，GPU 错误为 0 |
| 纹理/色调映射回归 | 每个浏览器 6 个纹理用例、11,063 个值及 4 个旧读写纹理产物拒绝检查通过；96 个色调映射作业重新转换并通过模块检查 |
| SM5 首错检查，`20261019-165142` | 4,010 个待编译变体；本次首错 FWriteToSliceGS 的 SPIR-V `Layer` builtin，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧、各 1 个页面错误 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

本轮前 14 个报告以 `-before-point-shadow-policy-20261019-1645.json` 后缀保留。验证脚本区分本轮排除项、既有 4 个间接参数修复及历史裁剪；纹理基线中缺席的其他旧失败精确对应 58 个历史/本轮排除项和 4 个已 GPU 验证修复项。之前 RenderCore.3、ShadowSetup 所在 Renderer.31 对象已被本轮重编替换，历史编译日志继续核验，当前对象要求本轮编译成功且哈希进入最终链接，不再要求已覆盖对象仍匹配旧哈希。其他既有编译对象、保守深度实现及链接输入继续核验。

**当前剩余：46 个转换失败仍阻止完整 Global Shader 库生成，真实 WebGPU 场景仍为 0 帧。** 后续优先核对移动曝光、OIT/排序、SMAA 等剩余作业的实际消费者，不用的功能同步限制编译与运行，必要路径才修复。之后仍需统一实际 Cook/运行配置，生成并加载完整 Global 库，验证普通 Unlit 静态网格地图、相机、输入和 HTML UI。普通阴影 GPU 绘制和本轮入口的实际场景执行尚未验证；目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构与 512 线程组设备协商边界保留。NullRHI 内容沿用有效的 324 文件、19,952,703 字节 Cook/Stage，浏览器循环本轮已重验。下文为历史检查点。

## 2026-10-19 第十六轮检查点

**2026-10-19 第十六轮，16:36：4 个间接派发参数 Shader 修复并通过真实 GPU 执行，独立转换失败 60→56。** 本轮只改 4 个 Shader 的 Web 缓冲声明，并在 `Platform.ush` 添加 `RWStructuredBuffer<uint>` 写派发参数重载；原有参数、索引、线程组及非 Web 分支保持。没有增加功能裁剪、RHI 格式或修改 C++，也没有移植完整次表面散射功能，仅验证其参数生成作业。

修复项为 `FClearIndirectDispatchArgsCS`、`FBuildIndirectDispatchArgsBufferCS`、`FInitIndirectArgs1DCS`、`FClearUAVBuildIndirectDispatchBufferCS`。它们此前均因 SPIR-V `SampledBuffer` 失败；Web 改用结构化缓冲后，实际 Cook 产物的反射、GPU 参数回读及间接派发均通过。

| 本轮检查 | 实测结果 |
| --- | --- |
| ES3.1 完整作业校验，`20261019-163034` | Cook 退出 3；1,032 个独立作业：976 个转换通过、56 个失败；112 条失败诊断 |
| 精确范围对照 | 全部 1,510 个类型、1,032 个变体及 16 项设置不变；恰好 4 个旧失败恢复，无新增失败、无新裁剪 |
| 独立 Shader 副本 | 1,227 个文件，累计 10 个严格核对的 Web 覆盖文件；共享辅助函数也进入副本，安装版受检输入哈希有效 |
| 缓冲 GPU 回归 | Chrome/Edge 各执行 34 个用例、核对 18,757 个值，覆盖原有 22 个作业及新增 4 个作业各 3 种场景，0 GPU 错误 |
| 真实间接派发 | 每个浏览器用生成的参数缓冲执行 29 次 `dispatchWorkgroupsIndirect`，回读原子计数器和保护值通过；覆盖零派发、条件开关、偏移、带填充步长、非二次幂 mip 尺寸与尾部越界保护 |
| 既有纹理/色调映射 | 每个浏览器 6 个纹理用例、11,063 个值及 4 个旧产物拒绝检查通过；96 个色调映射作业全部重新转换并通过模块检查 |
| 保留路径 | 50 个 HZB 作业、单采样深度复制和独立颜色解析均重新转换通过，原有可选路径限制继续有效 |
| 原生/WASM 构建证据 | 本轮未改 C++，复用并逐项核验既有原生 RenderCore、WASM 编译对象及最终链接输入哈希；未重新构建 |
| SM5 首错检查，`20261019-163303` | 4,025 个待编译变体；本次首错 FDeferredLightPS/11 的 SPIR-V switch fallthrough，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧、各 1 个页面错误 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

本轮前 15 个报告以 `-before-indirect-args-20261019-1629.json` 后缀保留。缓冲验证新增精确失败差集，要求仅恢复上述 4 个作业；裁剪验证继续使用各历史基线，避免将先前排除项计为本轮修复。汇总检查把纹理基线中消失的其他旧失败区分为 48 个历史排除项及本轮 4 个 GPU 验证修复项。配置比较中的 SM5 4,395 作业是原有完整扫描基线，当前 SM5 4,025 作业只进行首错检查。

GPU 验证入口为 `tests/web-platform/verify-web-buffer-cook.cjs`，读取当前真实 ES3.1 Cook 产物，需要本机 Playwright 依赖。其通过代表 Shader 和浏览器 WebGPU 间接派发通过，**尚未验证 Engine RHI 的间接调度、ShaderMap 加载或场景**；原有 LargeBuffer 512 线程组仍由测试设备显式申请，Engine 设备限制协商待接入。

**当前剩余：56 个转换失败仍阻止完整 Global Shader 库生成，真实 WebGPU 场景仍为 0 帧。** 主要包括点光源阴影、移动曝光、排序、SMAA 及其他后处理/可选路径。点光源与普通阴影共用文件，后续按具体入口核对编译和消费者，避免整文件排除普通阴影；不用的功能不扩展移植。随后仍需统一实际 Cook/运行配置、生成并加载完整 Global 库，验证普通 Unlit 静态网格地图、相机、输入和 HTML UI。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false` 和材质主机参数结构边界保留。NullRHI 内容沿用有效的 324 文件、19,952,703 字节 Cook/Stage；本轮已重验浏览器循环。下文为历史检查点。

## 2026-10-19 第十五轮检查点

**2026-10-19 第十五轮，16:19：Web 局部雾、体积雾的编译条件与消费者同步关闭，独立转换失败 67→60。** 既有配置已将 `r.SupportLocalFogVolumes`、`r.VolumetricFog` 设为 0，但部分全局 Shader 没有读取这些开关。本轮以共享 Web 平台条件补齐限制，没有修复这些可选效果，也没有扩展 RHI 资源格式。

`WebShaderPlatform.h` 同时用于原生 Cook 文件策略和目标 Shader 的编译条件。局部雾的项目支持判断、场景准备判断、剔除及普通/移动/半分辨率绘制入口均限制 Web；`InitLocalFogVolumesForViews` 原有空资源初始化分支保留。体积雾的公共 `ShouldRenderVolumetricFog` 限制准备与计算，体素化的平台条件和体积雾灯光函数材质条件也同步限制。后两项材质条件已在 WASM 编译，尚未进行实际体积材质 Cook。

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过，安装版受检输入哈希未变；原生 Renderer 仍为安装版，由共享文件策略排除雾效 Shader |
| WASM 编译与链接 | RenderCore.3、Renderer.10（局部雾）、Renderer.37（体积雾、灯光函数及体素化）编译通过；补编既有保守深度实现所在 Renderer.4 后增量链接通过 |
| 首次链接问题 | 新编译对象调用已有五参数 `AddGenerateConservativeDepthBufferPass`，旧 Renderer.4 对象未提供该签名；保留失败记录，重编实现修复链接，没有修改保守深度算法 |
| ES3.1 完整作业校验，`20261019-161422` | Cook 退出 3；1,032 个独立作业：972 个转换通过、60 个失败；120 条失败诊断 |
| 精确范围对照 | 8 个全局类型共 28 个变体退出编译，恰好包含 7 个旧失败和 21 个旧转换成功作业；其余 1,502 个类型、16 项设置不变，无新增失败 |
| 旧成功排除项 | 21 个作业均核验裁剪前真实 input/SPIR-V/WGSL 产物，排除不计为修复 |
| 保留路径 | 50 个 HZB 作业、单采样深度复制和独立颜色解析均本轮重新转换；既有 MSAA、胶囊等限制保持生效，相关编译对象哈希与链接输入匹配 |
| GPU 数据回归 | Chrome/Edge 各执行 22 项缓冲计算、核对 18,002 个值；各执行 6 项纹理更新、核对 11,063 个值，并通过 4 个旧读写纹理产物拒绝检查；GPU 错误为 0 |
| 色调映射回归 | 96 个已修复作业全部本轮重新转换，两浏览器各验证 96 个模块通过；该文件当前转换失败仍为 0 |
| SM5 首错检查，`20261019-161748` | 4,025 个待编译变体，首错 FWriteToSliceGS 的 SPIR-V `Layer` builtin，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

本轮前报告使用 `-before-fog-policy-20261019-1611.json` 后缀保留；首次链接失败单独保留为 `web-engine-webgpu-link-results-fog-depth-missing-20261019-1616.json`。验证脚本核验本轮三个编译对象、补编的保守深度对象及最终链接输入，避免只记录最终补编动作而遗漏前面的编译证据；保守深度源码与安装版副本哈希一致。汇总检查将纹理基线中缺席的其他旧失败精确对应 12 个 HZB、12 个胶囊、17 个 MSAA/子通道和本轮 7 个雾效排除项。

**当前剩余：60 个转换失败仍阻止 Global Shader 库生成，真实 WebGPU 场景仍为 0 帧。** 后续核对阴影投影、剩余缓冲声明和后处理的实际消费者，必要路径才修复，不为可选功能扩展移植范围；随后统一 Cook/运行配置，加载真实库并验证普通 Unlit 静态网格地图、相机及 HTML UI。局部雾空资源在真实 WebGPU 场景中的初始化和消费者未执行验证，不能计为运行通过。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构和 512 线程组设备协商边界保留。NullRHI 内容继续沿用有效的 324 文件、19,952,703 字节 Cook/Stage，浏览器运行已重验。下文为历史检查点。

## 2026-10-19 第十四轮检查点

**2026-10-19 第十四轮，16:06：Web 未启用的 MSAA/resolve 编译条件与运行入口同步限制，独立转换失败 84→67。** Web 的 SM5、ES3.1 配置原本均声明不支持 MSAA，RHI 也已拒绝多重采样。本轮只排除对应作业，没有增加 MSAA 能力或放宽绑定校验；保留单采样深度复制、独立颜色解析和普通色调映射。

`WebShaderPlatform.h` 的共享条件用于深度/颜色 MSAA resolve、深度复制变体和移动端解析。`SUBPASS_MSAA_SAMPLES=1` 仍使用子通道附件，因此 Web 只保留 `0` 的独立颜色纹理路径，不能按单采样纹理处理子通道。四个运行入口在选择 Shader 前拒绝不支持的输入：`AddViewDepthCopyPSPass`、`AddResolveSceneColorPass`、`AddResolveSceneDepthPass`、`RenderMobileCustomResolve`。原生 Cook 的 Renderer 仍为安装版，通过其自身导出的具名变体信息识别采样维度，不硬编码变体 ID；缺少维度时明确报错。目标源码直接读取实际变体域。

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过；新增覆盖 ResolveShader.cpp；安装版受检输入哈希未变 |
| WASM 构建 | RenderCore.3、Renderer.2（深度复制）、Renderer.7（HDR resolve）、Renderer.22（色调映射）、Renderer.28（场景 resolve）重编及增量链接通过 |
| ES3.1 完整作业校验，`20261019-160016` | Cook 退出 3；1,060 个独立作业：993 个转换通过、67 个失败；134 条失败诊断 |
| 精确范围对照 | 13 个类型少 18 个变体，恰好包含 17 个旧失败和 1 个未使用的 HDR resolve 顶点作业；其余 1,497 个类型、16 项设置不变，无新增失败 |
| 保留路径 | 单采样 FCopyDepthPS、独立 FMobileCustomResolvePS 均本轮重新转换；反射确认普通二维单采样纹理、无子通道附件；普通 FTonemapPS 100 个、FTonemapVS 1 个及 FResolveVS 1 个变体数量不变 |
| HZB 和既有裁剪 | 50 个保留 HZB 作业全部本轮重新转换；此前胶囊、R64、调试、GPUScene 等排除项保持生效；胶囊准备/调度沿用哈希有效的上轮编译对象 |
| GPU 数据回归 | Chrome/Edge 各执行 22 项缓冲计算、核对 18,002 个值；各执行 6 项纹理更新、核对 11,063 个值，并通过 4 个旧读写纹理产物拒绝检查；GPU 错误为 0 |
| 色调映射回归 | 96 个已修复作业全部本轮重新转换，两浏览器各验证 96 个模块通过；该文件当前转换失败为 0 |
| SM5 首错检查，`20261019-160444` | 4,117 个待编译变体，首错 FDeferredLightPS/1 的 switch fallthrough，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

裁剪前报告使用 `-before-msaa-policy-20261019-1557.json` 后缀保留。`verify-web-minimal-shader-policy.cjs` 核验精确变化、保留的两种单采样产物、历史裁剪证据、实际加载的原生模块和五个 WASM 单元；汇总检查要求纹理基线中消失的其他旧失败精确对应 12 个 HZB、12 个胶囊和本轮 17 个 MSAA/子通道排除项。排除作业不计为修复。单采样深度与颜色解析本轮仅验证转换及入口编译，**尚未验证其 GPU 绘制或实际场景调用**。

**当前剩余：67 个转换失败仍阻止 Global Shader 库生成，真实 WebGPU 场景仍为 0 帧。** 剩余错误分布在阴影投影、缓冲声明、部分后处理，以及雾、排序等可选路径。下一步仍先核对最小场景是否需要对应消费者，关闭不用功能时同步编译条件与运行入口，必要路径才修复；之后统一 Cook/运行配置、加载真实库并验证普通 Unlit 静态网格地图、相机与 HTML UI。当前目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构及 512 线程组设备协商边界仍保留。NullRHI 内容沿用有效的 324 文件、19,952,703 字节 Cook/Stage，浏览器运行已重验。下文为历史检查点。

## 2026-10-19 第十三轮检查点

**2026-10-19 第十三轮，15:42：Web 胶囊阴影的编译与准备/调度条件同步关闭，独立转换失败 96→84。** 胶囊阴影用于角色胶囊投影，本轮没有关闭普通静态网格阴影，也没有新增 RHI 格式或修复可选的胶囊计算 Shader。`WebShaderPlatform.h` 提供统一条件；四个目标 Shader 类型的编译条件和 `IsCapsuleShadowsEnabled` 使用该条件，后者同时约束直接/间接阴影、可移动天空光、距离场 inset 准备及 ShadowSetup 中的胶囊投影选择。

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过，安装版受检输入哈希未变；原生 Renderer 仍为安装版，由共享 RenderCore 排除对应 Shader 文件 |
| WASM 构建 | RenderCore.3、Renderer.1（胶囊调度）、Renderer.31（ShadowSetup 准备）重编和增量链接通过 |
| ES3.1 完整作业校验，`20261019-153750` | Cook 退出 3；1,078 个独立作业：994 个转换通过、84 个失败；168 条失败诊断 |
| 精确范围对照 | 胶囊计算/上采样像素/上采样顶点三个类型合计 20 个变体退出编译，恰好包含 12 个旧失败和 8 个旧转换成功作业；其余 1,507 个类型及 16 项设置不变，无新增失败 |
| 间接光方向计算类型 | ES3.1 上本来就没有可编译变体；目标源码也补上同一平台限制，防止 SM5 选择该类型 |
| HZB 回归 | 48 个保留计算变体和 2 个像素变体全部本轮重新转换；既有 12 个 R64 排除项保持生效 |
| 缓冲及纹理 GPU 回归 | Chrome/Edge 各执行 22 项缓冲计算、核对 18,002 个值；各执行 6 项纹理更新、核对 11,063 个值，及 4 个旧读写纹理拒绝检查；GPU 错误均为 0 |
| 色调映射回归 | 96 个已修复作业全部本轮重新转换；Chrome/Edge 各验证 96 个模块通过 |
| SM5 首错检查，`20261019-154123` | 4,131 个待编译变体；首错仍为 DeferredLight 的 SPIR-V switch fallthrough，退出 3；Stage 正确拒绝失败 Cook |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧、0 页面错误；WebGPU 均创建设备并初始化前置资源，仍缺 Global 库、0 帧 |
| 汇总核验 | `evidenceVerified=true`；整体 `pass=false` |

`verify-web-minimal-shader-policy.cjs` 对照本轮前快照验证精确裁剪，并继续核验全部 50 个保留 HZB 产物。汇总检查将纹理更新基线中消失的其他旧失败精确对应既有 12 个 HZB 和本轮 12 个胶囊排除项，避免把裁剪计为修复。原始报告使用 `-before-capsule-policy-20261019-1535.json` 后缀保留。运行入口和准备入口已编译链接，**实际场景中的胶囊准备/调度尚未执行验证**；原生 Cook 的 Renderer 没有重建。

**当前剩余：84 个转换失败仍阻止完整 Global 库生成，真实 WebGPU 场景仍为 0 帧。** 本轮同时确认部分深度复制失败产物是多重采样纹理，而 Web 两套配置均已声明不支持 MSAA；尚未修改绑定反射或该路径。下一步核对 MSAA/resolve 的编译条件与消费入口，保留普通单采样深度路径，不放宽资源绑定校验；随后处理剩余必要路径，统一 Cook/运行配置，加载真实库并验证普通 Unlit 静态网格地图、相机及 HTML UI。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构和 512 线程组设备协商边界保留。下文为历史检查点。

## 2026-10-19 第十二轮检查点

**2026-10-19 第十二轮，15:21：Web HZB 的 12 个 R64 可见性纹理变体退出编译，独立转换失败 108→96。** 普通深度归约保留；没有实现 64 位纹理或扩展 RHI 格式。移动端和普通渲染器的 HZB 输入为普通深度，R64 可见性输入来自已禁用的 Nanite 路径。目标源码同时限制 Shader 编译条件，并在 `BuildHZB` 入口明确拒绝 Web R64 输入，避免继续查找未打包变体。

原生 Cook 仍加载安装版 Renderer 5.8.0；共享 RenderCore 临时通过该 Shader 自身导出的具名变体信息识别 `VIS_BUFFER_FORMAT (3)`，没有复制变体 ID 编码。此桥接依赖该具名格式，缺少维度信息时直接报错，不将未知情况计为成功。目标 Renderer 的编译条件直接读取实际变体域。

| 本轮检查 | 实测结果 |
| --- | --- |
| 原生构建 | 隔离 RenderCore 8 项动作通过；安装版受检输入哈希未变 |
| WASM 构建 | RenderCore.3、Renderer.28、Renderer.33 三个单元重编及增量链接通过 |
| 链接失败留档 | 首次因旧对象缺少 `FGlintShadingLUTsStateData::GetParameters` 失败；补编已有实现所在 Renderer.33 后通过，未修改 Glint 逻辑 |
| ES3.1 完整作业校验，`20261019-151445` | Cook 退出 3；1,098 个独立作业，1,002 个转换通过、96 个失败；192 条失败诊断 |
| 裁剪范围 | 仅 FHZBBuildCS 从 60 减至 48 个变体；其余 1,509 个注册类型和 16 项设置不变 |
| HZB 保留路径 | 48 个计算变体、2 个像素变体全部本轮重新转换；恰好排除 12 个旧 R64 失败，无新增失败 |
| 已有 Shader 回归 | Chrome/Edge 各执行 22 项缓冲计算、核对 18,002 个值；各执行 6 项纹理更新、核对 11,063 个值，并通过 4 个旧读写纹理拒绝检查；均无 GPU 错误 |
| 色调映射回归 | 96 个已修复作业全部本轮重新转换；Chrome/Edge 各验证 96 个模块通过 |
| SM5 首错检查，`20261019-151855` | 4,152 个待编译变体；本次首错为 DeferredLight 的 SPIR-V switch fallthrough，退出 3；失败 Cook 仍被 Stage 拒绝 |
| 浏览器 Engine | NullRHI 两浏览器各 10 帧；WebGPU 均创建设备并初始化前置资源，仍缺 Global Shader 库、0 帧 |
| 证据核验 | `evidenceVerified=true`；整体 `pass=false` |

`verify-web-minimal-shader-policy.cjs` 验证精确裁剪范围、50 个保留 HZB 产物、原生模块加载和 WASM 构建。纹理更新回归现在独立约束其自身编译范围；其他消失的旧失败必须由汇总检查精确对应本轮 12 个 HZB 排除项。首次链接失败报告保留为 `web-engine-webgpu-link-results-hzb-glint-missing-20261019-1517.json`，裁剪前报告使用 `-before-hzb-policy-20261019-1512.json` 后缀。

**当前剩余：96 个转换失败仍阻止完整 Global 库生成，真实 WebGPU 场景仍为 0 帧。** 下一步继续核对胶囊阴影等可选功能的编译条件和运行入口，并处理必要的深度/resolve 资源绑定；随后统一 Cook/运行配置，加载真实库，验证普通 Unlit 静态网格地图、相机与 HTML UI。HZB 本轮仅验证编译转换和入口编译，未执行 GPU 深度归约或场景调用。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构不匹配和既有 512 线程组设备协商边界保留。下文为历史检查点。

## 2026-10-19 第十一轮检查点

**2026-10-19 第十一轮，15:05：6 个纹理更新/缓冲拷贝 Shader 已修复并通过真实 GPU 数据验证，独立转换失败 114→108。** `UpdateTextureShaders.usf` 仅在 Web 分支改用 storage buffer 声明，并将只写的二维、三维目标纹理标记为 SPIR-V `NonReadable`。线程组、参数、源/目标索引和非 Web 路径不变；没有增加 Engine RHI 的纹理或视图格式，也没有新增功能裁剪。

第一轮仅替换缓冲声明时，6 个作业已转换成功，但浏览器只有两个缓冲拷贝通过，四个纹理管线因 `read_write` storage texture 访问失败。该失败已保留为 `web-texture-update-cook-regression-results-texture-readwrite-20261019-1500.json`，不能计为 GPU 执行通过。局部补上真实只写语义并重新 Cook 后，四个纹理管线及数据验证通过；同一验证还实际加载四份旧产物，确认它们继续被浏览器拒绝。

| 本轮检查 | 实测结果 |
| --- | --- |
| 最终 ES3.1 完整作业校验，`20261019-150026` | Cook 退出 3；1,110 个独立作业中，1,002 个转换通过、108 个失败；216 条失败诊断 |
| 范围和失败对照 | 1,510 个注册类型、1,110 个变体及 16 项设置与上轮完全一致；恰好修复 6 个旧失败，无新增失败 |
| 新增直接 GPU 检查 | Chrome/Edge 各执行 6 个 Shader、核对 11,063 个值，0 GPU 错误；每浏览器另有 4 个旧产物拒绝检查通过 |
| 数据覆盖 | 两种每线程拷贝量；float/int/uint 二维子区域；带行距及切片距的 signed 三维更新；源/目标偏移、区域外哨兵和源缓冲保持不变 |
| 缓冲/色调映射回归 | 22 个旧缓冲修复和 96 个色调映射修复均本轮重新转换；两浏览器各执行 22 项/18,002 值及创建 96 个模块，均 0 错误 |
| SM5 首错复跑，`20261019-150335` | 4,164 个可编译变体，退出 3；此次首错为 `FWriteToSliceGS` 的 `Layer` builtin；Stage 拒绝失败 Cook |
| 浏览器 Engine 回归 | Chrome/Edge NullRHI 各 10 帧、0 页面错误，最小配置读回通过；WebGPU 设备及预初始化资源通过，缺 Global 库、0 帧 |

`prepare-web-cook-shaders.cjs` 严格核对五个 Shader 补丁与独立副本，所有安装版 Shader 输入哈希不变。新 `verify-web-texture-update-cook.cjs` 对照真实旧失败、全部实际作业、反射与读回数据；`verify-web-minimal-shader-policy.cjs` 对未再失败的保留作业要求匹配这 6 项已验证修复，不能将作业缺席解释为成功。最终交叉核验 `evidenceVerified=true`，整体 `pass=false`。

本轮没有修改 C++，原生 RenderCore 和 WASM 沿用哈希仍匹配的上轮产物，没有宣称重新构建。NullRHI 内容同样沿用 324 文件、19,952,703 字节的有效 Cook/Stage，浏览器运行已重验。71 个基础 Shader/Worker 样本证据仍有效，但本轮未重跑样本或无改动的共享 RHI 功能测试。直接执行这些 Cook Shader 仍不代表 Engine RHI 调度、Shader map 加载或场景绘制已验证；三维 Shader 的这项检查不代表新增三维场景功能。

**当前剩余：108 个转换失败仍阻止完整 Global 库生成。下一步继续核对 HZB 64 位可见性缓冲变体及阴影、雾、后处理的最小消费者；保留必要路径，关闭未使用路径时同步运行入口。之后统一实际 Cook/运行配置，加载真实库，验证硬件 Tick、普通 Unlit 静态网格地图、相机与 HTML UI。** HZB 本轮只完成源码核对，没有添加变体过滤；其 12 个失败仍在。目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、`fullNormalUBTBuildVerified=false`、材质主机参数结构不匹配及此前 512 线程组设备协商边界保留。

最终补丁复现入口：

```powershell
& .\tests\web-platform\cook-web-engine.ps1 -Mode WebGPU-ES31 -ValidateShaderJobCache -SkipBuild
# 当前完整 Cook 仍预期退出 3；以下脚本需本机 Playwright 和保留的旧失败证据。
node .\tests\web-platform\verify-web-texture-update-cook.cjs
node .\tests\web-platform\verify-web-buffer-cook.cjs
node .\tests\web-platform\verify-web-tonemap-cook.cjs
node .\tests\web-platform\verify-web-minimal-shader-policy.cjs
node .\tests\web-platform\verify-web-shader-cook-regression.cjs
```

以下为历史检查点。

## 2026-10-19 第十轮检查点

**2026-10-19 第十轮，14:50：Web GPU 崩溃测试和 ShaderPrint 已同步关闭编译与运行入口，独立转换失败由 131 降至 114。** 本轮只处理两组调试功能，没有扩展可选渲染能力。`WebShaderPlatform.h` 为原生 Cook 和 WASM 提供相同条件；`FShaderType` 的编译/预缓存入口排除三个对应 Shader 文件，GPU 崩溃测试自身的编译条件和调度入口也使用该条件，跳过时清除崩溃请求。

`ShaderPrint::IsSupported()` 限制参数上传及各类型编译，创建数据时将 Web 的计数清零并保留原有空绑定，绘制入口同时跳过普通及外部提交的调试数据。仅设置 `r.ShaderPrint=0` 不够：原 `BeginView()` 即使关闭显示仍可能上传参数，所以这里没有只改配置或只过滤失败列表。UMG/Slate 依赖保留。

| 本轮检查 | 实测结果 |
| --- | --- |
| ES3.1 完整作业校验，`20261019-144232` | Cook 退出 3；1,110 个独立作业：996 个转换通过、114 个失败；228 条失败诊断 |
| 精确范围对照 | 1,510 个注册类型中仅 14 个调试类型改变，排除 22 个变体；其余 1,496 个类型变体数及 16 项设置不变 |
| 失败集合对照 | 恰好排除 17 个旧调试失败；其余旧失败均有本轮记录，无新增失败；这是关闭功能，不是修复 17 个转换错误 |
| 原生 / WASM | RenderCore 8 个构建动作通过；WASM 的 RenderCore.1、RenderCore.3、Renderer.30 三个单元重编译及增量链接通过 |
| 缓冲 Shader 回归 | 22 个旧修复全部本轮重新转换；Chrome/Edge 各执行 22 项、核对 18,002 个值、0 GPU 错误 |
| 色调映射回归 | 96 个旧修复全部本轮重新转换；Chrome/Edge 各创建 96 个模块、0 错误；另 4 个输入附件变体仍失败 |
| SM5 首错复跑，`20261019-144707` | 4,164 个可编译变体，退出 3；`TCopyDataCS<2>` 纹理更新的 `SampledBuffer`；Stage 拒绝失败 Cook |
| 浏览器 Engine 回归 | Chrome/Edge NullRHI 各 10 帧、0 页面错误，最小配置读回通过；WebGPU 设备及预初始化资源通过，缺 Global 库、0 帧 |

NullRHI 内容沿用哈希仍匹配的 324 文件、19,952,703 字节 Cook/Stage，本轮未重新 Cook 这批未变资源；浏览器执行的是本轮新链接的 WASM。71 个基础 Shader/Worker 样本证据仍有效，本轮未重跑样本或无改动的共享 RHI 功能测试。安装版 DLL、Shader.cpp、RenderUtils.cpp、GPUDebugCrashUtils.cpp、Build.version 输入哈希不变。

原生 Cook 使用重新构建的 RenderCore，其他原生模块仍为安装版 5.8.0。原生 Renderer 的 ShaderPrint 函数并未重建，实际编译范围由共享 RenderCore 入口限制；对应运行入口补丁已在 WASM 编译。本轮没有在真实场景执行调试渲染入口，`runtimePassSelectionVerified=false`。缓冲计算仍为直接 WebGPU 验证，未证明 Engine RHI 调度；512 线程组的 Engine 设备协商仍待接入。当前 `evidenceVerified=true`，整体 `pass=false`，`fullNormalUBTBuildVerified=false`；目标 5.8.3/原生 5.8.0 混合、ES3.1 仅 Cook/浏览器仍 SM5、材质主机参数结构不匹配等边界保留。

**剩余主线：先核对 HZB 的 64 位可见性缓冲变体及必要纹理更新/解析绑定，再同步最小功能条件，统一实际 Cook/运行配置，生成并加载完整 Global 库，验证硬件 Tick 和普通 Unlit 静态网格地图，最后接相机输入与 HTML UI。** 本轮 12 个 HZB 失败的变体号均对应 `VIS_BUFFER_FORMAT=3`，源文件该分支使用 64 位纹理；普通深度归约没有因此删除。阴影、雾、OIT 等其余功能仍逐一按消费者判定，不预设补齐。

复现入口：

```powershell
& .\tests\web-platform\build-native-rendercore.ps1
& .\tests\web-platform\cook-web-engine.ps1 -Mode WebGPU-ES31 -ValidateShaderJobCache -SkipBuild
# 当前完整 Cook 预期退出 3；WASM 需按本轮三个响应文件重编译并链接后再交叉核验。
node .\tests\web-platform\verify-web-minimal-shader-policy.cjs
node .\tests\web-platform\verify-web-buffer-cook.cjs
node .\tests\web-platform\verify-web-tonemap-cook.cjs
node .\tests\web-platform\verify-web-shader-cook-regression.cjs
```

以下为历史检查点。

## 2026-10-19 第九轮检查点

**2026-10-19 第九轮，14:33：已修复并实际执行此前失败的 22 个缓冲清理/拷贝 Shader，完整 Global Shader Cook 仍未通过。** `ClearReplacementShaders.usf`、`ByteBuffer.usf`、`CopyUIntBuffer.usf` 仅在 `COMPILER_WEBGPU` 下将相关 `Buffer/RWBuffer` 声明改为 storage buffer 可表达的 `StructuredBuffer/RWStructuredBuffer`。参数名、索引算法和原有 64/512 线程组均保留；其他平台继续原声明。没有新增 RHI 视图格式、数组纹理、材质层等功能。

`prepare-web-cook-shaders.cjs` 对四个目标 Shader（含此前 Tonemap）逐个验证与安装版仅相差声明的 Web 分支，再复制到独立 Cook Shader 目录；所有安装版 Shader 输入哈希不变。首轮普通缓存 Cook 只捕获 14 个新产物，不能将其他作业缺席当作重新编译。新增诊断开关 `-ValidateShaderJobCache`，使用引擎自带 `r.ShaderCompiler.DebugValidateJobCache=1` 完整执行并校验作业后，22 个旧失败均有本轮真实 SPIR-V/WGSL 产物。

| 本轮检查 | 实测结果 |
| --- | --- |
| ES3.1 完整作业校验，`20261019-142543` | Cook 退出 3；1,132 个独立作业中，1,001 个转换通过、131 个失败；失败诊断 262 条 |
| Shader 范围 | 1,510 个注册类型、1,132 个可编译变体及 16 项设置与上轮完全一致，本轮没有新增裁剪 |
| 缓冲转换修复 | 清理 15、ByteBuffer 填充/复制/Scatter 6、分段 uint 拷贝 1，共 22 个旧失败全部重编译通过 |
| Chrome / Edge GPU 计算 | 各 22 项、18,002 个值，均通过，GPU 错误 0；检查偏移、边界外哨兵、非整线程组长度和分段目标 |
| 色调映射回归 | 此前 96 个 `FTonemapPS` 全部本轮重新转换，两浏览器各创建 96 个模块、0 错误；同文件另 4 个输入附件变体仍失败 |
| SM5 首错复跑，`20261019-142913` | 退出 3；4,186 个可编译变体；此次首错为纹理子资源更新的 `SampledBuffer` |
| NullRHI Cook / Stage / 浏览器 | 324 文件、19,952,703 字节；Chrome/Edge 各 10 帧、0 错误，最小配置读回通过 |
| WebGPU Engine / Stage | 两浏览器设备及预初始化资源通过，缺 Global Shader 库、0 帧；Stage 拒绝失败 SM5 Cook |

上轮 150 个独立失败中，恰好上述 22 个不再失败；全量校验另记录 3 个此前未记录的胶囊阴影/点光源阴影失败，因此当前总数为 131。没有把净差 19 当成修复数量。基础 Shader/Worker 71 样本证据核验仍有效，本轮未改动编译器 C++ 或重跑其样本，也未重跑无改动的共享 RHI 功能测试。材质主机参数结构不匹配仍未解决。

新增 `verify-web-buffer-cook.cjs` 直接执行真实 ES3.1 Cook 的 22 份计算产物，**不是通过 Engine RHI 调度、Shader map 加载或场景运行**。测试设备显式申请 512 个 compute invocations 以保留 LargeBuffer 原线程组；当前 Engine 设备创建仍使用默认限制，后续需要协商该限制或做一致的调度适配。Shader 的 float/sint 变体通过上述计算检查不代表 RHI 新增了对应 typed view 支持，原后端的拒绝边界保持不变。

本轮只修改 Shader 与验证/准备脚本，沿用哈希仍匹配的原生模块和 WASM 产物；未声称重新构建引擎。一次浏览器复跑因本地 8765 服务退出而连接失败，已单独保留 `web-engine-webgpu-results-server-unavailable-20261019-1431.json`；恢复隐藏后台服务后复跑得到表中结果。当前证据交叉核验通过，`evidenceVerified=true`，整体 `pass=false`。

**下一步仍以最小场景为边界：核对 HZB、阴影、调试与后处理的必要消费者，处理保留路径的绑定/转换问题；统一实际 Cook 与运行端配置，生成真实 Global 库后验证硬件 Tick、普通 Unlit 静态网格地图、相机和 HTML UI。** 原生 5.8.0/目标 5.8.3 混合、ES3.1 仅 Cook、浏览器 Engine 仍 SM5、`fullNormalUBTBuildVerified=false` 等边界保留。以下为历史检查点。

## 2026-10-19 第八轮检查点

**2026-10-19 第八轮，14:10：GPUScene 和骨骼场景扩展已按最小静态网格范围关闭，并完成原生 Cook、WASM 编译及浏览器设置读回验证；完整 Shader Cook 仍未通过。** `UseGPUScene()` 的移动分支此前读取主机开关，没有采用 Web 声明的不支持 GPUScene 能力；现在两个重载共用 `WebShaderPlatform.h` 的平台条件。`IsGPUSkinSceneExtensionEnabled()` 同样加平台条件，对应六个骨骼场景 Shader 文件不参与 Web 编译。普通静态网格保留原有非 GPUScene 绘制路径，没有增加骨骼、实例化或其他可选渲染功能。

Cook 与运行端的 Web 配置均关闭 `r.Mobile.SupportGPUScene`、`r.GPUSkin.UseSceneExtension`。实际 Cook 清单确认 `gpuSceneEnabled=false`，16 项配置的主机/目标值一致。原生 RenderCore 重编译、链接及 Cook 实际加载通过；原生 Engine 仍使用安装版，通过配置关闭骨骼扩展。WASM 重编译五个编译单元并增量链接通过，包含新的 RenderUtils、骨骼扩展条件及启动读回。安装版 DLL、RenderUtils.cpp、Shader.cpp、Build.version 哈希核对不变。

| 本轮检查 | 实测结果 |
| --- | --- |
| ES3.1 完整 Cook，`20261019-140014` | 退出 3；1,132 个可编译变体；150 个独立失败、280 条诊断 |
| 精确范围对照 | 1,510 个注册类型中仅 11 个的变体数改变，其他 1,499 个保持一致 |
| 本轮排除范围 | 实例裁剪 49、GPUScene 2、骨骼场景扩展 20，共 71 个变体；相关实际转换作业为 0 |
| 原生 / WASM | RenderCore 重新构建通过；五个 WASM 编译单元及增量链接通过 |
| SM5 首错复跑，`20261019-140339` | 退出 3；4,186 个可编译变体；此次首错为 `FGPUMorphUpdateCS` 的 `SampledBuffer` |
| NullRHI Cook / Stage / 浏览器 | 324 文件、19,952,703 字节；Chrome/Edge 各 10 帧、0 错误 |
| 浏览器设置读回 | 两浏览器均为 GPUScene=false、骨骼场景扩展=false，两个设置值均为 0 |
| WebGPU 浏览器 / Stage | 设备与预初始化资源通过，仍缺 Global Shader 库、0 帧；Stage 拒绝失败的 SM5 Cook |
| 基础 Shader / Worker | 重跑 71 样本：55 转换/绑定、16 预期拒绝；Editor/Worker 字节码相等及两项版本负例通过 |

本轮排除的路径包含上轮 62 个独立失败作业；另外有 1 个旧失败未再记录、5 个新失败记录，受缓存及实际作业集合影响，**不能把 208→150 称为修复了 58 个转换错误**。色调映射的 96 个成功产物继续引用明确标注的历史证据，本轮未重编译或重跑其浏览器模块；同文件的 4 个 `FMobileCustomResolvePS` 输入附件变体仍失败。

`verify-web-minimal-shader-policy.cjs`、当前源码/主机/Cook/Stage/Worker/浏览器交叉核验通过；`evidenceVerified=true`、整体 `pass=false`。设置读回不代表实际创建场景扩展或执行渲染入口，`runtimePassSelectionVerified=false`。当前原生主机仍为重建 RenderCore 加安装版 5.8.0 模块，目标分支为 5.8.3；ES3.1 仍仅用于 Cook，浏览器继续 SM5，`fullNormalUBTBuildVerified=false`。本轮未重跑无改动的共享 RHI 功能测试，材质主机参数结构不匹配仍未解决。

**剩余主线：处理最小场景必需的缓冲清理/拷贝及绑定转换问题，核对其余后处理消费者；统一实际 Cook 与运行端配置，生成并加载真实 Global 库，再验证硬件 Tick、普通 Unlit 静态网格地图、相机输入和 HTML UI。** 当前 150 个失败仍包含缓冲清理 15、HZB 12、阴影绑定和输入附件等，不预设全部需要补实现。以下为历史检查点。

## 2026-10-19 第七轮检查点

**2026-10-19 第七轮，13:47：原生 Cook 与 WASM 已接入同一份最小 Shader 条件，实测排除 LightGrid、MobileFog 的 334 个变体；完整 Shader Cook 仍未通过。** 新增 `RenderCore/Public/WebShaderPlatform.h`，按真实 `SF_WEBGPU_SM5` / `SF_WEBGPU_ES31` 格式识别目标，在 `FShaderType::ShouldCompilePermutation` 与 `ShouldPrecachePermutation` 统一排除两个明确的功能源码。其他平台继续原条件；没有修改 Shader 成功判定或库完整性检查。

原生侧使用独立 `.tools/ue58-web-native-build-host`，从安装版源码重新构建 RenderCore，并覆盖目标 `Shader.cpp` 和共享头。这三个既有 C++ 文件在改动前与安装版仅换行不同；其他原生模块仍为安装版二进制，**不是完整 5.8.3 同源构建**。新增 `native-ubt` 仅在显式 `UE_WEB_NATIVE_RENDERCORE=1` 时取消 RenderCore 的预编译标记；构建脚本导出并检查输出路径，8 个修改后构建动作通过，安装版 DLL、Shader.cpp、Build.version 哈希保持不变。Cook 主机替换 DLL 时先解除旧硬链接，再复制独立文件，没有覆盖安装目录或原样本主机。

WASM 侧同步三个相关编译单元并增量链接通过。`PrepareForwardLightData` 对目标平台走引擎已有空灯光 Uniform 路径，`RenderFog` 提前返回，避免运行端索取已排除的 Shader。LightGrid 反馈只由上述计算链调用，可视化受编辑器条件限制。**这些运行入口及空资源尚未在场景中执行验证**；默认空数据仍包含 ByteAddress 等资源，后续若实际阻塞应局部处理，不据此提前扩展 RHI。

| 本轮检查 | 实测结果 |
| --- | --- |
| ES3.1 完整 Cook，`20261019-133946` | 退出 3；1,203 个可编译变体；208 个独立失败、388 条诊断 |
| 精确范围对照 | 注册类型仍为 1,510；只有两个文件的 6 个类型受策略约束，其他 1,504 个类型的变体数逐一一致 |
| 排除效果 | LightGrid 129、MobileFog 205，共 334 变体；两组实际转换作业均为 0 |
| 原生模块 / WASM | RenderCore 编译、链接、实际 Cook 加载通过；WASM 三个编译单元、增量链接通过 |
| SM5 首错复跑，`20261019-134158` | 退出 3；4,206 个可编译变体；此次首错为 `TCopyDataCS<2>` 的 `SampledBuffer` |
| NullRHI Cook / Stage / 浏览器 | 324 文件、19,952,703 字节；Chrome/Edge 各 10 帧、0 错误 |
| WebGPU 浏览器 | 两浏览器设备及预初始化资源通过；仍缺 Global Shader 库、0 帧 |

`verify-web-minimal-shader-policy.cjs` 按旧清单逐类型核验范围、原生 DLL 来源、实际作业和 WASM 编译产物，`nativeCookPolicyVerified=true`、`wasmPolicyCompileLinkVerified=true`，而 `runtimePassSelectionVerified=false`。上轮 374 个独立失败中有 164 个属于此次排除的两组；其余缺席/新增记录还受缓存和作业集合影响，不能把 374→208 的全部差值当作修复。

上轮修复的 96 个 `FTonemapPS` 本轮未重编译，保留历史批次的 SPIR-V/WGSL 与不变 Shader 输入哈希，并在两浏览器重新创建这 96 个模块、0 错误。核验报告明确 `currentRecompiledRecoveredJobs=0`、`historicalRecoveredJobs=96`。同一文件的另外 4 个 `FMobileCustomResolvePS` 输入附件变体仍失败，与此前无限常量修复分开记录。基础 Shader/Worker 的 71 样本证据仍有效，本轮未重跑无修改的共享 RHI 功能测试；材质主机参数不匹配仍未解决。

当前剩余失败包括 InstanceCulling（41 个独立作业）、缓冲清理（15）、骨骼动画变换（13）、HZB（12）及其他绑定/输入附件问题。**下一步继续按最小静态网格消费者核对实例裁剪、骨骼和后处理条件；仅修复实际必需的 Shader，生成真实 Global 库后验证 WASM 加载、硬件 Tick 和地图。** 相机输入、HTML UI、普通完整 UBT 仍待验收。ES3.1 仍仅用于 Cook 试验，浏览器仍为 SM5；`fullNormalUBTBuildVerified=false`。当前交叉核验 `evidenceVerified=true`，整体 `pass=false`。以下为历史检查点。

## 2026-10-19 第六轮检查点

**2026-10-19 第六轮，12:25：已修复并实测此前失败的 96 个 ES3.1 色调映射像素 Shader，完整 Shader Cook 仍未通过。** 真实输入复现表明，`PostProcessTonemap.usf` 使用 `UniformGrainNP * POSITIVE_INFINITY` 再 clamp 求符号，生成的无限常量触发 Tint `std::isfinite` 断言。目标源码只增加 WebGPU 条件分支，以 `sign(UniformGrainNP)` 计算符号；其他平台保留原表达式，零噪声的抖动贡献为零。`WebGPUShaderFormat` 注入 `COMPILER_WEBGPU=1` 并将格式/DDC 版本升为 v9，避免复用旧结果。

原生 Cook 改用 `.tools/ue58-web-cook-shaders` 的 1,227 文件独立副本；准备脚本严格要求色调映射文件与安装版仅相差上述分支，拒绝覆盖链接文件。SM5、ES3.1 两个隔离主机均指向此副本，逐文件 SHA256 和安装版原 Shader 哈希已核验；未写入 `H:/UE_5.8` 的 Shader。这仍是安装版原生 Shader 副本加目标补丁，不代表原生主机已经与目标 5.8.3 全面同源。

| 本轮检查 | 实测结果 |
| --- | --- |
| ES3.1 完整 Cook，`20261019-121700` | 退出 3；1,537 个可编译变体；374 个独立失败、716 条诊断 |
| 色调映射真实作业 | 重编译 98 个像素变体；此前失败的 96 项全部生成 WGSL，无非有限 SPIR-V 常量，编译器绑定契约通过 |
| 浏览器 WGSL 模块验证 | Chrome 155.0.8059.84、Edge 155.0.4283.45 各 96 项、0 错误 |
| 基础 Shader / Worker | 71 样本、55 转换/绑定、16 预期拒绝；Editor/Worker 字节码逐一相等，两项版本负例通过 |
| NullRHI Cook / Stage / 浏览器 | 324 文件、19,952,703 字节；两浏览器各 10 帧、0 错误 |
| SM5 首错复跑 / WebGPU Engine | 仍失败于几何 Shader 的 Layer；Stage 拒绝失败 Cook；硬件路径仍缺 Global Shader 库、0 帧 |

专用核验脚本 `verify-web-tonemap-cook.cjs` 按完整作业名与旧批次逐一匹配这 96 项，并在两个浏览器创建真实 WGSL 模块；**未验证这些 Shader 的渲染管线或画面**。本轮 374 与上轮 469 是各批次实际记录的失败数；除已逐项确认的 96 个色调映射作业外，其他缺席的失败不计作修复，也不将新增记录解释为代码回归。缓存和作业集合差异不能直接当作修复数量。

`verify-web-shader-cook-regression.cjs` 已核对当前 Shader 副本、模块、Cook/Stage、基础样本及浏览器证据，`evidenceVerified=true`、整体验收 `pass=false`。ES3.1 仍仅用于 Cook 试验，浏览器运行端仍 SM5；材质主机参数不匹配、普通完整 UBT 构建尚未解决，本轮未重跑无改动的原生 RHI 功能测试。

**剩余主线：将最小 Unlit 场景的 Shader 条件同步到同源原生 Cook 与运行端，排除未使用的默认路径，生成真实 Global shader map/代码库，再验证 WASM 加载、硬件 Tick 和静态网格地图。** 相机输入和 HTML UI 仍待接入。没有扩展数组纹理、材质层、雾或复杂光照功能。

## 2026-10-19 第五轮检查点

**2026-10-19 第五轮，11:49：ES3.1 / MobileForward Cook 对照和最小渲染配置已实跑，完整 Shader Cook 仍未通过。** 新增独立 `WebGPU-ES31` 模式、`.tools/ue58-web-es31-cook-host` 和 `cook-profiles/WebGPU-ES31.ini`，使用 `Web/46`；浏览器增量产物继续使用 `Web/47` SM5，没有将 ES3.1 Cook 试验误记为运行端切换。

原生模块实际加载 1,510 个全局 Shader 类型，按真实 `ShouldCompilePermutation` 条件枚举得到：

| 配置 | 可编译类型 | 可编译变体 |
| --- | ---: | ---: |
| 原 SM5 配置 | 724 | 4,395 |
| ES3.1 对照 | 505 | 1,693 |
| ES3.1 最小渲染配置 | 487 | 1,537 |

最小配置位于 `tests/ue-shader-host/Config/Web/WebEngine.ini`，关闭 HDR、Gen4 TAA、Framebuffer Fetch、局部光源、天空/局部雾支持、虚拟纹理和 Landscape GPU Culling 等当前场景不需要的路径。14 个关键设置的主机/目标读取值实测一致；相对 ES3.1 对照减少 156 个变体，相对原 SM5 减少 65.03%。这些是捕获时的可编译范围，不是成功数或实际独立作业数。未注册 Shader 白名单，没有伪造编译结果或取消完整性检查。

最终完整尝试 `web-engine-webgpu-es31-cook-20261019-114440.log` 退出 **3**，`minimalRendererSettingsVerified=true`，记录 **469 个独立转换失败、908 条失败诊断**。重复编译和成功缓存命中均不能当成新增 Shader；本轮原 ES3.1 对照按完整 Shader 标识去重为 535 个失败作业。当前主要组包括 LightGrid 的 IR 转换、Tonemap 的 Tint 非有限值断言、MobileFog/InstanceCulling/缓冲清理的 `SampledBuffer`、HZB 的 int64 image 扩展及部分绑定契约不匹配。**不能把全部失败都认定为可选功能**：下一步应核对最小场景消费者，排除未使用路径，保留并修复实际必需的 Shader。相同最小配置的 SM5 首错复跑仍失败于 `FWriteToSliceGS` 的 `Layer` builtin。

新增 `analyze-web-shader-cook.cjs` 保存清单对比、设置值、独立作业和重复诊断；历史基线单独保留。诊断设置曾出现“目标配置已加载、主机参数只应用首键”的问题，失败批次 `113338` 已保存；按每个命令行键提供完整节名后复跑。独立 Worker 的跨平台配置查询增加编译条件保护，Editor/Program 模块均重新构建通过；Worker 构建脚本现在核验并保留已有静态平台表。基础回归重新通过 **71 样本、55 转换/绑定契约、16 预期拒绝**，55 个 Editor/Worker 字节码逐一相等，两项 Worker 版本负例通过。材质回归未重跑，第四轮的原生参数结构不匹配仍未解决。

NullRHI Cook/Stage 已按当前输入刷新，为 **324 文件、19,952,703 字节**。与此前 330 文件相比，关闭虚拟纹理后不再产生六份 `_VT.ubulk`，不是漏挂载既有 Cook 产物。Chrome 155.0.8059.84、Edge 155.0.4283.45 均 **10 帧、0 错误**；两浏览器 WebGPU 均完成设备及预初始化资源，仍因缺 Global Shader 库为 **0 帧**。失败 SM5 Cook 继续被 Stage 拒绝。交叉核验 `verify-web-shader-cook-regression.cjs` 的 `evidenceVerified=true`，而任务验收 `pass=false`；当前源码、主机、Cook/Stage、基础样本、浏览器证据分别核对。

**剩余主线：统一原生 Cook 源码/二进制与运行端的最小 Shader 范围，生成真实 Shader map/代码库，再验证 WASM 加载、硬件 Tick 和普通 Unlit 静态网格地图。** 相机输入、HTML UI 和当前普通完整 UBT 构建仍待验收。没有增加数组纹理、材质层等功能，没有改动安装目录；混合 5.8.3/5.8.0 和 `fullNormalUBTBuildVerified=false` 边界保留。

## 2026-10-19 第四轮检查点

**2026-10-19 第四轮，11:12：真实 WebGPU Shader Cook 已进入标准全局 Shader 编译，但尚未完成。** 新增 `cook-web-engine.ps1 -Mode WebGPU-SM5 -StopOnShaderError`，使用独立 `.tools/ue58-web-cook-host`：静态平台表只注册 `SP_WEBGPU_SM5=47` 到 `Web`，复制目标分支 DDPI，实测属性哈希 `3221603855`；原生 `WebTargetPlatform`、`WebGPUShaderFormat` 模块实际编译通过。标准 CookCommandlet 在进程内执行 Vulkan 前端、SPIR-V、Tint/WGSL 转换，启用真实共享 Shader 代码库；没有替换全局 Shader 或关闭运行时完整性检查。

最终 Cook `web-engine-webgpu-cook-20261019-111111.log` 退出 **3**，`web-engine-webgpu-cook-results.json` 为 **pass=false**。本次首错为 `FSparseVolumeTextureUpdateFromSparseBufferCS` 的 `SampledBuffer` capability；上次 11:02 复跑先遇到 `FWriteToSliceGS` 的 `Layer` builtin，两者都已实际复现，异步编译的首错顺序可不同。转换器现在保存 Shader 名称、源码、入口、输入 SPIR-V、反射及 `failure.json`，可在首个真实错误后直接结束诊断进程。早先批次主动中止并保留；其中 65 个已记录失败归并为 6 组，涉及稀疏体积纹理、纹理更新、Morph、延迟光照、几何 Shader，具体为 `SampledBuffer`、switch fallthrough、`Layer` 三类转换限制，见 `web-engine-webgpu-cook-blockers-results.json`。这不是完整 Shader 清单，也不表示要实现这些可选功能。

独立 WebGPU Stage、项目 Content 到 `/Engine/Programs/UEWebEngine/Content/` 的映射及 `?cook=webgpu` 挂载分支已实现；**成功产物挂载尚未实测**。Stage 要求真实 Global shader map 和 `ShaderArchive-Global-SF_WEBGPU_SM5.ushaderbytecode`，实际拒绝了失败的 Cook，未生成可用 WebGPU 内容包。NullRHI 保持独立布局：仅复制 DDPI 的资源布局节，避免旧样本主机发生 Shader 注册串扰；收紧新增 `.bin` 规则后，Cook/Stage 恢复 **330 文件、23,633,819 字节**。Chrome/Edge 同一增量 Engine 各 **10 帧、0 页面错误**；WebGPU 均创建设备并完成预初始化资源，仍 **0 帧**，停在缺少 Global Shader 库。

ShaderFormat 的基础回归已完成：**71 个样本、55 个转换与绑定契约、16 个预期拒绝**，原生 Worker 正常批次、两种版本负例及 Editor/Worker 字节码一致性通过。一次回归因重建 Worker 后平台表恢复为原版而失败，重新应用并核验原有 46/47 注册后恢复。材质回归 **未通过**：旧原生主机在抵达样本前，即因 `GenerateConservativeDepth.usf` 的 `ConservativeDepthFillSize` 与二进制参数结构不一致而退出；D3D SM5 和 NullRHI/SM6 尝试均保留失败日志，不能沿用旧材质报告宣称本轮通过。

最终交叉审计见 `web-engine-shadercook-regression-results.json`：当前 Cook 源码/主机文件、隔离主机准备、NullRHI 内容和浏览器报告哈希均核对；基础样本使用旧 `WebGPU/47` 测试配置，不与实际 Cook 的 `Web/47` 配置混用。整体仍为 false，明确区分基础样本通过、材质回归失败和真实 Shader Cook 失败。

**下一步：统一原生 Cook 主机与 WASM 运行端的最小 Shader 编译范围及源码版本，然后重新 Cook、Stage 和硬件启动。** 当前安装版原生模块仍会编译 Web 目标不需要的桌面排列；应在共享编译条件和消费者边界排除实际不使用的路径，不通过伪造输出或忽略失败生成库。之后仍需验证 wasm64 Shader map 反序列化、视口、硬件 Tick、基础 Unlit 静态网格、地图和 HTML UI，并补普通完整 UBT 构建。`fullNormalUBTBuildVerified=false`、混合 5.8.3/5.8.0 边界继续保留；安装目录未修改，没有扩展数组纹理、材质层等功能。

## 2026-10-19 第三轮检查点

**2026-10-19 第三轮，10:35：Chrome/Edge 的完整 wasm64 Engine 增量诊断产物均已完成真实 WebGPU 设备、工厂选择及预初始化资源阶段。** `preRHIResourcesInitialized=true`，此前默认资源阻塞已越过；硬件路径仍 0 帧，当前明确停在 `FShaderCodeLibrary::InitForRuntime`，缺少 `../../../Engine/Programs/UEWebEngine/Content/` 下的 `Global` Shader 库。现有 Cook/Stage 仍是无渲染 Shader 的 NullRHI-only 内容，不能作为硬件启动内容使用；没有关闭 Shader 库检查或伪造 Shader。

本轮只处理实际复现的初始化阻塞：

- `InstancedStaticMesh.cpp` 在 Web 不创建 `DummyFloatBuffer`，实际实例缓冲和工厂初始化明确 Fatal；目标 `SP_WEBGPU_SM5` 的实例化 Shader 排列关闭。普通静态网格不受这条实例化路径限制。
- `Particles/ParticleVertexFactory.cpp` 对粒子精灵采用相同边界，排除 SubUV 默认缓冲并关闭该目标排列，实际创建粒子精灵工厂明确拒绝。
- `PrimitiveUniformShaderParameters.cpp` 只排除当前源码没有读取者的旧 Primitive 数据纹理，保留 View 需要的天空辐照度结构化缓冲及 SRV；浏览器日志确认其 8 个 float4 元素的 SRV 成功创建。一次新增 GPUScene 检查误伤 NullRHI，失败报告保留；改为在初始化期间查询实际 RHI 类型后，两浏览器 NullRHI 恢复各 10 帧、0 页面/控制台错误。
- 将此前目标源码的 `FXRenderingUtils.cpp` Web 距离场排除接入隔离 Renderer 实际构建，越过 `FDFDummyByteAddress`，不新增 ByteAddress SRV 支持。
- 位置、切线、UV 的真实顶点缓冲继续创建，仅在 WebGPU 已关闭手动顶点取数和顶点 Shader SRV 的前提下不创建默认取数 SRV；显式请求未实现格式仍由原后端拒绝，没有新增缓冲格式支持。

Engine.26、39、43、45 和 Renderer.4 合并单元均实际单任务重编，随后多轮完整对象诊断链接与两浏览器检查。最终链接日志 `web-engine-webgpu-link-20261019-103426.log`，浏览器报告 `web-engine-webgpu-results.json`；硬件失败栈已从默认资源创建推进到 ShaderCodeLibrary，两边均无 GPU validation 错误。各中间阶段与 NullRHI 回归失败保存在 `*-after-ism-*`、`*-after-subuv-*`、`*-after-primitive-first-*`、`*-after-distancefield-*`、`*-after-position-*` 等历史报告。

**当前仍是混合 5.8.3/5.8.0 的增量诊断，`fullNormalUBTBuildVerified=false`。** 安装目录未写入，本轮没有重跑未改动的原生共享 RHI 回归，也没有完成浏览器视口、硬件 Engine Tick、Shader Cook、项目地图或 HTML UI。下一步是接真实 WebGPU 全局/材质 Shader Cook 与资源挂载，并补当前源码的普通完整 UBT 构建验收；最小场景仍限定普通静态网格、基础 Unlit 颜色/二维贴图、相机输入及 HTML UI。

## 2026-10-19 第二轮检查点

**2026-10-19 第二轮：完整 wasm64 Engine 的增量诊断产物已在 Chrome/Edge 创建设备并选中真实 WebGPURHI（平台 47），尚未完成硬件 RHI 初始化。** 同一产物的 NullRHI 路径两浏览器均 Tick 到 10 帧，无页面或控制台错误。硬件路径为 0 帧，当前可复现阻塞是 `FDummyFloatBuffer::InitRHI` 为实例化静态网格默认数据创建 `PF_R32_FLOAT` SRV；没有将设备成功误记为 Engine 启动或场景完成。

本轮接入与验证：

- 新增 Web 平台 `WebGPURHI` 模块和 `PlatformCreateDynamicRHI` 工厂，直接编译原有后端的五份实现文件。运行时 DDPI 注册 `SP_WEBGPU_SM5=47`；浏览器通过 emdawnwebgpu 异步请求 Adapter/Device，回调后进入真实 `FEngineLoop::PreInit`，避免主线程同步等待设备。
- 浏览器视口使用 canvas surface 和 RAF 隐式呈现，Windows 保留原生 HWND/Present 路径。此轮启动尚未抵达视口创建，不能称为浏览器视口验证通过。
- 修正新入口重复建立 `FTaskTagScope` 导致的 NullRHI 回归。最小启动中两个默认顶点缓冲继续实际分配，仅对浏览器排除原生诊断附带的同步 GPU 读回校验，日志明确 `gpuReadbackVerified=0`；原生仍读回 28 字节并验证。同步等待 API 继续拒绝浏览器阻塞，没有伪造成功。
- 首次硬件启动随后停在 Geometry Cache 默认 SRV。目标源码 `GeometryCacheVertexFactory.cpp` 仅在 Web 排除两个默认缓存缓冲、关闭该工厂 Shader 排列，并对实际创建/手动顶点读取明确 Fatal。隔离副本的实际 Engine.24 合并单元编译、全量对象链接与两浏览器重跑均越过该处；没有新增 Geometry Cache、数组纹理或新 SRV 格式支持。
- 原生共享 RHI 模块重新编译通过。核心 25 项、材质 32 项、资源状态 49 项通过，共核对 1,344,520 个值；全局 RHI 44 项/132,096 个值及 HWND 视口 72 项/143,976 个值通过。一次视口验证因旧全局报告仍引用上版模块哈希而失败，刷新全局运行后按原条件通过，没有放宽校验。启动负例仍区分“诊断符合预期”和“启动未成功”。
- Web Cook/Stage 已刷新，仍为 NullRHI-only 的 330 个文件、23,633,819 字节；没有渲染 Shader、项目地图或发行打包。

**构建证据边界：本轮当前完整普通 UBT 构建未通过验收。** 新的 RHI 生成头导出目录使大量参数文件变化，09:45、09:51、09:58 三次完整构建在无编译错误时主动终止，原日志和 false 报告保留；不是成功或编译失败结论。随后普通 UBT 的 BuildSettings、RHI、新入口和 WebGPURHI 共 11 个选定编译动作通过，再使用真实完整链接响应对既有 Engine 对象及新对象执行增量诊断链接。`link-web-engine-webgpu.ps1` 独立保存链接参数、全部对象/库哈希、指定重编单元、源码和产物，`fullNormalUBTBuildVerified=false`；旧普通完整构建与运行报告单独保存为 `*-before-webgpu-20261019-094408.json`，没有覆盖成当前成功。

当前诊断入口为 `http://127.0.0.1:8765/web-engine.html?rhi=webgpu&incremental=1`，无渲染回归为相同 URL 的 `rhi=null`。报告是 `results/web-engine-webgpu-link-results.json` 和 `results/web-engine-webgpu-results.json`，硬件报告 `pass=false` 是预期的未完成状态；启动失败保留实际带函数名调用栈。严格综合汇总尚未刷新，旧 GameEngine.cpp 外部变更导致的探针失效仍未处理。安装目录没有修改，仍是 5.8.3/5.8.0 混合隔离验证。

下一步先分析 `DummyFloatBuffer` 的实际消费者，按最小静态网格范围决定网页条件裁剪；再推进剩余默认初始化、真实全局 Shader 缓存/Cook 和项目地图。还需补当前源码的普通完整 UBT 构建验收；不能用本轮增量诊断替代。

## 2026-10-19 首轮检查点

**2026-10-19 09:31：Web Cook/Stage 的 NullRHI 启动链路通过，Chrome 和 Edge 均完成真实 `FEngineLoop::PreInit → Init → Tick`。** 当前普通完整目标仍使用 10 月 16 日已链接并审计的 wasm64 产物；本轮未改动或重编该产物。浏览器分别为 Chrome 155.0.8059.84、Edge 155.0.4283.45，首次采样 4 帧，继续运行到 10 帧，页面异常和控制台 error 均为 0。`web-engine-runtime-results.json` 的 `pass=true`、`engineLoopBrowserTickVerified=true`；`completeBrowserUERuntime`、`completeUEScene` 和 `p3Complete` 仍为 false。

本轮新增并实测：

- 独立 `WebTargetPlatform` 主机模块，仅命令行显式指定 `-WebNullRHICook` 时提供 Web Cook 目标。使用 Web DDPI 的 wasm64 布局、标准 CookCommandlet、无 Shader 格式和无音频；保留必要材质、贴图等真实包序列化，不提供 WebGPU 渲染 Cook 或 UAT 发布能力。安装版 UBT 不认识 Web SDK，因此仅这条验证路径通过自定义模块名注册；不冒充完整 Web SDK。
- `cook-web-engine.ps1` 以单构建任务、CPU affinity 3 执行。最新日志 `web-engine-cook-20261019-093021.log`；实际 162 个包 Cook、1 个按平台跳过，生成 330 个 `.uasset/.uexp/.ubulk` 文件，共 23,633,819 字节。Cook 退出 0、0 errors，保留无音频格式和未启用 ACL 插件等 warnings。内容包含引擎启动对象的依赖，不代表这些可选功能已实现。
- `stage-web-engine.cjs` 将 Cook 文件生成独立二进制包与文件清单。网页 `preRun` 校验整包 SHA256，写入 MEMFS 后再次校验全部 330 个文件。标准默认材质加载断言已越过，没有移除断言或伪造资源。
- 配置从四份补为九份：新增原始 BaseGame、BaseInput、BaseDeviceProfiles、BaseScalability、BaseGameUserSettings。补齐 BaseGame 前曾因空 `ProjectVersion` 在 UEngine::Init 失败，保留为 `web-engine-runtime-results-20261019-materials-loaded.json`；补齐后 Init/Tick 通过。
- 两项浏览器负例通过：篡改资源包首字节、篡改单文件哈希，均在引擎启动前拒绝，ready=null、frames=0。原有 ShaderPlatform / ShaderCompileWorker 在未启用 Cook 开关的正常路径回归退出 0，日志 `web-cook-host-regression-20261019-after-profile.log`，Worker 报告 `build/web-cook-host-regression-20261019/worker/worker-results.json` 为 pass=true。新增主机设备配置避免其在标准设备配置注册阶段缺项。

**严格综合汇总本轮退出 1，不能声称全套回归通过。** `web-engine-cook-summary-20261019.log` 中 `webEngineTargetBuildSucceeded=true`、`webNullRHICookStageVerified=true`、`webEngineLoopBrowserTickVerified=true`，但旧 `web-engine-target-results.json` 的安装版 `GameEngine.cpp` 原文件哈希已不匹配，导致 `p3EngineCompileProbePass=false`。当前安装文件时间为 2026-10-19 09:25:37，与隔离副本比较包含一处注释拼写和两处视口尺寸设置新增调用。本轮没有编辑安装文件，也没有覆盖此外部变化或刷新旧探针为成功；当前隔离构建产物与自身完整构建报告仍匹配。后续如刷新该源码探针，应以明确的隔离基线重新编译，不直接改安装目录。

剩余主线：将已有 WebGPURHI 接入完整 wasm64 Engine，接通 Web ShaderPlatform 与渲染 Shader Cook，加载最小项目地图，再验证静态网格、Unlit/二维贴图、相机输入与 HTML UI 桥。此次只证明无渲染 Engine 启动和启动资源的 Cook/Stage，仍是目标 5.8.3 与安装版 5.8.0 的混合隔离验证；没有重跑 P0/P2 GPU 全套检查，没有实现浏览器画面或 UAT 发布包。

## 2026-10-16 检查点

**21:13 检查点：普通完整 Engine Target 的 C++、最终 WASM 链接和元数据全部通过；首次真实浏览器启动已推进到默认材质加载，尚未完成 PreInit/Init 或 Tick。** 续编日志 `results/web-engine-full-20261016-192300.log` 为 89/89、退出 0，包含保留的 UMG。此前 BLAKE3、PNG、ICMP 字节序和 `sem_timedwait` 共 41 个未解析符号已由实际链接确认解决。最新 4MB 栈产物的构建日志为 `web-engine-full-20261016-211014.log`，完整报告为 `web-engine-full-build-results.json`；当前是带函数名的调试产物，WASM 180,224,000 字节，不能作为最终发行包体指标。

Chrome 实际执行的启动路径及处理：

- 首次停在 `FGenericPlatformProcess::ExecutableName` 未实现。Web 平台源文件使用 UBT 的 `UE_APP_NAME` 返回程序名及 `.js` 扩展名，公共头未改变；普通目标增量编译、链接通过。
- Web 启动器在 `preRun` 挂载原始 Web DDPI、安装版 Windows DDPI（仅供通用 NullRHI 选择原有 ShaderPlatform）、Base.ini 和 BaseEngine.ini。四份文件在 MEMFS 内重新计算 SHA256 并核对；没有伪造有效平台信息或实现 WebGPU 平台。
- NullRHI 默认 SM6 触发 Nanite 细分表读取，缺少该数据时越界。测试入口改用现有 `-sm5`，已越过该路径；没有移植 Nanite。
- 后续日志明确检测到 Emscripten 默认 64KB 栈溢出。Engine 测试目标使用 `-sSTACK_SIZE=4194304`，并用 `-g2` 保留函数名；重链通过，后续启动不再停在该栈错误。
- **最新阻塞为 `UMaterialInterface::AssertDefaultMaterialsExist()` 的 `GDefaultMaterials[Domain] != 0` 断言。** 日志包含 `/Engine/EngineMaterials`、`/Engine/EngineResources/WhiteSquareTexture` 等包缺失；已越过 NullRHI 和 `ObjectSystemReady`。网页目前仅挂载配置与 JS/WASM，没有 Cook 内容。未屏蔽材质断言、伪造默认材质或将运行结果记为通过。`web-engine-runtime-results.json` 保留控制台、带函数名的错误栈、配置/产物哈希和 0 帧状态；脚本在 Chrome 首次失败后停止，尚未执行 Edge Engine 验收。

当前使用 `build-web-engine.ps1 -MaxParallelActions 1`、CPU affinity 3，安装目录未修改。仍是目标 5.8.3 与安装版 5.8.0 依赖的混合隔离验证。后续接 Web Cook/Stage、默认资源与最小场景的数据挂载，再验证完整 PreInit/Init/Tick，最后接浏览器 WebGPU 场景和 HTML UI。真实 Engine Tick、WebGPU、Cook 与场景均未通过，P3 未完成。

**21:21 回归收尾：`build-web-ubt.ps1` 综合回归和严格汇总均退出 0。** 日志分别为 `results/web-ubt-integrated-20261016-211359.log`、`results/web-engine-linked-summary-20261016-212128.log`。BLAKE3 三环境各 210 项、libPNG 各 8 项，普通 Core Program 六组、基础服务七组，ApplicationCore 的 Chrome/Edge 四组各十五项，以及十个 Engine 关键源码和额外检查均重新通过。`verify-web-engine-exclusions.cjs` 的 12 个对象、5 份符号日志与两库实际链接输入审计通过，PNG 开关保持 1。汇总确认 `webEngineFullBuildMatchesCurrentSources=true`、`webEngineTargetBuildSucceeded=true`，但 `webEngineLoopBrowserTickVerified=false`、`p3Complete=false`；汇总退出 0 仅代表这些检查点的证据有效。首次汇总曾因新增库检查引用局部 `currentHash` 而退出 1，已修正作用域后重跑，没有放宽验收条件。当前链接分类报告记录 0 个未解析符号及此前 41 个符号的解决列表。

下一阶段不能直接使用现有 `WebGPUShaderHostTargetPlatform` 冒充 Cook 平台：该模块仅用于主机 Shader 编译发现，明确不提供 Cook/纹理格式/SDK 打包能力。需接真正 Web Cook 平台、可用的基础材质/贴图格式和数据挂载；保留默认材质等必要资源，不通过去掉断言来制造启动通过。

**21:28 最终证据刷新：** 关键源码探针会重写待构建的链接响应文件，因此完整构建现独立保存执行时的响应文件到 `<完整日志>.link.rsp`；排除检查改为核验该副本，严格汇总要求其与完整报告一致。重新链接的 `results/web-engine-full-20261016-212618.log` 退出 0，当前完整报告及链接分类报告均引用此次构建，库和 12 对象检查重新通过。刷新 Engine 诊断时一次 Chrome 页面进程崩溃，保留为 `web-engine-runtime-results-20261016-212715-crash.json`；再次运行仍复现默认材质缺失断言、0 帧，最新运行报告引用当前构建与源码。最终严格汇总 `web-engine-linked-summary-20261016-212838.log` 退出 0，编译/链接 true、真实 Engine Tick false。此轮没有重跑 P0/P1/P2 GPU 检查。

## 历史检查点

19:22 续编前：16:54 完整构建被系统异常重启中断，最后为 `[166/254] Module.MovieSceneTracks.2.cpp`，无退出结果、未链接。最后日志更新时间 18:17:54，系统启动时间 19:08:41；Windows System 日志含多次检测错误重启（`0x0000003b`、`0x00000050`），根因未确定。证据为 `results/web-engine-system-interruption-20261016-1817.json`。此中断没有记为编译失败或构建成功。之后采用单任务续编，重启后 BLAKE3 三环境各 210 项、libPNG 各 8 项重新通过。

**16:53 检查点：已接入剩余四类链接阻塞的处理，完整目标重新构建中，尚未确认链接成功。** BLAKE3、libPNG 均直接编译引擎自带源码；保留双任务、两个逻辑核限制。此前 41 个未解析符号是上一轮链接结果，不能提前记为已清零。

本轮变更和已完成验证：

- BLAKE3 使用目标分支自带的 1.3.1 C 源码构建 wasm64 portable 静态库，关闭 x86/ARM SIMD 分派；没有新增付费依赖。35 组随源码提供的原始向量覆盖普通哈希、带密钥哈希和派生密钥，分别采用一次性及 97 字节分段输入，比较全部 131 字节输出并检查默认摘要前缀。Node、Chrome、Edge 各 210 项通过，无浏览器错误。结果为 `results/web-blake3-build-results.json`、`results/web-blake3-results.json`。目标与安装版公开头文件文本一致，文件哈希差异来自换行格式。
- libPNG 使用目标分支自带的 1.6.44 C 源码构建 wasm64 portable 静态库，链接已接入的 Emscripten zlib，不改 ImageWrapper 的公开 PNG 开关。四种 RGBA 图像覆盖 8/16 位像素、元数据、逐字节往返，以及损坏 IDAT 拒绝和 longjmp 错误恢复，Node、Chrome、Edge 各 8 项通过。引擎使用的五份公开/私有头和配置逐份文本核对一致，避免混用其他版本库与 UE 私有结构布局。结果为 `results/web-libpng-build-results.json`、`results/web-libpng-results.json`。此检查没有运行 UE ImageWrapper，Cook 后贴图加载仍待验证。
- UDPPing 在 Web 不编译原生 UDP、字节序和后台探测实现；保留三个公开入口，立即回调 `NotImplemented`，批量请求同时返回原目标列表与失败状态。没有实现浏览器网络。
- BuildPatchServices 的 Verifier 在 Web 使用原有 `ProcessVerifyJobs(nullptr)` 同步分支，不编译创建验证线程及限时信号量等待的代码。没有伪造 `sem_timedwait` 成功结果，也未改写验证算法。
- Online 在隔离宿主中仅将 ICMP、BuildPatchServices 改为本地副本。9 份 ICMP 文件仅 UDPPing.cpp 不同，223 份 BuildPatchServices 文件仅 Verifier.cpp 不同；安装目录未写入。两个覆盖文件及 BLAKE3 源码已加入完整构建和关键探针审计。
- 两个原有第三方库均已接入 `build-web-engine.ps1` 与 `build-web-ubt.ps1`；后者包含 Node/浏览器验收。扩展了 UDP 和补丁等待的对象符号检查，尚待完整构建生成新对象后执行。

16:40 的 `results/web-engine-full-20261016-164008.log` 是尝试关闭 PNG 后触发的重编，约完成前 20 个动作时主动停止，退出 1、无编译错误、未链接；完整记录保留为 `web-engine-full-build-results-20261016-164008.json`。随后确认原有 libPNG 可直接构建，恢复 PNG 开关后重新执行普通完整目标；不能将主动停止记为构建通过。下文 16:14 的链接失败和 16:17 的综合回归保留为上一检查点。当前仍是目标 5.8.3 与安装版 5.8.0 依赖的混合隔离验证；真实 Engine 初始化/Tick、WebGPU、Cook 与场景未通过。

**P3 完整目标的 C++ 编译阶段已通过，包括保留的 UMG；最终 WASM 链接仍失败，未解析符号已从 68 个减少到 41 个。** 本轮补平台入口、采用标准应用宏并排除无声目标的可选音频解码器，实际链接消掉 27 个符号缺口。尚无可运行的 Engine JS/WASM，真实 PreInit/Init/Tick、WebGPU、Cook 和最小场景仍未验证。P3 未完成。

当前结果来自普通 UBT 的 `web-engine-full-20261016-161416.log`：五个待执行 C++ 编译动作通过，第六个为 `Web Link UEWebEngine.js`，退出 6，未执行成功后的 WriteMetadata。首次进入链接的旧日志为 `web-engine-full-20261016-154438.log`，当时有 68 个不同未解析符号。两轮都复用已经验证的对象，不是从零重编所有源码；完整目标依然混用目标分支 5.8.3 与安装版 5.8.0 依赖。`results/web-engine-link-blockers-results.json` 记录最新日志与完整报告哈希、剩余分类、全部符号和与前次报告的差异，没有屏蔽未解析符号。

| 链接阻塞类别 | 不同符号数 | 后续处理方向 |
| --- | ---: | --- |
| BLAKE3 | 3 | 接入真实可移植哈希实现，不能用空结果替代 |
| PNG | 34 | 选择实际 Web 解码库或关闭本期不使用的运行时图片路径 |
| 网络字节序 | 3 | 检查 ICMP/UDP 探测是否应在当前无原生 Socket 的目标排除 |
| 限时信号量等待 | 1 | 检查单线程 Web 对 BuildPatch 等可选等待路径的依赖 |

本轮已处理：

- 测试入口使用 `IMPLEMENT_APPLICATION(UEWebEngine, "UEWebEngine")`，由 UE 原有宏定义项目名、GEngineLoop、模块注册和真实 FMemory 桥接，替代手写的两个全局变量。
- Web 实现 `FGenericCrashContext::CleanupPlatformSpecificFiles()`；该平台不创建桌面崩溃报告文件，清理函数无操作，与原 Unix 平台此函数的边界一致。
- Web 提供 `PlatformCreateDynamicRHI()` 入口；调用硬件分支明确 Fatal，不返回假 GPU。当前测试继续通过 `-nullrhi` 使用既有 NullRHI，浏览器 WebGPU 接入尚未完成。
- Engine_Web 排除 RadAudio、Bink、Vorbis、Opus、Adpcm 五个可选动态解码模块，保留 Engine、UMG 和 Slate。当前入口固定 `-nosound`，引擎既有 `FApp::CanEverRenderAudio()` 判断阻止 AudioDeviceManager 创建；没有实现或验证浏览器音频。此次实际消掉 RadAudio/Vorbis/Opus 共 23 个缺失符号。

关键探针新增应用入口符号与五个解码器链接输入检查。前次完整报告保留为 `results/web-engine-full-build-results-20261016-154438.json`，旧分类保留为 `results/web-engine-link-blockers-results-20261016-155442.json`。

**本轮改动后的综合回归与严格汇总均退出 0。** `build-web-ubt.ps1` 的日志为 `results/web-ubt-integrated-20261016-161752.log`：工具链、Core 类型、Oodle 条件编译、普通 Core Program 构建与 Node/Chrome/Edge 六组运行、基础服务七组、ApplicationCore 构建与四组各十五项浏览器检查、Engine 十个关键源码及额外 TagTrace/RHIValidation 强制编译全部通过。`web-engine-entry-symbols.log` 确认 FMemory_Malloc、FMemory_Free、IMPLEMENT_MODULE_UEWebEngine 和两个全局变量均由标准入口生成；`applicationModuleBoilerplateVerified=true`、`audioDecodersExcluded=true`。SlateCore/Sockets 对象排除也重新通过。汇总日志为 `results/web-engine-link-reduction-summary-20261016.log`，当前完整报告与源码匹配，编译阶段已进入链接，但完整构建和真实浏览器 Tick 仍为 false。此轮没有执行 Engine 网页，也未重跑 P0/P1/P2 GPU 测试。

`verify-web-engine-exclusions.cjs` 已执行通过：五个 SlateCore 合并对象无 MSDF/SDF 算法与任务实现，字体数据访问/序列化入口仍在；Sockets 对象无 BSD 实现，平台工厂存在且私有能力定义为 0。结果见 `results/web-engine-exclusion-results.json`，记录源码、副本、对象、定义和符号日志哈希；只验证编译与符号，不声称字体运行或浏览器网络可用。

2026-10-16 11:50 的重编日志 `results/web-engine-full-20261016-115041.log` 最后记录为 12:43 的 `[129/350] Module.Engine.31.cpp`，没有退出结果；系统最近启动时间为 12:47:46，构建进程已结束。System 日志的 1001 事件记录检测错误 `0x00000050`，6008 事件记录意外关闭，按系统异常重启中断记录，具体根因未确定；证据见 `results/web-engine-system-interruption-20261016-1247.json`。13:39 的续编 `web-engine-full-20261016-134047.log` 已通过剩余 Engine、Launch、MovieSceneTracks、全部 RHI，随后在 RenderCore 的 ShaderCodeArchive.cpp 两处列表收窄处退出 6，未链接。

ShaderCodeArchive.cpp 的 Shader 索引区间只补两个显式 `int32` 转换，与目标分支原文件的差异仅此两行。隔离宿主将 RenderCore 改为本地副本并覆盖该目标文件；212 份文件哈希核对仅此文件与安装版不同，安装版原件哈希未变。14:53 的完整构建 `results/web-engine-full-20261016-145300.log` 已通过原失败 RenderCore.4 和后续 .5/.6，随后在 Renderer.27 的 SceneCullingRenderer.cpp:340 退出 6，未链接。

SceneCulling 的 ViewGroupId 来自添加视图组后的数组索引，只补一处显式 `uint32` 转换，不移植场景剔除新功能。隔离 Renderer 改为本地副本，仅覆盖该目标文件；781 份文件哈希核对仅此文件不同，安装版原件哈希未变。此前目标 FXRenderingUtils.cpp 的距离场裁剪未纳入该副本，仍只有独立 Win64 条件编译证据。15:07 续编 `results/web-engine-full-20261016-150743.log` 已通过原失败 Renderer.27 及全部剩余普通源码合并单元，随后在 SignalProcessing.1 的 FloatArrayMath.cpp 两处未实现向量移位宏退出 6，未链接；Renderer.gen.cpp 尚未执行。动作数量不是功能完成比例。

FloatArrayMath.cpp 的 ArrayInt16SwapBytes 已有逐元素循环，仅用 `PLATFORM_ENABLE_VECTORINTRINSICS` 守卫前面的向量部分；无向量指令的平台由已有循环处理全部元素，没有增加 FPU 移位宏或新音频能力。SignalProcessing 使用安装源码的隔离副本，199 份文件中仅该目标文件不同，安装版原件哈希未变。`web-engine-full-20261016-152211.log` 已通过全部三个普通源码合并单元，随后在 SlateCore.2 缺失 msdfgen 头文件处退出 6，未链接；音频运行结果未验证。

SlateCore 的 Web 条件关闭 SDF 功能查询与生成器创建，排除 msdfgen 相关几何运算；字体数据序列化和通用数据访问仍编译。327 份隔离副本文件中只有 FontCache、PreprocessedFontGeometry、SlateSdfGenerator 三个目标文件不同，安装原件哈希未变。`web-engine-full-20261016-152754.log` 已通过全部五个 SlateCore 普通源码合并单元、SlateNullRenderer、SlateRHIRenderer 和 SlateReflector，随后在 Slate.1 缺失 `AHEasing/easing.h` 处退出 6。

AttributeInterpolator.cpp 在 Web 保留既有 Linear 分支，条件排除第三方非线性缓动代码；请求不支持的类型明确 Fatal，不假装实现。随后补 WebPlatformTextField.h 复用通用空实现，并在两个函数排除依赖 RECT 的桌面光标锁定。Slate 隔离副本的 465 个原文件中仅三个目标文件不同，另新增一个平台头，安装版原件哈希未变。`web-engine-full-20261016-154027.log` 已通过全部七个 Slate 普通源码合并单元，随后在 Sockets 的 EPROCLIM 映射处退出 6；未验证 UMG 控件或字体运行。

新增 Sockets_Web 规则，仅在 Sockets 模块私有定义关闭 BSD/IPv6 实现，平台工厂返回 NAME_None，不注册原生 Socket 子系统；没有实现浏览器 TCP/UDP 或 WebSocket。`web-engine-full-20261016-154438.log` 已通过 Sockets、剩余依赖和 UMG，进入上述最终链接失败。新增平台文件和覆盖层已加入完整构建与关键探针的源码审计。

16:00 检查点已重新执行 Engine 十源码探针及额外 TagTrace/RHIValidation 检查，全部通过；ApplicationCore 普通 Target 的重新链接和 20 个模块对象审计也通过。新旧 ApplicationCore JS/WASM 哈希相同，但当时旧浏览器报告引用旧构建报告哈希，因此严格汇总将 ApplicationCore 浏览器验收标记 false，退出码为 1；没有重写旧运行报告或放宽检查。历史日志见 `results/web-engine-checkpoint-summary-20261016.log`。

此前 localhost:8765 服务在系统重启后未恢复，后台启动曾被自动批准审核拒绝，仅返回 `blocked by policy`。用户随后明确要求“跑下验证”；2026-10-16 16:06 正常启动服务成功，页面返回 200，COOP/COEP 响应头正确。

**16:07 浏览器与基础运行回归完成，严格汇总退出 0。** 本轮直接验证已构建产物，没有重新编译或尝试完整 Engine 链接；验证脚本的日期改为实际执行时间。Chrome 155.0.8059.40、Edge 155.0.4283.45 没有页面或控制台错误。结果如下：

| 本轮验证 | 结果 |
| --- | --- |
| ApplicationCore 浏览器循环、键鼠/滚轮、焦点、HTML 输入隔离、DPI/尺寸、停止与清理 | Chrome/Edge 各桌面 1280×800 DPR 1、窄视口 390×844 DPR 2，共 4 组，各 15 项通过 |
| 普通 Core Program | Node、Chrome、Edge 各 6 组通过，包括数组分配、文件接口、对齐重分配、Transform FPU 与算术移位 |
| Core 基础服务诊断 | Node、Chrome、Edge 各 7 组通过，包括字符串、原子、字节内存操作、数学、TLS、递归锁和 zlib |
| 可选实现排除 | 五个 SlateCore 对象与一个 Sockets 对象重新核验通过，保留接口与源码/副本/符号哈希一致 |
| 语法与差异检查 | 三个本轮修改的验证脚本通过 `node --check`；目标引擎 `git diff --check` 通过 |
| 严格汇总 | `summarize.cjs` 退出 0，日志 `results/web-validation-summary-20261016.log` |

16:07 检查点的 `web-application-results.json` 引用了当时实际核验的构建报告哈希，`p3ApplicationCoreBrowserPass=true`、`webBrowserMainLoopVerified=true`、`webApplicationCoreInputVerified=true`。`webEngineTargetCompileStageCompleted=true`、`p3EngineCompileProbePass=true`、`webEngineOptionalImplementationsExcluded=true`、`webApplicationTargetBuildVerified=true`，但 `webEngineTargetBuildSucceeded=false`、`webEngineLoopBrowserTickVerified=false`、`p3Complete=false`。汇总通过只表示已实现检查点的证据有效，当时仍有 68 个链接符号未解析；本轮续编后的剩余 41 个以本文开头为准。没有执行尚未链接成功的 Engine 网页，也没有重跑 P0/P1/P2 GPU 测试。

已新增 `web-engine.html` / `verify-web-engine.cjs`，仅通过语法检查。它们要求成功完整构建与源码/产物哈希一致后，才在 Chrome/Edge 检查真实 PreInit/Init 后标记和连续 Tick；目前尚未执行该验收，也未生成运行通过结果。失败诊断保留控制台日志；读取失败页面状态最多等待五秒，避免初始化阻塞主线程时诊断自身无期限等待。`summarize.cjs` 已接入该验收报告的哈希、浏览器和连续帧检查，仍保持引擎运行标记为 false。

此前 6 类 Core 链接符号已解决；普通 `UEWebSmoke` 新增 FPU Transform 检查，运行组数从 5 增至 6。7 组基础服务样本保持独立验证。`UEWebApplication` 覆盖逐帧执行、canvas 键鼠/滚轮、失焦释放、网页输入框隔离、DPI/尺寸变化和停止清理，Chrome/Edge 两视口共四组、每组 15 项。

此前报告将 `-WriteOutdatedActions` 的 650 项动作、612 项 Core 编译称为完整动作图，表述不准确。它只导出当时待构建的动作，数量会随缓存变化；不用于衡量 Core 的完成比例。

IoStore 裁剪后的综合回归 `build-web-ubt.ps1` 与 `summarize.cjs` 均通过。Core Program 的 6 组与基础服务的 7 组在 Node/Chrome/Edge 重新通过，ApplicationCore 的 Chrome/Edge 两视口共四组、各 15 项通过；Engine 十个关键源码和额外 TagTrace 强制重编通过，包含 InputCore 实现与调用方。链接输入检查确认 IoStoreOnDemand、IoStoreHttpClient 已排除，IoStoreOnDemandCore 保留。汇总也检查新增平台文件是否包含在完整报告中，修复前的失败不冒充当前源码结果。后续仍需剩余编译及链接、真实 PreInit/Init/Tick、WebGPU、Cook、最小场景与 HTML UI 桥接。本轮未重跑 P0/P1/P2 GPU 测试。

| 项目 | 结果 |
| --- | --- |
| UBT 注册 Web / wasm64 | 通过；`PlatformValidate: Web VALID 6.0.9` |
| C++20 编译、静态库归档、JS/WASM 链接 | 三个真实 UBT action 执行通过；编译和链接均传入 `-m64` |
| 编译器头文件依赖 | `.d` 包含源文件、libc++ 及对应 UE 核心类型头，已关联到 UBT action；尚未验证完整 Target 的增量构建 |
| Node 执行 | 64 位指针，100 个整数计算结果 15,550 |
| Chrome / Edge 执行 | 两者结果均为 15,550；JS 再调用导出函数，7 个整数结果 112；无页面/控制台错误 |
| 真实 UE 核心类型头 | Node、Chrome、Edge 通过；指针与 `SIZE_T` 为 8 字节，`TCHAR` 为 2 字节，结构体大小/对齐/成员偏移通过断言 |
| 超过 32 位范围的参数 | 浏览器 BigInt 调用 WASM，`0x100000010 + 17 = 0x100000021` |
| 普通 Target 源文件编译 | 23 个关键 Core 文件、3 个 Web 平台实现和 Program 入口强制重编；源码副本与目标分支哈希一致 |
| 普通 Target 完整构建 | 编译、普通 Program 链接、WriteMetadata 均通过，退出 0；全部链接对象和响应文件核对 wasm64 并记录哈希 |
| 普通 Core Program 执行 | Node、Chrome、Edge 的 6 组检查通过；新增 float/double Transform 旋转、缩放、逆变换、组合及高坐标精度 |
| 普通 ApplicationCore Program | 正常 UBT 构建退出 0；Chrome/Edge 的两个视口各 15 项通过，20 个 ApplicationCore 对象核对 WASM 头与响应文件 |
| 浏览器循环与消息 | requestAnimationFrame 驱动自定义 UE 回调；真实 GenericApplicationMessageHandler 接收排队的键鼠/滚轮/焦点/尺寸事件 |
| UE 文件接口 | 复用 Unix 实现，Emscripten MEMFS 内中文文件名、二进制 write/flush/read/rename/delete 通过 |
| 真实 Core 对象链接执行 | `GenericPlatformStricmp.cpp.o` 加入诊断样本静态库，Node、Chrome、Edge 执行通过 |
| 7 组基础服务 | 字符串、原子、字节内存操作、数学、TLS、递归锁、zlib；浏览器无页面/控制台错误 |
| zlib 接入 | Web 第三方规则使用 Emscripten 免费开源 port，压缩往返和损坏校验拒绝通过 |
| SDK 缺失 | 预期拒绝，不计入正向 Runtime 通过项 |
| Oodle 排除 | 移除 Web 库依赖，条件排除实现与直接调用；不支持的数据明确拒绝 |
| Oodle 条件源码回归 | 五个完整源码文件分别编译桌面/Web 条件的 Win64 对象；桌面预处理逻辑保持，Web 对象无 Oodle 实现/绑定符号 |
| 普通 Core Target 上轮阻塞 | 6 类链接依赖已解决；不再依赖预期失败诊断 |
| Core / ApplicationCore WASM | 两个 Program 配置编译及单体链接通过；没有独立模块 archive |
| Engine Target / UHT | 正常 UBT 模块规则及反射生成通过；初次成功生成 6,200 个文件，未绕过 UMG |
| Launch/FEngineLoop WASM | 真实方法定义已编译为对象；完整目标编译通过，最终链接未通过 |
| Renderer / UMG 编译 | 当前完整目标所需 C++ 构建动作已通过；不代表绘制或控件运行可用 |
| Cook / 浏览器 UE 场景 / HTML UI 桥 | 尚未接通 |

## wasm64 与构建边界

目标 5.8.3 的 `HAL/Platform.h` 已统一定义 64 位平台，并断言 `sizeof(void*) == 8`。预定义 `PLATFORM_64BITS` 或沿用 wasm32 均不能直接满足这些约束。当前选择原生 wasm64，避免先修改引擎的 32 位布局假设；原 P0 的 wasm32/64 对照测试保留。

Web 平台定义 `TCHAR = char16_t`、8 字节 `SIZE_T`，复用 Clang 编译器设置。没有修改公共 `Platform.h` 的类型断言；DDPI 的实际 Cook/frozen 数据兼容性仍待验证。浏览器验证使用本机 Chrome 155.0.8059.40、Edge 155.0.4283.45。

平台实现位于 `reference-engine/Engine/Platforms/Web`，通过引擎已有的平台扩展扫描入口接入，没有修改 UBT 中央平台枚举或项目文件。

| 文件 | 内容 |
| --- | --- |
| `Config/DataDrivenPlatformInfo.ini` | 平台标识、64 位冻结布局信息；实验配置，不代表 Cook 平台可用 |
| `Config/Web_SDK.json` | 固定 Emscripten 6.0.9 |
| `UEBuildWeb.cs` | Web factory、wasm64、基础定义；当前仅单体非 Editor，关闭 ISPC/PCH/ICU/Trace/自动化测试 |
| `WebPlatformSDK.cs` | 检查 SDK 版本、Python、em++、emar、clang++、wasm-ld 和配置文件 |
| `WebToolChain.cs` | Python 调用 em++ / emar，响应文件、依赖文件、静态库和 JS/WASM；`z` 系统库转为 `--use-port=zlib` |
| `Source/Runtime/Core/Core_Web.Build.cs` | 普通 Core Target 的 Public/Private 平台头路径和 zlib 依赖 |
| `Source/ThirdParty/zlib/zlib_Web.Build.cs` | 复用引擎 zlib 头文件，链接 Emscripten port |
| `Public/Web/WebPlatform*.h` | 类型、字符串、Clang 原子/数学、通用内存、TLS、pthread 锁、亲和性、输出设备、Unix 文件接口等适配；仅下述子集已运行验证 |
| `Private/Web/WebPlatformManualResetEvent.h` | 使用 UE 通用手动重置事件；阻塞/唤醒运行结果尚未验证 |
| `Public/Web/WebSemaphore.h` | 使用 UE 既有 pthread 信号量；并发运行结果尚未验证 |
| `Private/Web/WebPlatformMemory.cpp` | libc 对齐分配/释放；WASM 页大小和线性内存上限，物理 RAM 未知 |
| `Private/Web/WebPlatformProcess.cpp` | Emscripten 虚拟文件系统基础路径 `/` |
| `Private/Web/WebPlatformFile.cpp` | 包含目标 Unix 文件实现和 POSIX 标准头，提供物理文件入口；关闭不适用于 MEMFS 的 OS 独占写锁 |
| `ApplicationCore/ApplicationCore_Web.Build.cs` | ApplicationCore 的 Web 扩展及公开平台头路径 |
| `ApplicationCore/Public/Web/WebPlatformApplicationMisc.h` | 应用工厂、消息泵和前台状态入口 |
| `ApplicationCore/Public/Web/WebApplication.h`、`Private/Web/WebApplication.cpp` | 单 canvas 窗口、事件队列、基础输入与浏览器帧回调 |
| `ApplicationCore/Public/Web/WebPlatformSplash.h` | 使用 UE 通用空启动画面 |

UBT C# 文件位于 `Source/Programs/UnrealBuildTool`。当前构建为单线程，没有启用 Emscripten `-pthread`。`PLATFORM_USE_PTHREADS=1` 用于选择 POSIX TLS/锁接口，`SupportsMultithreading()` 仍为 false，不能据此认为 UE 工作线程已可用。DLL、ISPC、PCH 等未实现模式明确拒绝；Cook/Stage 部署入口明确报错。

隔离测试工程 `tests/web-platform/web-ubt/UnrealBuildTool.Web.csproj` 编译**安装版 5.8.0 的 UBT 源码**，同时包含目标 5.8.3 分支的新 Web 平台文件。普通 Target 按依赖使用**目标分支的 5.8.3 Core、TraceLog、ApplicationCore、CoreUObject、Launch、ChaosCore 和 AtomicQueue 源码副本**；Engine 的 Preshader2、SparseVolumeTextureData 也来自目标分支，其余 Engine 源码使用安装版 5.8.0 的隔离副本，包括 `GameEngine.cpp`。其他依赖仍来自安装版。Core-only Target 不依赖 ApplicationCore。这是混合版本接入验证，不代表目标 5.8.3 整引擎已经编译。

本轮进一步覆盖目标分支的 MovieSceneSkeletalAnimationSection，所在 MovieSceneTracks 模块其余源码仍为安装版 5.8.0 副本。该目标文件相对安装版已有两处骨骼空指针检查，本次只增加三处显式 float 转换；没有覆盖或撤回目标分支既有修改。

隔离宿主位于 `.tools/ue58-web-build-host`。Core、TraceLog、ApplicationCore、CoreUObject、Launch、ChaosCore、AtomicQueue、Engine、MovieSceneTracks、RenderCore、Renderer、SignalProcessing、SlateCore 和 Slate 为本地副本，其余源码、着色器和 Config 通过目录联接读取安装引擎；UHT 配置复制到本地，Build、Platforms、Binaries 和构建缓存均在隔离目录。后六个模块仅覆盖上述目标文件。`prepare-web-core-host.ps1` 核验联接后建立覆盖层，并通过受核验的 DotNet 运行时联接支持 WriteMetadata。已运行的 Program 产物仍是 `UEWebSmoke.js` / `.wasm` 与 `UEWebApplication.js` / `.wasm`；没有可运行的 Engine 产物，没有修改安装引擎。测试保留本地 UBA executor，Python/Emscripten action 均以 NoUba 执行。

`WebToolchainSmokeMode.cs` 是测试专用 UBT 模式，用真实 `UEToolChain`、`ActionGraph` 和执行器完成基础诊断样本构建，`-CoreObject` 将普通 Target 的字符串对象加入样本静态库。**普通 Program 使用另外的正常 UBT Build 模式和完整 Target 模块图**，由 `probe-web-core-target.cjs` 验证成功构建，再由 `verify-web-core-program.cjs` 执行 Node/浏览器测试；不通过诊断模式绕过链接依赖。

## 本轮 Core 平台服务

优先复用现有 `FGenericWidePlatformString`、Clang 原子/数学、通用字节内存操作和 pthread 锁。TLS 为 wasm64 的 `pthread_t` 另分配 32 位 UE 线程 ID，避免指针截断；当前只验证单线程 ID 稳定和 TLS 槽位隔离，没有验证多线程唯一性。

| 分组 | 已运行的检查 |
| --- | --- |
| 字符串 | 真实 Core 大小写比较，窄/宽/UTF-8 组合、前缀、中文、UTF-16 代理对长度及 64 位格式宏 |
| 原子 | 32 位加法、比较交换成功/失败，64 位加法/读取、JS BigInt 导出调用，以及 `FInt128` 数组元素的 16 字节对齐；未启用 128 位原子 |
| 内存 | 基础服务样本检查重叠 Memmove、局部 Memzero 和指针标记位；UE 分配器另由普通 Program 检查 |
| 数学 | 零值前导零计数、64 位位计数、超过 32 位的向上取整及溢出拒绝 |
| TLS | 两槽独立存取、清空、释放及当前线程 ID 稳定 |
| 递归锁 | 同一线程 Lock/TryLock 递归及对应 Unlock |
| zlib | 引擎 1.3 头文件链接 SDK port 1.3.2；UTF-8 内容压缩往返、损坏校验拒绝 |

为越过实际编译错误，只在 Web 条件下跳过通用进程头中要求 x86/ARM 指令的 Yield 实现，由 Web 提供编译器屏障；AtomicQueue 的自旋提示采用相同方式。Trace 关闭时，不再从 Channel、Trace 和私有锁头包含其依赖 CPU yield 的原子头。其他平台保留这些路径的原代码。这里的 Yield 不能让出浏览器事件循环，事件循环与调度仍需专门接入。

编译器属性现在明确包含 `GCC_ALIGN`、`GCC_PACK` 和 inline 设置，解决 `FInt128` 对齐断言；`UE_ARCH_NAME=wasm64` 使用引擎既有架构名称入口。Web 关闭 `PLATFORM_HAS_FPlatformVirtualMemoryBlock`，从而使用线性分配器后备路径，不编译 Binned3/GPU 和未使用的虚拟栈分配器。后者的声明与实现均受能力开关保护，没有模拟 OS 的 reserve/commit/decommit。

关闭虚拟内存还暴露了 ParkingLot 后备分支的既有类型错误：普通对象被通过 `->` 调用。该分支改用旁边已有的 `TNoDestroy` 模式；没有重写调度器。另补齐事务锁池头的 `size_t` 标准声明。通用手动事件与 pthread 信号量只通过源码编译，不能视为浏览器阻塞等待可用。

普通 Program 已运行 UE 分配器的基本成功路径；完整字符串转换/格式化、共享锁竞争、UE 工作线程、时间服务运行结果和完整 `FCompression` 往返仍未验证。`Compression.cpp` 与 `CompressedBuffer.cpp` 已编译为 WASM 且没有未解析的 Oodle codec 引用，但普通 Program 未调用其压缩接口；zlib 检查直接调用 zlib API。文件 IO 只在内存文件系统测试，Cook 数据挂载、持久化和 mapped-file 路径仍未验证。

## Oodle 的最小处理

只在 Web 目标移除 `OodleDataCompression` 依赖；Core 内三个 Oodle 实现文件不参与 Web 条件编译，`FCompression` 与 `FCompressedBuffer` 的直接调用也同时排除。

默认 `FCompressedBuffer::Compress` 在 Web 采用已有的无压缩格式；显式请求 Oodle 压缩返回空结果，Oodle 解压拒绝，其他已有解码路径保留。没有引入替代收费 SDK 或空壳 codec。后续 Cook/Stage 必须选择 Web 实际支持的资源格式，已有 Oodle 数据不能据此直接加载。

`verify-web-core-compression-source.cjs` 比较固定提交基线与修改后桌面分支的预处理代码，仅归一化诊断路径、行号和由行号生成的统计变量名，再分别编译桌面/Web 条件对象并检查符号。该项使用安装版 5.8.0 头文件和 Win64/MSVC。本轮还强制重编真实 `Compression.cpp` 与 `CompressedBuffer.cpp` 为 WASM；普通 Target 也已越过三个被条件排除的 Oodle 实现文件。**这些编译结果不代表完整 UE 压缩运行时往返通过**。

## 普通 Core Program

`tests/ue-web-smoke` 使用普通 Program Target，入口依赖 Core，不依赖 Engine、CoreUObject、ApplicationCore 或 UMG。该样本已在 Node、Chrome、Edge 运行，并显式释放测试分配和关闭文件句柄。它没有调用 FEngineLoop，也没有运行完整引擎初始化/退出。

普通 Target 先对 23 个关键 Core 文件、3 个 Web 平台实现及入口逐个执行 `-SingleFile`，移除对应旧对象以防缓存掩盖编译。覆盖字符串、压缩、Ansi 分配和内存、容器分配、时间、断言、进程、亲和性、架构名、原子、输出设备、线性分配、ParkingLot、WordMutex 和任务并发限制。源码、对象、响应文件和 21 个关键覆盖层文件均记录哈希，包含本轮修改的 FPU 头。

随后执行普通完整 Target，要求链接、写入元数据均成功且退出 0。链接响应中的所有对象均检查 WASM 文件头、`-m64` 和当前哈希；其中含缓存对象和条件排除后的空翻译单元，不能据此计算已实现功能比例。待构建动作图只用于参数和依赖检查；脚本在导出前移除入口对象，确保每次确实重新链接。

上轮 6 类链接依赖的实际处理如下，测试 Target 保留 `-Wl,--error-limit=0`：

| 符号 | 本轮实现 |
| --- | --- |
| `BinnedAllocFromOS` | Web 类型提供 `posix_memalign`，以 64KiB 对齐，不递归调用 FMemory；失败返回空 |
| `BinnedFreeToOS` | 与 libc 分配配对，直接 `free` |
| `BaseDir()` | 返回 Emscripten 虚拟文件系统根 `/` |
| `GInternalProjectName` | Core-only Program 自身提供项目名，未引入 Launch |
| `pthread_setschedparam` | 来源为通用 pthread 线程类；Web 保留 TLS/锁/事件接口，排除该线程类和实际线程创建分支 |
| `GetPlatformPhysical()` | 使用目标 Unix 文件实现；时间戳转换改用字段实际类型，避免依赖 glibc 私有 `__time_t` |

`GetConstants()` 返回 WASM 页大小、底层分配粒度和 Emscripten 线性内存上限，不将其伪装成物理 RAM。一般物理内存统计仍沿用通用实现，不代表统计和 OOM 流程已移植。Unix 文件缓存采用原非 Editor 默认值 100；MEMFS 独占写锁关闭，不声明支持竞争访问和 OS 锁。

| 普通 Program 分组 | 已运行的检查 |
| --- | --- |
| TArray | 4096 个元素累加为 25,188,352；Reserve(8192)、移除 128 项、Shrink、Empty 后无存储 |
| 对齐重分配 | FMemory 申请 257 字节，扩到 8193 字节，保持 64 字节对齐及原始 257 字节内容，再释放 |
| 底层页分配 | 65537 字节分配保持 64KiB 对齐，可写到第二页，再配对释放 |
| 文件 | UE Unix 文件接口创建目录、中文文件名二进制写入/Flush/读回/重命名/删除，关闭句柄并清理目录 |
| 平台模式 | 基础路径 `/`、多线程支持为 false |
| Transform / FPU 运算 | float/double 的寄存器构造、90 度旋转、非均匀缩放、逆坐标变换、均匀缩放的逆变换及组合；double 大于 2^33 坐标的精度；整数 0/1/31/32/255 位算术右移 |

本轮综合脚本与汇总均退出 0。普通 Program 的 6 组检查和基础服务的 7 组在 Node/Chrome/Edge 通过，第六组包含新增的算术右移检查；ApplicationCore 的四组浏览器检查各 15 项通过，Engine 十个关键对象及额外 `TagTrace.cpp` 强制重编通过。此综合回归不包含完整 Engine 构建；单独完整构建的最后一次失败仍按下文保留。引擎头文件仍有 Clang 枚举算术、switch 覆盖和 void 函数 nodiscard 警告；“零警告”仅指 UBT 的 C# 构建，以上结果不能等同于完整 UE 启动成功。

后续接 Launch/FEngineLoop 与必要的 Engine 依赖，将浏览器回调接到真实引擎 Tick，再接最小场景的 RHI/Renderer、Cook/Stage/挂载、HTML UI 桥。数组纹理、材质层等可选功能继续延后。P2 的旧原生宿主仍停在距离场默认 ByteAddress SRV；已有目标源码条件裁剪尚未链接到它，P2 不因此标为完成。

## ApplicationCore 与浏览器循环

新增独立 `UEWebApplication` Program Target，启用 ApplicationCore，保留原 Core-only Target。`FWebPlatformApplicationMisc::CreateApplication` 创建 `FWebApplication`，使用目标分支的 `GenericApplication`、`FGenericWindow` 和 `FGenericApplicationMessageHandler`；没有复制或模拟这些 UE 接口。

浏览器事件只写入队列，`FPlatformApplicationMisc::PumpMessages` 在逐帧回调中派发到消息处理器。键盘监听绑定 canvas；网页输入框有焦点时不向 UE 派发按键。鼠标松开监听 window，并换算回 canvas 坐标，处理拖动到画布外再松开的情况。失焦释放已按住的键和按钮。`DestroyApplication` 取消帧回调、移除监听、释放输入状态并清理窗口；测试随后销毁应用对象，再验证没有新帧和消息，重复停止安全返回。

`StartMainLoop` 使用 `emscripten_set_main_loop_arg(..., 0, false)`，由 requestAnimationFrame 驱动调用者提供的 `TFunction<void(float)>`，计算并限制单帧 Delta 为 0..0.25 秒。它不是 FEngineLoop 的实现；当前 Program 只调用消息泵和应用 Tick。尺寸为 CSS 像素，canvas 绘制缓冲随 DPR 调整；浏览器 CSS 改变由消息泵检测。完整窗口管理和 RHI surface 尚待接入。

| 检查范围 | 已运行的结果 |
| --- | --- |
| 循环 | 跨浏览器帧持续增加 UE 计数；停止后保持不变 |
| 键盘 | Shift+W、重复键、释放和 ASCII 字符进入 UE；失焦释放仍按住的 A |
| 鼠标 | canvas 内位置、左键按下、canvas 外松开及相对坐标 |
| 滚轮 | 对照实际 DOM 的 CSS 滚动量检查方向与数值，DPR 1/2 分别验证 |
| 网页 UI | HTML 输入框能够输入文字，不增加 UE keyDown 事件 |
| 焦点与尺寸 | 前台/失焦消息、320x180 CSS 尺寸及 DPR 对应的绘制缓冲大小 |
| 清理 | 停止与销毁后再发送 DOM 输入，没有新帧或消息；重复停止 |

Chrome 155.0.8059.40、Edge 155.0.4283.45 各执行桌面 1280x800 / DPR 1 和窄视口 390x844 / DPR 2，共四组、各 15 项通过，页面/控制台错误为空。窄视口是 Windows 浏览器测试，不是移动设备验证。ApplicationCore 的 208 个目标源码文件逐一核对隔离副本哈希，20 个已链接模块对象核对 WASM 头和编译响应；数量仅用于审计。

此前遇到的 ApplicationCore 编译问题只作局部处理：Web 平台头将 Splash 复用为通用空实现；通用软件光标的声明/定义在 Web 下不编译，以免依赖桌面 RECT，Web 使用自己的最小光标位置适配。没有移植桌面启动画面、光标裁剪或其他可选功能，没有移除 UMG/Slate 依赖。

边界：单 canvas、旧 DOM keyCode 与 ASCII 字符；修饰键仅记录聚合状态，未区分左右。IME、触摸、手柄、指针锁定、浏览器全屏、原生光标外观、隐藏页生命周期、InputCore/EnhancedInput 和真实游戏输入尚未验证。ApplicationCore Program 只在浏览器运行；Node 继续验证原 Core 样本。P3、完整浏览器 Runtime 和场景均保持未完成。

## Engine Target、UHT 与真实主循环源码

新增 `UEWebEngine` Program Target，启用 Engine/CoreUObject/ApplicationCore，并设置 `bBuildRequiresCookedData=true`、NullRHI、单线程、无声音。此处 NullRHI 只用于准备引擎启动，不验证 WebGPU 绘制。Program 入口准备调用真实 `GEngineLoop.PreInit/Init/Tick`，尚未完成链接或执行。

本轮实际修复了以下构建阻塞：

1. 隔离宿主补齐安装版着色器目录引用及 UHT 配置副本。缺少 UHT 配置会让所有带参数委托解析失败，不需要逐个修复 Engine/UMG/AI 类型。
2. 使用 Cooked Target 排除 DDC/Zen 的开发运行依赖；Web ImageWrapper 规则移除 Oodle 依赖，Launch 同步排除 Oodle 启动调用。
3. 工具链在 `bCompileISPC=false` 时返回空 ISPC 输出，与引擎既有行为一致；真正启用 ISPC 仍拒绝。
4. Web CoreUObject 明确关闭脚本虚拟栈选项。Blueprint 上下文在平台不支持虚拟内存时不实例化该分配器，沿用已有 alloca 路径，没有模拟 reserve/commit。
5. Web 选择引擎已有的寄存器式 Transform API，由 `UnrealMathFPU` 实现；CPU SIMD 仍关闭。解决 Chaos 头的寄存器构造要求，没有移植新的 SIMD 后端。

`probe-web-engine-target.cjs` 通过普通 UBT 导出待构建动作、执行 UHT，并强制重编十个文件：`LaunchEngineLoop.cpp`、`Launch.cpp`、`ScriptCore.cpp`、`UObjectBase.cpp`、`GameEngine.cpp`、`Preshader2.cpp`、`SkeletalRenderCPUSkin.cpp`、`InputCoreTypes.cpp`、`WebPlatformInput.cpp` 和测试入口。新增文件覆盖完整构建实际遇到的错误；InputCoreTypes 调用方和新增网页键码实现分别编译。定义要求 `WITH_ENGINE=1`、`WITH_COREUOBJECT=1`，对象检查 WASM 文件头和 `-m64`；符号检查要求存在真实 `FEngineLoop::PreInit/Init/Tick/Exit` 定义且不再引用 Oodle 初始化。CoreUObject、Engine、UMG 的反射产物及目标源码副本记录哈希。

初次 UHT 成功生成 6,200 个文件；待构建动作数随缓存变化，均不作为完成比例。选定对象编译成功也不代表其余 Engine 模块已编译或链接。接下来仍需完整 Engine Target 构建、处理实际链接依赖和第三方库、挂载配置及 Cook 资源，再验证浏览器真实初始化、Tick 和退出。Renderer/WebGPURHI、Cook/Stage 与场景继续保留未完成状态。

## 完整 Engine 构建入口

新增 `build-web-engine.ps1`，直接执行普通 `UEWebEngine Web Development` 的完整构建，首个失败后停止调度。Engine Target 启用 UE 自带 Unity 合并编译，十对象诊断通过 `-WebEngineCompileProbe` 继续逐文件编译。Core/ApplicationCore 的构建设置保持不变。

每次复跑只删除当前 Engine Target 的单个 Makefile 缓存，保留编译对象；这是因为新增 HTTP 平台规则后，UBT 曾复用旧图导致平台 include 路径未生效。脚本在隔离宿主写入遇错停止配置，记录带时间的构建日志、UBT 详细日志和 `web-engine-full-build-results.json`，包括退出码、编译错误、进程失败及源码哈希。完整构建失败会退出非零；不以关键对象诊断通过代替整程序成功。

本轮完整构建先暴露统计模块引用缺失的 `WebPlatformHttp.h`。Web HTTP 规则补充平台 include 路径，复用 `FGenericPlatformHttp` 并关闭默认事件循环及本地 HTTP 服务器。通用请求的 `ProcessRequest` 返回 false，没有实现浏览器网络传输，没有接入 Curl/WinHTTP；该修改只解决构建依赖。

后续 AnimGraphRuntime 的编译暴露 Chaos FPU 头的两处 `Vec`/`V` 笔误和 double 分支误用 float 构造，以及 `VectorShiftRightImmArithmetic` 未实现。修改限于这三处头文件调用和四分量带符号右移，不移植物理系统新功能；大于等于 32 位的立即数按符号位扩展，避免 C++ 超宽移位。Core Program 的第六组新增负数、正数和 0/1/31/32/255 位移检查。

上述修复后，完整构建的 AnimGraphRuntime 与 AppFramework 合并单元均通过。下一处 AudioMixerPlatformAudioLink 编译要求 `FPlatformProperties::GetRuntimeSettingsClassName`，Web 属性补充 `/Script/WebTargetPlatform.WebTargetSettings`，调用方只把它作为 INI 节名读取；此处没有新增反射设置类或音频后端，启动仍使用 `-nosound`。

此前完整构建通过 AudioLink/AudioMixer、Chaos 主模块和 CoreUObject，在 Core 的 LLM 私有头停止：分配器模板的实例化声明同时具有 `always_inline` 和 `noinline`，Clang 拒绝。Web 通过已有 `PLATFORM_SUPPORTS_LLM=0` 开关关闭低级内存分析器，不移植该分析工具；Engine 编译诊断额外重编触发该头的 `TagTrace.cpp`。本轮完整构建的 19 个 Core Unity 单元通过，包括原失败的 `Module.Core.12.cpp`，已实际越过该阻塞。

`web-engine-full-20261015-214936.log` 已进入 Engine 本体，停止于 `Module.Engine.47.cpp` 的 `Preshader2.cpp`。Move 解码和打印各有三处将非 constexpr 的 `int` 列表初始化为 `uint8`；值已被掩码限制为 0–3 或 0–1，只补六个显式转换，不改变 Preshader 格式或运算。该文件在目标 5.8.3 与安装版 5.8.0 间只有行尾差异；隔离 Engine 改用安装版源码本地副本，仅覆盖这一目标文件。4,037 份文件哈希比较确认唯一差异为 Preshader2，安装原件未修改。

第二次完整构建 `web-engine-full-20261015-224419.log` 已通过上述 Unity 单元，随后停止于 `Module.Engine.49.cpp`。`SkeletalRenderCPUSkin.cpp` 的三个原始调用传入 `const uint16*`，FPU 的 `VectorLoadURGBA16N(void*)` 却要求可写指针。修正只将参数改为 `const void*`、内部指针改为 `const uint16*`；不改变四通道数值读取，不增加 CPU 蒙皮功能。原始 Preshader2 与 CPU 蒙皮源码纳入当时的八对象探针。

继续构建的 `web-engine-full-20261015-231703.log` 已通过 CPU 蒙皮合并单元，随后在 `Module.Engine.51.cpp` 的 `SparseVolumeTextureData.cpp:722` 遇到两处 `int32` 到 `SIZE_T` 列表收窄。只给 `GPixelFormats[].BlockBytes` 补显式转换，没有移植稀疏体积纹理功能，也未关闭全局诊断。`prepare-web-core-host.ps1` 在隔离 Engine 的安装版副本中覆盖目标 Preshader2 和该文件；4,037 份文件哈希比较确认仅这两份不同，安装版原件未修改。

`web-engine-full-20261016-001504.log` 已通过原失败的 Engine.51、其余 Engine 本体单元和 HTTP，随后停于 `Module.InputCore.cpp` 缺少 `Web/WebPlatformInput.h`。新增 InputCore 的 Web 平台规则、头和键码表：物理键映射承接现有 ApplicationCore 的 DOM keyCode；字符映射复用 UE 的通用表。只覆盖基础键盘输入，IME、左右修饰键区分、触摸和手柄仍未实现。键码表进入 UE 输入管理器后的浏览器行为，仍需完整引擎运行验证。

接着执行的 `web-engine-full-20261016-003317.log` 因 SDK 缓存竞争在 Chaos.24 停止，退出 6、未进入链接。并行语法检查使用了不同斜杠形式的 `EM_CONFIG`，使 Emscripten 的字面 `LLVM_ROOT` 校验值变化并清空共享缓存；当时正在运行的编译找不到标准库头 `__utility/scope_guard.h`。这不是 Chaos 代码错误。头文件与 SDK 源文件哈希一致后，原 Chaos.24 响应参数串行重放退出 0，产生 4,831,573 字节 WASM 对象；InputCore 整个合并单元的语法检查也退出 0。

两个构建入口统一 SDK 配置路径形式；基础回归在开始前刷新 Core/Application 的单个 Makefile，Engine 诊断与完整构建原有的 Makefile 刷新保留。原因是 UBT 会从缓存 Makefile 恢复旧环境，单改父进程环境仍会反复重置 SDK 缓存。保留编译对象，不跳过 SDK 校验；共享同一 SDK 缓存的额外检查按串行执行。独立失败单元重放不能代替完整 Target 复跑成功。

后续 `web-engine-full-20261016-013125.log` 再次通过 Chaos（包含原失败的 Chaos.24），在 CoreUObject 阶段中断；`web-engine-full-20261016-081334.log` 续编通过剩余 CoreUObject、Core，进入 Engine 本体后中断。两次均没有最终退出码或 `Result`，不能当作成功或新的编译失败，也没有覆盖上次正常结束的完整构建报告。系统 `LastBootUpTime` 为 2026-10-16 08:27:31，与第二次中断吻合，重启原因未诊断。09:00 的续编使用独立隐藏进程、保留带时间的标准输出和错误日志；UBT 检测到上次中断的 Engine.17 依赖文件不完整并重新编译，该单元已通过。当前继续原有完整目标，不增加可选功能。

`web-engine-full-20261016-090048.log` 重新通过全部 Engine 本体与 HTTP，停止于 `Module.IoStoreHttpClient.cpp`：`Socket.inl:66` 在未知平台分支引用缺失的 `CoreHttp/Http.inl`。退出 6，未进入链接。虽然 `bCompileIoStoreOnDemand` 默认 false，Engine 的私有依赖列表仍无条件包含 IoStoreOnDemand，后者带入 IoStoreHttpClient。新增 `Engine_Web.Build.cs` 只移除 Web 下这条私有依赖，保留资源管理器使用的 IoStoreOnDemandCore；显式请求远程下载时拒绝构建。没有补 POSIX 套接字、TLS 或下载实现，也没有移除本地 Pak/IOStore 资源路径。诊断增加链接输入检查，要求排除两个下载模块、保留接口模块；实际本地 Cook 资源加载仍待实现。

裁剪后的综合回归输出为 `web-ubt-integrated-20261016-095424.out.log`，错误日志为空；最终 Engine 十个选定对象及 TagTrace 通过，`ioStoreOnDemandNetworkExcluded=true`、`ioStoreOnDemandCoreRetained=true`。汇总退出 0。10:09 再次启动完整 Target；选定对象通过仍不代表完整合并单元、链接或浏览器启动通过。

`web-engine-full-20261016-100949.log` 已通过 Engine 本体全部合并单元、IoStoreOnDemandCore 和 Launch，越过原下载模块阻塞。InputCore 完整对象在前次构建结束前已成功生成，本次正常复用，符号检查包含 `FInputKeyManager::InitKeyMappings`、`FWebPlatformInput::GetKeyMap/GetCharKeyMap`。后续停止于 MovieSceneTracks.2：`MovieSceneSkeletalAnimationSection.cpp:76–78` 将三个秒数表达式从 double 列表初始化到原有 float 字段。只增加三个 `static_cast<float>`，不改字段布局或时间变换逻辑。

MovieSceneTracks 改用安装版 5.8.0 的隔离本地副本，仅覆盖目标 5.8.3 的上述文件；目标文件原有的两处骨骼空指针检查保持。未通过目录联接修改安装引擎。完整报告审计目标文件及副本；11:10 的完整续编已通过原失败单元，继续后续依赖与链接。尚未验证动画运行行为，也未新增 Sequencer 或动画功能。

`web-engine-full-20261016-110959.log` 已通过全部 MovieSceneTracks/MovieScene、NullDrv 和 PakFile 单元，随后停于 RHI.3 的 `RHIValidation.cpp` 六处 uint32 到 uint16 列表收窄，退出 6、未进入链接。Web 不移植这套可选调试层，新增 `RHI_Web.Build.cs` 公开定义 `ENABLE_RHI_VALIDATION=0`，沿用 `Misc/Build.h` 已有覆盖入口，使 RHI 与使用它的模块保持一致的资源布局；不关闭全局收窄诊断，也不修改 RHIValidation 源码。诊断增加原失败源文件编译、排除校验实现符号，以及 Launch/Engine/测试入口中该定义的一致性检查。既有 Dawn/WebGPU 校验测试配置未改变。

最终综合回归 `web-ubt-integrated-20261016-112105.out.log` 完成，错误日志为空。Core Program 六组、基础服务七组在 Node/Chrome/Edge 通过，ApplicationCore 四组各十五项通过，Engine 十个关键对象、TagTrace 和原失败的 RHIValidation.cpp 均编译通过；校验实现符号被排除，Launch/Engine/入口的公开定义一致。`summarize.cjs` 退出 0，`p3EngineCompileProbePass=true`。随后串行重放原 `Module.RHI.3.cpp.o.rsp`，只改输出与依赖文件位置，退出 0，生成 2,400,739 字节 WASM 对象，证据见 `web-rhi3-replay-results.json`。这不是完整 Target 复跑；当时最新完整失败报告保留为历史快照，`webEngineFullBuildMatchesCurrentSources=false`、`webEngineTargetBuildSucceeded=false`，没有后台完整构建。11:50 已另行启动新定义下的完整重编，见本文开头。

扩大构建核心范围时出现 Clang WebAssembly 指令选择和 CLR 原生崩溃。原先失败的 AppFramework 合并单元在此前使用的两个逻辑核心下重放通过，因此撤回了临时的控件裁剪和模块 Unity 例外，没有保留 UMG/AppFramework 功能修改。崩溃根因尚未确定；完整构建脚本沿用两个核心并在结束后恢复亲和性。ChaosCore 使用目标 5.8.3 的隔离副本，其余未覆盖依赖仍为安装版 5.8.0。

```powershell
& H:/ue_html/tests/web-platform/build-web-engine.ps1
```

## 复跑与结果

先启动现有 `tests/web-platform/serve.cjs`，保持 localhost:8765 可用。PowerShell 7 在 `H:\ue_html` 执行：

```powershell
& .\tests\web-platform\build-web-ubt.ps1
node .\tests\web-platform\summarize.cjs
```

构建脚本设置并恢复当前进程的 SDK 环境与 CPU 亲和性，不永久修改系统配置。

| 结果文件 | 说明 |
| --- | --- |
| `results/web-ubt-results.json` | 工具链、Node/浏览器结果、源码与产物哈希 |
| `results/web-core-types-results.json` | 真实核心类型头、布局及 64 位参数的 Node/浏览器结果 |
| `results/web-core-services-results.json` | 真实 Core 字符串对象链接、7 组服务的 Node/Chrome/Edge 结果及哈希 |
| `results/web-core-program-results.json` | 普通 Target 产物的 Node/Chrome/Edge 6 组执行结果及哈希 |
| `results/web-core-program-node.log` | 普通 Core Program 的 Node 实际输出 |
| `results/web-application-target-results.json` | 普通 ApplicationCore Target 构建成功、源码/副本/对象/产物哈希 |
| `results/web-application-results.json` | Chrome/Edge 两个视口各 15 项循环与输入检查、实际 DOM 滚轮及 UE 事件 |
| `results/web-application-build.log` | ApplicationCore Program 链接及元数据生成成功日志 |
| `results/web-engine-target-results.json` | Engine Target 的 UHT、十个关键编译对象、方法符号与源码哈希；完整链接/运行标记保持 false |
| `results/web-engine-launch-symbols.log` | 真实 FEngineLoop 方法定义与未定义依赖，排除 Oodle 启动引用 |
| `results/web-engine-*-compile.log` | 十个关键源码及额外 TagTrace 强制编译的日志 |
| `results/web-engine-RHIValidation-compile.log` | 原失败源码在 Web 关闭调试校验层后的强制编译；报告另核验消费者定义及校验实现符号排除 |
| `results/web-rhi3-replay-results.json`、`.log`、`.o` | 原失败 RHI 合并单元按原响应参数串行重放，退出 0；不代表完整 Target 已重编或链接 |
| `results/web-engine-full-build-results.json` | 完整 Engine 构建尝试的退出码、错误、源码哈希与链接状态；与选定对象报告分开 |
| `results/web-engine-full-时间.log` | 完整构建普通输出；对应 `.ubt.txt` 保留原生进程退出等详细信息 |
| `results/web-chaos24-replay.log`、`.o` | 原失败合并单元按原响应参数串行重放；退出 0、生成 WASM 对象，不代表整个 Target 通过 |
| `results/web-inputcore-syntax.log` | InputCore 完整合并单元的语法检查；不能代替对象、链接或浏览器输入验证 |
| `results/web-core-compression-source-results.json` | 五个 Core 文件的桌面/Web 条件源码与对象符号验证 |
| `results/web-ubt-build.log` | 隔离 UBT 构建，零警告/零错误 |
| `results/web-ubt-sdk.log` | Web SDK 校验 |
| `results/web-ubt-smoke.log` | 三个实际编译/归档/链接动作 |
| `results/web-ubt-missing-sdk.log` | SDK 缺失拒绝 |
| `results/web-core-target-diagnostic.json` | 26 个 Core 对象和入口、链接对象审计、成功构建与产物哈希 |
| `results/web-core-source-compile.log` | 23 份 Core、3 份平台实现与程序入口分别强制编译的成功日志 |
| `results/web-core-services-build.log` | 包含真实 Core 字符串对象的诊断样本构建 |
| `results/web-ubt-core-target.log` | 普通 Target 链接及 WriteMetadata 成功日志 |
| `results/web-ubt-integrated-run.log` | 本轮 P3 综合回归输出 |
| `build/web-ubt-smoke/actions.json` | 编译→归档→链接依赖关系和实际命令 |
| `build/web-core-target/actions.json` | 普通 Core Target 当时待构建的动作；数量随缓存变化 |
| `web-core-program.html` | 普通 Core Program 测试页；加载 `build/web-core-program` 中与原产物哈希一致的副本 |
| `web-application.html` | 单 canvas 与 HTML 输入框测试页；加载普通 ApplicationCore Program 的相同哈希副本 |

Core 和 ApplicationCore 汇总分别核验可运行 Program 及浏览器输入子集。`p3EngineCompileProbePass`、`webEngineReflectionGenerationVerified`、`webLaunchEngineLoopWasmCompiled` 只核验 Engine 构建链及选定对象。`webEngineTargetBuildSucceeded=false`、`webEngineLoopBrowserTickVerified=false`、`p3Complete=false`、`completeBrowserUERuntime=false`，因为完整 Engine 链接、初始化、Renderer 和场景尚未完成。

## 上轮关闭 LLM 后的基础回归（历史）

`build-web-ubt.ps1` 与 `summarize.cjs` 均退出 0。普通 Core Program 重新编译、链接和 WriteMetadata 成功；Node/Chrome/Edge 的 6 组检查通过，`arithmeticShiftFPUVerified=true`。独立基础服务 7 组继续通过。ApplicationCore 重新编译、链接成功，Chrome/Edge 的桌面和窄视口共四组、各 15 项通过，错误列表为空。

Engine 六个关键源码重新编译通过，真实 FEngineLoop 方法符号及无 Oodle 启动引用检查继续通过。额外的 `TagTrace.cpp` 编译退出 0，Engine 测试入口通过 `WITH_ENGINE && !ENABLE_LOW_LEVEL_MEM_TRACKER` 编译断言。它们只验证关闭 LLM 后的相关源码，未完成完整 Engine 链接或运行。

当时完整构建报告对应 `web-engine-full-20261015-210407.log` 的 LLM 失败，`webEngineFullBuildAttempted=true`、`webEngineFullBuildReportVerified=true`。后来关闭 LLM，`webEngineFullBuildMatchesCurrentSources=false`；这是修复前的历史失败快照，不代表当前源码完整构建成功或仍存在同一错误。当时 `webEngineFullLinkAttempted=false`，没有新的 Engine JS/WASM 产物。最新完整尝试及验证结果见本文开头。

此前已从关闭 LLM 后的版本继续完整构建，并处理 Preshader/FPU 错误；本轮进一步通过原失败单元、修正两处 `SIZE_T` 收窄并补基本输入平台入口。后续仍需剩余编译和链接、浏览器真实 PreInit/Init/Tick、WebGPURHI/Renderer、Cook/Stage、最小静态场景与 HTML UI 桥，未新增数组纹理、材质层或 UMG 功能。
