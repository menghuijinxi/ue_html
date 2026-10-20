# UE 5.8 WebGPURHI：核心、材质、资源状态、视口与 SRV 测试

日期：2026-10-20。

## 当前进度

**2026-10-20 第四十八轮：双浏览器已越过 RenderCurve 和 Nanite 默认缓冲初始化。** RenderCurve 保留注册、Web 禁用扩展并清零默认参数；Nanite 材质/ownership 默认参数清零，已有平台能力检查保留。三个文件共新增 16 行 Web 分支，其他平台正文保留，没有移植毛发、Nanite 或 Raw/Structured Buffer。重编原有 Engine.32 解决诊断链接材质符号缺失，未修改材质逻辑；最终 28 单元/415 项诊断链接通过。

ApplicationCore 正常构建与双浏览器 68 项窗口测试、4 组 marker ABI 正反例、原 40 项和阶段回归通过。共享 RHI 与 Cook 本轮未改，沿用已核验的原生深度/综合/二维/视口/静态/Unlit 和 Cook 证据。真实地图 BeginPlay、NullRHI 各 10 个有效 Tick；WebGPU 当前卡在 GetDefaultSkinningParameters 的默认 Raw Buffer，Init 未返回、完成 Tick 和实际深度 pass 为 0。下一步只排除未用蒙皮默认初始化并核对消费者；首帧与完整正常 Web UBT 仍未验收。详见 P3 第四十八轮。

以下为历史检查点。

**2026-10-20 第四十七轮：双浏览器已越过局部雾、DBuffer 与反射的默认资源初始化。** 两个局部雾入口只在 Web 清零参数；BasePass 在 DBuffer 关闭检查下清零参数，未用阴影数组设空，反射参数清零，调试/遮挡反馈默认 UAV 设空。没有实现雾、数组、Cube 或 Raw Buffer。移除本轮分支后，局部雾精确恢复上轮源码 SHA256，BasePass 恢复安装版完整正文。25 单元/415 项诊断链接通过。

本轮共享 RHI 未改，上一轮 18 项深度、综合 43 draw/5 dispatch/1,344,520 值及二维/视口/静态/Unlit 的有效来源与产物沿用哈希核验；没有声称重新跑原生探针。ApplicationCore 正常构建与 68 项双浏览器窗口测试重新通过，原 40 项和平台阶段回归重新通过。真实地图 BeginPlay、NullRHI 各 10 个 Tick；WebGPU 当前到完整深度预通道构建网格命令时，HairStrands 的 RenderCurve 场景 Uniform 默认回调创建 Raw Buffer 失败，Init 未返回、完成 Tick 和实际深度 pass 都为 0。新 `verify-web-local-fog-defaults.cjs` 和 ES31 阶段通过，首帧与完整正常 Web UBT 未验收；详见 P3 第四十七轮。

以下为历史检查点。

**2026-10-20 第四十六轮：基础深度/模板附件与真实读回已验证。** PF_DepthStencil 使用 Depth24PlusStencil8，分别提供附件、DepthOnly 和 StencilOnly 视图；按 UE 资源状态、采样标量类型和深度/模板只读语义校验。临时 RHI 退出恢复宿主格式记录。recorded/bypass 共 18 项新增检查通过，验证 reversed-Z 遮挡、第二个只读通道、GPU 深度 0.75/模板清值 37、非法输入拒绝与注册恢复。模板比较/写入管线、MSAA、深度拷贝和 mip 链仍未支持。

此前因深度格式失败的完整原生 WebRHIProbe 已重新通过：43 次 draw、5 次 dispatch、1,344,520 个值，包含深度写入转只读后的遮挡。正常原生构建、二维 232 项、视口 72 项、静态绑定 38 项、空 UniformBuffer 8 项和两套 Unlit 像素回归通过。仅 Web 排除三个移动数组默认值，并用现有清零构造代替未用 dummy 灯光缓冲初始化；没有扩展数组、Raw/Structured Buffer 或光照。

24 单元/415 项诊断链接及原 40 项、平台阶段回归通过；Chrome/Edge 均越过 SceneDepthZ 格式检查，地图 BeginPlay、NullRHI 各 10 个 Tick。当前 WebGPU 卡在局部雾默认数组的 RegisterExternalTexture 校验，实际深度分配和深度 pass 都是 0，硬件 Init 未返回、完成 Tick 为 0。新增 `verify-web-scene-depth.cjs` 明确区分原生深度通过和浏览器尚未执行；首帧及完整正常 Web UBT 仍待验收，详细证据见 P3 第四十六轮。

以下为历史检查点。

**2026-10-20 第四十五轮：呈现最终转换和空 UniformBuffer 生命周期已接通，真实项目地图已 BeginPlay。** RHI 声明 NeedsExtraTransitions，保留 Present 状态检查，并实现无需浏览器同步等待的 RHITick。原生视口测试改用与 Slate 相同的 Unknown→Present，同时验证未转换时访问仍被拒绝；72 项/143,976 通道值通过。空 UniformBuffer 新增 8 项创建和更新快照检查通过，静态绑定仍为 38 项，二维和既有 Unlit 像素回归通过。计算调度上限读取实际设备限制。可选 GPU 消息、光照 Profile、VSM、天空反射和对应 View 参数仅在 Web 排除；未增加数组/Cube/Raw Buffer 支持。WebGPU 首帧、连续 Tick 和完整正常 UBT 仍按 P3 单独验收。

最终 23 单元重编、415 项诊断链接通过。Chrome/Edge 的真实 `/Game/WebMinimal` 都到达 BeginPlay，NullRHI 各完成 10 个 Tick；硬件路径在 Init 内首次场景重绘创建 `SceneDepthZ` 时，因 DepthStencil 格式 Supported 检查停止，仍为 0 个完成 Tick。启动清屏的 2 次 draw 和 23 个命令缓冲已提交并通过队列完成检查，不能作为场景首帧。阶段回归和原 40 项 Shader 回归通过；下一步核对深度格式能力及视图/模板语义，重新运行已有 reversed-Z 与浏览器用例。详细记录见 P3 第四十五轮。

以下为历史检查点。

**2026-10-20 第四十四轮：实际 WebGPU Init 已返回，PSO 缓存保护保留。** 同一 WASM/内容的 Chrome、Edge 单变量对照确认：开启异步缓存合并复现保护，关闭后越过；Web 使用引擎现有同步路径。另用既有 Web GPUScene 能力判断排除灯光上传调用，不增加 Structured/Raw Buffer 功能。22 单元、415 项诊断链接通过，输出 ES3.1/834 Shader/GPUScene 关闭的 P3_ENGINE_READY。

当前首次 Tick 到 EndDrawingViewport 时资源仍为 RTV 0x1000，要求 Present 0x2，保护报错；完成帧数仍为 0。默认 OpenWorld 地图也未 Cook，已触发 MapNotFound 退出请求；Init 返回、回调计数和场景加载必须分别记录。新增 PSO 对照与核验入口，Cook 校验增加 -noshaderddc 以保留真实作业记录；具体回归和剩余项见 P3。共享 RHI、安装版 PSO 保护和原子操作本轮未改，以下为历史检查点。

**2026-10-20 第四十三轮：真实 Cook 归档已在 Chrome/Edge 创建 Shader 和图形管线，完成首次清屏 draw 提交。** Web 编译入口输出未压缩代码，834 条归档 Shader 的哈希、映射和 1,049 个作业的 WGSL 全部保留；共享 RHI 正确读取 UE 可选数据，16 项原生正反例通过。默认 bAllowMSAA 许可不再阻断单采样清屏，NumSamples=1 限制保留，两种原生命令模式的绘制/像素回归通过。

两浏览器各 2 个 ShaderModule、1 条管线、1 次 draw、15 个命令缓冲及真实队列完成，无 GPU validation；35 张/107 mip/9,454,164 字节读回及 NullRHI 各 10 帧通过。当前正常原生构建、二维 232 项、视口 72 项、静态绑定 38 项、两套 Unlit 和原 40 项回归通过。新 verify-web-shader-payload.cjs 及阶段汇总通过，完整 WebGPU 启动仍 false、0 Engine 帧：当前停在 PipelineStateCache.cpp:1797 的缓存合并保护，底层原因待查，未验证场景或清屏像素。

重新 Cook 163 包，327 文件增至 51,157,974 字节；未增加浏览器 Oodle 解码器或 MSAA。最终 415 项诊断链接通过，21 单元重编及本轮此前 RenderCore.3 的保留编译证据均与实际对象核对。下一步处理单线程 PSO 缓存合并，再验证连续 Tick 和 Unlit 场景；完整正常 Web Engine UBT 未验收。完整复现和证据边界见 P3，以下为历史检查点。

**2026-10-20 第四十二轮：Web 固定 FIFO 呈现接入与 Canvas 区域查询已通过，进入真实 Shader 归档读取。** Web 后端接受调用方非 VSync 请求，surface 仍为 FIFO；原生 VSync 校验和原生呈现保持原状，未改 Slate 调用方或 SDK。WebWindow::GetFullScreenInfo 返回现有虚拟显示的 CSS 区域；正常 ApplicationCore Program、四组 DPR/窗口输入及区域测试共 68 项通过。

Chrome/Edge 各完成一次视口结束和后缓冲引用清理；到失败点各提交 14 个命令缓冲，队列完成检查在纹理读回前通过。当前已开始一个 CanvasClear render pass，但 ShaderModule、管线、draw 均为 0；准确阻塞为 TOneColorVS 对应 Shader 归档的 Oodle 解压，不是场景首帧。两浏览器仍为 0 Engine 帧。

最终 22 单元重编、415 项诊断链接通过；原生二维 232 项、视口 72 项、静态绑定 38 项及两套 Unlit GPU 对照重新通过。二维读回各 35 张/107 mip/9,454,164 字节、NullRHI 各 10 帧、原 40 项 Shader 和 WASM64 标记正反例回归通过。新增 verify-web-browser-fifo.cjs，阶段汇总通过；下一步处理 Web Shader 归档的免费压缩或未压缩格式，完整正常 Web Engine UBT 与场景首帧未验收。详细证据见 P3，以下为历史检查点。

**2026-10-20 第四十一轮：共享 WebGPURHI 已实现静态 UniformBuffer 绑定，实际 Engine 推进到首次 EndDrawingViewport。** 支持整批替换/清空、单槽替换/清空、上下文强引用和关闭时释放；按 UE 布局哈希查找运行时静态槽，常量与资源表共用解析入口，保留布局、标志及双重绑定校验。

原生 recorded/bypass 静态绑定共 38 项通过。真实 Unlit 的静态 View 和直接绑定各 19 次 GPU 绘制、各比对 1,114,112 个通道值，默认图像一致，静态路径解析 38 次，无验证错误；新材质定向入口使用已有临时全局 RHI 环境。旧综合探针的深度格式 Supported 检查失败未计入通过项，详见 P3。正常原生 UBT、二维 232 项、隐藏 HWND 72 项/143,976 个通道值重新运行通过。

22 个实际 Web 单元重编、415 项诊断链接通过。Chrome/Edge 实际各执行一次空 RDG 静态绑定，推进到 EndDrawingViewport；当前阻塞为首次 Slate 请求不锁定 VSync，而后端只支持 FIFO/VSync。仍是 0 Engine 帧、无已验证浏览器呈现；各 35 张/107 mip/9,454,164 字节读回及 NullRHI 各 10 帧通过。新增 `probe-web-static-uniforms.ps1`、`verify-web-static-uniforms.cjs`，完整正常 Web Engine UBT、字节码和场景首帧仍待验收。以下为历史检查点。

**2026-10-20 第四十轮：实际 Engine 首次获取 Canvas 后缓冲，并发送 GPU breadcrumb。** Web 局部跳过当前 Unlit 不用的矩形灯光/BSDF LTC 默认纹理，未扩展 RG16F 或高级光照；完整桌面初始化和安装版不变。随后定位并修复 Emdawn 两个 InsertDebugMarker 接口的 WASM64 指针签名，以受版本控制的 port 在生成签名表之后补两条元数据，SDK 和共享 C++ 实现保持原状。

Chrome/Edge 独立正反例均通过：未修复版本复现 BigInt 错误，修复版本各接收命令/渲染通道共 6 条定长、中文 UTF-8、空字符串标记，真实 GPU 提交完成且无验证错误。实际 Engine 各配置一次 640×360 BGRA8、获取一次后缓冲、接收两条 RDG 标记，GPU validation 为 0；仍为 0 帧，当前卡在 `RHISetStaticUniformBuffers` 未实现。

18 个实际单元重编、415 项诊断链接通过；各 35 张二维纹理、107 mip、9,454,164 字节读回一致，NullRHI 各 10 帧，原 40 项/当前材质条件及阶段汇总通过。ApplicationCore 60 项重新运行通过，既有原生 RHI/视口证据哈希复核有效。新增 `build-web-marker-abi.ps1`、`verify-web-marker-abi.cjs`、`verify-web-ltc-defaults.cjs`、`verify-web-breadcrumb-abi.cjs`。下一步补通用 RDG 静态 UniformBuffer 绑定；字节码解压/实际 Shader 创建、场景首帧及完整正常 Web UBT 仍待验收。详细边界见 P3，以下为历史检查点。

**2026-10-20 第三十九轮，15:10：实际 Engine 已配置浏览器 Canvas WebGPU 视口。** 修正空窗口标识、平台默认强制全屏和 10 位后缓冲三项问题；Web 使用稳定单窗口标识、-windowed 和现有 8 位设置，非法参数检查保留。当前 Emdawn 不填写 surface usages，仅 Web 用浏览器实际配置验证；原生能力检查保留。

Chrome/Edge 均实际 configure 为 640×360、BGRA8、usage=17，GPU validation 为 0，但后缓冲获取仍为 0、Engine 仍为 0 帧。启动进一步到 GGX.LTCAmp 的 PF_G16R16F；下一步先排查当前 Unlit 路径不需要的 LTC 初始化，不扩展整套高级光照。正常 ApplicationCore UBT/四组 DPR 输入测试共 60 项、原生二维 232 项、原生隐藏 HWND 72 项及 143,976 个通道值全部通过。两浏览器二维读回各 36 张/108 mip/9,486,932 字节一致，NullRHI 各 10 帧，原 40 项证据和阶段回归通过。

新增 `capture-web-canvas.cjs` / `verify-web-canvas-viewport.cjs`；18 个实际链接单元重编、415 项增量链接，显式拒绝未参与链接的重编产物。完整正常 Web UBT、Shader 解压/创建和场景仍未验收。详细复现与当前阻塞见 P3，以下为历史检查点。

**2026-10-20 第三十八轮，14:39：已越过系统纹理初始化和引擎默认资源加载，进入游戏窗口/Canvas 视口创建。** 只在 Web 排除未用数组/立方体占位、Perlin 体噪声更新和 Landscape 权重数组默认资源；补齐启动必需的二维整数、半浮点、R8/RG8 路径，预积分纹理使用 UE 原有 RG8 回退。两份引擎源码只增加 25 行条件，桌面实现与安装版保持一致，没有实现通用数组或新的三维格式/更新。

两浏览器各 35 张纹理、107 mip、9,454,164 字节读回一致，GPU validation 为 0；原生正常 UBT 构建及两模式共 232 项检查通过，其中 112 项为本轮二维格式/标量检查，既有计算回归共 20 次派发、1,680 个值。NullRHI 各 10 帧、原 40 项证据、当前材质条件及阶段汇总通过。新增 `probe-web-system-textures.ps1` / `verify-web-system-textures.cjs`，完整启动仍 false、0 帧，当前为窗口句柄/尺寸校验失败；下一步接 Web Canvas 视口。WASM 仍是明确保留旧 unity 分组的 415 项增量链接，完整正常 Web UBT、Shader 解压/创建及场景尚未通过。详细证据见 P3，以下为历史检查点。

**2026-10-20 第三十七轮，14:06：体纹理调试默认资源的启动阻塞已越过。** 完整双浏览器调用栈定位到 GeometryCollectionRenderLevelSetActor 默认对象构造时加载 VolumeToRender；仅 Web 屏蔽该 Actor 的两个默认调试资源并禁用其后处理。安装版源码未改，去掉 Web 分支后的完整文件与安装版一致；受影响单元重编和 415 项增量链接通过。

两浏览器已到达 ObjectSystemReady/系统纹理初始化，二维读回各 12 张、54 mip、7,487,500 字节，GPU validation 为 0；NullRHI 各 10 帧和原有材质证据回归通过。`web-debug-defaults-results.json` 为 true，完整启动仍 false、0 帧，现在卡在系统 BlackArrayDummy 数组占位纹理。下一步核对并禁用已关闭功能的占位初始化，不扩展通用数组纹理；Shader 解压/实际创建、场景和完整正常 Web UBT 尚未通过。详细证据见 P3，以下为历史检查点。

**2026-10-20 第三十六轮，13:50：默认贴花变体不一致已修复，双浏览器已越过原阻塞。** 修复原生 Cook 的平台设置注册，显式关闭移动 DBuffer/Substrate 并启用完整深度预通道；原生清单和两个浏览器均确认 DBuffer=false、fullDepthPrepass=true。v13 实际重编 838 个 Global、211 个材质作业，163 包完成、0 错误、13 警告；原有材质完整性检查保留。

新增 `web-material-policy-results.json` 为 true：仅 3 个 DBuffer 贴花变体移除、1 个 Mobile 变体新增，985 个保留 WGSL 不变，63 个移动 BasePass/贴花像素 WGSL 随条件改变。原 40 项的 Emissive GPU 测试明确使用保留的历史成功产物；当前 39 项工厂排除与原生 24 项检查重新验证。二维纹理各 53 mip/7,487,496 字节、NullRHI 各 10 帧通过；实际 WebGPU 仍 0 帧，当前为 EngineDebugMaterials/VolumeToRender 的 RGBA16F 体纹理创建失败。下一步先排查并排除不需要的调试初始化，解压、实际 Shader 创建和场景尚未验收。详细证据见 P3，以下为历史检查点。

**2026-10-20 第三十五轮，12:26：普通二维纹理初始化已通过真实 GPU 读回。** 补齐尺寸/内存估算、sRGB RGBA8/BGRA8、线性 R8、多 mip 初始化及写入锁，启动 mip 上限改由设备能力确定；没有扩展数组或立方体功能。Chrome、Edge 各核验实际 UE 上传的 11 张二维纹理、53 个 mip、7,487,496 字节，每级 SHA256 相同，GPU validation 为 0。存储字节通过不等于 sRGB 采样、多 mip SRV 或场景绘制通过。

原 40 项回归和 NullRHI 各 10 帧重新通过，旧 Cook 及 415 项链接输入哈希有效。阶段报告 `web-texture2d-results.json` 为 true；实际引擎仍 0 帧，阻塞已从 RHICalcTexturePlatformSize 移到默认贴花材质缺 FDeferredDecalMobilePS。Cook 没有该变体，运行时却要求它；下一步核对两端条件，不跳过材质完整性检查。Shader 解压、RHI Shader 创建、正常完整 UBT 及混合版本边界不变。完整证据见 P3，以下为历史检查点。

**2026-10-20 第三十四轮，11:58：两浏览器已使用 ES3.1/46，真实 Global 与项目库接入通过。** 重新 Cook 的 838 个 Global、213 个材质作业全部通过，163/163 个包。327 个运行文件逐项装入并核验哈希；Global 库识别 726 个 Shader，项目库识别 125 个 Shader，启动越过 Global 映射加载进入普通贴图初始化。

修正了 Cook/WASM 冻结内存布局描述，沿用已有顶点流路径，补齐 ES3.1 下省略未使用 SRV 的条件。文件缓存仅在 Web 将请求回收移到同步回调返回后；Chrome/Edge 各通过 387 个块读取、3 个跨块读取和三次句柄释放，核验 25,362,483 字节；桌面实现与安装版源码一致。原 40 项回归及原 115 个静态网格 WGSL 保留检查再次通过。

本轮阶段报告 `web-es31-runtime-integration-results.json` 为 true，完整浏览器运行报告 `web-engine-webgpu-es31-results.json` 仍为 false。NullRHI 各 10 帧；WebGPU 当前 0 帧，明确阻塞在普通贴图所需的 `RHICalcTexturePlatformSize`。压缩字节码解压、RHI Shader 创建和场景绘制未验证，正常完整 UBT 构建及 5.8.3/5.8.0 混用边界不变。下一步只处理普通二维纹理启动接口，再推进最小场景。完整证据见 P3，以下为历史检查点。

**2026-10-20 第三十三轮，11:21：40 个材质转换失败已全部处理，最小默认资源 ES3.1 Cook 通过。** 39 项按用户要求排除未用的 7 种骨骼/布料、粒子、Landscape 顶点工厂，1 项贴花修复采样/裁剪顺序；排除工厂共退出 72 个旧作业，其中 33 个原本成功。原 115 个普通静态网格作业全部保留并重新编译。体积雾已关闭的能力同步限制深度生成，消除宿主参数 ensure，未修改安装版 DLL。

新缓存键下 838 个 Global、213 个材质作业全部成功，163/163 包、退出 0。两浏览器贴花三轴裁剪各 48 个读回值、原生工厂三组 24 项对照及既有 GPU 回归通过。WASM 所需单元编译/链接通过；库结构为 91 个映射、729 个引用、726 份压缩代码，尚未由引擎解压加载。`materialRegressionVerified=true`，整体仍为 false；NullRHI 各 10 帧，WebGPU Engine 仍用 SM5、缺匹配库、0 帧。下一步统一到 ES3.1、接入实际库并验证最小静态网格第一帧，完整证据见 P3。以下为历史检查点。

**2026-10-20 第三十二轮，10:48：修复只含资源的材质 UniformBuffer 绑定检查，两个 FLocalVertexFactory 失败恢复。** 材质常量优化掉后，纹理和采样器仍通过 UE 资源表绑定；校验现在严格核对表、索引、类型及绑定，不再强制要求不存在的常量描述符。直接调用生产 C++ 函数的两个正例和 13 个反例通过；Chrome、Edge 各执行两个真实 Cook Shader、验证 24 个深度/颜色读回值，WGSL 未改写。

关闭逐作业 DDC 并保留全作业校验后，缓存 `Job` 断言不再出现。实际 Cook 重新转换 839 个 Global 作业全部通过；285 个材质作业中 245 成功、40 失败，失败 42→40、无新增失败，记录到的 115 个普通 FLocalVertexFactory 作业全部转换成功。五个主机编译/链接动作通过，WASM/RenderCore 沿用有效产物；既有两浏览器缓冲、纹理、色调映射、捕获/阴影回归刷新通过。参数 ensure 已通过只读元数据探针定位为 Renderer DLL 的 `ConservativeDepthTextureSize` 与源码 `ConservativeDepthFillSize` 不一致，仍未修复。

完整 Cook 仍退出 3。剩余主要是暂不需要的骨骼/布料、粒子和 Landscape 顶点工厂，下一步约束最小编译及使用范围，不扩展其功能。Global 库结构通过但未解压/加载；NullRHI 各 10 帧，WebGPU Engine 仍缺匹配 SM5 库、0 帧，整体验收 false。完整证据和后续事项见 P3。以下为历史检查点。

**2026-10-20 第三十一轮，10:15：ES3.1 的 839 个 Global Shader 作业全部转换通过，失败 2→0。** 两处局部 Web 数值分支分别避免零法线归一化及无穷深度常量；所有类型、变体数和设置不变，没有新增排除。两浏览器各 10 个相关模块、四个实际 GPU 用例及 256 个 float 读回值通过，既有缓冲、纹理、色调映射回归通过。本轮没有 C++ 修改或重复构建，已有 415 个链接输入及 287 份源文件哈希核验通过。

首次产生 ES3.1 Global 映射（333,357 字节）和字节码库（2,891,378 字节）。库结构核验为 92 个 ShaderMap、730 个引用、727 份 Oodle 压缩字节码；解压、映射反序列化及引擎加载均未验证。Cook 仍退出 3，存在 `ConservativeDepthFillSize` 参数结构 ensure，以及材质作业缓存 `Job` 断言。NullRHI 两浏览器各 10 帧，WebGPU Engine 仍缺匹配 SM5 库、0 帧。`evidenceVerified=true`，整体 `pass=false`。下一步处理主机参数和材质 Cook，按实际文件命名接入并统一 Cook/浏览器配置，再验证场景；详细证据和边界见 P3。以下为历史检查点。

**2026-10-20 第三十轮，09:58：同步关闭 Web 立方体阴影缓存复制，失败 3→2。** 复用既有点光源阴影能力，限制分层/几何顶点和立方体复制 GS/PS，直接立方体复制在读取缓存或准备图资源前明确报错。原生 Cook 按文件和入口精确限制，保留普通全屏、二维和滚动复制；这三个作业本轮重新转换通过。去掉新增保护块后，完整复制函数与安装版一致，实际拒绝及普通复制 GPU 绘制未验证。

完整校验为 839 个独立作业、837 个转换通过、2 个失败。两个类型退出 2 个变体，包含一个旧失败和一个旧成功；其余 1,508 个类型的变体数及 16 项设置不变，无新增失败。原生 RenderCore、两个 WASM 单元及链接通过，415 个链接输入、六份声明/全屏实现文件和两浏览器 Shader 回归通过。NullRHI 各 10 帧、0 页面错误，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体验收 false。下一步处理场景捕获和屏幕阴影，再统一配置、生成匹配库并验证普通场景，详细边界见 P3。以下为历史检查点。

**2026-10-20 第二十九轮，09:48：同步关闭 Web GPU 粒子编译、运行查询及 PSO 预缓存，失败 4→3。** 十个类型退出 10 个变体，包含一个旧顶点失败和九个旧成功；其余 1,500 个类型的变体数及 16 项设置不变，无新增失败。既有初始化、调度和创建消费者读取公共查询；PSO 和向量场调试网格跳过，曲线资源及样本分配受限，直接使用明确报错。系统记账和释放保留；CPU 粒子未改，实际旁路、控制台覆盖及原生 GPU 粒子材质/资产 Cook 未验证。

完整校验为 841 个独立作业、838 个转换通过、3 个失败。原生 RenderCore、四个 WASM 单元及链接通过，415 个链接输入及八份声明/消费者文件核验通过；两浏览器缓冲、纹理和色调映射回归通过。NullRHI 各 10 帧、0 页面错误，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体验收 false。剩余阴影分层复制顶点、场景捕获和屏幕阴影；之后仍需统一配置、生成匹配库并验证普通场景，详细边界见 P3。以下为历史检查点。

**2026-10-20 第二十八轮，09:32：同步关闭 Web 虚拟纹理页表编译及使用能力，失败 6→4。** 八个类型退出 8 个变体，包含两个顶点旧失败和六个像素旧成功；其余 1,502 个类型的变体数及 16 项设置不变，无新增失败。公共 Shader 平台和纹理构建目标查询均返回关闭，既有渲染及场景扩展消费者沿用公共判断；四个直接页表入口在分配/查询前明确报错，系统记账、释放和更新结束逻辑保留。没有移植 VT，普通纹理未改；实际旁路、VT 资产 Cook/拒绝及普通场景纹理绘制未验证。

完整校验为 851 个独立作业、847 个转换通过、4 个失败。隔离原生 RenderCore、两个 WASM 单元及链接通过，415 个链接输入和八份声明/消费者文件核验通过；两浏览器缓冲、纹理和色调映射回归通过。NullRHI 各 10 帧、0 页面错误，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体验收 false。剩余粒子顶点、阴影分层复制顶点、场景捕获和屏幕阴影四个失败；之后仍需统一配置、生成匹配库并验证普通静态网格场景，详细边界见 P3。以下为历史检查点。

**2026-10-20 第二十七轮，09:20：同步跳过 Web 移动遮挡反馈编译和资源初始化，失败 8→6。** 两个类型退出 3 个变体，包含两个像素旧失败及一个顶点旧成功；其余 1,508 个类型的变体数及 16 项设置不变，无新增失败。共享能力约束 Shader 和两处初始化入口，控制台开启也不能绕过；直接初始化/绘制在准备前明确报错，避免空资源被标为已初始化。普通 HZB/硬件查询选择保留，运行旁路及普通遮挡路径仍未场景验证。

完整校验为 859 个独立作业、853 个转换通过、6 个失败。隔离原生 RenderCore、四个 WASM 单元及链接通过，8 份声明/消费者文件和两浏览器 Shader 回归通过。首次 Edge NullRHI 遇到资源加载错误，报告保留；Cook 结束后复测两浏览器均为 10 帧、0 页面错误。WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体验收 false。后续核对虚拟纹理、粒子及阴影分层复制顶点，再统一配置生成匹配库，详细边界见 P3。以下为历史检查点。

**2026-10-19 第二十六轮，21:12：同步跳过 Web 地形纹理输出和 IES 调试，失败 12→8。** 四个类型退出 7 个变体，包含 4 个旧失败及 3 个旧成功；其余 1,506 个类型的变体数和 16 项设置不变，无新增失败。地形限制的是运行时高度图/权重图输出，公共入口返回 false，渲染消费者同步受限；普通地形绘制未修改但未验证。IES 调试与更新共文件、共入口，按类型及文件精确筛选，普通更新 CS 本轮重新转换通过。

完整校验为 862 个独立作业、854 个转换通过、8 个失败。隔离原生 RenderCore、三个 WASM 单元及链接通过，Landscape 已成为工作区独立副本；4 份声明文件及既有两浏览器 GPU 回归通过。普通 IES GPU 执行及两项旁路仍未实际场景验证。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体验收 false。下一步核对遮挡反馈、虚拟纹理、粒子等剩余路径，再统一配置生成匹配库，详细边界见 P3。以下为历史检查点。

**2026-10-19 第二十五轮，20:45：同步跳过 Web 调试/编辑器图元合成和 HMD 畸变，失败 15→12。** 四个类型共退出 6 个变体，包含 3 个旧失败及 3 个旧成功；其余 1,506 个类型的变体数和 16 项设置不变，无新增失败。Shader 条件、合成开关、HMD 后处理序列及专用顶点声明同步限制。HMD 直接入口保留场景颜色或拷贝到指定输出；直接合成调用在资源准备前报错。编辑器专用入口仅源码核验，运行旁路尚未实际场景验证。

完整校验为 869 个独立作业、857 个转换通过、12 个失败。隔离原生 RenderCore、三个 WASM 单元及链接通过，6 份声明文件核验及既有两浏览器 GPU 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体验收 false。下一步核对地形合并和 IES 调试的用途及调用条件，再统一 Cook/运行配置并生成匹配库，详细边界见 P3。以下为历史检查点。

**2026-10-19 第二十四轮，19:43：同步跳过 Web 粒子 GPU 排序的编译、资源初始化和任务接收，失败 22→15。** 七个类型共退出 7 个旧失败变体，其余 1,503 个类型的变体数和 16 项设置不变，无新增失败。任务接收在分配前返回 false，Cascade 保留未排序索引；直接排序调用明确报错，渲染事件通知保留。当前目标不含 Niagara；回退及资源旁路尚未在实际场景执行。

完整校验为 875 个独立作业、860 个转换通过、15 个失败。隔离原生 RenderCore、两个 WASM 单元及链接通过，8 份排序声明/调用文件核验通过；既有两浏览器 GPU 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体验收 false。下一步核对编辑器合成深度、地形编辑和 HMD 等未用路径，再统一 Cook/运行配置并生成匹配库，详细边界见 P3。以下为历史检查点。

**2026-10-19 第二十三轮，18:12：同步限制 Web 稀疏体积更新的编译与流送能力，失败 25→22。** 两个类型共退出 4 个变体，包含 3 个旧失败和 1 个旧成功；其余 1,508 个类型的变体数和 16 项设置不变，无新增失败。既有流送生命周期/请求/更新九处入口读取公共能力，直接上传跳过派发但保留解锁及释放。

完整校验为 882 个独立作业、860 个转换通过、22 个失败。隔离原生 RenderCore、两个 WASM 单元及链接通过，4 份流送实现/上传头文件审计通过；保留路径及既有两浏览器 GPU 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；流送旁路和上传清理未在场景执行，证据核验通过、整体验收 false。后续按最小场景处理剩余作业，再统一 Cook/运行配置并加载匹配库，详细边界见 P3。以下为历史检查点。

**2026-10-19 第二十二轮，18:00：同步限制灯光形状和 HDR 调试显示的 Web 编译及调用，失败 29→25。** 三个类型共退出 5 个变体，包含 4 个旧失败及 1 个旧成功；其余 1,507 个类型的变体数和 16 项设置不变，无新增失败。灯光形状的状态更新、网格/顶点声明准备及绘制入口同步限制；HDR 直接入口保留场景颜色或向指定输出目标拷贝，尚未实际 GPU 执行。

完整校验为 886 个独立作业、861 个转换通过、25 个失败。隔离原生 RenderCore、四个 WASM 单元及链接通过，6 份声明/调用文件审计通过；其他移动后处理、普通阴影/HZB/单采样产物及既有两浏览器 GPU 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体验收 false。后续继续按最小场景处理剩余作业，再统一 Cook/运行配置并加载匹配库，详细边界见 P3。以下为历史检查点。

**2026-10-19 第二十一轮，17:47：同步限制 Web 天空大气的编译、准备及绘制入口，失败 32→29。** 当前配置已关闭该效果；七个类型共退出 103 个变体，包含 3 个旧失败及 100 个旧成功，其他 1,503 个类型的变体数和 16 项设置不变，无新增失败。九个目标编译条件及运行入口读取同一能力，可选采样缓冲跳过 Web 初始化；必要场景记账保留，默认视图资源绑定仅经源码审计。

完整校验为 891 个独立作业、862 个转换通过、29 个失败。隔离原生 RenderCore、两个 WASM 单元及链接通过，10 份调用/声明文件审计通过；其他移动后处理、普通阴影/HZB/单采样产物及既有两浏览器 GPU 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；天空旁路和默认资源尚未在场景执行，证据核验通过、整体验收 false。后续处理剩余必要作业，再统一 Cook/运行配置并加载匹配库，详细边界见 P3。以下为历史检查点。

**2026-10-19 第二十轮，17:32：Web 移动自动曝光的编译与消费者条件同步限制，失败 37→32。** 按共用文件的四个入口精确排除五个旧失败，同文件其余 41 个变体全部重新转换通过；其他 1,505 个类型的变体数和 16 项设置不变，无新增失败。公共运行判断同时约束后处理序列及预曝光，直接入口在资源分配或历史交换前返回，原有固定曝光回退保留。

完整校验为 994 个独立作业、962 个转换通过、32 个失败。隔离原生 RenderCore、两个 WASM 单元及链接通过；普通阴影/HZB/单采样产物及既有两浏览器 Shader 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；固定曝光及场景消费者尚未 GPU 验证，证据核验通过、整体验收 false。后续按最小场景处理剩余作业，再统一 Cook/运行配置并加载匹配库，详细边界见 P3。以下为历史检查点。

**2026-10-19 第十九轮，17:20：Web SMAA 的编译、后处理序列与纹理加载条件同步限制，失败 41→37。** 网页抗锯齿配置本来已关闭；八个类型的 18 个变体退出编译，包含 4 个旧失败及 14 个旧成功，其余 1,502 个类型的变体数和 16 项设置不变，无新增失败。直接 Pass 入口保留指定输出目标的拷贝旁路，尚未执行 GPU 验证。

完整校验为 999 个独立作业、962 个转换通过、37 个失败。隔离原生 RenderCore、四个 WASM 单元和增量链接通过；普通阴影/HZB/单采样产物及既有缓冲、纹理、色调映射两浏览器回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体验收 false。后续按最小场景核对曝光、排序等消费者，再生成和加载真实库，版本和配置等边界见 P3。以下为历史检查点。

**2026-10-19 第十八轮，17:07：Web OIT 三角形排序的编译、索引分配和调度条件同步限制，失败 46→41。** 共 4 个类型、5 个变体退出编译，其余 1,506 个类型和 16 项设置不变，无新增失败。目标公共开关同时约束已有索引替换及移动/桌面排序入口，排序调试 Shader 也补上限制；普通透明混合保留，未扩展 RHI 格式。

完整校验为 1,017 个独立作业、976 个转换通过、41 个失败。隔离原生 RenderCore、两个 WASM 单元及最终链接通过；三个消费者的 6 份安装版/隔离副本审计通过。首次链接已成功，补充消费者审计后使用同一批对象再次链接，未重复编译。普通阴影、HZB、单采样产物及既有两浏览器 GPU 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；真实透明绘制和场景消费者未验证。证据核验通过、整体验收 false；后续按最小场景处理剩余作业及库加载，版本和配置等边界见 P3。以下为历史检查点。

**2026-10-19 第十七轮，16:53：Web 点光源立方体阴影的编译、准备、深度分配和投影条件同步限制，失败 56→46。** 按 `MainOnePassPointLightPS` 入口精确排除 10 个变体，没有排除整个共用文件；其余 1,500 个类型和 16 项设置不变，无新增失败。同文件 15 个普通/调制阴影投影作业全部重新转换通过，未新增 RHI 格式。

完整校验为 1,022 个独立作业、976 个转换通过、46 个失败。隔离原生 RenderCore、三个 WASM 单元及增量链接通过；缓冲、纹理、色调映射两浏览器回归及保留 HZB/单采样产物通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧。普通阴影绘制和实际场景入口未验证，目标材质深度类型条件仅通过编译、未完成实际材质 Cook；证据核验通过、整体验收 false。后续按最小场景核对曝光、排序、SMAA 等消费者，再统一 Cook/运行配置、加载真实库；详细边界见 P3。以下为历史检查点。

**2026-10-19 第十六轮，16:36：4 个共享间接派发参数 Shader 修复，失败 60→56。** Web 缓冲声明和共享写参数函数使用结构化缓冲；没有修改 C++、增加裁剪或扩展 RHI 格式，次表面相关文件只处理其参数生成作业。1,032 个独立作业中 976 个转换通过、56 个失败；全部 1,510 个类型及 16 项设置不变，无新增失败。

Chrome/Edge 各通过 34 个缓冲用例、18,757 个值，包含生成参数后的 29 次真实 `dispatchWorkgroupsIndirect` 及 GPU 计数回读，0 GPU 错误；既有纹理更新、色调映射和保留 HZB/单采样产物回归通过。C++ 未改，既有原生/WASM 编译及链接证据经哈希复核有效，本轮没有重编。NullRHI 各 10 帧；WebGPU Engine 仍缺 Global 库、0 帧。Engine RHI 间接调度及场景未验证；`evidenceVerified=true`，整体验收 false。后续按最小场景核对剩余 56 个失败及消费者，再统一 Cook/运行配置和加载真实库，版本等边界见 P3。以下为历史检查点。

**2026-10-19 第十五轮，16:19：局部雾和体积雾的 Web 编译与运行条件同步关闭，失败 67→60。** 配置开关原本已关闭，本轮补齐未读取开关的 Shader 和消费者，保留局部雾空资源初始化。8 个类型共 28 个变体退出编译，精确包含 7 个旧失败、21 个旧转换成功作业；其余 1,502 个类型和 16 项设置不变，无新增失败，没有增加 RHI 格式。

完整作业校验覆盖 1,032 个独立作业：972 个转换通过、60 个失败。原生 RenderCore、三个相关 WASM 单元编译通过；首次链接暴露旧保守深度对象签名不一致，补编既有实现所在第四个单元后链接通过，失败记录已保留。50 个 HZB 作业和两种单采样产物重新转换通过，缓冲、纹理、色调映射两浏览器回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧。雾效空资源和实际场景消费者尚未执行，体积材质 Cook 未验证；证据核验通过、整体验收 false。下一步按最小场景需要核对阴影、缓冲及后处理，版本和配置边界详见 P3。以下为历史检查点。

**2026-10-19 第十四轮，16:06：同步限制 Web 未启用的 MSAA/resolve 编译与运行入口，失败 84→67。** 保留普通单采样深度复制、独立颜色解析和色调映射；没有扩展 RHI 多重采样能力或放宽绑定校验。13 个类型精确移除 18 个变体，包含 17 个旧失败及 1 个未用的 HDR 顶点作业；其余 1,497 个类型和 16 项设置不变，无新增失败。

完整作业校验覆盖 1,060 个独立作业：993 个转换通过、67 个失败。原生 RenderCore、五个 WASM 单元及增量链接通过。保留的深度复制和颜色解析产物反射均无多重采样或子通道附件，50 个 HZB 作业重新转换通过；22 项缓冲计算、6 项纹理更新和 96 项色调映射两浏览器回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧。深度/解析尚未执行 GPU 绘制或场景调用；证据核验通过、整体验收 false。后续按最小场景需要处理剩余阴影、缓冲和后处理路径，可选功能同步限制消费者；版本及 Cook/运行配置边界详见 P3。以下为历史检查点。

**2026-10-19 第十三轮，15:42：Web 胶囊阴影的编译、准备和调度条件同步关闭，失败 96→84。** 三个 Shader 类型共 20 个变体退出编译，包含 12 个旧失败和 8 个旧转换成功项；其他 1,507 个类型及 16 项设置不变，无新增失败。普通静态网格阴影保留，没有新增 RHI 能力。

完整作业检查覆盖 1,078 个独立作业：994 个转换通过、84 个失败。原生 RenderCore、胶囊调度与 ShadowSetup 所在 WASM 单元及增量链接通过。50 个保留 HZB 作业本轮全部转换通过；22 项缓冲计算、6 项纹理更新和 96 项色调映射两浏览器回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；实际场景中的胶囊准备与调度尚未执行，原生 Renderer 仍为安装版。当前证据核验通过、整体验收 false。后续先核对 MSAA/resolve 条件并保留单采样深度路径，版本及配置边界见 P3。以下为历史检查点。

**2026-10-19 第十二轮，15:21：排除 HZB 的 12 个 Web R64 可见性变体，失败 108→96，普通深度归约保留。** 同步目标编译条件与运行入口，明确拒绝 Web R64 输入；原生 Cook 通过安装版 Renderer 导出的具名变体信息临时桥接，不复制变体 ID。其余 1,509 个类型和 16 项设置不变，没有新增 RHI 格式。

完整作业检查覆盖 1,098 个独立作业：1,002 个转换通过、96 个失败；保留的 48 个 HZB 计算变体和 2 个像素变体全部转换通过，无新增失败。原生 RenderCore、三个 WASM 单元及增量链接通过；首次旧 Glint 对象缺符号失败已留档，重编已有实现后通过，未增加该功能。22 项缓冲计算、6 项纹理更新及 96 项色调映射两浏览器回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧。HZB 深度归约和 Engine 场景未执行；当前证据核验通过、整体验收 false，混合版本及配置边界见 P3。以下为历史检查点。

**2026-10-19 第十一轮，15:05：纹理更新文件的 6 个旧失败已修复，失败总数 114→108。** Web 分支使用 storage buffer，并为实际只写的目标纹理保留只写语义。首次转换成功后四个纹理管线仍因读写访问方式失败，证据已保留；修正后 Chrome/Edge 各执行 6 个真实 Cook Shader、核对 11,063 个值，0 GPU 错误，并各确认 4 个旧产物仍被拒绝。

完整作业校验记录 1,110 个独立作业：1,002 个转换通过、108 个失败；编译范围和 16 项设置不变，无新增失败。22 项缓冲计算和 96 项色调映射本轮全部重新转换，两浏览器回归通过。未修改 C++ 或新增 RHI 格式；直接 GPU 检查尚未验证 Engine RHI 调度或场景。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；当前证据核验通过、整体验收 false。HZB 本轮只核对源码，12 个失败仍保留，版本和配置边界详见 P3。以下为历史检查点。

**2026-10-19 第十轮，14:50：Web 调试 Shader 与消费者同步关闭，失败由 131 降至 114。** GPU 崩溃测试和 ShaderPrint 共 14 个类型、22 个变体退出编译，恰好包含 17 个旧失败；其他 1,496 个类型及 16 项设置不变，无新增失败。原生 RenderCore 和三个 WASM 单元重编译、增量链接通过，安装版输入哈希不变。

完整作业校验覆盖 1,110 个独立作业，996 个转换通过、114 个失败，Global 库仍未生成。22 项缓冲计算及 96 项色调映射本轮全部重新转换，两浏览器回归通过；NullRHI 各 10 帧，WebGPU Engine 仍 0 帧。调试入口未在场景执行；直接 GPU 计算仍不等于 Engine RHI 调度或场景验证。当前证据核验通过、整体验收为 false，未增加共享 RHI 功能；后续处理 HZB 64 位变体、必要纹理更新及绑定，版本和配置边界详见 P3。以下为历史检查点。

**2026-10-19 第九轮，14:33：此前失败的 22 个真实缓冲 Shader 已转换并在浏览器计算通过。** 三个 Shader 文件只增加 Web storage buffer 声明分支，保留参数、索引和 64/512 线程组。完整作业缓存校验实际记录 1,132 个独立作业：1,001 个转换通过、131 个失败；编译范围及 16 项设置不变，本轮没有新增裁剪。Chrome/Edge 各执行 22 项、核对 18,002 个值、0 GPU 错误。

这项验证直接使用 WebGPU，尚未通过 Engine RHI 调度或加载 Shader map；LargeBuffer 测试申请了 512 线程组限制，Engine 设备协商仍需接入。没有新增后端 typed view 格式或重跑无改动的共享 RHI 功能测试。96 个色调映射产物本轮全部重新转换并在两个浏览器创建模块通过；NullRHI 仍各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧。当前证据核验通过、整体验收为 false，材质主机和版本边界详见 P3。以下为历史检查点。

**2026-10-19 第八轮，14:10：最小范围的 GPUScene、骨骼场景扩展已同步关闭。** 原生 RenderCore 与 WASM 共用平台条件；原生 Cook 的骨骼扩展通过配置关闭，WASM 同时编译平台条件。实测仅 11 个 Shader 类型改变，共排除 71 个变体，其余 1,499 个类型保持一致；ES3.1 范围 1,203→1,132，完整 Cook 仍退出 3，记录 150 个独立失败、280 条诊断。没有增加共享 RHI 功能或修改安装目录。

五个相关 WASM 编译单元及增量链接通过。Chrome/Edge NullRHI 各 10 帧、0 错误，均实际读回两个功能关闭、配置值为 0；场景中的扩展创建和绘制入口仍未执行。WebGPU 仍缺 Global 库、0 帧，失败 SM5 Cook 被 Stage 拒绝。基础 Shader/Worker 71 样本重跑通过；96 个色调映射产物只引用历史验证，本轮未重编译或重验模块。当前证据核验通过、整体运行验收为 false；共享 RHI 功能测试未重跑，ES3.1 Cook 与 SM5 运行端尚待统一。下一步处理最小场景必需的缓冲清理/拷贝及绑定问题，详细证据和版本边界见 P3。以下为历史检查点。

**2026-10-19 第七轮，13:47：最小 Shader 裁剪已在原生 Cook 和 WASM 编译链同步。** 工作区独立重建 RenderCore 并实际加载，共享条件排除 LightGrid、MobileFog 的 334 个变体；ES3.1 可编译范围 1,537→1,203，其余 1,504 个类型的变体数不变。运行端同步跳过灯光网格和移动雾入口，三个相关 WASM 编译单元和增量链接通过；入口执行及空灯光资源仍未在场景实测。没有扩展 RHI 功能，安装目录哈希保持不变。

完整 Cook 仍退出 3，记录 208 个独立失败、388 条诊断，尚无完整 Global 库。新产物的 Chrome/Edge NullRHI 各 10 帧、0 错误；WebGPU 仍完成设备和预初始化后缺库、0 帧。上轮 96 个有限常量色调映射产物本轮引用明确标注的历史证据并重验浏览器模块，没有误计为重编译。当前证据核验通过、整体运行验收为 false；共享 RHI 功能测试未重跑，ES3.1 仍为 Cook 试验、运行端仍 SM5。下一步核对实例裁剪、骨骼和后处理的必要条件，具体报告及版本边界见 P3。以下为历史检查点。

**2026-10-19 第六轮，12:25：ES3.1 色调映射转换阻塞已局部修复。** WebGPU Shader 条件分支使用 `sign()`，避免生成 Tint 无法读取的无限常量，其他平台保留原逻辑。此前失败的 96 个真实作业全部重新转换通过，Chrome/Edge 各验证 96 个 WGSL 模块、0 错误；此项不代表渲染管线或画面验证。Cook 主机使用工作区独立 Shader 副本，源文件/产物及安装版 Shader 哈希均核对。

完整 Cook 仍退出 3，本次记录 374 个独立失败、716 条诊断，尚无完整 Global Shader 库。基础 Shader/Worker 的 71 样本通过；NullRHI 仍为 324 文件、两浏览器各 10 帧、0 错误；WebGPU 仍缺 Global Shader 库、0 帧。当前证据交叉核验通过，整体运行验收仍为 false。运行端继续 SM5，ES3.1 仅为 Cook 试验；原生 RHI 功能测试未重跑。下一步同步同源 Cook/运行端的最小 Shader 范围，不扩展可选功能，详细证据和版本边界见 P3 报告。以下为历史检查点。

**2026-10-19 第五轮，11:49：ES3.1 最小 Shader Cook 对照已完成，尚未生成完整 Shader 库。** 独立 `Web/46` Cook 试验将可编译变体从原 SM5 的 4,395 个降到 1,693 个，再由 Web 最小配置降到 1,537 个；14 个关键设置的主机/目标值核对一致。最终 Cook 退出 3，记录 469 个独立转换失败、908 条诊断，不能全部视为可裁剪功能；仍需共享最小编译条件并处理必要 Shader 的转换问题。浏览器继续 SM5，没有切换 ES3.1 或增加 RHI 功能。

基础 Shader/Worker 重新通过 71 样本（55 转换/绑定、16 预期拒绝），Editor/Worker 字节码相等及两项版本负例通过。NullRHI Cook/Stage 为 324 文件、19,952,703 字节；Chrome/Edge 各 10 帧、0 错误。WebGPU 仍完成设备和预初始化资源后缺 Global Shader 库、0 帧；失败 Cook 被 Stage 拒绝。当前证据交叉核验通过，整体运行验收仍为 false。原生 RHI 功能测试本轮未重跑，材质主机版本不匹配、普通完整 UBT、硬件 Tick 和场景仍待解决，详见 P3 报告。以下为历史检查点。

**2026-10-19 第四轮，11:12：标准 WebGPU Shader Cook 已接入并实跑，尚未生成可用 Shader 库。** 独立主机以 Web/47 和目标 DDPI 编译，最终首错为稀疏体积纹理 Shader 的 `SampledBuffer` capability；此前复跑先遇到几何 Shader `FWriteToSliceGS` 的 `Layer` builtin。已保存具体 Shader、SPIR-V 和失败诊断，Stage 实际拒绝了失败的 Cook。早先批次另记录 switch fallthrough 限制，下一步统一 Cook/运行端的最小 Shader 排列范围，不扩大可选 RHI 功能。

NullRHI Cook/Stage 刷新后仍为 330 文件、23,633,819 字节，Chrome/Edge 各 10 帧、0 页面错误；WebGPU 设备及预初始化资源通过，仍因缺少 Global Shader 库为 0 帧。基础 ShaderFormat/Worker 的 71 样本通过（55 转换、16 预期拒绝），材质回归在旧主机启动时因 `ConservativeDepthFillSize` 参数结构不匹配而失败，未计通过。本轮未修改共享 RHI 或重跑其 GPU 功能回归；当前仍是混合 5.8.3/5.8.0 增量诊断，普通完整 UBT、硬件 Tick 和场景未完成。详细日志和剩余主线见 P3 报告。以下为历史检查点。

**2026-10-19 第三轮，10:35：Chrome/Edge 均越过全部当前预初始化资源，`preRHIResourcesInitialized=true`。** 实例化、粒子 SubUV、距离场和未使用 Primitive 纹理只在 Web 最小范围裁剪；位置/切线/UV 顶点缓冲及天空辐照度结构化缓冲仍实际创建，未扩展 RHI 格式。NullRHI 各 10 帧、0 页面错误；WebGPU 仍为 0 帧，新的共同阻塞是缺少真实 `Global` Shader 库。当前仍为混合 5.8.3/5.8.0 的增量诊断，普通完整 UBT 构建未验收；本轮未修改共享 RHI，未重复原生 GPU 回归。下一步转 Shader Cook/挂载，详见 P3 报告。以下为历史检查点。

**2026-10-19 第二轮：共享 WebGPURHI 已实际编入完整 wasm64 Engine 的增量诊断产物。** Chrome/Edge 均异步创建浏览器 Device、选择平台 47 并进入默认资源初始化；硬件仍 0 帧，当前停在实例化静态网格的 `DummyFloatBuffer` 标量浮点 SRV。两个浏览器的同产物 NullRHI 各 10 帧且无页面错误。Geometry Cache 的两个默认缓存及消费者只在 Web 条件排除，已实际编译、链接和越过；未扩展 RHI 格式或可选功能。

共享后端原生回归重新通过：核心 25、材质 32、状态 49 项，共 1,344,520 个值；全局 RHI 44 项/132,096 个值、原生视口 72 项/143,976 个值。启动负例仍证明预期阻塞，不能记作启动成功。本轮并非此前十四批全部重跑。当前完整普通 UBT 构建尚未完成，硬件与无渲染结果来自单独记录的增量诊断链接，`fullNormalUBTBuildVerified=false`。详细源码/对象证据和剩余步骤见 P3 报告；下段是当天首轮历史状态。

**2026-10-19：P3 的完整 wasm64 Engine 已完成 NullRHI PreInit/Init/Tick，Chrome/Edge 各 10 帧。** 本轮新增 Web Cook/Stage，330 个启动资源文件约 23.6 MB 经浏览器逐文件哈希验证后挂载，默认材质断言已越过；不包含 WebGPU Shader Cook、Renderer 或项目地图。P2 GPU 本轮未改动或重跑，硬件 RHI 接入完整引擎仍待完成。严格汇总因旧 GameEngine.cpp 安装源哈希失效退出 1，当前完整构建与运行证据仍有效，详见 P3 报告。下列 10 月 16 日状态为历史。

**2026-10-16 21:13：P3 完整 wasm64 Engine Target 首次链接成功，旧 41 个未解析符号已解决；保留 UMG。** Chrome 已实际执行 NullRHI 启动，补程序名查询、挂载原始配置、选择 `-sm5` 并增加测试栈后，停在缺少 Cook 默认材质的断言，尚未完成 PreInit/Init/Tick，当前 0 帧。下一步接 Cook/Stage 与资源挂载。完整日志见 P3 报告。此轮没有修改或重跑 P2 GPU 功能；P2 原生启动、浏览器 WebGPU 与场景仍未完成。

21:21 的 P3 综合回归、对象检查与严格汇总均通过，确认当前完整构建与源码匹配。P2 GPU 结果继续保留原有证据，未在本轮重跑。

21:28 的 P3 最终构建/汇总仍通过，实际链接参数已单独保存；浏览器重跑仍停在默认材质缺失断言，0 帧。当前构建为 `web-engine-full-20261016-212618.log`，汇总为 `web-engine-linked-summary-20261016-212838.log`，详细边界见 P3 报告。

以下为此前检查点，所述最终链接失败已由上文更新。BLAKE3 portable 库的 Node/Chrome/Edge 各 210 项检查通过，同版 libPNG 各 8 项通过；UDP 探测与补丁验证线程按最小场景范围裁剪，没有扩展数组纹理、材质层等功能。

当前 **P2 原生启动未完成；P3 已通过 Engine Target 的 UHT 和真实 Launch/FEngineLoop 关键源码的 wasm64 编译**。完整 Engine 尚未链接运行。此前 ApplicationCore Program 的 Chrome/Edge 桌面和窄视口四组、各 15 项检查通过；Core-only Program 新增 Transform FPU，现为 6 组，基础服务保持 7 组。十四批 RHI 探针保留 **1,236/1,236** 项、75 draw / 149 dispatch、917 finalize / submit、1,697,120 个核验值通过；本轮未重复执行 GPU 测试。

本轮完整构建已通过原 CPU 蒙皮 const 调用；SparseVolumeTextureData 只补两处 `SIZE_T` 转换，原失败单元也已通过。后续越过 Engine 本体与 HTTP，现补 InputCore 的 Web 平台规则、头和基本键码表，实现与调用方分别生成 wasm64 对象。随后完整尝试因并行检查触发 SDK 缓存竞争而停止，原 Chaos.24 单元串行重放通过；构建入口统一 SDK 路径、刷新旧 Makefile。Core/基础服务三个运行环境、ApplicationCore 四组各 15 项、Engine 十个关键源码和额外 TagTrace 回归通过，综合脚本与汇总退出 0，完整 Target 另行续编。Engine 源码在隔离目录使用安装版副本，仅覆盖目标 Preshader2、SparseVolumeTextureData，未改安装目录。完整 Engine 链接、浏览器真实 Tick 和场景仍未完成，RHI 范围未扩展。

2026-10-16 后续：完整目标的 InputCore、Launch、MovieSceneTracks 和 PakFile 均已编译通过。Web 规则排除可选 IoStore 远程下载实现并保留 IoStoreOnDemandCore；MovieSceneTracks 只补三处 float 显式转换。最新完整失败在 RHIValidation 六处整数列表收窄，现通过 Web RHI 模块公开定义 `ENABLE_RHI_VALIDATION=0` 排除可选调试层，综合回归与原失败单元重放通过。完整 Engine 链接及浏览器初始化/Tick 尚未验证；未新增数组纹理、材质层或其他可选 RHI 功能。

此前综合回归和汇总通过；2026-10-16 的完整目标 C++ 编译阶段现已通过，包括 UMG。最新完整链接确认，补 Web 平台入口、采用标准应用宏和排除无声目标的可选音频解码器后，未解析符号从 68 个减少到 41 个；剩余 BLAKE3、PNG、ICMP 字节序和限时信号量等待，详见 P3 报告。Web 仅局部排除实际阻塞的可选路径；字体 SDF 与原生 BSD Socket 对象符号检查通过。硬件 RHI 工厂仍明确拒绝调用，完整 Engine/P2 启动和浏览器运行尚未完成，不将编译通过算作启动完成。

| 阶段 | 状态 | 已验证或剩余工作 |
| --- | --- | --- |
| P0 平台可行性 | 已通过独立探针 | 原生 GPU、浏览器 WASM32/64、线程、ABI、读回与呈现 |
| P1 主机 Shader 编译 | 已通过隔离主机验证 | 独立 ShaderPlatform、真实 Worker IPC、WGSL/反射包、材质样本；目标 5.8.3 全源码构建仍未完成 |
| P2 原生 RHI 与启动 | 进行中 | 距离场初始化/消费者已在目标源码按 Web 条件排除，双分支单文件编译通过；尚未链接，旧宿主仍停在 FDFDummyByteAddress |
| P3 UE WASM Runtime | 无渲染 Init/Tick 通过，阶段未完成 | Chrome/Edge 各 10 帧；仍需完整引擎 WebGPU 与场景接入 |
| P4 资源打包 | 启动资源 Cook/Stage 通过，阶段未完成 | 无 Shader 的 Web Cook 与浏览器挂载通过；渲染 Shader Cook、项目地图及 UAT 发布仍待接入 |
| P5 浏览器场景 | 待接入 | UE 场景完整启动、Renderer、场景交互与 HTML UI 桥接 |

最近完成的实现：新增 Engine Program Target，补齐隔离宿主 UHT 配置/着色器路径、关闭分支的 ISPC 工具链行为、Blueprint 虚拟栈回退、FPU 寄存器式 Transform，以及 Launch 的 Web Oodle 初始化排除。保留 UMG 反射生成，没有扩展可选 RHI 功能。隔离宿主新增目标 5.8.3 CoreUObject/Launch 副本，UBT、GameEngine 和其他依赖仍来自 5.8.0。对象与待构建动作数不代表功能完成比例。详见 [P3 构建与运行报告](H:/ue_html/UE58_P3_WEB_RUNTIME_TEST_RESULTS.md)。此前距离场源码双分支 Win64 编译已通过，但尚未链接，旧原生启动阻塞保持不变。

2026-10-15 范围调整：后续以静态网格、基础 Unlit 颜色/二维贴图材质、相机与输入、Cook 资源加载组成的最小浏览器场景为目标。数组纹理、材质层和其他未使用功能延后，遇到默认初始化阻塞先追踪消费者并评估 Web 条件禁用，仅对最小场景无法绕过的依赖补最小实现。距离场已完成第一处目标源码条件裁剪；此前默认纹理/顶点 SRV 的省略仍是隔离宿主适配，View/Uniform 等消费者尚待处理。下文历史批次的计划以此调整为准，探针数量不作为场景接入进度。

## 已完成的链路

新增 `WebGPURHI` Runtime 模块，实现自己的 `FDynamicRHI` / `IRHICommandContext`，在隔离 UE commandlet 的渲染线程创建 Dawn D3D12 Device。UE 的资源描述、资源初始化器、Shader 参数、render pass 和 draw/dispatch/copy 命令进入该 context；context 完成命令编码后，通过 `RHIFinalizeContexts` / `RHISubmitCommandLists` 提交真实 GPU 工作并读回核验。

```text
独立 Web ShaderPlatform + ShaderCompileWorker
  -> 带平台、版本、反射和 WGSL 的 .webshader
  -> FRHIShader / FRHIBuffer / FRHITexture / FRHIUniformBuffer / PSO
  -> FRHICommandList_RecursiveHazardous
  -> WebGPURHI 的 IRHICommandContext
  -> Dawn command encoder / queue
  -> GPU readback + 数值比较
```

前三批宿主使用 NullRHI。探针显式创建自己的 RHI，不调用主机全局 PSO cache；非 fallback PSO 模式下用命令 lambda 绑定已经创建的原生 PSO，随后实际 draw/dispatch/parameters/copy 命令由 UE 命令列表执行。测试子类仅公开 bound-shader 状态更新，以便验证命令列表里的 Shader 参数。

前三批验证独立 RHI context；第四批新增临时 `GDynamicRHI` 接管、全局命令执行器和 PSO cache 测试；第五批验证 RenderResource 生命周期、初始化上传及真实 HWND surface；第六批补齐二维 TextureSRV 对象、直接绑定和生命周期；第七、八批分别实现 Typed R32_UINT BufferSRV/UAV；第九批增加 Typed uint4；第十批增加 Structured SRV 与默认 Structured UAV；第十一批增加 Typed float4；第十二批增加 Buffer Lock/Unlock；第十三批增加三维 RGBA8/BGRA8、BulkData 和 Texture3D SRV；第十四批增加 RGBA8_UINT 体积纹理与 Shader sample 类型检查。启动诊断已到达 ImportedRHI 模块选择、Device 创建、三个默认纹理 SRV、七个 Buffer SRV、五个 Buffer UAV、白色 RDG Buffer 上传编码和三个默认体积纹理上传，**尚未完成预初始化资源、完整启动和 Renderer。** 模块默认 `IsSupported()` 返回 false，只在显式 `-WebRHIStartupProbe` 且 SM5 请求时允许启动实验。

## 第一批：核心测试

25/25 检查通过，19 次 draw、2 次 dispatch，29 个 finalize / submit 命令列表，40 个 bind group，核验 164,352 个通道或整数值。Dawn GPU validation 错误为 0，commandlet 退出码为 0。

| 检查 | 实际核验 |
| --- | --- |
| 4 组 indexed draw | uint16 / uint32 索引，64×64 / 96×48，逐像素核对 2×2 纹理的四个象限 |
| Uniform 更新与纹理复制 | 同一 pass 左、右两次 draw 使用不同位置 Uniform；复制目标逐像素匹配 |
| 纹理更新顺序 | 一份命令列表先 draw、再上传纹理、再 draw；前后目标分别匹配原色与反色 |
| Loose 参数与 scissor | 同一 pass 三次颜色更新，核对裁剪区域和每次绘制的参数快照 |
| reversed-Z | 深度 0.25、0.75、0.5 顺序绘制，最终只有近处绿色覆盖全图 |
| 混合状态 | SourceAlpha / InverseSourceAlpha 混合，RGBA8 量化允许 1 的误差 |
| 颜色写入掩码 | 只写 R/G；B/A 保持清除值 |
| 计算、UAV 范围、复制 | 1,024 字节缓冲中的 256..767 字节作为 UAV；两次 dispatch 分别写 7 / 19，之间和之后分别复制；范围外哨兵保持不变 |
| 命令列表顺序 | 两份列表分别 finalize，再同一批 submit，最后目标为第二份列表绘制的绿色 |
| 11 个负向检查 | UAV 对齐、越界、Typed UAV；Shader 频率、截断、magic、DDPI hash、平台、版本、schema；采样当前 render attachment |

负向检查调用与实际创建/绑定共用的验证函数，在提交无效 GPU 工作前拒绝输入；不是故意向 Dawn 提交非法资源。纹理反馈检查也不是完整 UE transition / RDG validation 的替代。

Uniform 更新保留命令时的数据副本；每次 draw/dispatch 再创建绑定的 GPU 常量快照。纹理上传通过独立 staging buffer 编入 command encoder，使 upload 相对 draw 的次序可验证。StructuredBuffer UAV 绑定使用 view 的实际 offset / count，检查 Device 的 storage alignment 和底层分配边界，避免误绑整个缓冲。

读回只接受关闭 LinearToGamma 的原始 mip0 RGBA8 模式；超时后的 map / queue 回调继续持有完成状态，避免引用已经返回的栈变量。输出报告前等待队列完成。设备丢失与强制超时恢复尚未做故障注入验证。

一键复现同步重跑了 P1：79 个 Worker 任务、63 个成功包、16 个预期拒绝、252 个包损坏和 252 个平台混用检查，以及 2 个缺配置检查全部通过。随后 Chrome 155.0.8059.40 / Edge 155.0.4283.45 的 GlobalShader 和材质页面、桌面和移动视口共 8/8 回归通过，核验 9,243,648 个值。浏览器回归验证已有独立 WebGPU Shader 页面，没有执行新增的原生 UE RHI 模块。

## 第二批：材质资源表

同一一键脚本新增材质 RHI 探针。32/32 检查通过，使用四个真实 Web ES31 Worker Shader、两个图形 PSO，19 draw、38 bind group、20 次资源表解析绑定，核验 1,114,112 个 RGBA 通道值。两批合计 57 项、38 draw / 2 dispatch、115 finalize / submit、78 bind group、1,278,464 个数值通过；Dawn validation 错误为 0，commandlet 退出码为 0。

本批消费 `UnlitColor` 与 `UnlitTexture` 的 Mobile BasePass / FLocalVertexFactory `WebVertexInput` 配置。顶点输入以 UE 两/三个独立 float 流提供，输出四个 RGBA8 MRT；主目标与 CPU 期望逐像素比较，另外三个 MRT 与零输出逐通道比较。原始 alpha=0 保留在 RGBA 中，预览 PNG 只将 alpha 显示为不透明。

| 检查 | 实际核验 |
| --- | --- |
| 2 项成员偏移核对 | View / Primitive 的实际 `FShaderParametersMetadata` 成员 offset / size 对上 VS/PS 反射 |
| 14 组材质绘制 | 两种材质分别测试 uint16 / uint32 索引、参数覆盖、Primitive 变换、View 投影、百万级 high 坐标相消与 low 平移、PreExposure |
| 2 组同一 pass 更新 | 两次 draw 更新 Primitive；颜色材质更新数值常量，纹理材质更新 Uniform 中的纹理引用，左右区域保持各自内容 |
| 2 项当前资源核对 | 使用实际 RHI 的 SRT 解析函数检查当前纹理/采样器对象 |
| 10 项负向检查 | 未绑定 UB、错误/缺失布局哈希、错误 token offset / member、缺失 token、空纹理/采样器、UB 槽位混用、资源 RHI 类型错误 |
| 2 项资源寿命 | 调用方释放纹理/采样器引用后，UB 仍持有资源表引用，并正确完成四 MRT 绘制 |

修复了原先单 Uniform 探针未覆盖的槽位问题：UE Uniform 参数的 `baseIndex` 可以都为 0，实际槽位应读 `bufferIndex`。绑定时核对 Shader 的 `ResourceTableLayoutHashes`，不能用简化布局假冒 UE 布局。核心 DrawRectangle Uniform 也改为使用 UE 注册的真实布局。

材质生成探针将 `FRHIUniformBufferLayout` 的名字、常量大小、StaticSlot、BindingFlags、Flags、资源 offset / type 导出为 `uniform-layouts.json`。RHI 探针重建布局并重新计算哈希，不直接赋入导出的哈希。View / Primitive 常量使用宿主真实成员 offset 写入，而非只按 WGSL 反射填造另一个内存布局；材质数值使用真实 `FillUniformBuffer` 默认/override 产物。文件只存布局描述与数值，不导出主机资源指针。

`FWebGPUUniform` 在创建和更新时，使用 UE `GetShaderParameterResourceRHI` 采集资源引用。更新数据与引用随命令保留，每次 draw 的 GPU 常量/绑定组独立创建。TextureMap / SamplerMap 根据 UB slot、resource index、bind index 解析；同时检查导出的资源名/类型与 UB 实际成员。SRV/UAV 的 SRT 绑定尚未实现。

本次所有读回对比都遍历完整图像，RGB 量化误差上限 2，alpha 精确核对。独立 Node 验证器另行核对两个默认材质的原始 RGBA、所有必需检查名及计数、四个材质 Worker 包、布局和数值产物 SHA256。完整脚本重跑 P1 的 79 个任务、63 个成功包、16 个预期拒绝与所有已有负向检查；Chrome / Edge 桌面和移动视口 8/8 回归通过。

`p2MaterialRHIProbePass=true` 只表示本批探针通过。尚未把 `FLocalVertexFactory` 对象、RenderResource 或 MeshDrawCommand 接入全局 Renderer。Native 配置的 `BatchedPrimitive` 是含 RDG Buffer SRV 的 Uniform View，需要专门实现，本批不覆盖；浏览器既有 Native 配置 Shader 小样本通过不能作为 UE Uniform View 接入已完成的证据。材质布局包含共享 Wrap/Clamp sampler 槽位，但这两种简单 Shader 没有活跃使用它们，因此共享采样器 Shader 绑定仍需专门样本。

## 第三批：资源状态与 transition

49/49 检查通过，5 draw、3 dispatch、13 bind group，逐项核验 66,056 个通道或整数值。本批创建、Begin、End、释放各 15 个 transition；三批合计各 24 个，运行结束没有待完成或待释放项。三批累计 106/106 检查、43 draw / 5 dispatch、130 finalize / submit、91 bind group、1,344,520 个数值；Dawn GPU validation 错误为 0。

新增 `WebGPUTransitions.cpp`，实现 `RHICreateTransition`、`RHIBeginTransitions`、`RHIEndTransitions` 和 `RHIReleaseTransition`。Buffer / Texture 保存 `ERHIAccess` 与 pending transition。Begin 检查旧状态并锁定资源，End 更新状态并解除 pending；整批先验证再修改，避免一项错误造成部分资源切换。transition 持有底层资源或 UAV 引用。

| 检查 | 实际核验 |
| --- | --- |
| RTV → SRV → CopySrc → RTV | 清除后采样、复制，再复用原目标；完整图像核对采样/复制保留旧颜色，原目标为新颜色 |
| split Begin / End | 跨两个实际 submit 保持 pending；禁止中途使用/读回、重入 Begin、重叠 transition、提前 End / 释放 |
| 批量与访问掩码 | 两资源切换、组合只读状态、Unknown Before；错误 Before 导致整批拒绝且状态不变 |
| DSVWrite → DSVRead | 第一 pass 深度 0.75 绘制绿色，第二只读 pass 深度 0.5 红色被遮挡；禁止绑定写深度 PSO |
| UAV → UAV → CopySrc → UAV | 同状态 UAV 顺序、子范围哨兵、复制保留值 23、资源复用后值 29；未切换即复制/dispatch 被拒绝 |
| 生命周期与提交 | 调用方释放 Buffer 后 transition 仍持有引用并正确复制；逆序提交被拒绝，随后按记录顺序提交成功 |
| 能力、范围与 flags | 拒绝读写混合/多写状态、资源能力不符、非零 mip / array / plane、Unknown After、IgnoreAfterState、commit、重复/空资源、异步队列和 transient aliasing |

绘制、dispatch、显式复制与采样绑定共用访问验证；本轮实际执行 305 次资源访问检查。render pass 内不能切换状态、复制或采样当前 attachment。深度只读 attachment 使用 WebGPU 的 `depthReadOnly`，对应 pass 不清除/存储深度，并在绑定时拒绝写深度 PSO。

初始化上传和 CPU 读回是后端内部操作：在 pass 外编码复制，检查资源能力和 pending 状态，保留调用方声明的 UE 逻辑访问状态。显式 `CopyTexture` / `CopyBufferRegion` 仍严格要求 CopySrc / CopyDest。单 context 的状态按记录顺序更新，finalize 的列表带序号，submit 必须遵守记录次序。

**第三批生命周期边界仍为隔离探针。** UE `FRHITransition` 分配和 Begin/End marker cleanup 由宿主 NullRHI 的全局入口管理；测试适配器显式调用本地 WebGPURHI 的后端创建/释放，实际命令列表调用本地 context 的 Begin/End。本地表保存后端状态，不使用全局 RHI private transition data。因此第三批报告的 `singleQueueTransitionsImplemented=true`，但 `globalTransitionDispatchImplemented` 与 `fullRHITransitionsImplemented` 保持 false。第四批另行验证真实全局分配/释放；两种探针不能混同。

只支持单 owner、Graphics 队列及当前单 mip / 单 array / 单 plane 资源。未支持 AsyncCompute、跨队列 fence、transient aliasing、reserved resource commit 或高级 transition flags；这些请求明确拒绝。完整 Renderer 使用的 transition 集合仍需启动后的实际样本逐步验证。

更新后一键构建退出码为 0，独立 Node 验证器通过三批全部检查、计数及读回，记录新增 transition 源码和图像 SHA256。P1 的 79 个 Worker 任务、63 个成功包、16 个预期拒绝、252 个包损坏与 252 个平台混用检查、2 个缺配置检查全部重跑通过。Chrome / Edge 的两页面、桌面和移动视口 8/8 回归通过，核验 9,243,648 个数值，无页面错误或横向溢出；这项浏览器回归仍只执行已有 JS/WASM Shader 页面，新增 transition 实现运行于原生 UE 探针。

## 第四批：临时全局 RHI 与命令执行器

新增 `WebGPUGlobalProbe.cpp` 和独立 commandlet 参数 `-WebGlobalRHIProbe`。进程先以 NullRHI 完成主机初始化，在 RenderThread 排空宿主命令和缓存，通过实际模块 `CreateRHI(SM5)` 创建后端并短暂接管 `GDynamicRHI`。记录模式和 bypass 模式各 22/22 检查通过，合计新增 44 项、12 draw / 4 dispatch、50 finalize / submit、28 bind group、132,096 个数值；两次运行 GPU validation 错误均为 0。

四批合计 150/150 检查、55 draw / 9 dispatch、180 finalize / submit、119 bind group、1,476,616 个通道或整数值。前三批合计 106 项的结果保留独立报告，第四批输出 `global-rhi-results.json`，避免把临时接管算成整个引擎已由 WebGPURHI 启动。

```text
IDynamicRHIModule::CreateRHI(SM5) -> 临时 GDynamicRHI
  -> UE 全局 RHICreate* / FRHICommandListImmediate
  -> UE PipelineStateCache / SetGraphicsPipelineState / SetComputePipelineState
  -> UE 全局 executor / close translate chain / finalize / submit
  -> WebGPURHI / Dawn / GPU 读回
  -> 清理后端绑定、PSO cache、资源删除队列
  -> 恢复 NullRHI、ShaderPlatform / 能力状态、transition 配置及执行模式
```

| 检查 | 实际核验 |
| --- | --- |
| 模块与全局入口 | 模块工厂创建 Device；全局资源初始化器创建纹理、VB/IB、UB；SM5 映射为独立 Web 平台 47 |
| 记录 / bypass | 记录后 draw 计数保持为 0，flush 后执行；bypass 在记录调用时直接执行 |
| 真正的 UE PSO cache | 重复请求只创建一个 clear PSO、一个 screen PSO、一个 compute PSO；顶点声明也重复命中同一对象 |
| 全局 transition | 配置 16 字节 private storage，UE 分配尾部数据；split 跨 submit，End marker 自动调用全局释放并析构后端数据 |
| 采样、复制与读回 | 全局 indexed draw 采样此前 clear 的颜色；复制目标一致；读回后继续绘制目标为绿色 |
| 普通命令列表 | 两份非 recursive、非 immediate 的 `FRHICommandList` 记录后不执行；排队提交按顺序覆盖，最终全图黄色，缓存不重复创建 |
| compute 与帧边界 | 全局 compute PSO / 参数、UAV 子范围、复制和复用，值 17 / 31 与范围外哨兵匹配；executor 调用 EndFrame，空 flush 不破坏提交次序 |
| 恢复和再次接管 | 每轮清理资源与缓存，恢复宿主指针、全局状态、ShaderPlatform、transition size/alignment 与执行模式；同一进程再创建另一 Device，最终 commandlet 正常退出 |

普通命令列表在两个模式样本中都先切到记录模式再排队，保持其递延执行语义。核心 GPU API 仍只允许当前 RenderThread，禁用独立 RHI 线程、并行 translation、资源/Shader 多线程创建及异步 PSO 编译。draw event 发射在探针中关闭，恢复时按宿主设置重新配置；GPU breadcrumb、时间戳和故障注入不属于本批。

后端修正了几个全局执行合约：default context 首次获取时打开 encoder；没有 context 的 finalize 返回空结果；bypass 的读回先提交已打开的 context，后续 pass / compute / transition 可重新打开；EndFrame 验证 pass/encoder 已关闭。Shader 对象保存基于真实字节码的 UE `FShaderHash`，缓存使用的 Shader 身份不再是默认零值。

全局 transition 使用 UE `GRHITransitionPrivateData_SizeInBytes` / `AlignInBytes` 和 `GetPrivateData`，placement 构造后端引用，UE `FRHITransition::Cleanup` 实际分派到当前 WebGPURHI，后端验证 End 完成后析构 private data 并移除表项。前三批的本地测试适配器保持原入口，继续独立回归。

完整一键构建退出码为 0，两份独立 Node 报告分别通过前三批 106 项和第四批 44 项，两个 commandlet 均正常退出。P1 的 79 个 Worker 任务、63 个成功包、16 个预期拒绝及既有负向检查同步重跑通过。随后 Chrome 155.0.8059.40 / Edge 155.0.4283.45 的 GlobalShader 和材质页面、1280 / 390 两种视口共 8/8 回归通过，核验 9,243,648 个数值，页面诊断为空。浏览器仍运行独立 JS/WASM Shader 页面，本批全局 UE RHI 测试运行于原生主机。

**第四批是一段临时全局执行测试，没有覆盖完整启动和 Renderer。** 后续第五批另行验证 `RHIPostInit`、测试资源生命周期及 viewport / present；独立启动诊断验证 Windows ImportedRHI 选择。已有全局 RenderResource 整体重建、完整 `RHIInit`、全局 ShaderMap 和 Renderer 仍未通过。目前只配置测试需要的 ShaderPlatform 和串行执行能力，不应把它当成完整硬件能力表。SM5 对应样本 Shader 的运行也不代表完整 SM5 功能已经支持。

`p2GlobalDispatchProbePass` 和 `temporaryGlobalWebGPURHIDispatchVerified` 记录本批结果；`importedWebGPURHIStartupVerified`、`globalWebGPURHIReplaced`、`p2Complete`、`completeBrowserUERuntime` 仍为 false。

## 第五批：资源生命周期与 surface 呈现

新增 `-WebViewportRHIProbe`，仍在 NullRHI 宿主的 RenderThread 临时接管全局 RHI。记录 / bypass 两模式各 36/36 项，合计新增 72 项、8 draw、83 finalize / submit、143,976 个核验值；GPU validation 错误均为 0，正常恢复宿主并退出。五批累计 222/222 项、63 draw / 9 dispatch、263 finalize / submit、1,620,592 个核验值。

`WebGPUGlobalScope` 复用第四、第五批的排空命令、清理缓存、保存和恢复宿主状态逻辑。完整重跑后第四批仍为 44/44，前三批仍为 106/106，计数和像素验证保持通过。

| 检查 | 实际核验 |
| --- | --- |
| RHIPostInit | 经 UE 全局入口设置像素格式宽度并调用后端 PostInit；这发生在临时接管期间 |
| RenderResource 生命周期 | 实际 `InitResource` 重复调用不重复创建；`UpdateRHI` 释放并重建；释放后可再次初始化；三次 VB/IB GPU 内容均匹配 |
| ResourceArray 上传 | 快照后调用 `Discard()`；测试数组随即清空，GPU 仍包含原始八个整数 |
| Texture initializer | 经 `GetTexture2DSubresource(0)` 写入 3×2 RGBA8 / BGRA8，验证行跨度、所有像素及 BGRA 通道交换 |
| HWND 与 surface | 实际隐藏 Windows 窗口创建 Dawn surface，按能力选择格式，FIFO，验证原生 window / swapchain 指针 |
| 取帧与呈现 | 同一帧重复取 backbuffer 返回同一对象；绘制、读回、Present 转换和真实 `wgpuSurfacePresent` 成功；旧帧资源访问被拒绝 |
| 缩放、跳过与恢复 | 64×64 → 96×48 重新配置；跳过帧不调用 present，丢弃后恢复取帧/绘制；每模式 4 acquire、3 present、1 skip |
| GPU breadcrumb | UE `EndDrawingViewport` 自动 marker 的 Begin/End 严格配对；启用 draw events 后在两个模式各实际发出一个 WebGPU debug marker |
| 错误输入与清理 | 拒绝空 window、零尺寸、超限尺寸、fullscreen、未支持格式；8 个全局 transition 全部自动释放，无 GPU validation 错误 |

`WebGPUViewport.cpp` 包装真实 surface texture 为 `FRHITexture`。backbuffer 初始为 `Present`，绘制显式切换至 RTV，再返回 Present。CPU 读回只作后端内部 copy，不改变调用方声明状态。呈现或跳过后使旧 wrapper 失效，即使调用方还保留引用，也不能继续用旧帧绘制或切换状态。BGRA 读回转换为 UE `FColor` 后保存统一 RGBA 产物。

窗口全程隐藏，**本批验证 surface GPU 内容和呈现 API 成功，没有检查可见桌面扫描输出，也没有接入浏览器 canvas。** 只支持当前 owner 线程、FIFO/vsync、windowed、RGBA8/BGRA8。resize 要求此前帧已结束，跳过呈现通过 unconfigure / configure 丢弃；零尺寸暂停、窗口遮挡、surface lost / outdated、设备丢失恢复、多窗口和跨线程生命周期尚未验证。

纹理 initializer 只支持单 mip、单层二维 RGBA8/BGRA8，其他资源明确拒绝；texture BulkData、立方体、多 mip、压缩格式和 SRGB 尚未实现。ResourceArray 的 CPU 数据在快照后释放，GPU 上传使用后端持有副本。VB/IB 内容用逐字节比较，纹理用逐通道比较，报告的核验值包含两种计数。

完整 `build-ue-rhi.ps1` 退出码为 0，三份独立 Node 验证分别通过 106、44、72 项。第五批另行核对八份原始 surface 图像的每个通道、两个执行模式的匹配哈希、模块及 commandlet DLL / 源码 SHA256 和正常退出日志。随后 Chrome 155.0.8059.40 / Edge 155.0.4283.45 的两页面、1280 / 390 视口 8/8 回归通过，9,243,648 个数值匹配，页面诊断为空；浏览器仍只运行既有独立 Shader 页面。

`p2ViewportRHIProbePass`、`nativeWebGPUSurfacePresentationVerified`、`webGPURenderResourceLifecycleVerified` 记录第五批结果。它们不表示完整引擎启动或 Renderer 已通过。

## 第六批：TextureSRV 对象、直接绑定和生命周期

新增 `-WebTextureSRVProbe`，通过真正的全局资源入口创建 `FRHIShaderResourceView`，后端独立创建 Dawn texture view；引擎基类 `FRHIView` 持有底层纹理引用。Shader 参数中的 Texture 和 ResourceView 使用相同的 UE SRV 参数槽，绑定时按实际资源类型选择默认 view 或显式 SRV handle，并验证底层纹理的访问状态。

范围为二维、单 mip、单层、单采样、主平面的线性 RGBA8/BGRA8，视图格式必须与纹理匹配。UE 的省略范围及显式 `(0,1)` 范围均支持，规范化使用 `GetViewInfo()`。纹理 SRV 验证函数拒绝 BufferSRV、格式重解释、其他维度/平面及越界范围；BufferSRV 在第七批另行实现。SRT 的 SRV/UAV 和 Uniform View 仍未实现。

记录 / bypass 两模式各 37/37 项，新增 **74/74**、12 draw、43 finalize / submit、24 bind group、12,288 个通道值；GPU validation 错误为 0。六批累计 **296/296**、75 draw / 9 dispatch、306 finalize / submit、1,632,880 个核验值。

本批验证：

- 默认与显式 view 实际创建；view 持有底层纹理；释放 view 并清理资源后纹理引用回落。
- 使用原始 Worker `FScreenVS` / `FScreenPS`，RGBA8 与 BGRA8 两种输入分别绘制四色纹理，四个 texel 的 alpha 各不相同。
- 默认 SRV → 直接 Texture → 显式 SRV 重新绑定；录制模式在 submit 前没有提前 draw。
- 释放调用方的纹理和两个 view 引用后执行待提交绘制；Shader 绑定继续持有实际 view。
- 对每幅 16×16 图像的所有通道进行核验，两个模式、两种格式、三次绘制共 12 份原始 RGBA 内容一致。
- 采样活动 attachment、访问状态不匹配、split transition 的 Begin/End 之间使用均拒绝；End 后恢复有效并自动释放 transition。
- 空资源、BufferSRV、UAV 描述、缺少 ShaderResource 能力、失效纹理、未知/立方体维度、stencil 平面、格式重解释、越界 mip/层明确拒绝。

`verify-ue-rhi-texture-srv.cjs` 独立检查项目名称、计数、全部像素、图像哈希、Worker 包平台与来源、RHI/commandlet DLL 和源码哈希及正常退出日志。`p2TextureSRVProbePass` / `webGPUTextureSRVDirectBindingVerified` 只记录以上原生范围。

2026-10-15 全量 `build-ue-rhi.ps1` 退出 0，四份独立验证分别通过 106、44、72、74 项，前五批的计数及像素均保持通过。随后 Chrome 155.0.8059.40 / Edge 155.0.4283.45 的两个既有页面、1280 / 390 视口共 8/8 通过，9,243,648 个核验值匹配，页面诊断为空；检查了移动页面截图及本批采样 PNG。浏览器回归运行的是既有独立 Shader 页面，新增 TextureSRV 的本轮实现和验证仍在原生宿主。

## 第七批：Typed R32_UINT BufferSRV 的 storage 表示

新增 `-WebBufferShaderProbe` 与 `-WebBufferSRVProbe`。前者通过 UE 注册的 `FMemcpyCS` 和原始 `/Engine/Private/ByteBuffer.usf`，选择已有 `RESOURCE_TYPE=1 / STRUCTURED_ELEMENT_SIZE=0` 分支，生成只读 `StructuredBuffer<uint>` 输入和可写结构化输出。沿用真实 GlobalShader 编译环境、独立 Web SM5 平台及原始 ShaderCompileWorker IPC；45 个 include 与目标提交的 Shader 快照逐一核对，Worker/Editor 参数表和字节码一致，独立 Tint 转换结果相同，错误协议版本与格式版本均被拒绝。

RHI 创建真正的 `FRHIShaderResourceView`，持有底层非 Structured Buffer。Typed R32_UINT 描述通过 UE `GetViewInfo()` 规范化为 uint32 范围；WebGPU 绑定使用只读 storage buffer，不创建纹理或占位 view。省略 count 支持 offset=0 的整个资源；显式子范围检查 storage binding 对齐、大小上限和 64 位范围运算。

ShaderFormat 新增 `readOnlyStorage` / `storageElementFormat` 反射字段，并更新格式缓存版本。Vulkan 前端把该只读 StructuredBuffer 记为参数类型 4；后端保留原始参数表与槽位，依据 SPIR-V 的只读属性选择实际 SRV 资源。这样不需要伪造 Worker 参数表，也不会将只读绑定作为可写 UAV 提交。

记录 / bypass 两模式各 38/38 项，新增 **76/76**、8 dispatch、41 finalize / submit（17 / 24）、8 bind group、3,072 个 uint32 值；GPU validation 错误为 0。七批累计 **372/372**、75 draw / 17 dispatch、347 finalize / submit、1,635,952 个核验值。

| 检查 | 实际核验 |
| --- | --- |
| 描述与引用 | 默认全缓冲 256 个元素；offset=256 字节、96 个元素的子范围；两个 view 实际持有资源引用 |
| 真实 GPU 读取 | 129 元素全缓冲读取及 67 元素子范围读取，目标范围外哨兵不变 |
| 数据更新 | CopyBufferRegion 更新源资源后，既有子范围 view 读取新数据；源资源保持只读 |
| 命令与寿命 | 录制模式提交前不执行；释放调用方的 buffer/view 引用后，待提交 dispatch 仍正确完成 |
| 状态与绑定 | 错误访问状态、split Begin/End 之间访问、非 view 资源、错误元素格式和可写反射均拒绝 |
| 描述负向检查 | 空资源、缺少能力、Structured/Raw/未知类型、float、显式 Typed stride、counter、未对齐、缺 count、越界和整数溢出均拒绝 |
| 独立核验 | Node 重新生成带高位、0 和 UINT_MAX 的期望值，逐个检查十二份 1,024 字节读回，两模式对应哈希一致 |

本批只支持 **RHI Typed R32_UINT view 到已反射 uint32 storage Shader 的明确表示**。没有实现原始 HLSL `Buffer<T>` / texel-buffer 指令的通用 lowering，没有支持其他 Typed 格式、Raw/Structured SRV 或 SRT SRV；Typed UAV 在第八批另行实现。DDPI 的 `SupportsTypedBufferSRVs` 继续为 false，原有 15 个 Typed clear Shader 拒绝项仍保留；不能将本批结果解释为所有 Typed Buffer Shader 已可运行。子范围对齐遵循 WebGPU storage 限制，也不是通用 UE Typed view 的全部范围。

结果为 `ue-buffer-shader-build-results.json`、`ue-rhi-buffer-srv-build-results.json` 和 `buffer-srv-results.json`。前者保存编译、include 与参数表来源，后两者记录 GPU 检查与独立数值核验；源码、模块 DLL、commandlet DLL 和 Worker 包均校验 SHA256。`p2BufferSRVProbePass` / `webGPUTypedR32UintStorageSRVVerified` 表示以上原生范围，`generalTypedBufferShaderLoweringImplemented=false`。

2026-10-15 最终全量 `build-ue-rhi.ps1` 退出 0，五份 RHI 独立验证分别通过 106、44、72、74、76 项，启动诊断准确匹配下一处 Typed BufferUAV 阻塞。P1 的 79 个任务、63 个包、16 个预期拒绝、两类各 252 个包负向检查及两个缺配置检查重跑通过，新增 Buffer Shader 的 Worker 编译与版本负向测试也通过。Chrome 155.0.8059.40 / Edge 155.0.4283.45 的既有两页面、桌面/移动视口共 8/8 通过，9,243,648 个数值匹配，页面诊断为空，移动页面截图正常。`summarize.cjs` 退出 0，汇总 372 项及 1,635,952 个原生核验值。浏览器回归仍为独立 Shader 页面，本批新增 BufferSRV 的 UE RHI 验证运行在原生宿主。

## 第八批：Typed R32_UINT BufferUAV 的 storage 写入

新增 `-WebBufferUAVProbe`，在全局 RHI 的 recorded / bypass 两个模式各通过 41/41 项，新增 **82/82**、12 dispatch、48 finalize / submit（20 / 28）、12 bind group、3,584 个 uint32 值。八批累计 **454/454**、75 draw / 29 dispatch、395 finalize / submit、1,639,536 个核验值，GPU validation 错误为 0。

Typed R32_UINT UAV 使用格式决定的 stride=4，支持 offset=0/count=0 的默认全缓冲和满足 WebGPU storage 对齐的显式子范围。创建与绑定使用同一个范围验证函数；实际绑定调用 UE `GetViewInfo()`，避免把省略的 stride/count 误作零大小绑定。原有 StructuredBuffer UAV 显式 stride/count 路径保留并回归。

`WebBufferShaderProbe` 增加引擎注册的 `FMemsetBufferCS`，与已有 `FMemcpyCS` 一起使用原始 `ByteBuffer.usf` 的 uint storage 分支。两个 Shader 都经真实 Worker IPC、Editor 字节码/原始参数表核对、45 个 include 审计及独立 Tint 转换。可写绑定必须有明确的 `readOnlyStorage=false`；Typed UAV 还必须匹配 `storageElementFormat=PF_R32_UINT`。未改变 ShaderFormat 输出规则，因此继续使用第七批的缓存版本。

| 检查 | 实际核验 |
| --- | --- |
| 全范围与子范围 | 全缓冲写 UINT_MAX，随后子范围写 0x80000001，范围外值保持不变 |
| 两种 Shader 的顺序 | Memcpy 写入带高位的源数据，随后 Memset 覆盖交叠范围，读回符合命令顺序 |
| UAV → SRV | 真实 transition 后经 Typed SRV 再 dispatch 读取，全部 256 个元素与写入一致 |
| Copy 与寿命 | CopyBufferRegion 保存早期写入，后续写入不改变副本；释放调用方 buffer/view 引用后待执行写入仍正确 |
| 访问与类型拒绝 | 错误/缺失反射类型、只读/缺失访问属性、非 view、错误资源状态、split Begin/End 之间绑定均拒绝 |
| 描述拒绝 | 无能力、Structured 资源的 Typed view、Raw/未知类型、float、显式 Typed stride、counter/append、未对齐、缺 count、越界和溢出均拒绝 |
| 独立核验 | Node 逐个比较十四份 1,024 字节读回、两个模式对应哈希，以及模块/源码/Worker 包来源 |

本批支持 R32_UINT 的明确 storage 表示，未实现通用 `RWBuffer<T>` lowering、其他 Typed 格式、UAV counter/append、SRT UAV 或完整 RDG。DDPI Typed Buffer 能力仍关闭，原有 Typed clear Shader 拒绝项保留。

2026-10-15 全量 `build-ue-rhi.ps1` 退出 0，六份独立 RHI 验证分别通过 106、44、72、74、76、82 项，全部使用相同模块版本。P1 的 79 个 Worker 任务、63 个包、16 个预期拒绝、两类各 252 个包负向检查和两个缺配置检查均重跑通过；两个 Buffer Shader 的有效批次与协议/格式版本负向检查也通过。Chrome 155.0.8059.40 / Edge 155.0.4283.45 的两个既有页面、桌面/移动视口共 8/8 回归通过，核验 9,243,648 个值，页面诊断为空。`summarize.cjs` 退出 0，汇总 454 项和 1,639,536 个原生核验值；完整引擎与浏览器场景标志仍为 false。

## 第九批：uint4 BufferSRV/UAV

新增 `-WebUint4Probe`，recorded / bypass 各 39/39 项，合计 **78/78**、12 dispatch、53 finalize / submit（22 / 31）、12 bind group、8,192 个 uint32 值。九批累计 **532/532**、75 draw / 41 dispatch、448 finalize / submit、1,647,728 个核验值，GPU validation 错误为 0。

`PF_R32G32B32A32_UINT` view 使用 16 字节元素规范化，绑定为已反射的 `array<vec4<u32>>` storage。格式反射要求 unsigned 32 位、四分量、runtime array、stride=16、单成员且 offset=0；Shader 缓存版本升至 v4。R32_UINT 与 uint4 view 必须匹配 Shader 的元素格式和读写属性，不能互相混绑。

原始 `ByteBuffer.usf` 的 `FMemcpyCS` / `FMemsetBufferCS` 使用已有 Structured uint4 分支编译；与原有 scalar 两个包合计四包，分别通过 Editor/Worker 字节码、原始参数表、45 个 include 与独立 Tint 输出核对。这仍是 Typed RHI view 的明确 storage 表示，没有实现原始 `Buffer<T>` / `RWBuffer<T>` 的通用 lowering，DDPI Typed Buffer 能力与既有 Typed Shader 拒绝项保持不变。

| 检查 | 实际核验 |
| --- | --- |
| 四分量与范围 | 全缓冲及对齐子范围拷贝，各分量取不同值，包含 0、UINT_MAX、最高位；范围外哨兵保持不变 |
| 向量填充 | 对部分 uint4 元素执行 Memset，核对四个分量全部更新，未触及区域保留此前内容 |
| 更新与访问 | 原 SRV 观察 CopyBufferRegion 更新；UAV 切换到 SRV 后经真实 dispatch 读取全部 128 个向量 |
| 生命周期与模式 | recorded 延迟执行、bypass 立即执行；释放调用方 buffer/view 引用后，Shader 绑定仍持有资源并完成读写 |
| 拒绝边界 | 非 16 字节长度、未对齐、越界、乘法范围溢出、缺 count、float4 格式、scalar/vector 混绑、错误状态、split transition 间绑定 |
| 独立核验 | Node 独立生成期望值，逐个比较十六份 2,048 字节读回，核对两个模式对应哈希与模块/源码/Worker 包来源 |

前八批全部回归通过，使用同一 RHI 模块；Chrome 155.0.8059.40 / Edge 155.0.4283.45 的既有 Shader/材质页面、桌面/移动视口共 8/8 通过，核验 9,243,648 个值，页面诊断为空。更新启动诊断后，全量 `build-ue-rhi.ps1` 与 `summarize.cjs` 均退出 0，`p2Uint4ViewsProbePass=true`，完整启动和浏览器 Runtime 标志仍为 false。浏览器没有运行新增 UE RHI C++ 或完整 UE Runtime。

## 第十批：Structured SRV 与默认 UAV

新增 `-WebStructuredProbe`，uint / uint4 两种元素、recorded / bypass 两种模式共四组，每组 50/50 项，合计 **200/200**、24 dispatch、106 finalize / submit（两组 22、两组 31）、24 bind group、20,480 个 uint32 值。十批累计 **732/732**、75 draw / 65 dispatch、554 finalize / submit、1,668,208 个核验值，GPU validation 错误为 0。

Structured view 的 format 必须为 Unknown，底层 Buffer 必须具有 Structured 与相应 ShaderResource/UnorderedAccess 能力。省略 stride 时读取 Buffer stride，省略 count 且 offset=0 时使用整个 Buffer；显式 stride 只接受与 Buffer 一致的值。SRV/UAV 共用范围验证，检查非零且四字节整数倍的 stride、完整元素、storage 对齐、Device binding 大小上限，以及 64 位范围计算；counter/append、重解释 stride 和 Raw view 不支持。

ShaderFormat 新增 `storageElementStride`，来自 SPIR-V 单成员、offset=0 的 runtime array 元素布局，缓存升至 v5。Structured SRV/UAV 实际绑定要求反射步长与规范化 view 一致，SRV 还要求只读反射属性。实际绑定继续调用 UE `GetViewInfo()`，把推导后的 byte offset / size 传给 WebGPU。Typed view 的元素格式检查保持独立，原有所有探针回归通过。

| 检查 | 实际核验 |
| --- | --- |
| 默认描述与子范围 | uint / uint4 的默认 SRV/UAV 推导完整 256 元素，子范围分别验证显式与继承 stride |
| 实际 GPU 读写 | 原始 ByteBuffer.usf Memcpy/Memset Worker 包执行全范围与子范围拷贝、部分填充，四分量差异与范围外哨兵保持正确 |
| 更新与可见性 | 同一 SRV 观察 CopyBufferRegion 更新；UAV→SRV transition 后经第二次 dispatch 读取写入结果 |
| 寿命与执行模式 | recorded 延后执行、bypass 立即执行；释放调用方引用后待执行操作正确，Shader 绑定保留 view 与 Buffer |
| 拒绝边界 | 空资源、缺能力、非 Structured Buffer、错误 format/stride、counter/append、对齐/缺 count/越界/溢出、缺失或不匹配的 Shader stride、错误状态及 split transition 之间绑定 |
| 独立核验 | Node 独立计算期望值，逐个比较三十二份 1,024/4,096 字节读回；对应模式哈希一致，模块/源码/Worker 包来源一致 |

全量 `build-ue-rhi.ps1` 和 `summarize.cjs` 均退出 0，`p2StructuredViewsProbePass=true`。P1 原有 79 任务、63 包、16 个预期拒绝及负向检查重跑通过；四个 Buffer Shader 的 Worker/Editor、45 个 include 与独立 Tint 核对通过。Chrome 155.0.8059.40 / Edge 155.0.4283.45 的既有 Shader/材质页面、桌面/移动视口 8/8 回归通过，核验 9,243,648 个值，页面诊断为空。

Structured GPU 样本覆盖 uint 与 uint4，其他结构布局需要专门样本。启动创建 `BlackFloat4StructuredBuffer` 的 SRV/UAV 只验证描述与生命周期入口，没有测试浮点 Shader 运算；不能据此宣称 Typed float4 已支持。SRT SRV/UAV、Uniform View、完整引擎和浏览器 Runtime 仍未完成。

## 第十一批：Typed float4 SRV/UAV 与浮点运算

新增 `-WebFloat4Probe`，recorded / bypass 各 41/41 项，合计 **82/82**、12 dispatch、53 finalize / submit（22 / 31）、12 bind group、16,384 个浮点核验值。十一批累计 **814/814**、75 draw / 77 dispatch、607 finalize / submit、1,684,592 个值，GPU validation 错误为 0。

`PF_A32B32G32R32F` Typed SRV/UAV 使用 16 字节元素，支持默认全缓冲与对齐子范围。ShaderFormat 只对 32 位、四分量、stride=16、offset=0 的 float runtime array 输出该格式，缓存升至 v6；Typed 绑定要求元素格式、步长、读写属性和访问状态一致。float4 与 uint4 的误绑定在创建 bind group 前拒绝。

本批新增明确标记为 probe-only 的 `WebFloat4Probe.usf`，包含 `StructuredBuffer<float4>` / `RWStructuredBuffer<float4>` 乘加和填充两个入口，沿用 UE 注册的计算 Shader 编译环境，经 Native Vulkan 前端、独立 Web SM5、真实 ShaderCompileWorker IPC 和 Tint 生成可执行包。两个包各核对 44 个 include，其中 43 个来自固定目标 Shader 快照，另一个是测试专用文件；Worker/Editor 字节码、参数表及独立 Tint 输出一致。原有四个 uint/uint4 包继续各核对 45 个引擎 include。

| 检查 | 实际核验 |
| --- | --- |
| 浮点乘加 | 每分量使用不同 scale/bias，完整 4,096 字节 Buffer 核对负数、二进制小数、结果和范围外哨兵 |
| 子范围与填充 | SRV offset=256、UAV offset=512；局部变换、四种不同浮点填充值及未改写数据 |
| 更新可见性 | 同一个 view 在底层 Buffer 复制更新后读到新数据；UAV 写入经 transition 后由 SRV 读取到 Structured 输出 |
| 引用寿命 | 记录 dispatch 后释放调用方 Buffer/view 引用，执行后由 Shader 保留的 view 回读，源数据保持不变 |
| 格式、范围、状态拒绝 | 不完整元素、显式 Typed stride、未对齐、缺 count、越界、溢出、scalar float 格式、uint4/float4 混绑、错误状态和 split transition |
| 提交与恢复 | recorded / bypass 实际执行时机、两个 compute PSO 复用、六个 transition 释放及恢复 NullRHI |

独立 Node 验证器逐项比较十六份完整二进制读回，两种模式对应文件哈希相同。数值选择可精确表示的有限二进制小数，未定义或测试 NaN、Inf、subnormal 的跨平台合同。测试专用 Shader 不等同于原始引擎 Typed `Buffer<T>` / `RWBuffer<T>` 的通用 lowering；DDPI Typed Buffer 能力与既有 16 个拒绝项不变。

全量 `build-ue-rhi.ps1` 与 `summarize.cjs` 退出 0，`p2Float4ViewsProbePass=true`。前十批原生回归全部通过，P1 的 79 任务、63 包、16 个预期拒绝和负向检查重新通过。Chrome 155.0.8059.40 / Edge 155.0.4283.45 的既有 Shader/材质页面、桌面/窄屏视口共 8/8 通过，核验 9,243,648 个值，页面诊断为空。该浏览器回归没有执行新增 UE RHI 或 float4 原生探针。

## 第十二批：Buffer Lock/Unlock 与上传顺序

新增 `-WebBufferLockProbe`，recorded / bypass 与 UE `r.RHICmdBufferWriteLocks` 开关组合成四组，每组 40/40 项，合计 **160/160**、4 dispatch、108 finalize / submit（28 / 22 / 29 / 29）、7,296 个 uint32 核验值。十二批累计 **974/974**、75 draw / 81 dispatch、715 finalize / submit、1,691,888 个值，GPU validation 错误为 0。

实现 `LockBuffer_BottomOfPipe` / `UnlockBuffer_BottomOfPipe`。WriteOnly 返回后端持有的 CPU 暂存区；Unlock 创建独立 staging Buffer，再向当前 encoder 编码复制，使较早 draw/dispatch/copy 不会观察到未来的写入。允许四字节对齐的非空子范围，使用 64 位范围计算；当前不支持两字节/其他未对齐锁、NoOverwrite 和多线程 owner。每组五次上传共 1,100 字节，六次 Lock/Unlock 平衡，活动锁持有底层 Buffer。

原生 ReadOnly 通过真实 GPU Buffer 复制和 map 同步读回，先提交较早编码的工作，再返回请求范围的 CPU 数据，不依赖可能过期的 CPU shadow。Unlock 丢弃这份 CPU 数据的修改，不回写 GPU。此同步实现只在原生 Dawn 宿主验证，不能据此认为浏览器事件循环中的同步读锁已经可用。

| 检查 | 实际核验 |
| --- | --- |
| 完整写入与部分更新 | 1,024 字节 Vertex Buffer 完整写入后先复制；再更新 20..59 字节、重叠更新 32..47 字节，各阶段复制保留当时结果及范围外哨兵 |
| UE 缓存写锁 | recorded/bypass、缓存开/关四组合；验证实际后端上传发生时机与最终读回一致 |
| GPU 写后读锁 | 原始 ByteBuffer.usf Memset Worker Shader 写入 23 个 uint；ReadOnly 读取真实 GPU 结果，保留逻辑 UAV 状态，CPU 修改不回写 |
| Index 与引用寿命 | stride=2 的 Index Buffer 使用四字节对齐锁上传，核对整个资源；调用方释放后，活动后端锁仍保留 Buffer |
| 并发锁与状态 | 两个不同 Buffer 可同时锁定；同 Buffer 的重入、锁定期间的 GPU 访问、读回和 transition 均拒绝 |
| 负向与清理 | 空资源、空范围、未对齐、越界、溢出、NoOverwrite、无效模式、无匹配/重复 Unlock、render pass 内锁定、split transition 内锁定；最终恢复 NullRHI 和控制台变量 |

四组共三十二份读回由独立 Node 验证器逐个 uint 比较，每组 1,824 个值；同名输出在四种模式下的 SHA256 一致。计算样本复用真实引擎的 `WebR32Uint_MemsetBufferCS` Worker 包，45 个引擎 include、参数表、包和模块/源码哈希均核对。

全量 `build-ue-rhi.ps1` 和 `summarize.cjs` 退出 0，`p2BufferLockProbePass=true`；前十一批回归通过。P1 79 任务、63 包、16 个预期拒绝及负向检查重新通过。Chrome 155.0.8059.40 / Edge 155.0.4283.45 既有 Shader/材质页面桌面/窄屏共 8/8 通过，核验 9,243,648 个值；浏览器没有执行新增 UE Lock/Unlock 探针。

## 第十三批：三维纹理、BulkData 与实际采样

新增 `-WebTexture3DProbe`，recorded / bypass 各 71/71 项，合计 **142/142**、48 dispatch、143 finalize / submit（58 / 85）、3,552 个核验值。十三批累计 **1,116/1,116**、75 draw / 129 dispatch、858 finalize / submit、1,695,440 个值，GPU validation 错误为 0。

实现范围为单 mip、单采样、单 array 元素、线性 `PF_R8G8B8A8` / `PF_B8G8R8A8` 的 Texture3D，支持 Default、Initializer 与 BulkData。上传包含全部深度层，行距为 width×4，rowsPerImage 为 height；BulkData 在释放源数据前复制快照，再调用一次 Discard。BGRA8 保持原生 BGRA8 格式与字节顺序，实测无需通道转换。二维同格式也接入 BulkData。

ShaderFormat 新增 sampled image 的 `textureDimension`、`textureArrayed`、`textureMultisampled` 反射，缓存版本升至 v7。实际绑定必须匹配 Shader 的二维/三维维度；Texture3D SRV 只接受匹配格式、Primary plane、mip0 和完整深度。现有二维更新、纹理复制和 ReadSurfaceData 明确拒绝三维资源，尚未扩大为通用 3D 更新/复制接口。

两个明确标记为测试专用的 Shader 位于 `WebTexture3DProbe.usf`，经 UE 原生编译、真实 Worker IPC 和独立 Tint 比较，每个核对 44 个 include（43 个目标引擎 include、一个测试源）。Load 与 SampleLevel 输出 uint4 storage array，测试没有替换引擎 Shader，也不表示 Renderer 已接入。

| 检查 | 实际核验 |
| --- | --- |
| 3×2×3 非对称体素 | RGBA8/BGRA8、Initializer/BulkData 四组，18 个体素的 R/G/B/A 均不同，覆盖全部深度层 |
| Load 与采样 | 原始 Texture 直接 Load、Texture3D SRV Load、point sample、Z 方向 wrap 与 clamp，各分量精确比较 |
| BulkData 生命周期 | Discard 覆写并释放源内存后，GPU 仍读到原始数据；错误大小的 BulkData 不会被 Discard |
| 资源引用 | 释放调用方 Texture/SRV 后执行命令，Shader 参数保留 view 和底层纹理，读回一致 |
| 绑定/状态拒绝 | 拒绝二维 Shader/三维纹理、二维 view/三维纹理、三维 Shader/二维纹理和 CopyDest 状态下采样 |
| 创建边界 | 拒绝 array、多 mip、多采样、SRGB、3D render target/UAV、空尺寸、缺失/错误 BulkData、未支持的整数格式 |
| 二维回归 | RGBA8/BGRA8 的二维 BulkData 逐像素核对颜色和 alpha |

48 份完整 uint4 Buffer 由 Node 独立比较 3,456 个值，同名 recorded/bypass 文件哈希相同；二维 BulkData 的另外 96 个通道值在 UE 内比较，共 3,552 个值。前十二批正向回归均退出 0；首轮总脚本在旧启动阻塞匹配处停止，按实际新日志更新诊断后，该阶段单独复跑退出 0，汇总退出 0。Chrome 155.0.8059.40 / Edge 155.0.4283.45 既有 Shader/材质页面桌面和窄视口 8/8 回归通过；这不是 UE Runtime 或真实手机测试。

## 第十四批：整数体积纹理与 Shader 类型

新增 `-WebTextureUintProbe`，recorded / bypass 各 60/60 项，合计 **120/120**、20 dispatch、59 finalize / submit（24 / 35）、1,680 个 uint32 核验值。十四批累计 **1,236/1,236**、75 draw / 149 dispatch、917 finalize / submit、1,697,120 个值，GPU validation 错误为 0。

`PF_R8G8B8A8_UINT` 映射为原生 `RGBA8Uint`，目前只开放单 mip、单采样、单 array 元素的 Texture3D ShaderResource，复用 Default、Initializer、BulkData 和完整深度上传。对应 SRV 保持整数格式，禁止用 RGBA8 Unorm view 重解释。二维整数资源、整数 render target/UAV、过滤采样和三维更新/复制未在本批开放。

ShaderFormat v8 从 SPIR-V 的标量类型生成 `textureSampleType`（float/uint/sint），并与 Tint 的 sampled kind 比较。实际纹理绑定同时检查维度与标量类型，整数纹理不能进入 float Shader，归一化纹理也不能进入 uint Shader；缺失类型字段或 signed/unsigned 不符在创建绑定组之前拒绝。记录 sint 不代表后端已经支持有符号纹理格式。

两个测试专用 Shader 位于 `WebTextureUintProbe.usf`：LoadCS 原样读取 uint4，InspectCS 反向遍历体积并用 GetDimensions 输出宽、高、深度和 mip 数。均经 UE 原生编译、真实 Worker IPC、Editor 包与独立 Tint 比较，每个核对 44 个 include（43 个目标引擎 include、一个测试源），生成 `texture_3d<u32>`。同时重编第十三批 float 体积 Shader，验证两种类型的拒绝关系。

| 检查 | 实际核验 |
| --- | --- |
| 3×2×3 整数体素 | Initializer/BulkData 两组，每个分量直接读出字节值，包含 0、1、127、128、254、255 |
| Load / GetDimensions | 直接纹理、Texture3D SRV、逆序 XYZ 读取、实际 3×2×3 尺寸与单 mip；输出两端保留 `0xdeadbeef` 哨兵 |
| 初始化与释放 | BulkData 快照后覆写/释放源内存，调用方 Texture/SRV 释放后读回一致；默认创建首次读取为零 |
| 引擎默认资源形状 | 1×1×1 RGBA8_UINT 的 BulkData、四分量 Load 与 GetDimensions 单独核验 |
| Shader 类型拒绝 | 拒绝 float Shader/uint 纹理（直接与 SRV）、uint Shader/unorm 纹理、缺失类型和 sint 类型 |
| 创建与 view 边界 | 拒绝二维整数、SRGB、3D render target/UAV、多 mip、array、多采样、超限尺寸、缺失/过短/过长 BulkData、格式重解释与 view 越界 |
| 状态和恢复 | CopyDest 期间拒绝绑定，恢复 SRV 后读取；临时全局 RHI、PSO cache 和宿主退出正常 |

20 份完整 Buffer 由 Node 独立核验全部 1,680 个值，同名 recorded/bypass 文件哈希一致。前十三批正向回归通过，十二个 RHI commandlet 全部正常退出。总脚本首轮在旧启动诊断预期处停止；按真实新日志更新后，启动诊断单独复跑与汇总均退出 0。Chrome 155.0.8059.40 / Edge 155.0.4283.45 既有 Shader/材质页面桌面及窄视口 8/8 通过，核验 9,243,648 个值；新增整数体积测试在原生宿主执行。

## 启动诊断：最小启动越过数组纹理，停在颜色 Buffer SRV

隔离平台增加 `WebGPUEngine.ini`：

```ini
[ImportedRHI]
ModuleName=WebGPURHI
RHIName=WebGPU
FeatureLevel=SM5
```

使用 `-PlatformRHI=WebGPU -WebRHIStartupProbe -AllowCommandletRendering -onethread -norhithread -NoShaderCompile`，不使用 `-nullrhi`，也不在 commandlet 中手工交换 `GDynamicRHI`。实际链路为 `RHIInit -> Windows PlatformCreateDynamicRHI -> ImportedRHI -> 模块 IsSupported / CreateRHI -> WebGPURHI::Init`，日志确认平台 47 和 Device 创建。

原先的 ResourceArray Buffer 和 RGBA8 texture initializer 阻塞已补齐，并纳入第五批独立验证。第六批补齐 TextureSRV 后，真实启动成功创建 `FWhiteTexture`、`FBlackTextureWithSRV`、`FBlackTexture` 的三个 SRV，格式均为 37（RGBA8）。

第七、八批补齐后，启动创建 `EmptyVertexBuffer` 的 R32_UINT SRV 和 UAV，规范化结果均为 stride=4、count=4、offset=0。第九批进一步创建 `EmptyUInt4VertexBuffer` 的 SRV 和 UAV，格式为 48（`PF_R32G32B32A32_UINT`），规范化均为 stride=16、count=1、offset=0。

第十批进一步创建 `EmptyStructuredBuffer` 的 Structured SRV/UAV，format=0、stride=4、count=4、offset=0；随后创建 `BlackFloat4StructuredBuffer` 的 Structured SRV/UAV，format=0、stride=16、count=1、offset=0。两个资源都使用省略 stride/count 的默认 view 描述。

第十一批进一步创建 `BlackFloat4VertexBuffer` 的 Typed float4 SRV/UAV，以及 `WhiteVertexBuffer`、`BlackVertexBuffer` 的同格式 SRV。均为 format=1（`PF_A32B32G32R32F`）、stride=16、count=1、offset=0。

第十二批启动日志确认 `WhiteVertexBufferWithRDG` 的 WriteOnly Lock/Unlock 已完成：offset=0、size=16、mode=1。这个启动尝试已编码上传，尚未提交/读回该默认资源；数据与次序由单独的第十二批原生 GPU 探针验证。

第十三批进一步确认两个 `BlackVolumeTexture3D` 已执行 BulkData 上传，日志均为 dimension=2、format=2、depth=1，对应 RenderCore 的黑色及 alpha=1 默认体积纹理。此启动进程没有对默认体积纹理做读回；上传数据、采样及 Discard 生命周期由第十三批独立 GPU 探针验证。

第十四批进一步确认第三个 `BlackVolumeTexture3D` 已执行 BulkData 上传，dimension=2、format=60、depth=1，对应 RenderCore 的 `GBlackUintVolumeTexture`。此启动进程没有读回默认纹理；整数体积的各分量、尺寸与引用寿命由第十四批独立 GPU 探针验证。

未裁剪的对照启动停止于 BGRA8 二维数组纹理创建：`dimension=1 format=2 extent=1x1 depth=1 array=1 mips=1 samples=1 init=2 flags=0x8`。宿主枚举中 dimension=1 为 Texture2DArray，format=2 为 BGRA8，init=2 为 Initializer；RenderCore 的 `FBlackArrayTexture` 使用该描述。即使 array=1，其资源/Shader 维度仍为数组，本后端尚未支持。

新增 `-WebMinimalStartup` 开关，只在 `-WebRHIStartupProbe` 的 `Init` 中生效。设备创建后、`GIsRHIInitialized` 仍为 false 时，用 `ReleaseResource()` 从待初始化列表注销以下六项，并验证它们原先已注册、没有 TextureRHI/SamplerStateRHI、注销后不再初始化。保留全局资源对象，不修改安装版 RenderCore 或目标分支源码。

| 注销的默认资源 | 已核对的主要消费者 | 最小场景处理范围 |
| --- | --- | --- |
| GBlackArrayTexture | MaterialUniformExpressions 的 Array2D/ArrayCube 参数；View 的 Glint、SSProfiles、SpecularProfile、ToonProfile；SubsurfaceProfile 回退 | 不启用数组材质和这些高级着色路径；View 中的未使用字段仍待源码适配 |
| GWhiteTextureCube / GBlackTextureCube | 材质 Cube 回退、天空光、雾、反射等 | 当前 Unlit 启动测试不消费它们，未验证真实 Renderer |
| GBlackTextureDepthCube / GBlackCubeArrayTexture | 阴影及反射回退、SystemTextures | 最小场景不启用相关路径，消费者裁剪尚未接入 |
| GBlackUintTexture | 虚拟纹理页表、光照贴图 VT、Lumen / MaterialCache | 当前最小场景不使用虚拟纹理，未增加 PF_R32G32B32A32_UINT 纹理支持 |

源文件位置和消费者已对照目标提交与安装版代码核对：`RenderCore/Private/GlobalRenderResources.cpp`、`RenderResource.cpp`、`Engine/Private/Materials/MaterialUniformExpressions.cpp`、`SceneManagement.cpp` 及相关 Renderer 文件。该开关是安装版宿主的验证适配，不代表真正 Web 平台的条件编译已完成，也不能据此让数组资源的消费者继续运行。

首次带开关的启动保留此前默认资源的全部创建/上传日志，到达 `FNullColorVertexBuffer`：`format=37 bufferType=1 stride=0 count=0 offset=0`，随后因 Typed RGBA8 BufferSRV 尚不支持而退出 3。没有创建该 SRV，也没有完成预初始化、commandlet Main 或 Renderer。`FNullColorVertexBuffer` 的顶点缓冲用于普通网格，不能整项注销；本轮继续处理如下。

`probe-ue-rhi-startup.cjs` 依次验证未裁剪和最小启动：配置哈希、模块选择/Device、六项注销日志及其时序、此前默认资源日志一致，以及两种确切阻塞/调用栈。`ue-rhi-startup-diagnostic.json` 保留对照结果，并在 `minimalStartup` 下记录新结果。`diagnosticVerified=true` 和 `minimalStartup.diagnosticVerified=true` 表示诊断符合预期；两者 `startupSucceeded=false`。全局 Shader 编译/加载仍由 `-NoShaderCompile` 禁用，`importedWebGPURHIStartupVerified=false`。

上一轮增量编译、十二个原生 RHI commandlet 和独立验证器通过，十四批 1,236 项和 1,697,120 个核验值保持通过；当时 `webGPURHIStartupBlocker=NullColorVertexBufferTypedSRV`。没有重新构建 P1 Worker 或重跑浏览器页面，浏览器 UE Runtime、Cook 和真实场景仍未接入。

### 保留顶点缓冲与延迟状态校验

在显式最小启动模式，按 `GNullColorVertexBuffer.VertexBufferRHI` / `GNullVertexBuffer.VertexBufferRHI` 指针匹配两个资源，并检查格式、默认 view 范围、缓冲大小和用途。DDPI 的 manual vertex fetch 与 vertex shader SRV 能力都关闭时，仅省略 PF_R8G8B8A8 SRV。两个顶点缓冲保留真实分配和上传，GPU 读回逐字节核对：颜色缓冲 16 字节全 255，空顶点缓冲 12 字节全 0。这 28 字节独立记录，不叠加到既有十四批计数；没有实现通用 RGBA8 Typed SRV。

状态对象创建先保留原始描述：Rasterizer / DepthStencil / Blend 由现有 PSO 校验实际使用范围；Sampler 在绑定时才创建 Dawn 对象并检查原先支持的 point/no-bias/no-comparison 范围。未绑定的默认线框、MSAA、线性和各向异性描述因此不再阻塞预初始化，没有新增这些绘制能力。`-WebRejectDeferredRasterizer` 和 `-WebRejectDeferredSampler` 分别令已有核心绘制尝试使用线框和 bilinear 状态，要求对象先成功构造，再在 PSO / `ResolveSampler` 明确拒绝，不能接受其他位置的失败。

最小启动保留此前默认资源日志，新增 `FPrimitiveIdDummyBuffer` 的 format=28、stride=4、count=1 SRV，当前停止于 `FDFDummyByteAddress`：`format=0 bufferType=4 stride=0 count=0 offset=0`。原生启动仍退出 3，预初始化、commandlet Main 和 Renderer 尚未完成。该缓冲为 `Renderer/Private/FXRenderingUtils.cpp` 的内部静态全局资源；即使 ShaderPlatform 已关闭距离场，也仍被默认初始化。下一步同时守卫初始化与 `DistanceFields::SetupAtlasParameters` 的消费路径，不增加 Raw Buffer。

适配边界保持明确：本轮没有修改安装版引擎或目标分支源码；View、LocalVertexFactory 等消费者以及 SM5 Uniform 对空 SRV 的检查尚未完成 Web 适配。顶点缓冲读回通过不能证明完整网格 Renderer 已可运行。

本轮增量构建成功；复用未修改的 Worker Shader 包，十二个正向 commandlet 和全部独立验证器均退出 0，1,236 项与 1,697,120 个核验值通过，报告均匹配当前同一 RHI DLL。更新后的四进程诊断和 `summarize.cjs` 退出 0；`webGPUDefaultVertexBuffersPreservedVerified`、`webGPUDeferredStateValidationVerified` 为 true，`webGPURHIStartupBlocker=DistanceFieldDummyByteAddressSRV`。最小启动的 28 字节读回与两项预期拒绝单独记录，未增加正向批次计数。本轮未重建 P1 Worker、未重跑浏览器页面。

### 距离场的目标源码裁剪

目标提交的 `Engine/Source/Runtime/Renderer/Private/FXRenderingUtils.cpp` 已新增 `defined(PLATFORM_WEB) && PLATFORM_WEB` 分支，同时排除 `FDFDummyByteAddress` 类、`GDFDummyByteAddress` 静态对象及原距离场对象/Atlas 绑定代码。公开元数据与三个函数入口保留：`HasDataToBind` 返回 false；两个 Setup 函数接收空目标指针时不做操作，实际要求绑定参数则 Fatal 明确拒绝。这样不会继续注册空 pooled buffer，也不声称支持距离场效果；Niagara 距离场相关效果不在最小场景范围。

新增 `verify-web-renderer-source.cjs`，对完整修改文件进行条件源码验证。安装版 5.8.0 的 Renderer 定义、真实头文件与现有 UBT/MSVC 编译环境用于生成两个 Win64 对象：常规桌面分支、`PLATFORM_WEB=1` 分支。对照预处理目标 5.8.3 的原文件，归一化空白与诊断文件名/行号后桌面代码完全一致。对象符号检查确认桌面仍有原默认资源和 `DistanceField::Setup*` 依赖；Web 下两者均不存在，三个公开入口仍保留。完整编译均退出 0，未用模拟类型替代 Renderer/RDG 接口。

结果写入 `results/ue-web-renderer-source-results.json`，记录目标/原文件、编译定义和对象哈希；汇总校验当前源码与对象哈希后设置 `webDistanceFieldConditionalSourceVerified=true`。`modifiedWebRendererLinkedIntoHost`、`modifiedWebRendererStartupVerified`、`modifiedWebRendererWasmCompiled` 均保持 false。安装版引擎和 RHI 插件本轮未修改，没有重跑既有 1,236 项 GPU 回归或浏览器页面；已有结果保留。旧宿主使用的 Renderer DLL 尚未改变，其距离场启动阻塞仍未越过。

下一步优先接入 Web UBT/Emscripten、定义 `PLATFORM_WEB=1` 的真正构建入口和最小 Core/Launch Runtime，配合继续落实必要消费者裁剪；不再将重编桌面 Editor 或清空其全部默认资源阻塞作为 WASM 的前置条件。

## 复现

工作区已有固定 Dawn、DXC、目标 Shader 快照、UE 安装版及 MSVC 工具链。

```powershell
& H:/ue_html/tests/web-platform/build-ue-rhi.ps1 -Engine H:/UE_5.8
node H:/ue_html/tests/web-platform/summarize.cjs
```

脚本先构建 Dawn C API DLL，再全量复现 P1 独立 ShaderPlatform / Worker，构建插件并刷新隔离主机；随后向隔离主机复制 Dawn / DXC DLL，编译并独立核验六个 Buffer Shader（四个引擎分支、两个测试专用）、两个测试专用浮点 Texture3D Shader 和两个测试专用整数 Texture3D Shader。最后分别运行本地、临时全局、viewport、TextureSRV、BufferSRV、BufferUAV、uint4、Structured、float4、BufferLock、Texture3D、TextureUint 十二个 RHI commandlet 及对应独立核验，再运行 `probe-ue-rhi-startup.cjs`。十二个正向 RHI commandlet 必须退出 0；该诊断另启四个预期退出 3 的进程：未裁剪启动匹配二维数组纹理，最小启动匹配距离场 ByteAddress SRV，两项状态拒绝匹配对象构造标记与确切 PSO/绑定调用栈。其他错误不接受，预期失败不计入正向通过项。

脚本最后执行 `verify-web-renderer-source.cjs`，验证目标源码裁剪；该步骤不替换隔离宿主的 Renderer DLL。只复现本轮源码验证时可单独运行 `node H:/ue_html/tests/web-platform/verify-web-renderer-source.cjs`，再运行 `summarize.cjs`。

本轮 Windows 事件记录出现 bundled .NET 的 coreclr / clrjit 访问冲突，MSVC 也出现 C1001 / 访问冲突。限制构建进程 CPU 亲和性后完成全量复现，尚未证明底层根因；没有改动系统设置或安装引擎配置。需要复现本轮限制时，在单独 PowerShell 会话中执行：

```powershell
$taskProcess = Get-Process -Id $PID
$taskSavedAffinity = $taskProcess.ProcessorAffinity
try {
    $taskProcess.ProcessorAffinity = [IntPtr]3
    & H:/ue_html/tests/web-platform/build-ue-rhi.ps1 -Engine H:/UE_5.8
} finally {
    $taskProcess.ProcessorAffinity = $taskSavedAffinity
}
```

`verify-ue-rhi.cjs` 检查所有必需项目、draw/dispatch/submit 计数、原始 64×64 RGBA 数据和日志，同时记录 Shader 包、源码、RHI DLL、Dawn / DXC 的 SHA256。输出：

| 文件 | 内容 |
| --- | --- |
| `tests/web-platform/build/ue-rhi/rhi-results.json` | UE 内部运行结果、核心计数快照、材质和 transition 结果及功能边界 |
| `tests/web-platform/build/ue-rhi/indexed-64x64.rgba` | GPU 读回的原始图像 |
| `tests/web-platform/results/ue-rhi-build-results.json` | 独立像素验证、版本和依赖来源 |
| `tests/web-platform/results/ue-rhi-host.log` | commandlet 日志 |
| `tests/web-platform/results/ue-rhi-indexed-64x64.png` | 原始读回转换的 PNG |
| `tests/web-platform/build/ue-rhi/UnlitColor-64x64.rgba`、`UnlitTexture-64x64.rgba` | 两种默认材质的原始 GPU 读回，alpha=0 |
| `tests/web-platform/results/ue-rhi-UnlitColor-64x64.png`、`ue-rhi-UnlitTexture-64x64.png` | 材质读回的 RGB 预览，alpha 显示为不透明 |
| `tests/web-platform/build/ue-platform-material-worker/uniform-layouts.json` | UE 导出的实际布局描述，与 Worker 哈希匹配 |
| `tests/web-platform/build/ue-rhi/transition-sampled-64x64.rgba` | RTV → SRV 后采样得到的原始 GPU 读回 |
| `tests/web-platform/results/ue-rhi-transition-sampled-64x64.png` | 独立 Node 验证器逐像素核对后的 transition 预览 |
| `tests/web-platform/build/ue-rhi-global/global-rhi-results.json` | 全局 recorded / bypass 两个模式的结果、计数与功能边界 |
| `tests/web-platform/results/ue-rhi-global-build-results.json` | 44 项检查与图像的独立核验、命令入口/模块/Shader/源码 SHA256 |
| `tests/web-platform/results/ue-rhi-global-host.log` | 临时全局 RHI commandlet 日志，核对恢复后的正常退出 |
| `tests/web-platform/build/ue-rhi-global/recorded-64x64.rgba`、`bypass-64x64.rgba` | 全局 indexed 采样的真实读回，两个模式内容一致 |
| `tests/web-platform/build/ue-rhi-viewport/viewport-rhi-results.json` | 第五批两个执行模式的检查及 surface 计数 |
| `tests/web-platform/results/ue-rhi-viewport-build-results.json` | 72 项检查、八份 surface 读回及模块/源码的独立核验 |
| `tests/web-platform/results/ue-rhi-viewport-recorded-surface-first-frame.png` | 第一个真实 surface 的读回预览 |
| `tests/web-platform/results/ue-rhi-viewport-host.log` | 第五批正常退出日志 |
| `tests/web-platform/build/ue-rhi-texture-srv/texture-srv-results.json` | 第六批 recorded / bypass 的 74 项检查和计数 |
| `tests/web-platform/results/ue-rhi-texture-srv-build-results.json` | 十二幅逐像素核验及 DLL、源码、Shader 包哈希 |
| `tests/web-platform/results/ue-rhi-texture-srv-recorded-rgba8-default-view.png` | 四色及不同 alpha 的真实采样回读 |
| `tests/web-platform/results/ue-buffer-shader-build-results.json` | 第七批 Shader 的 Worker/Editor、45 个 include、原始参数表与独立 Tint 核对 |
| `tests/web-platform/build/ue-buffer-worker/WebR32Uint_MemcpyCS.webshader` | 原始 ByteBuffer.usf uint storage 分支的真实 Worker 字节码 |
| `tests/web-platform/build/ue-rhi-buffer-srv/buffer-srv-results.json` | 第七批两个执行模式的 76 项检查和计数 |
| `tests/web-platform/results/ue-rhi-buffer-srv-build-results.json` | 十二份 uint32 GPU 读回的独立校验及来源哈希 |
| `tests/web-platform/build/ue-buffer-worker/WebR32Uint_MemsetBufferCS.webshader` | 第八批原始 ByteBuffer.usf Memset 的真实 Worker 字节码 |
| `tests/web-platform/build/ue-rhi-buffer-uav/buffer-uav-results.json` | 第八批两个模式 82 项检查与 GPU 计数 |
| `tests/web-platform/results/ue-rhi-buffer-uav-build-results.json` | 十四份 uint32 读回、来源哈希和独立数值核验 |
| `tests/web-platform/build/ue-rhi-uint4/uint4-results.json` | 第九批两个模式 78 项检查、GPU 与命令列表计数 |
| `tests/web-platform/results/ue-rhi-uint4-build-results.json` | 十六份 uint4 GPU 读回、模块/源码/Worker 包哈希及独立数值核验 |
| `tests/web-platform/build/ue-rhi-structured/structured-results.json` | 第十批 uint/uint4、recorded/bypass 四组 200 项检查与 GPU 计数 |
| `tests/web-platform/results/ue-rhi-structured-build-results.json` | 三十二份 GPU 读回、模块/源码/Worker 包哈希及独立核验 |
| `tests/web-platform/build/ue-rhi-float4/float4-results.json` | 第十一批 recorded/bypass 两组 82 项检查与 GPU 计数 |
| `tests/web-platform/results/ue-rhi-float4-build-results.json` | 十六份浮点 GPU 读回、模块/源码/Worker 包及 include 来源哈希、独立核验 |
| `tests/ue-shader-host/Shaders/Private/WebFloat4Probe.usf` | 明确标记为 probe-only 的浮点乘加与填充 Shader |
| `tests/web-platform/build/ue-rhi-buffer-lock/buffer-lock-results.json` | 第十二批四种执行/缓存组合的 160 项检查及 GPU/锁计数 |
| `tests/web-platform/results/ue-rhi-buffer-lock-build-results.json` | 三十二份 GPU 读回、模块/源码/Worker/include 来源哈希与独立逐值核验 |
| `tests/web-platform/results/ue-rhi-buffer-lock-host.log` | Lock/Unlock commandlet 的检查与正常退出日志 |
| `tests/web-platform/results/ue-texture-shader-build-results.json` | 两个 Texture3D Shader 的 Worker/Editor、include 哈希和独立 Tint 核验 |
| `tests/ue-shader-host/Shaders/Private/WebTexture3DProbe.usf` | 明确标记为 probe-only 的 Texture3D Load/SampleLevel Shader |
| `tests/web-platform/build/ue-rhi-texture-3d/texture-3d-results.json` | 第十三批两种执行模式的 142 项检查、48 dispatch 与 3,552 个核验值 |
| `tests/web-platform/results/ue-rhi-texture-3d-build-results.json` | 48 份完整 Buffer 的独立核验、模块/源码/Worker/include 来源哈希 |
| `tests/web-platform/results/ue-texture-uint-shader-build-results.json` | 两个整数 Texture3D Shader 的真实 Worker/Editor、include 哈希与独立 Tint 核验 |
| `tests/ue-shader-host/Shaders/Private/WebTextureUintProbe.usf` | 明确标记为 probe-only 的 Texture3D uint4 Load/GetDimensions Shader |
| `tests/web-platform/build/ue-rhi-texture-uint/texture-uint-results.json` | 第十四批两种执行模式的 120 项检查、20 dispatch 与 1,680 个整数核验值 |
| `tests/web-platform/results/ue-rhi-texture-uint-build-results.json` | 20 份完整 Buffer 的独立核验、模块/源码/Worker/include 来源哈希 |
| `tests/web-platform/results/ue-rhi-startup-diagnostic.json` | 启动对照、默认顶点缓冲 28 字节 GPU 核对、保留状态描述与两项实际使用拒绝；启动仍未成功 |
| `tests/web-platform/results/ue-rhi-startup-host.log` | 未裁剪对照启动日志，停在二维数组纹理 |
| `tests/web-platform/results/ue-rhi-minimal-startup-host.log` | 最小启动日志，停在距离场 FDFDummyByteAddress 的 ByteAddress SRV |
| `tests/web-platform/results/ue-rhi-deferred-rasterizer-host.log`、`ue-rhi-deferred-sampler-host.log` | 未支持状态先构造、后在 PSO / sampler 绑定拒绝的调用栈 |
| `reference-engine/Engine/Source/Runtime/Renderer/Private/FXRenderingUtils.cpp` | 首处目标引擎源码修改，Web 下排除距离场默认资源与原消费路径 |
| `tests/web-platform/results/ue-web-renderer-source-results.json` | 双分支单文件编译、桌面对照、Web 资源/消费符号排除和哈希；尚未链接或启动 |
| `tests/web-platform/build/ue-web-renderer-source/` | 完整预处理输出、两个 Win64 对象、编译响应文件与符号日志 |

Native Dawn 静态库需要较新的 MSVC 标准库符号，因此以 14.51 工具链链接独立 `WebGPUHost.dll`，导出 276 个 C API；UE 模块继续使用安装引擎配置的 14.44 工具链，只链接 C API import library。没有把 Dawn C++ ABI 或其 MSVC STL 直接暴露给 UE。

## 版本与范围

- 目标分支：`396c9f059903aed5fec78ecd3d437a40c6415368`，UE 5.8.3。
- 实际宿主及 RHI 接口：安装 UE 5.8.0，CL / BuildId `55116800`。
- Shader：既有目标 5.8.3 Shader 快照及独立 Web SM5 / ES31 Worker 产物，六个核心、四个材质、四个 uint32/uint4 storage 样本、两个测试专用 float4、两个测试专用浮点 Texture3D 及两个测试专用整数 Texture3D 包逐一记录哈希。
- GPU：NVIDIA GeForce RTX 3070，Dawn D3D12。
- 依赖：Dawn / Tint `v20261009.190412`，DXC `v1.9.2609`。

这仍是安装版宿主下的验证，未完成目标 5.8.3 全源码引擎构建。插件目前只允许 Win64，浏览器中的既有测试仍运行独立 JS/WASM GPU 探针，没有把 UE Runtime 编译成 WASM。

已实现的保守范围：单线程 context、单采样二维 RGBA8/BGRA8/Depth32 资源、单 mip 线性 RGBA8/BGRA8 三维采样纹理与 RGBA8_UINT 整数体积及 BulkData/Initializer、二维/三维 TextureSRV 直接绑定与维度/标量类型校验、Typed R32_UINT / R32G32B32A32_UINT / A32B32G32R32F BufferSRV/UAV 的 storage 表示、Structured SRV/UAV（GPU 样本包括 uint/uint4 及 float4 输出）、四字节对齐 WriteOnly/原生同步 ReadOnly Buffer Lock/Unlock、数值和纹理/采样器资源表 Uniform、point sampler、多个顶点流的 float2/3/4、triangle list/strip、四 MRT、基本混合和无 stencil 深度状态、单队列资源状态与 split transition、二维纹理复制和离屏读回。实测像素为 RGBA8。光栅状态暂只支持 solid/no-cull/no-bias；未知操作或不支持的参数明确报错，不用 NullRHI 模拟完成。

## 剩余接入

1. Web UBT / wasm64 的普通 Core 和 ApplicationCore Program 已构建运行，浏览器帧回调与基础键鼠消息通过；下一步接 Launch/FEngineLoop 与必要的 Engine 依赖，将已有回调接到真实引擎 Tick，不等待桌面 Editor 或通用 RHI 补齐。
2. 距离场裁剪已落实到源码，待真正 Web 构建与链接验证；继续落实默认纹理/顶点 SRV 的必要裁剪，处理 View、LocalVertexFactory 与 SM5 Uniform 的未使用资源字段。
3. 接通最小场景实际使用的顶点工厂、材质、ShaderMap 和 Renderer 绘制路径，只补运行该场景必需的 RHI 接口与同步，不要求覆盖完整 RDG 或所有 RHI 功能。
4. 接入最小项目的 Cook / Stage / 数据挂载，在浏览器运行真实 UE 场景并验证画面与交互，再接 HTML UI 桥接。

数组纹理、材质层、立方体、多 mip、三维更新/复制、通用 Typed Shader lowering 及更多资源格式不再列为当前必须完成的功能；以后由实际场景需求决定是否接入。已有实现和测试保留，新增测试只针对必要改动及其回归风险。

`p2CoreRHIProbePass`、`p2MaterialRHIProbePass`、`p2TransitionRHIProbePass`、`p2GlobalDispatchProbePass`、`p2ViewportRHIProbePass`、`p2TextureSRVProbePass`、`p2BufferSRVProbePass`、`p2BufferUAVProbePass`、`p2Uint4ViewsProbePass`、`p2StructuredViewsProbePass`、`p2Float4ViewsProbePass`、`p2BufferLockProbePass`、`p2Texture3DProbePass`、`p2IntegerVolumeProbePass` 分别表示十四批探针结果；`p2Complete`、`globalWebGPURHIReplaced`、`completeBrowserUERuntime` 保持 false。

UMG / Slate 依赖没有移除，也未因当前探针引入问题。后续遇到具体 Web 阻塞点时按用户约定局部禁用问题路径。
