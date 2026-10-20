# UE 5.8.3 浏览器平台：实际接入设计

调研日期：2026-10-13。目标：`menghuijinxi/UnrealEngine-1` 的 `html` 分支，提交 `396c9f059903aed5fec78ecd3d437a40c6415368`，`Build.version` 为 5.8.3。

更新日期：2026-10-20。按用户澄清，将原生网页 UI 作为默认产品界面，保留引擎现有 UMG 依赖；UMG 的网页兼容问题优先局部禁编译或降级，不投入大量时间修复，也不以彻底剔除模块为目标。

约束：UE 场景在访问者的浏览器本地运行；不使用像素流；不依赖收费 Web SDK；网页目标不使用 UMG 产品界面。

**2026-10-20 第四十八轮：Web 已排除 RenderCurve 与 Nanite 的未用默认缓冲初始化。** 保留 Scene Uniform/扩展注册和桌面正文，Web 禁用曲线扩展、清零曲线与 Nanite 材质/ownership 默认参数；Nanite 既有平台能力检查保留。没有增加毛发、Nanite 或 Raw/Structured Buffer 功能。原有材质提供者 Engine.32 重编后解决诊断链接缺符号，最终 28 单元/415 项链接通过；仍不是完整正常 Web UBT。

Chrome/Edge 实际越过上述旧栈，当前推进到 GetDefaultSkinningParameters 的默认 Raw Buffer。地图 BeginPlay、NullRHI 各 10 个有效 Tick；WebGPU Init 未返回、完成 Tick 及深度 pass 为 0，首帧未通过。ApplicationCore 68 项、marker ABI 四组正反例、原 40 项和阶段回归通过；原生 RHI 与两套 Cook 沿用有效哈希证据。下一步只排除未用蒙皮默认资源并核对消费者，再验收首帧/连续 Tick、单 Unlit 网格、相机/HTML UI 与完整正常 UBT/版本一致性。详见 P3 第四十八轮，以下为历史检查点。

**2026-10-20 第四十七轮：未用局部雾与 BasePass 默认资源已在 Web 排除。** 局部雾参数保留接口并清零实例/资源；BasePass 对关闭的 DBuffer 保留检查、未用阴影数组设空、反射参数清零、调试/遮挡反馈默认 UAV 设空。其他平台正文及之前策略保留，没有扩展雾、数组、Cube、Raw Buffer 或毛发功能。25 单元/415 项诊断链接、ApplicationCore 正常构建和 68 项浏览器窗口测试、原 40 项及阶段回归通过；原生 RHI 与两套 Cook 本轮未改，已有有效证据沿用哈希审计。

Chrome/Edge 真实地图 BeginPlay，NullRHI 各 10 个有效 Tick；WebGPU 越过局部雾、DBuffer 与反射 Cube 的旧失败，当前在 `RenderFullDepthPrepass → BuildMeshRenderingCommands → Scene Uniform` 的 RenderCurve 默认回调创建 Raw Buffer 时停止。硬件 Init 未返回、完成 Tick 为 0，深度资源分配和深度 pass 为 0。下一步只排除该未用默认初始化，再验收实际深度通道/首帧/连续 Tick、单 Unlit 网格和相机/HTML UI；完整正常 Web UBT 与混合版本仍待验收。新增验证器及各失败前后证据见 P3 第四十七轮，以下为历史检查点。

**2026-10-20 第四十六轮：最小深度附件已接入，浏览器首帧继续独立验收。** 共享 RHI 使用基础 Depth24PlusStencil8，提供实际深度/模板视图、资源状态及只读通道语义；18 项原生检查和完整 RHI 探针的 43 次 draw/5 次 dispatch/1,344,520 个值通过。原生验证包括 reversed-Z、只读深度、深度 0.75 与模板清值 37 的 GPU 读回，未扩展 MSAA、模板比较管线或深度拷贝。

沿用最小功能原则，仅 Web 将三个移动数组默认值设空，并使用引擎已有清零构造初始化 dummy 灯光参数，避免创建未用 Raw/Structured Buffer。桌面正文及已有改动通过逐字/哈希对照保留。24 单元/415 项诊断链接、正常原生与 ApplicationCore 构建、原 40 项和当前阶段回归通过；Cook 沿用已审计真实地图产物，本轮没有重新 Cook。

双浏览器真实地图 BeginPlay 和 NullRHI 各 10 个 Tick 通过。WebGPU 越过原深度格式检查后，停在 `SetDummyLocalFogVolumeForView → GetZeroUIntArrayDummy` 的空外部纹理注册；实际深度分配与深度 pass 为 0，Init 未返回、完成 Tick 为 0。下一步局部排除未用局部雾初始化并核对消费方，再验收深度通道/首帧/连续 Tick、单 Unlit 网格与相机/HTML UI；完整正常 Web UBT 与混合版本问题仍待验收。详细证据见 P3 第四十六轮，以下为历史检查点。

**2026-10-20 第四十五轮：最小验收改为真实 Cook 的 `/Game/WebMinimal`。** 两种 RHI 均必须记录实际 Game World 的包名、BeginPlay 和退出状态；Tick 前后退出请求会中止计数。旧的缺失地图回调计数不再视为运行通过。双浏览器地图 BeginPlay 与 NullRHI 连续 Tick 已通过，硬件首帧仍独立推进。

Web RHI 使用 UE 原有额外呈现转换，保留严格状态检查；允许原生 API 规定的无内容 UniformBuffer 创建和后续更新，绑定时仍检查实际内容尺寸。对当前 Unlit 无用的 GPU 消息、光照 Profile、VSM 和天空反射，在 Web 调用端禁编译；数组相关 View 参数同步禁用。保持桌面实现和既有 UMG/Slate 依赖，不扩展可选功能。具体原生回归、Cook/Stage 与浏览器阻塞见 P3 第四十五轮。

最终真实硬件路径停在 Init 内的地图首次重绘：`SceneDepthZ` 的 DepthStencil 格式未通过 Supported 检查。两浏览器 BeginPlay 为 true、退出请求为 false，硬件 Init 返回和完成 Tick 仍为 false/0；NullRHI 各完成 10 个有效 Tick。23 单元/415 项诊断链接、原 40 项 Shader 和当前阶段回归通过，完整 Runtime 仍 false。下一步聚焦深度格式能力、视图和模板语义，再用现有 reversed-Z 与浏览器首帧验证；完整正常 Web UBT 和单 Unlit 场景仍待验收。以下为历史检查点。

**2026-10-20 第四十四轮：WebGPU 的 FEngineLoop::Init 已返回，仍未完成首个 Tick。** Web 单线程选择 r.pso.EnableAsyncCacheConsolidation=0；Chrome/Edge 同一二进制对照均确认异步开关决定原 PSO 保护是否触发。缓存/原子操作/调度实现与修复前一致，保护未删。FScene 的单独 GPUScene 灯光上传调用使用既有 Web 能力判断，避免关闭 GPUScene 后仍分配 LightData。

当前 ES3.1 平台 46、834 Shader、GPUScene 关闭的 Ready 信息已输出；首次 Tick 卡在后缓冲 RTV 0x1000 → Present 0x2 的访问状态检查，完成帧数为 0。此外默认 OpenWorld 未 Cook，触发退出请求，需要真实最小地图。后续先接通这两项，再验收连续 Tick/Unlit 网格/HTML UI；诊断链接仍是混合版本，完整正常 Web Engine UBT 未验收。校验 Cook 增加 -noshaderddc，避免整图缓存冒充本轮逐作业重编，详细证据见 P3。以下为历史检查点。

**2026-10-20 第四十三轮：已打通真实 Cook Shader 到浏览器清屏 draw 的路径。** Web Shader 编译入口选择 NAME_None，归档运行时沿用 UE 原有未压缩分支；保留 834 个 Shader 的哈希/映射及 1,049 个作业的完整 WGSL，不修改格式版本或引入 Oodle 解码器。共享 RHI 增加严格 UE 附加数据封装读取，16 项原生正反例通过；默认光栅 MSAA 许可与单采样配置兼容，未支持多采样。

Chrome/Edge 各创建 2 个 ShaderModule、1 条管线，执行 1 次 CanvasClear draw，15 个命令缓冲提交并完成队列，无 GPU validation。仍为 0 Engine 帧，完整启动 false；当前停在 PSO 缓存异步合并的并发保护检查，具体调度/计数原因待定位。下一步核对 Web 单线程合并路径，保留缓存一致性检查，之后再验收连续 Tick、单 Unlit 网格和 HTML UI，不能把清屏提交算成场景首帧。

本轮正常 Cook 163 包、327 文件，总计 51,157,974 字节，体积增长是未压缩 Shader 的实际代价。原生二维/视口/静态绑定/Unlit、原 40 项 Shader 以及双浏览器纹理读回回归通过；新增 verify-web-shader-payload.cjs。最终仍为混合版本的 415 项诊断链接，完整正常 Web Engine UBT 未验收；详细证据、保留对象核验和复现见 P3。以下为历史检查点。

**2026-10-20 第四十二轮：已越过首次视口结束与窗口区域查询，当前准确阻塞转为 Oodle Shader 解压。** Web 的 surface 保持 FIFO，接受 UE 非 VSync 请求而交给浏览器控制呈现；原生校验和显式呈现保留。WebWindow::GetFullScreenInfo 返回单 Canvas 的 CSS 虚拟显示区域，不申请浏览器全屏。正常 ApplicationCore 构建、Chrome/Edge 四组 DPR/窗口回归 68 项通过。

实际 Engine 各完成一次视口结束、两次后缓冲获取、14 个命令缓冲提交及队列完成；开始 CanvasClear pass 后，TOneColorVS 的 FShaderCodeArchive::CreateShader 因 Oodle 无法解压失败。仍是 0 Engine 帧、0 ShaderModule、0 draw，未宣称物理呈现或场景首帧。22 单元/415 项诊断链接、原生二维/视口/静态绑定/Unlit 和原 40 项 Shader 回归通过，详细边界见 P3。

下一步优先让 Web Cook/归档输出未压缩或免费压缩格式，并让运行时按真实格式解包，不引入收费解码器，也不跳过 Shader 校验；随后验证真实 RHI Shader、单静态网格 Unlit 首帧、相机和 HTML UI。完整正常 Web Engine UBT 与版本一致性仍待验收，UMG/Slate 依赖保留。以下为历史检查点。

**2026-10-20 第四十一轮：已接通 RDG 静态 UniformBuffer，推进到首次视口呈现入口。** 上下文持有绑定引用，支持整批与单槽更新/清空；用 UE 布局哈希查询运行时静态槽，避免 Cook/运行时注册顺序差异；常量与资源表共用校验入口。原生命令两模式共 38 项绑定检查通过，静态 View/直接绑定各 19 次真实 Unlit 绘制、各 1,114,112 个通道值一致，另重跑二维 232 项和视口 72 项通过。材质定向入口的验证边界及旧综合探针深度格式失败见 P3。

22 个 Web 单元重编、415 项诊断链接；Chrome/Edge 实际执行空 RDG 绑定并到达 EndDrawingViewport，当前卡在首次 Slate 的非 VSync 请求与后端固定 FIFO 约束不符，仍为 0 Engine 帧。二维读回和 NullRHI 回归通过，原 40 项 Shader 回归继续保留。下一步处理 Web 呈现参数接入，随后仍需字节码解压/实际 Shader 创建、Unlit 场景首帧、相机/HTML UI 和完整正常 Web UBT；没有扩展可选渲染功能。详细证据见 P3，以下为历史检查点。

**2026-10-20 第四十轮：已从 Canvas 配置推进到真实后缓冲获取和 RDG GPU 调试标记。** 当前 Unlit 不用的 GGX/sheen LTC 默认初始化仅在 Web 排除，桌面源码、安装版和原资源保留，没有为启动增加整套高级光照。Emdawn 两个 InsertDebugMarker 的 WASM64 指针签名通过受版本控制的 port 在生成表之后补充；不修改 SDK 或共享 C++ breadcrumb 逻辑。

Chrome/Edge 的独立未修复版本复现 BigInt 错误，修复版本各验证两类接口共 6 条定长/UTF-8/空标记及 GPU 队列完成。实际 Engine 各取得一次 640×360 BGRA8 后缓冲和两条真实 RDG 标记，无 GPU validation；仍为 0 帧，新阻塞为 `RHISetStaticUniformBuffers`。18 单元重编、415 项诊断链接及原材质/二维纹理/窗口阶段回归通过，完整正常 Web Engine UBT 未验收。下一步只补 RDG 必需的静态 UniformBuffer 绑定，再推进免费字节码打包/解压、Shader 创建和单 Unlit 场景首帧；UMG/Slate 依赖保留，不扩展数组、材质层等可选功能。详细证据见 P3，以下为历史检查点。

**2026-10-20 第三十九轮，15:10：Web 窗口与 Canvas WebGPU 配置已实测接通。** 单窗口初始化后提供稳定不透明标识，平台支持窗口模式，入口显式 -windowed，Web 启动选择现有 8 位后缓冲。Chrome/Edge 实际 configure 为 640×360、BGRA8、RenderAttachment|CopySrc，GPU validation 为 0。Emdawn 固定版本没有填写 surface usages，网页仅避开这个不完整查询，原生校验仍保留。

正常 ApplicationCore UBT 和四组 DPR/尺寸输入回归通过；原生共享 RHI 的二维 232 项、隐藏 HWND 72 项/143,976 个通道值通过。18 个实际链接单元重编、415 项增量链接；新检查拒绝未链接的重编对象。视口报告和阶段报告为 true，完整 Engine 仍 false、0 帧、无后缓冲获取，不能把配置成功当成呈现或场景首帧。新阻塞是 Slate 绘制触发 GGX.LTCAmp 的 PF_G16R16F；下一步先核对 Unlit 不需要的 LTC 光照初始化能否局部排除，再继续字节码和首帧。UMG/Slate 依赖保留，未扩展数组/材质层，完整正常 Web Engine UBT 仍未验收。详细证据见 P3，以下为历史检查点。

**2026-10-20 第三十八轮，14:39：Web 已通过系统纹理和引擎默认资源加载，推进到 Canvas 视口创建。** 不用的数组/立方体占位、Perlin 体噪声更新及 Landscape 权重数组默认加载在 Web 局部排除；保留真正需要的二维整数、半浮点、单/双通道默认纹理，预积分纹理使用 UE 已有 RG8 回退。没有添加通用数组、三维更新或收费组件，UMG/Slate 依赖保持原状。

Chrome/Edge 各 35 张、107 mip、9,454,164 字节实际 GPU 读回一致；原生两模式 112 项新增检查及既有计算回归通过。两份引擎文件只增加 25 行条件，桌面源码和安装版哈希保持一致，工作区覆盖可重建。415 项诊断链接明确保留原 Renderer unity 分组，不能当作完整正常 Web UBT 成功。阶段报告 true、完整启动仍 false、0 帧；当前是游戏窗口句柄/尺寸校验，下一步接 Web 窗口与 Canvas 视口，再处理字节码解压/实际 Shader 创建、单 Unlit 网格首帧和网页 UI。详细证据见 P3，以下为历史检查点。

**2026-10-20 第三十七轮，14:06：已仅在 Web 排除 LevelSet 调试 Actor 的默认体纹理与光线步进材质加载。** 修改前的完整浏览器调用栈证实它在创建默认对象时触发，而非场景需要。受影响模块单元重编/增量链接通过，安装版保持只读，桌面实现逐字保留；没有增加体纹理能力。

Chrome/Edge 均越过 VolumeToRender，进入 ObjectSystemReady 和系统纹理初始化；各 54 mip/7,487,500 字节读回、NullRHI 各 10 帧、原材质证据回归通过。阶段报告 `web-debug-defaults-results.json` 为 true，完整启动仍 false、0 帧；下一处为无条件创建的 BlackArrayDummy。继续按最小功能范围核对并排除不用的数组占位初始化，避免扩展数组纹理；通用 RDG 注册和实际使用方需同步核对。压缩字节码、实际 Shader 创建、单 Unlit 网格首帧和网页 UI 仍未完成。完整 Web UBT 与混合版本边界不变，详细证据见 P3，以下为历史检查点。

**2026-10-20 第三十六轮，13:50：Cook 与浏览器的默认贴花条件已统一，原缺失 Mobile 变体错误已在双浏览器消失。** 原生自定义入口 WebCook 配套注册 TargetPlatform/TargetPlatformSettings，避免桌面 DBuffer 掩码残留；Web 配置显式关闭移动 DBuffer/Substrate、开启完整深度预通道，避免 subpass 输入。v13 全部 838 Global、211 材质作业重新转换通过，163 包；运行包 327 文件、23,907,500 字节，两浏览器打开 Global 726/项目 108 个 Shader。

本轮没有移植体渲染功能。二维纹理读回、NullRHI 和原 40 项保留证据回归通过；新阶段报告 `web-material-policy-results.json` 为 true，完整启动仍 false、0 帧，新的阻塞是 EngineDebugMaterials/VolumeToRender 的 10×10×10 RGBA16F 体纹理。下一步先定位其调试加载链并优先在 Web 排除最小场景不用的初始化，再推进解压/实际 Shader 创建、单 Unlit 网格首帧及网页 UI。旧 40 项的 Emissive 变体证据被明确标记为历史成功 Cook，不与当前 211 个材质作业混淆；完整 Web UBT 和混合版本边界不变。最新证据见 P3，以下为历史检查点。

**2026-10-20 第三十五轮，12:26：普通二维纹理的创建与多 mip 上传已接入。** 原尺寸查询阻塞已越过，支持普通 RGBA8/BGRA8、sRGB 贴图、字体 R8 和逐 mip 写入锁；设备尺寸上限替代原单 mip 启动限制。Chrome、Edge 各从实际 UE WebGPURHI 上传的纹理读回 53 个 mip、7,487,496 字节，逐级与 CPU 数据一致，GPU validation 为 0。没有扩展数组或立方体功能；sRGB 采样、多 mip SRV 尚未验收。

当前引擎仍 0 帧，新的阻塞为默认贴花材质要求 Cook 中不存在的 FDeferredDecalMobilePS。先比较两端 DBuffer/Substrate 等编译条件和初始化顺序，保留完整性检查，再推进压缩字节码/实际 Shader 创建及单 Unlit 网格首帧。旧 Cook 产物有效，原 40 项回归与 NullRHI 重验通过，本轮没有重新 Cook。阶段报告 `web-texture2d-results.json` 为 true，完整浏览器启动仍 false，混合版本与完整 UBT 边界不变。最新证据见 P3，以下为历史检查点。

**2026-10-20 第三十四轮，11:58：ES3.1 已从 Cook 接入实际浏览器引擎。** 浏览器平台注册、RHI 工厂、特性级别及 17 项渲染设置与 Cook 对齐；327 个运行文件、24,042,244 字节经哈希装入。真实 Global 库（726 个 Shader）和项目库（125 个 Shader）在 Chrome、Edge 打开，Global 映射加载已越过并进入对象/贴图资源初始化。

本轮修正 Cook 的 wasm64 Clang 冻结布局描述、已有顶点 SRV 省略条件及 Web 单线程文件缓存回调回收时机；没有扩展可选功能。重新 Cook 仍为原六个入口、163 个包，1,051 个独立作业全部通过；原 40 项及 115 个静态网格 WGSL 保留检查通过。库接入阶段 `es31LibraryIntegrationVerified=true`，完整运行仍为 false，WebGPU 0 帧，首个阻塞为 `RHICalcTexturePlatformSize`。

下一步处理普通二维纹理的必要查询/创建/上传，再验证可运行的 Shader 字节码打包与创建，最后跑单静态网格/Unlit 第一帧和相机输入。打开库不能代表 Oodle 解压或 RHI Shader 创建通过；本轮不声明完整正常 UBT 构建或 5.8.3 全源版本一致性。保留 UMG/Slate、采用网页 UI 的原则不变。最新证据见 P3 与 `web-es31-runtime-integration-results.json`，以下为历史检查点。

**2026-10-20 第三十三轮，11:21：原 40 个材质转换失败已全部对应处理，最小默认资源 ES3.1 Cook 完整通过。** 39 项来自未用顶点工厂，按平台能力在编译前排除；1 项贴花将 Web 边界裁剪移到材质采样后修复。没有完整移植骨骼、粒子或 Landscape。除已声明工厂及已关闭体积雾的一条深度生成外，前后作业集合完全一致；115 个普通静态网格作业全部保留。宿主适配仅作用于单独 Web Cook，桌面及其他目标回调对照保持原行为。

缓存键 v11 下 838 个 Global 和 213 个材质作业全部重编译成功，163/163 个包、退出 0；两浏览器的贴花三轴读回、资源专用材质正反例及既有 GPU 回归通过。`materialRegressionVerified=true`，但浏览器仍用 SM5、缺匹配 Global 库、0 帧；完整正常 UBT 构建未验证，原生宿主仍为安装版 5.8.0、目标为 5.8.3。

后续收敛为：先统一 WASM 与已通过 Cook 的 ES3.1 平台编号/Shader 格式/特性级别，按实际含 `SP_WEBGPU_ES31` 的文件名接入 Global 映射和共享库；验证解压、引擎反序列化，再用单静态网格、普通二维纹理/Unlit 材质和相机跑第一帧。保留 UMG/Slate 依赖，网页 UI 原则不变。详细证据见 P3，以下为历史检查点。

**2026-10-20 第三十二轮，10:48：Cook 推进到实际材质编译，修复两个普通静态网格材质绑定失败。** 原生资源表可以保留仅含纹理/采样器的 `Material` UniformBuffer 参数；Web 格式检查改为验证资源表映射，不再错误要求被优化掉的常量描述符。两个正例、13 个错误映射反例，以及两浏览器各两个实际 Shader 的深度/颜色读回用例通过；WGSL 本身未改变。

关闭逐作业 DDC、保留全作业校验避开主机缓存断言；实际重编译的 839 个 Global 作业全部成功，285 个材质作业中 245 成功、40 失败，失败集合精确减少两个。普通 FLocalVertexFactory 本次记录的 115 个作业全部转换成功。剩余主要来自最小场景不用的骨骼/粒子/Landscape 工厂，按编译和使用范围约束处理，不投入完整移植。Renderer DLL 与源码的参数字段不一致已读出实证，仍需处理，不能把缓存命中未报错视为修复。

整体仍未运行 UE WebGPU 场景：Cook 退出 3，浏览器仍为 SM5、缺匹配 Global 库、0 帧。后续先完成最小材质 Cook 和主机兼容处理，再按真实库命名接入、统一平台及特性级别、验证映射/字节码加载与普通地图。UMG/Slate 的局部处理原则不变。回归和混合版本边界见 P3。以下为历史检查点。

**2026-10-20 第三十一轮，10:15：ES3.1 Global Shader 的转换阶段通过，839 个作业全部成功。** 只修正 Web 移动捕获的零法线归一化和屏幕阴影的无穷常量，不改变编译范围、不扩展功能。两浏览器每个均通过 10 模块检查、四个实际 GPU 用例和 256 个读回值；前向渲染没有新增 GBuffer 法线数据。既有缓冲、纹理及色调映射回归通过，无 C++ 修改，旧构建证据重新核验。

首次生成 Global 映射及字节码库，库结构对应 92 个 ShaderMap、730 个引用、727 份压缩字节码；未验证解压或引擎加载。Cook 仍因主机参数结构 ensure 和材质缓存断言失败，网页 Engine 仍用 SM5、缺匹配库、0 帧。下一步处理这两个主机问题，使用实际包含 `SP_WEBGPU_ES31` 的文件名规则接入 Cook/Stage，统一平台及特性级别后再加载和验证普通场景。UMG 保留依赖，遇到 Web 问题继续优先局部禁编译/降级。证据与完整边界见 P3。以下为历史检查点。

**2026-10-20 第三十轮，09:58：同步关闭最小场景未用的立方体阴影缓存复制，失败 3→2。** 该分层顶点只用于点光源立方体复制，复用已有能力限制其顶点/几何/像素编译及直接使用入口。原生策略按文件和入口精确识别，普通全屏、二维及滚动复制三个作业重新转换通过；直接立方体复制在读取缓存及准备图资源前报错。去掉新增保护后，复制函数与安装版一致；真实拒绝及普通复制 GPU 执行未验证。

完整校验为 839 个独立作业、837 个转换通过、2 个失败。两个类型退出 2 个变体，包含一个旧失败和一个旧成功；其余 1,508 个类型的变体数及 16 项设置不变，无新增失败。原生 RenderCore、两个 WASM 单元及链接、六份声明/全屏实现文件和两浏览器 Shader 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体 false。下一步处理场景捕获/屏幕阴影，随后统一配置、生成匹配库和验证场景，详细边界见 P3。以下为历史检查点。

**2026-10-20 第二十九轮，09:48：同步关闭最小场景未用的 GPU 粒子，失败 4→3。** 原生文件策略和目标公共编译能力共用 Web 判断，运行查询先检查平台再检查控制台和设备。既有 FX 消费者沿用该查询；PSO 预缓存和向量场调试网格在 Shader/资源准备前退出，曲线分配受限，直接使用明确报错。系统记账与释放保留，CPU 粒子未改；实际旁路、控制台覆盖、CPU 粒子及原生 GPU 粒子材质/资产 Cook 未验证。

完整校验为 841 个独立作业、838 个转换通过、3 个失败。十个类型退出 10 个变体，包含一个旧失败和九个旧成功；其余 1,500 个类型的变体数及 16 项设置不变，无新增失败。原生 RenderCore、四个 WASM 单元及链接通过，八份声明/消费者文件和两浏览器 Shader 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体 false。下一步核对阴影分层复制，再处理场景捕获/屏幕阴影，统一配置并生成匹配库，详细边界见 P3。以下为历史检查点。

**2026-10-20 第二十八轮，09:32：同步关闭最小场景未用的 Web 虚拟纹理页表，失败 6→4。** 共享能力同时约束文件策略、页表 Shader 模板和公共平台查询，纹理构建目标查询也对 Web 关闭 VT。移动/桌面更新及运行时 VT 场景扩展沿用公共判断；直接页表初始化、分配、准备和提交在资源/Shader 查询前明确报错，系统记账、释放和更新结束保留。没有移植虚拟纹理，普通纹理路径未改；实际旁路、VT 资产 Cook/拒绝及普通场景纹理绘制未验证。

完整校验为 851 个独立作业、847 个转换通过、4 个失败。八个类型退出 8 个变体，包含两个旧失败和六个旧成功；其余 1,502 个类型的变体数及 16 项设置不变，无新增失败。原生 RenderCore、两个 WASM 单元及链接通过，415 个链接输入、八份声明/消费者文件和两浏览器 Shader 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体 false。下一步核对剩余粒子及阴影分层复制路径，再处理场景捕获/屏幕阴影，统一配置并生成匹配库，详细边界见 P3。以下为历史检查点。

**2026-10-20 第二十七轮，09:20：同步跳过最小场景未用的移动遮挡反馈，失败 8→6。** 共享能力覆盖两个 Shader 类型及两处资源初始化，即使控制台启用也在创建前拒绝；直接初始化和绘制明确报错，避免空资源被标为已初始化。释放和原有移动调用条件保留，普通 HZB/硬件查询选择未改，运行旁路及普通遮挡路径尚未场景验证。

完整校验为 859 个独立作业、853 个转换通过、6 个失败。两个类型退出 3 个变体，包含两个旧失败和一个旧成功；其余 1,508 个类型的变体数及 16 项设置不变，无新增失败。原生 RenderCore、四个 WASM 单元及链接通过，8 份声明/消费者文件和既有两浏览器 Shader 回归通过。NullRHI 复测各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体 false。后续核对虚拟纹理、粒子及阴影分层复制顶点，再统一配置生成匹配库，详细边界见 P3。以下为历史检查点。

**2026-10-19 第二十六轮，21:12：同步跳过最小场景未用的 Web 地形纹理输出及 IES 调试，失败 12→8。** 地形限制的是运行时高度图/权重图输出功能；公共入口在准备资源前返回 false，Shader 条件和直接渲染消费者同步限制，普通地形绘制未改动但未验证。IES 调试与普通更新共用文件及 MainCS，通过精确类型和文件筛选避免误删更新路径，两个调试入口在 ShaderPrint/资源准备前退出。普通更新声明和实现与安装版一致，普通 CS 本轮重新转换通过，尚未证明 IES GPU 执行。

完整校验覆盖 862 个独立作业：854 个转换通过、8 个失败。四个类型退出 7 个变体，包含 4 个旧失败及 3 个旧成功；其余 1,506 个类型的变体数和 16 项设置不变，无新增失败。原生 RenderCore、三个 WASM 单元和链接通过，Landscape 为工作区独立副本，4 份声明文件及既有两浏览器 Shader 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体 false。后续核对剩余遮挡反馈、虚拟纹理和粒子路径，再统一配置生成匹配库，详细边界见 P3。以下为历史检查点。

**2026-10-19 第二十五轮，20:45：同步跳过最小场景未用的 Web 调试/编辑器图元合成和 HMD 畸变，失败 15→12。** 共享能力覆盖 Shader 条件、公共合成开关、HMD 的桌面/移动后处理序列、直接入口及专用顶点声明初始化。HMD 旁路保留颜色或拷贝至指定输出，直接合成请求在资源准备前报错；编辑器专用入口仅源码核验，运行旁路未在真实场景执行。

完整校验覆盖 869 个独立作业：857 个转换通过、12 个失败。四个类型精确退出 6 个变体，包含 3 个旧失败和 3 个旧成功；其余 1,506 个类型的变体数和 16 项设置不变，无新增失败。原生 RenderCore、三个 WASM 单元和链接通过，6 份声明文件及既有两浏览器 Shader 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体 false。后续核对地形合并与 IES 调试用途及调用条件，再统一 Cook/运行配置并生成匹配库，版本等边界见 P3。以下为历史检查点。

**2026-10-19 第二十四轮，19:43：同步跳过最小场景未用的 Web 粒子 GPU 排序，失败 22→15。** 共享能力覆盖七个目标 Shader 条件、两个全局资源初始化、任务接收和直接排序入口。任务在分配前拒绝，Cascade 沿用未排序索引；直接调用明确报错，渲染阶段通知保留。当前目标不含 Niagara，尚未验证其排序/剔除，也未实际执行 Cascade 回退和资源旁路。

完整校验覆盖 875 个独立作业：860 个转换通过、15 个失败。精确排除 7 个旧失败变体，其余 1,503 个类型的变体数和 16 项设置不变，无新增失败。原生 RenderCore、两个 WASM 单元和链接通过，8 份排序声明/调用文件及既有两浏览器 Shader 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体 false。后续优先核对编辑器合成深度、地形编辑及 HMD 等路径，再统一 Cook/运行配置并生成匹配库，版本等边界见 P3。以下为历史检查点。

**2026-10-19 第二十三轮，18:12：同步限制 Web 稀疏体积纹理更新的编译和流送能力，失败 25→22。** 两个目标 Shader 条件及公共平台能力读取共享 Web 判断；既有流送生命周期、注册和更新入口同步受限。直接上传仅跳过派发，保留缓冲解锁和释放；这些旁路尚未在实际场景执行。

完整校验覆盖 882 个独立作业：860 个转换通过、22 个失败。精确排除 4 个变体，包含 3 个旧失败和 1 个旧成功；其余 1,508 个类型的变体数和 16 项设置不变，无新增失败。原生 RenderCore、两个 WASM 单元和链接通过，4 份流送实现/上传声明文件及既有两浏览器 Shader 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体 false。后续按最小场景核对剩余排序、后处理等路径，再统一 Cook/运行配置并加载匹配库，版本等边界见 P3。以下为历史检查点。

**2026-10-19 第二十二轮，18:00：同步限制灯光形状与 HDR 调试显示的 Web 编译和消费者，失败 29→25。** 两项调试显示不属于最小场景；三个目标 Shader 条件、灯光形状的状态/资源准备及绘制、HDR 的后处理序列和直接入口均使用共享能力判断。HDR 直接调用保留原场景颜色或拷贝到指定输出目标，该旁路尚未实际 GPU 执行。

完整校验覆盖 886 个独立作业：861 个转换通过、25 个失败。精确排除 5 个变体，包含 4 个旧失败和 1 个旧成功；其余 1,507 个类型的变体数和 16 项设置不变，无新增失败。原生 RenderCore、四个 WASM 单元和链接通过，6 份声明/调用文件及既有两浏览器 Shader 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体 false。后续按最小场景核对剩余排序、后处理等路径，再统一 Cook/运行配置并加载匹配库，版本等边界见 P3。以下为历史检查点。

**2026-10-19 第二十一轮，17:47：同步限制 Web 天空大气编译与消费者，失败 32→29。** 原配置已关闭该效果；共享能力判断覆盖九个目标 Shader 条件、公共运行判断、场景/视图 LUT 准备、生成与提交、绘制和调试入口，可选全局采样缓冲跳过 Web 初始化。必要场景记账和原有视图默认资源保留，尚未在真实场景执行验证。

完整校验覆盖 891 个独立作业：862 个转换通过、29 个失败。七个类型共排除 103 个变体，包含 3 个旧失败及 100 个旧成功；其余 1,503 个类型的变体数和 16 项设置不变，无新增失败。原生 RenderCore、两个 WASM 单元和链接通过，10 份调用/声明文件及既有两浏览器 Shader 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体 false。后续继续按最小场景核对剩余排序、后处理等路径，再统一 Cook/运行配置并加载匹配库，版本等边界见 P3。以下为历史检查点。

**2026-10-19 第二十轮，17:32：同步限制 Web 移动自动曝光编译与消费者，失败 37→32。** 当前移动 HDR 已关闭；共享能力判断按 `PostProcessMobile.usf` 的四个曝光入口排除五个旧失败，同步限制目标编译条件、公共运行判断及两个直接 Pass 入口。同文件其余 41 个变体全部重新转换通过，原有固定曝光路径保留，其他 1,505 个类型的变体数和 16 项设置不变，无新增失败。

完整校验覆盖 994 个独立作业：962 个转换通过、32 个失败。原生 RenderCore、两个 WASM 单元及链接通过，四份预曝光消费者/数据头文件审计及既有两浏览器 Shader 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；固定曝光 GPU 显示与真实场景入口尚未验证。证据核验通过、整体 false；后续按最小场景核对剩余天空大气、排序等路径，再统一 Cook/运行配置并加载匹配库，版本等边界见 P3。以下为历史检查点。

**2026-10-19 第十九轮，17:20：同步限制 Web SMAA 编译与消费者，失败 41→37。** 网页配置已关闭抗锯齿，共享能力判断同步约束四个文件、八个目标 Shader 类型、桌面/移动后处理序列及查找纹理加载。直接 Pass 入口在创建中间资源前旁路，并用已有拷贝 Pass 保留可选的指定输出目标；该旁路尚未实际 GPU 执行。

完整校验覆盖 999 个独立作业：962 个转换通过、37 个失败。恰好排除 18 个 SMAA 变体，包含 4 个旧失败和 14 个旧成功，其他 1,502 个类型的变体数和 16 项设置不变，无新增失败。原生 RenderCore、四个 WASM 单元和链接通过，既有两浏览器 Shader 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体 false。后续按最小场景核对剩余曝光、排序等消费者，再统一 Cook/运行配置并加载真实库，版本等边界见 P3。以下为历史检查点。

**2026-10-19 第十八轮，17:07：同步限制 Web OIT 三角形排序编译和消费者，失败 46→41。** 公共能力判断同时用于原生 Cook 文件策略、目标排序开关及独立调试 Shader；既有索引分配和移动/桌面排序调度均读取该开关。普通透明混合与原有网格索引路径保留，未实现可选排序算法或扩展 RHI 格式。

完整校验覆盖 1,017 个独立作业：976 个转换通过、41 个失败。恰好排除 4 个类型的 5 个旧失败，其余 1,506 个类型和 16 项设置不变，无新增失败。原生 RenderCore、两个 WASM 单元和最终链接通过，三个消费者的 6 份文件审计及既有两浏览器 Shader 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；实际透明绘制及场景入口未验证。证据核验通过、整体 false；后续按最小场景核对曝光、SMAA、剩余排序与后处理，再统一 Cook/运行配置并加载真实库，版本等边界见 P3。以下为历史检查点。

**2026-10-19 第十七轮，16:53：同步限制 Web 点光源立方体阴影的编译及消费者，失败 56→46。** 共用文件只限制 `MainOnePassPointLightPS` 入口，保留其他普通阴影；同步限制公共运行能力判断、点阴影初始化器准备、立方体深度分配和投影，目标材质深度类型只移除 OnePassPoint 位。没有实现可选立方体阴影采样或增加 RHI 格式。

完整校验覆盖 1,022 个独立作业：976 个转换通过、46 个失败。恰好排除 10 个旧点阴影失败，其余 1,500 个类型和 16 项设置不变，无新增失败；同文件 15 个普通/调制阴影投影作业重新转换通过。原生 RenderCore、三个 WASM 单元及增量链接通过；既有两浏览器 Shader 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；普通阴影绘制和场景消费者未验证，原生安装版 Renderer 的材质深度 Cook 未验证。证据核验通过、整体 false；后续按最小场景核对剩余曝光、排序、SMAA 等，再统一 Cook/运行配置并加载真实库，版本等边界见 P3。以下为历史检查点。

**2026-10-19 第十六轮，16:36：4 个共享间接派发参数 Shader 修复，失败 60→56。** 只增加 Web 结构化缓冲声明及共享写参数重载；没有新裁剪、RHI 格式或 C++ 修改。完整校验覆盖 1,032 个独立作业：976 个转换通过、56 个失败；全部 1,510 个类型和 16 项设置不变，恰好修复 4 个旧失败，无新增失败。

Chrome/Edge 各通过 34 个缓冲用例、18,757 个值，以及生成参数后的 29 次真实间接派发；既有纹理和色调映射回归通过。既有原生/WASM 构建证据哈希复核有效，本轮未重编；直接 Shader GPU 执行尚不代表 Engine RHI 或场景通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；证据核验通过、整体 false。后续按最小场景需要核对剩余阴影、曝光、排序及后处理消费者，再统一 Cook/运行配置并加载真实库；混合版本、ES3.1 Cook/SM5 运行及普通完整 UBT 未验收边界保留，详见 P3。以下为历史检查点。

**2026-10-19 第十五轮，16:19：补齐 Web 局部雾、体积雾的编译与消费者限制，失败 67→60。** 对应配置原本已关闭；本轮同步限制局部雾准备、剔除、绘制，体积雾公共开关、体素化和灯光函数材质条件。保留局部雾空资源分支，不修复这些可选效果或新增 RHI 格式。原生 Cook 的安装版 Renderer 通过共享 RenderCore 文件策略限制编译。

完整校验为 1,032 个独立作业：972 个转换通过、60 个失败。仅 8 个类型少 28 个变体，精确包含 7 个旧失败、21 个旧成功作业；其余 1,502 个类型和 16 项设置不变，无新增失败。原生 RenderCore、三个 WASM 单元编译通过，补编既有保守深度实现所在第四个单元后链接通过；首次签名不一致的链接失败已留档。保留的 HZB、单采样产物及既有两浏览器 Shader 回归通过。

NullRHI 各 10 帧；WebGPU Engine 仍缺 Global 库、0 帧。真实场景空资源和消费者未验证，体积材质 Cook 未验证。当前证据核验通过、整体验收 false；后续按最小场景核对阴影、缓冲及后处理，再统一实际 Cook/运行配置并加载真实库。混合版本、ES3.1 Cook/SM5 浏览器运行、普通完整 UBT 未验收等边界保留，详见 P3。以下为历史检查点。

**2026-10-19 第十四轮，16:06：Web 不支持的 MSAA/resolve 编译条件与四个运行入口已同步限制，失败 84→67。** 保留单采样深度复制、独立颜色解析及普通色调映射。移动端 `SUBPASS_MSAA_SAMPLES=1` 仍是子通道附件，Web 只保留 `0` 的普通颜色纹理路径；没有增加 RHI 能力或放宽绑定反射。原生 Cook 的安装版 Renderer 通过具名采样维度临时桥接，目标源码直接读取变体域。

完整作业校验为 1,060 个独立作业：993 个转换通过、67 个失败。13 个类型少 18 个变体，精确包含 17 个旧失败和 1 个不用的 HDR 顶点作业；其他 1,497 个类型和 16 项设置不变，无新增失败。原生 RenderCore、五个 WASM 单元和增量链接通过，保留的两种单采样产物及 50 个 HZB 作业转换通过；缓冲、纹理和色调映射两浏览器回归通过。

NullRHI 各 10 帧；WebGPU Engine 仍缺 Global 库、0 帧。深度/解析本轮未执行 GPU 绘制或实际场景调用。当前证据核验通过、整体验收 false；下一步按最小场景处理剩余阴影、缓冲和后处理消费者，再统一 Cook/运行配置并加载真实库。混合版本、ES3.1 Cook/SM5 浏览器运行、普通完整 UBT 未验收等边界保留，详见 P3。以下为历史检查点。

**2026-10-19 第十三轮，15:42：Web 胶囊阴影同步关闭编译、准备和调度条件，失败 96→84。** 共享平台条件同时约束目标 Shader 类型及胶囊阴影公共能力判断，覆盖直接/间接调度和 ShadowSetup 中的胶囊投影准备；保留普通静态网格阴影，没有新增 RHI 格式。原生 Cook 的安装版 Renderer 由共享 RenderCore 文件策略限制编译。

完整作业校验覆盖 1,078 个独立作业：994 个转换通过、84 个失败。精确排除三个类型共 20 个变体，包含 12 个旧失败；其余 1,507 个类型和 16 项设置不变，无新增失败。原生 RenderCore、三个 WASM 单元和增量链接通过，50 个保留 HZB 作业及既有缓冲/纹理/色调映射两浏览器回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧。

实际场景的胶囊准备与调度未执行验证。当前证据核验通过、整体验收 false；下一步核对未启用的 MSAA/resolve 变体及消费入口，保留普通单采样深度，不放宽绑定校验。混合版本、ES3.1 Cook/SM5 浏览器运行、普通完整 UBT 未验收等边界保留，详见 P3。以下为历史检查点。

**2026-10-19 第十二轮，15:21：HZB 的 12 个 Web R64 可见性变体退出编译，失败 108→96。** 普通深度归约和其他格式保留。目标 Shader 编译与运行入口使用同一条件，Web R64 请求明确终止；不增加 64 位纹理能力。原生 Cook 仍用安装版 Renderer，通过其自身导出的具名变体信息临时桥接，缺少维度时明确报错，不复制变体 ID 编码。

完整作业校验记录 1,098 个独立作业，1,002 个转换通过、96 个失败；仅一个类型少 12 个变体，其余 1,509 个类型和 16 项设置不变，无新增失败。48 个保留 HZB 计算变体和 2 个像素变体全部转换通过。原生 RenderCore、三个 WASM 单元及增量链接通过；首次 Glint 缺符号失败已留档，补编已有实现后通过。22 项缓冲计算、6 项纹理更新、96 项色调映射两浏览器回归通过。

NullRHI 各 10 帧；WebGPU Engine 仍缺 Global 库、0 帧。HZB 尚未执行 GPU 深度归约或场景调用；当前证据核验通过、整体验收 false。后续核对胶囊阴影等可选消费者及必要深度/resolve 绑定，再统一 Cook/运行配置并加载真实库。混合版本、ES3.1 Cook/SM5 运行及普通完整 UBT 未验收边界保留，详见 P3。以下为历史检查点。

**2026-10-19 第十一轮，15:05：6 个纹理更新/拷贝 Shader 已修复并完成数据验证，失败 114→108。** 仅修改该 Shader 的 Web 资源声明和只写纹理标记，保留原线程组与索引。首轮转换后四个纹理管线仍失败，未计通过；补齐只写语义后，Chrome/Edge 各核对 11,063 个值、0 错误，并各验证 4 个旧产物拒绝。没有新增 RHI 格式或裁剪功能。

最终完整作业校验覆盖 1,110 个独立作业，1,002 个转换通过、108 个失败；所有变体及 16 项设置与上轮一致，无新增失败。22 个缓冲修复和 96 个色调映射修复均本轮重新转换并通过两浏览器回归。C++ 产物沿用哈希仍匹配的上轮构建，NullRHI 重验各 10 帧，WebGPU Engine 仍缺库、0 帧。直接 GPU 数据验证不等于 Engine RHI 调度或场景验证。

下一步仍按最小消费者处理 HZB 64 位变体、阴影和后处理，再统一实际 Cook/运行配置并加载真实库。HZB 本轮只核对源码，12 个失败仍在；混合版本、ES3.1 Cook/SM5 运行端、普通完整 UBT 未验收等边界保留。当前证据核验通过、整体验收 false，详见 P3。以下为历史检查点。

**2026-10-19 第十轮，14:50：Web GPU 崩溃测试及 ShaderPrint 已同步关闭编译和运行入口。** 保留 ShaderPrint 空绑定；参数上传、手工创建的数据和外部提交的绘制也受平台条件约束。原生 Cook 的共享 RenderCore 条件精确排除 14 个类型、22 个变体，其余 1,496 个类型及 16 项设置不变。独立失败 131→114，恰好少了 17 个旧调试失败，没有新增失败。未扩展可选渲染功能。

原生 RenderCore、三个 WASM 单元及增量链接通过，安装版输入哈希不变。完整作业校验记录 1,110 个独立作业：996 个转换通过、114 个失败；完整库尚未生成。22 项缓冲计算和 96 项色调映射本轮全部重新转换并通过两浏览器回归；NullRHI 各 10 帧，WebGPU Engine 仍缺库、0 帧。原生 Renderer 仍为安装版，其调试 Shader 编译范围由 RenderCore 限制；WASM 调试入口已编译，未在场景执行。当前证据核验通过、整体运行验收 false。

后续先核对 HZB 64 位可见性缓冲变体和必要纹理更新/解析绑定，再统一实际 Cook/运行配置、生成真实 Global 库，验证硬件 Tick、普通 Unlit 静态网格地图和交互。ES3.1 仍仅 Cook、浏览器仍 SM5，混合版本及普通完整 UBT 未验收边界保留，详见 P3。以下为历史检查点。

**2026-10-19 第九轮，14:33：最小缓冲清理/拷贝的 22 个旧转换失败已修复。** 三个目标 Shader 在 Web 分支改用可映射为 storage buffer 的声明，参数、算法、线程组保持一致；没有新增 RHI 视图格式或裁剪 Shader。完整作业缓存校验记录 1,132 个独立作业，其中 1,001 个转换通过、131 个失败。Chrome/Edge 直接执行这 22 份真实 Cook 产物，各核对 18,002 个值、0 GPU 错误；尚未验证 Engine RHI 调度或场景。LargeBuffer 保留 512 线程组，测试显式请求对应限制，Engine 设备创建的协商仍待接入。

96 个色调映射作业本轮重新转换并通过两浏览器模块检查；NullRHI 各 10 帧、0 错误，WebGPU Engine 仍缺 Global 库、0 帧。当前证据核验通过，整体验收仍 false。后续核对 HZB、阴影、调试和后处理的最小消费者，处理必要的绑定问题，再统一 Cook/运行配置并接真实库、硬件 Tick 和地图交互。安装目录未修改，ES3.1 Cook、SM5 Engine 运行端和混合版本/普通完整 UBT 边界继续保留，详见 P3。以下为历史检查点。

**2026-10-19 第八轮，14:10：GPUScene 和骨骼场景扩展的最小平台条件已接入并验证。** 修正移动 `UseGPUScene()` 仅读取主机开关的问题，在原生 RenderCore 与 WASM 共用 Web 条件；骨骼扩展消费者与六个 Shader 文件同步限制，原生 Engine 使用关闭配置。普通静态网格保留非 GPUScene 绘制路径。实际 ES3.1 清单仅 11 个类型改变、排除 71 个变体，其余 1,499 个类型不变；可编译范围 1,203→1,132，仍有 150 个独立失败，完整库尚未生成。

原生模块及五个 WASM 编译单元、增量链接通过；安装目录哈希未变。Chrome/Edge NullRHI 各 10 帧、0 错误，实际读回两个功能及其配置均关闭；这不代表场景渲染入口已执行。WebGPU 仍缺 Global Shader 库、0 帧，失败 SM5 Cook 被 Stage 拒绝。基础 Shader/Worker 71 样本重跑通过，当前证据核验通过但整体验收为 false。下一步处理必要缓冲清理/拷贝与绑定问题，再统一 Cook/运行端配置、生成真实库和验证地图及交互，不扩展未使用功能。原生混合 5.8.3/5.8.0、ES3.1 仅 Cook、浏览器 SM5 和普通完整 UBT 未验收边界保留，详见 P3。以下为历史检查点。

**2026-10-19 第七轮，13:47：共享最小 Shader 条件已接入并实测。** 新 `WebShaderPlatform.h` 将 LightGrid、MobileFog 的编译、预缓存和运行入口限制统一；原生 Cook 使用工作区重新构建的 RenderCore，其他原生模块仍是安装版 5.8.0。目标与安装版这几个改动前源文件除换行外一致，安装目录未修改；不是完整 5.8.3 同源构建。WASM 三个相关编译单元及增量链接通过。

ES3.1 清单保持 1,510 个注册类型，精确排除 334 个变体，可编译范围 1,537→1,203；其他 1,504 个类型变体数不变。完整 Cook 仍有 208 个独立失败、388 条诊断，Global 库尚未生成。运行端条件已编译，但雾/灯光入口和空资源尚未在场景执行。Chrome/Edge NullRHI 各 10 帧、0 错误；硬件仍缺库、0 帧。下一步继续核对实例裁剪、骨骼、后处理消费者和必要 Shader，再接真实库、硬件 Tick、静态网格地图及 HTML UI；不扩展未使用功能。当前运行端仍 SM5，ES3.1 仅用于 Cook 试验，普通完整 UBT 尚未验收，详细证据见 P3。以下为历史检查点。

**2026-10-19 第六轮，12:25：已消除 ES3.1 色调映射的无限常量转换阻塞。** 目标 `PostProcessTonemap.usf` 只在 `COMPILER_WEBGPU` 下用 `sign()` 求噪声符号，ShaderFormat/DDC 升为 v9。原生 SM5/ES3.1 Cook 主机使用独立 Shader 副本，逐项核验与安装版仅相差该条件分支；安装版 Shader 未修改。此前失败的 96 个色调映射作业全部重新转换，Chrome/Edge 各验证 96 份 WGSL 模块、0 错误；尚未测试渲染管线或画面。

完整 ES3.1 Cook 仍退出 3，本次记录 374 个独立失败，未生成完整 Global Shader 库。71 个基础 Shader/Worker 样本及 NullRHI 启动回归通过；WebGPU 仍缺库、0 帧。下一步统一同源原生 Cook 与运行端的最小 Shader 条件，排除未使用消费者后生成真实代码库，再验证硬件 Tick、静态网格地图和 HTML UI。浏览器仍 SM5，材质主机版本不匹配、当前普通完整 UBT 构建边界保留，未增加可选功能。详细证据见 P3 报告。以下为历史检查点。

**2026-10-19 第五轮，11:49：ES3.1 / MobileForward 的独立 Cook 试验已实跑。** 原 SM5 配置枚举 4,395 个可编译变体，ES3.1 为 1,693 个，加入 Web 最小渲染配置后为 1,537 个；14 个关键设置的主机/目标值一致。最终仍记录 469 个独立转换失败，未生成完整库。配置裁剪有效，但不足以排除默认必编译路径；下一步核对消费者，将必要的编译条件同步到原生 Cook 和 WASM，先解决源码/二进制一致性，不逐个扩展可选功能。浏览器仍使用 SM5，ES3.1 尚未接入运行端。

本轮基础 Shader/Worker 的 71 样本、55 个成功字节码的一致性和两项版本负例通过；材质主机参数不匹配未解决。当前 NullRHI 内容为 324 文件、19,952,703 字节，Chrome/Edge 各 10 帧；WebGPU 完成设备和预初始化资源，仍缺 Global Shader 库、0 帧。真实 Shader 库加载、视口/硬件 Tick、最小地图、HTML UI 和当前普通完整 UBT 均未完成。当前证据核验通过不代表运行目标通过，详细清单及日志见 P3 报告。以下为历史检查点。

**2026-10-19 第四轮，11:12：真实 WebGPU Shader Cook 入口已接入，完整 Cook 尚未通过。** 新独立原生主机使用 Web/47 和目标 DDPI，标准 CookCommandlet 已进入真实全局 Shader 的 SPIR-V→WGSL 转换。最终首错为稀疏体积纹理 Shader 的 `SampledBuffer` capability，此前诊断还复现 `FWriteToSliceGS` 的 `Layer` builtin 和延迟光照 switch fallthrough。下一步在原生 Cook 与 WASM 端同步最小 Shader 编译范围及源码版本，排除未使用的可选路径；不以补齐这些功能作为前提。

WebGPU 内容 Stage 和独立挂载路径已实现，但仅验证了拒绝失败 Cook，成功产物挂载待验证。NullRHI 仍为两浏览器各 10 帧；WebGPU 完成设备和预初始化资源，仍缺 Global Shader 库、0 帧。71 个基础 Shader/Worker 样本通过，材质回归被旧原生主机的 `ConservativeDepthFillSize` 参数不匹配阻塞。普通完整 UBT、视口、硬件 Tick、地图和 HTML UI 均未完成；混合 5.8.3/5.8.0 边界保留，详见 P3 报告。以下为历史检查点。

**2026-10-19 第三轮，10:35：两浏览器已完成真实 WebGPU 的预初始化资源阶段。** 本轮按最小场景裁剪实例化、粒子 SubUV、未被读取的 Primitive 旧纹理及距离场默认路径；位置/切线/UV 顶点缓冲和 View 天空辐照度缓冲保留。Chrome/Edge NullRHI 继续各 10 帧、无页面错误；WebGPU 为 0 帧，当前停在缺少真实 `Global` Shader 库，进入 Shader Cook/挂载主线。没有新增可选 RHI 格式或绕过 Shader 校验。当前仍是混合 5.8.3/5.8.0 增量诊断，普通完整 UBT 构建未验收，视口、硬件 Tick、地图和 HTML UI 待完成，详见 P3 报告。以下段落为历史检查点。

**2026-10-19 第二轮：已进入浏览器完整 Engine 的真实 WebGPURHI 初始化。** 新平台注册、Adapter/Device 异步创建及工厂选择在 Chrome/Edge 的增量诊断产物中实测通过；同产物 NullRHI 各 10 帧，硬件路径仍 0 帧。Geometry Cache 默认资源已按 Web 条件裁剪并越过，当前阻塞是实例化静态网格的 `DummyFloatBuffer` 默认 SRV。核心、材质、资源状态、全局和原生视口回归通过。当前普通完整 UBT 构建尚未完成，诊断链接明确 `fullNormalUBTBuildVerified=false`；渲染 Shader Cook、地图和 HTML UI 尚未完成，详见 P3 报告。下段为当天首轮历史检查点。

**2026-10-19：无渲染启动链路通过。** 新增独立 Cook 主机模块，以 `-WebNullRHICook` 显式限定无 Shader/无音频资源验证；标准 CookCommandlet 生成 330 个文件约 23.6 MB，网页校验并挂载后，Chrome/Edge 均完成真实 PreInit、Init 和 10 帧 Tick。两项损坏数据拒绝检查及原 Shader Worker 主机回归通过。WebGPU Shader Cook、Renderer 场景、项目地图和 HTML UI 交互仍待接入，不能称为浏览器场景完成。完整构建和本轮 Cook/Stage/浏览器证据有效，但严格汇总因旧探针的安装版 GameEngine.cpp 原文件发生外部变化而退出 1，详细边界见 P3 报告。

以下 10 月 16 日检查点保留为历史记录。

**21:13 检查点：完整 Engine Target 的 C++、最终 WASM 链接和元数据通过，旧 41 个未解析符号已解决。** 首次成功续编日志为 `web-engine-full-20261016-192300.log`（89/89），当前产物的后续增量链接日志为 `web-engine-full-20261016-211014.log`。Chrome 已执行真实 Engine 启动，程序名查询、DDPI 配置、SM6 Nanite 路径和默认 64KB 栈问题已分别处理或避开；当前 NullRHI `-sm5`、4MB 栈、四份原始配置，停在缺少 Cook 默认材质的 `UMaterialInterface::AssertDefaultMaterialsExist()`，0 帧。不能称为 PreInit/Init/Tick 或场景运行通过。下一步接 Cook/Stage 和资源挂载，再完成引擎循环与浏览器 WebGPU。详细日志、哈希和边界见 P3 报告。

21:21 综合回归与严格汇总均退出 0，两个 portable 库、Core/基础服务、ApplicationCore 浏览器检查、Engine 十源码探针及实现排除对象检查通过。当前完整构建与源码匹配，Engine Tick、Cook、WebGPU 和场景仍未通过。日志为 `web-ubt-integrated-20261016-211359.log`、`web-engine-linked-summary-20261016-212128.log`。

21:28 已补实际链接参数快照，避免关键源码探针改写响应文件后混用证据。当前完整构建为 `web-engine-full-20261016-212618.log`，最终汇总为 `web-engine-linked-summary-20261016-212838.log`，均通过；库与对象检查重新通过。最新浏览器结果仍为缺少默认材质的断言、0 帧，一次页面进程崩溃另存历史记录。完整初始化和场景状态未变。

16:53 及以下为历史检查点，所述“剩余 41 个符号/尚无产物”已由上文更新：引擎自带 BLAKE3 portable 库在 Node、Chrome、Edge 各 210 项原始向量检查通过；同版 libPNG 1.6.44 在三个环境各 8 项通过。PNG 保留原库，UDP 探测返回不支持，补丁验证使用同步分支。安装目录未修改，仍为目标 5.8.3 与安装版 5.8.0 混合隔离验证。

当前实施进度（2026-10-16）：P0 浏览器/ABI 与 P1 隔离主机 ShaderPlatform/Worker 验证通过；**P3 完整目标所需 C++ 编译动作已通过，包括 UMG，最新最终 WASM 链接仍失败，未解析符号从 68 个降至 41 个**。Web 仅对实际阻塞局部修复或排除可选路径，保留 UMG/Slate 依赖。Engine 十源码探针、可选实现排除检查与 ApplicationCore 构建审计通过。16:06 恢复 localhost 服务后，ApplicationCore 的 Chrome/Edge 四组各 15 项重新通过；Core Program 6 组和基础服务 7 组在 Node/Chrome/Edge 重新通过，严格汇总退出 0。本轮平台入口、应用宏和可选音频依赖改动的后续综合回归另见 P3 报告；尚未执行 Engine 浏览器启动或场景验证。源码仍是目标 5.8.3 Core 等模块和少量目标文件覆盖安装版 5.8.0 依赖的混合隔离验证。P2 旧宿主仍停在 `FDFDummyByteAddress`；十四批 RHI 结果保持 1,236 项、1,697,120 个核验值，本轮未重跑 GPU 测试。P4 Cook/Stage、P5 浏览器场景与 HTML UI 桥接尚未接入。详见 [P3 构建与运行报告](H:/ue_html/UE58_P3_WEB_RUNTIME_TEST_RESULTS.md) 和 [P2 进度报告](H:/ue_html/UE58_P2_RHI_TEST_RESULTS.md)。

最近检查点：2026-10-16 的完整目标 C++ 编译阶段已通过，包括保留的 UMG；`web-engine-full-20261016-161416.log` 再次进入最终 WASM 链接，未解析符号从 68 个降至 41 个，尚无 Engine 产物。已使用 UE 标准应用宏补齐内存桥接，提供 Web 崩溃文件清理与明确拒绝硬件 RHI 调用的工厂入口，并移除当前无声目标的五套可选音频解码器。剩余 BLAKE3 3 个、PNG 34 个、ICMP 字节序 3 个、限时信号量等待 1 个；没有移植浏览器音频或声称 WebGPU 可启动。字体 SDF 与 BSD Socket 的对象符号排除检查已通过，当前仍是混合 5.8.3/5.8.0 隔离验证。下一步按最小场景接入必要依赖、排除可选路径并完成链接，再验证真实浏览器引擎启动。

该批改动后，`build-web-ubt.ps1` 综合回归与严格汇总均退出 0；Core/基础服务的 Node/Chrome/Edge、ApplicationCore 四组各十五项和 Engine 十源码编译通过，标准应用入口符号、五个解码器排除及 SlateCore/Sockets 对象检查通过。当前报告与源码匹配，完整 Engine 链接/启动仍未通过；日志为 `results/web-ubt-integrated-20261016-161752.log` 和 `results/web-engine-link-reduction-summary-20261016.log`。

实施范围调整（2026-10-15）：按用户要求，优先交付静态网格、基础 Unlit 颜色/二维贴图材质、相机与输入、Cook 资源加载组成的最小浏览器场景，再接 HTML UI。数组纹理、材质层及其他未被该场景使用的功能按需再做，不以通用 RHI 功能齐全或安装版宿主全部默认资源可用作为进入 WASM 的前置条件。

本轮完整构建进展（2026-10-16）：原 CPU 蒙皮 const 调用已在完整构建通过；SparseVolumeTextureData 仅补两处 `SIZE_T` 转换，原失败的 Engine.51 也已通过。完整构建越过其余 Engine 本体与 HTTP，停于 InputCore 缺少 Web 平台头；现补基本键码映射，实现与调用方分别生成 wasm64 对象。随后完整尝试因并行检查使用不同 SDK 配置路径而触发缓存竞争，原 Chaos.24 单元串行重放已通过；构建入口统一路径并刷新旧 Makefile。Core/基础服务三个运行环境、ApplicationCore 四组各 15 项、Engine 十个关键源码和额外 TagTrace 回归通过，综合脚本与汇总退出 0，完整 Target 另行续编。隔离 Engine 使用安装版源码本地副本，仅覆盖目标分支 Preshader2、SparseVolumeTextureData；4,037 份文件核对仅这两份不同。完整 Engine 链接、真实浏览器引擎循环、WebGPU/Cook 与场景仍未完成，没有新增 UMG、蒙皮或可选 RHI 功能。

遇到默认初始化阻塞，先追踪资源的实际消费者，检查能否只在 Web 平台禁用未使用的初始化和消费路径；确认最小场景无法绕过时，才补所需的最小实现和针对性验证。不能只因引擎创建了某种默认资源，就展开该功能的完整移植。距离场已完成第一处目标源码条件裁剪；此前六项默认纹理和两个顶点 SRV 的省略仍是安装版宿主适配，View/Uniform 等消费者尚待处理。已有实现与测试保留；后续进度以引擎启动、实际场景绘制、WASM 和打包里程碑衡量，探针数量只作验证证据。下文历史批次中的“下一步”以此范围调整为准。

本文是源码核对后的接入设计。候选布局中的 Web UBT、SDK 配置、基础工具链及部分 Core 服务已按 P3 报告实现；完整 Runtime/Cook/部署目录与命令仍为设计，不代表已经完成 UE 网页平台。2026-10-14 已执行独立 P0：原生 GPU/ABI 与 Chrome、Edge 的 wasm32/64、线程、读回和呈现测试均通过；另完成一组使用精简 include 的 UE Shader 冒烟测试，确认 typed-buffer 和纹理格式能力障碍。完整结果与边界见 [UE58_P0_TEST_RESULTS.md](H:/ue_html/UE58_P0_TEST_RESULTS.md)。前一轮的参考清单见 [UE58_PORTING_REFERENCES.md](H:/ue_html/UE58_PORTING_REFERENCES.md)。

## 1. 本轮最重要的结论

需要增加一个 UE `Web` 目标平台，串起 **构建工具、平台运行时、RHI、Shader 编译、Cook、网页启动器**。普通项目插件无法独立补齐这六部分；现有 Windows 打包产物也不能直接转换成网页包。

建议保留上一轮的多项目组合，但调整 Diligent 的接入定位：

| 部分 | 接入选择 | 主要参考 |
| --- | --- | --- |
| UBT/UAT、Core、Launch、ApplicationCore | 新写 5.8 接口适配，复用旧 HTML5 的流程设计 | UE4.27 HTML5、用户 5.8.3 的平台扩展接口 |
| WebGPURHI | 优先评估 UE 到 WebGPU 的直接适配 | Diligent、GodotWebGPU、Filament、bgfx |
| 桌面/浏览器 WebGPU API | 同一源码版本的 Dawn / emdawnwebgpu | Dawn 官方包与构建文档 |
| Shader | 主机离线编译 HLSL → SPIR-V → WGSL，并保存绑定元数据 | UE VulkanShaderFormat、Diligent ShaderTools、GodotWebGPU |
| 浏览器循环、输入、音频、缓存 | 分别接入 UE 平台接口 | UE4.27 HTML5、Godot Web、UE 自带 SDL3、Emscripten |
| 产品 UI 与场景交互 | HTML/CSS/TypeScript + 异步命令/事件桥 | Emscripten 导出接口和线程代理；UE GameInstance/输入接口 |

**Diligent 有完整图形后端可参考，但目前不能直接和最新 emdawnwebgpu 混装。** 本次源码发现：

1. Web 构建使用 `-s USE_WEBGPU=1 -s USE_PTHREADS=1`。[D2]
2. 内置 Dawn 固定到 `db55f595741106be83b823a02ebdc58efbe997f1`，不是本次另行检查的 Dawn 主干提交。[D3]
3. 创建 Adapter/Device 和 GPU Map 使用旧回调签名。[D1][D5]
4. ShaderTools 会链接 Tint，运行时还会解析或重映射 WGSL。[D4][D6]

因此，“加一份 Diligent 静态库和一份最新 Dawn”不是已经验证的接入方案。整库路线还要处理版本迁移、双层资源抽象和浏览器包体；建议先把 Diligent 用作资源管理、PSO、绑定与测试的主要源码参考。是否整库接入，通过小规模对比实验决定。

## 2. 构建机器与浏览器的分工

```text
构建机器：Windows / Linux
  UE Editor + WebTargetPlatformSettings/Controls
    ├─ Cook 场景、材质、纹理、音频
    └─ ShaderCompileWorker + WebGPUShaderFormat + native Tint
          └─ WGSL + UE 参数映射 + WebGPU BindGroupLayout 描述

  UBT + WebToolChain + Emscripten
    └─ UE Runtime + Web 平台实现 + WebGPURHI → .wasm / .js

  UAT + Web.Automation
    └─ Stage/Cook 数据 + WASM + 启动模板 + 清单 → 可自托管目录

浏览器
  页面：HTML/CSS/TypeScript 界面 + 场景 canvas
    ├─ 启动器：能力检查、下载、缓存、挂载文件、创建 GPU、启动 UE
    └─ WebSceneBridge：命令 → UE Game Thread；状态/事件 → 网页
          └─ UE Core / UObject / Engine / Blueprint / Renderer / Chaos
                └─ WebGPURHI → emdawnwebgpu → 浏览器 WebGPU → 本机 GPU
```

Editor、UHT、ShaderCompileWorker、DXC、Tint 编译器留在构建机器上。浏览器只携带运行游戏需要的模块和已经 Cook 的资源；浏览器 GPU 仍需根据 WGSL 创建 ShaderModule 和 Pipeline。

## 3. 建议的目录与模块边界

下面是候选工程布局，文件尚未创建：

```text
Engine/Platforms/Web/
  Config/
    DataDrivenPlatformInfo.ini
    WebEngine.ini
    WebDeviceProfiles.ini
    Web_SDK.json
  Build/TemplateFiles/
    index.html
    web-loader.js
    web-worker-bootstrap.js
  Shaders/Public/
    PlatformCommon.ush
  Source/Programs/UnrealBuildTool/
    UEBuildWeb.cs
    WebPlatformSDK.cs
    WebPlatformSDK.Versions.cs
    WebToolChain.cs
    WebProjectGenerator.cs
  Source/Programs/AutomationTool/
    Web.Automation.csproj
    WebPlatform.Automation.cs
  Source/Developer/
    WebTargetPlatform/
    WebTargetPlatformSettings/
    WebTargetPlatformControls/
    WebGPUShaderFormat/
  Source/Runtime/
    Core/                       # Core_Web.Build.cs 与 WebPlatform* 实现
    ApplicationCore/            # WebApplication / Window / Input
    Launch/                     # LaunchWeb.cpp
    RHI/                        # Web 平台的 DynamicRHI 选择
    AudioMixerWeb/

Engine/Source/Runtime/WebGPURHI/ # 同时供 Win64 原生验证和 Web 使用
Engine/Source/ThirdParty/Dawn/   # native 库与固定版本头文件
Engine/Source/ThirdParty/Tint/   # 只用于 host ShaderCompileWorker
Engine/Plugins/Runtime/WebSceneBridge/ # 候选桥接插件，含主机测试用 transport

WebUI/                         # 独立 HTML/CSS/TypeScript 界面与桥接客户端
```

将共享 WebGPURHI 放在普通 Runtime 目录，是为减少原生验证阶段的模块发现问题。平台专属 Core/Launch 放在平台扩展内，避免散布 `PLATFORM_WEB` 条件。具体扩展 Build.cs 的继承与扫描规则，实施时仍需用 5.8 的模块规则验证。

## 4. UBT：你的分支已经提供的入口

### 4.1 平台发现与注册

用户分支的 `UnrealBuildTool.csproj` 明确编译：

```text
../../../Platforms/*/Source/Programs/UnrealBuildTool/**/*.cs
```

`UEBuildPlatform.RegisterPlatforms()` 扫描程序集中的 `UEBuildPlatformFactory` 派生类，并调用 `RegisterBuildPlatforms(ILogger)`。[U1][U2]

新平台至少要接：

| 接入点 | 作用 |
| --- | --- |
| `partial struct UnrealTargetPlatform` | 用现有 `FindOrAddByName("Web")` 注册名称 |
| `partial struct UnrealArch` | 注册明确的 WASM 架构/ABI名称 |
| `UnrealArchitectureConfig` | 声明支持架构、输出目录及活动架构 |
| `WebPlatformFactory` | 建立 SDK 对象，注册 `WebPlatform` |
| `WebPlatform : UEBuildPlatform` | 验证目标、设置编译环境、建立 ToolChain |
| `WebPlatformSDK` | 验证实际安装的 emcc、版本和固定依赖 |
| `DataDrivenPlatformInfo.ini` | 使工具链和运行时知道平台名称、能力与类型布局 |

5.8 的 `UEBuildPlatform` 构造参数已经包含 `UnrealArchitectureConfig` 和 `ILogger`；Factory 的注册函数也有 Logger。UE4 HTML5 的旧构造与旧 DotNETCommon 引用需要迁移。[U2][U3]

**架构名称中的 `bIsX64` 表示 x86-64 架构类别，不等同于“指针为 64 位”。** 用户分支的 `UnrealArch` 单独记录这个值。不能为了 wasm64 就把它设为 true，再误走 x86 SIMD 或预编译库分支。[U4]

### 4.2 ToolChain 与最终链接

按用户分支的接口覆盖 `ValidateTarget()`、`SetUpEnvironment()`、`CreateToolChain()` 等函数；编译 ActionGraph 和响应文件做法参考 UE4.27 HTML5。[U2][H1]

首期明确：

- Web 目标构建 Game/Program，采用单体链接；主机 Editor/UHT/SCW 仍构建原生程序。
- C++ 编译由 `em++` 完成，目标静态库由对应 Emscripten 工具建立，最终链接也必须经过 `em++`。
- UE 的 include、define、优化和生成代码规则继续由 UBT 驱动。
- 第三方 `.lib`、`.dll`、原生 `.o` 不能直接进入 WASM 链接。
- Browser JS 库与 `--use-port=...` 必须进入最终链接，只有 C++ 静态库不够。
- C++ 标准、异常、SIMD、pthread、指针宽度等必须在所有目标库中一致。

Dawn 官方要求 `--use-port=emdawnwebgpu` 或本地 port 文件同时用于编译和链接。本地包可以随项目固定，不必让每次 UE 构建下载远程依赖。[W1]

不要照搬旧 HTML5 或其他 UE 分支的 .NET TargetFramework。用户 UBT 导入的 `UnrealEngine.csproj.props` 不在本次检查到的 Git 树中；它与 Setup 依赖一起补齐后，UAT 工程应使用同一套配置。当前可读 csproj 中 Microsoft 依赖已是 10.0.6，但这不能单独证明最终 TargetFramework。[U1]

### 4.3 WASM ABI 先验证，再固定

| 模型 | 接入代价 | 验证重点 |
| --- | --- | --- |
| wasm32 | 浏览器基础路径；需处理 UE 32 位类型布局与假设 | 指针截断、SIZE_T、allocator、Cook 的 frozen layout |
| native wasm64 | 有机会减少 UE 64 位代码迁移 | 浏览器支持、emdawn、pthread、JS BigInt 边界 |
| 64 位指针降低到 wasm32 | 可作为兼容实验 | 工具链支持与转换成本；地址空间仍不能按原生 wasm64 理解 |

Emscripten 当前源码仍描述 `MEMORY64=0/1/2`，同时将此设置标为 deprecated，并推荐标准的 wasm64 编译目标选项。`MEMORY64=2` 的特殊降低模式不能当作普通 `-m64` 的同义词，也不能据此宣称解决了网页内存容量问题。[W2]

推荐先用独立 WebGPU probe 验证 API，再用 UE Core 小程序比较 ABI。正式场景只保留一个已验证模型；平台的 `PLATFORM_64BITS`、数据驱动 Freezing 配置、Cook 类型布局和目标库必须同步。

2026-10-15 实施选择：Web UBT 已固定原生 wasm64，编译和链接均使用 `-m64`；真实 5.8.3 的 `HAL/Platform.h` 自行定义 64 位平台并强制 8 字节指针，不从 UBT 预定义 `PLATFORM_64BITS`。真实核心类型头的 Node/Chrome/Edge 样本已验证布局与高位参数，完整 Core 库及 Cook 数据布局仍待验证。上表其他模型仅保留为前期比较记录。

## 5. Shader 注册：5.8 有现成扩展机制

用户分支 `UEBuildPlatform.AddPlatformStaticShaders()` 能生成：

```text
BuildSettings: RHIStaticShaderPlatformNames.gen.cpp
RHI:           WebRHIShaderPlatform.h
```

生成的头文件形式为：

```cpp
inline constexpr EShaderPlatform SP_WEBGPU_ES31 = EShaderPlatform(/* 固定、合法且不冲突的 Index */);
```

这只是机制示例，不是已经选择的 Index 或可编译补丁。Index 必须在该版本允许的静态平台范围内固定，并检查已安装平台的冲突。[U2]

同时需要：

1. `DataDrivenPlatformInfo.ini` 中的 `[ShaderPlatform SP_WEBGPU_ES31]`。
2. 对应 `ShaderFormat=SF_WEBGPU_ES31` 和明确的 `MaxFeatureLevel`。
3. 主机侧 `WebGPUShaderFormat` 模块。
4. Web TargetPlatform 返回该 ShaderFormat。
5. WebGPURHI 初始化时建立 FeatureLevel 到 ShaderPlatform 的对应关系。
6. 主机 Editor/SCW 的构建包含额外 Shader 格式，并执行静态平台注册生成。

**只写 INI 不够。** 用户分支 `DataDrivenShaderPlatformInfo.cpp` 对无法解析的 ShaderPlatform 发出警告并跳过；这里的 `SP_CUSTOM_PLATFORM_FIRST` 主要还用于 Editor preview 的动态条目，不应直接拿一个临时编号用于可发布的 cooked shader。[U5]

注册函数本身受 `Target.bNeedsExtraShaderFormats || Target.Platform == Platform` 条件控制。因此必须同时验证主机 SCW 和 Web Game 的生成结果。[U2]

## 6. 先在 Windows 接 WebGPURHI

### 6.1 已经存在的导入入口

用户分支 `WindowsDynamicRHI.cpp` 中有 `-PlatformRHI=` 和 `[ImportedRHI]` 配置读取路径，受 `ALLOW_OTHER_PLATFORM_CONFIG` 控制。[U6]

原生验证的候选配置：

```ini
; 候选 Engine/Platforms/Web/Config/WebEngine.ini
[ImportedRHI]
ModuleName=WebGPURHI
RHIName=WebGPU
FeatureLevel=SM5
```

候选调用：

```powershell
UnrealEditor.exe "Project.uproject" -game -PlatformRHI=Web -NoSound -NoSplash
```

前提：WebGPURHI 已构建并可加载、平台配置可发现、相关宏开启、ShaderPlatform 注册与格式编译完成。命令本身不能把现有 D3D Shader 变成 WGSL。

**这里先用 SM5 导入做原生 RHI 验证，不表示已经支持完整桌面 SM5 功能。** 你的 Windows 代码还有一个额外限制：`GetES31ModuleName()` / `GetES31ModuleNameByString()` 只处理 D3D11/D3D12/Vulkan/OpenGL，直接把未知的 WebGPURHI 设为 ES3_1 会走到 `check(false)` 的分支。后续原生 Mobile 验证要补齐这条映射，或建立专门验证入口。[U6]

网页首期仍建议采用能力受限的 Mobile Forward/ES3_1 渲染配置。原生验证档位和最终网页渲染档位应分别设置。

### 6.2 必须覆盖的 5.8 接口

`FDynamicRHI`、`IRHICommandContext` 和旧 UE4 RHI 已有显著差异。本次实际读到的 5.8 入口包括：[U7][U8]

| UE 接口/对象 | WebGPURHI 的责任 | 参考 |
| --- | --- | --- |
| `IDynamicRHIModule::CreateRHI()`、`FDynamicRHI::Init()` | 创建/接入 Device，设置真实能力 | Dawn、Diligent EngineFactory |
| `RHICreateBufferInitializer()` | 创建 Buffer，并完成 initializer 生命周期 | Diligent Buffer/UploadMemoryManager；UE5 本版 RHI |
| `RHICreateTextureInitializer()` | Texture、初始数据、格式和 mip | Diligent Texture/TextureView |
| `RHICreate*Shader(const FRHICreateShaderDesc&)` | 读取自己定义的 shader blob | UE ShaderCode、Diligent ShaderWebGPU |
| `RHISetShaderParameters()` | UE 参数索引到绑定布局、uniform 上传 | Diligent ShaderResourceCache；UE shader reflection |
| `RHIBeginRenderPass()`、`RHIEndRenderPass()` | attachment、load/store、resolve、pass 边界 | Diligent DeviceContext、Filament Driver |
| `RHISetGraphicsPipelineState()` | PSO cache、顶点布局、格式、深度和混合状态 | Diligent PipelineState；bgfx |
| `RHIDraw*()`、`RHIDispatch*()` | Draw、索引/间接绘制、Compute | Diligent DeviceContext |
| `RHIBeginTransitions()`、`RHIEndTransitions()` | 资源用法跟踪、必要的 pass 切分与 hazard 检查 | Diligent、GodotWebGPU |
| `RHIGetCommandContext()`、`RHIFinalizeContexts()`、`RHISubmitCommandLists()` | 5.8 的记录、封装、提交与顺序保证 | UE5 本版 DynamicRHI；Diligent/Godot 队列设计 |
| Fence、读回、延迟销毁 | 异步完成通知与资源生命周期 | Diligent WebGPUResourceBase；Filament QueueManager |

WebGPU 没有 Vulkan 式显式 barrier API，但不能因此把 UE Transition 全部留空。需要利用 UE 的访问声明判断 pass 内外用法是否合法，并保证同一资源不会以不兼容的方式同时绑定。

首期关闭并行 RHI translation、独立 async compute 与并行 GPU 资源创建，保持 GPU API 单一所属线程。**仍要实现 5.8 的 finalize/submit 合约**，不能只重写旧 `RHIGetDefaultContext()`。

未支持的必要操作应给出明确失败信息。NullRHI 适合无图形启动验证，它的静态空缓冲和空操作不能用于证明 WebGPURHI 渲染正确。

## 7. Diligent 的两种实际接法

### A：把 Diligent 作为依赖

```text
FWebGPUDynamicRHI
  → Diligent::IRenderDevice / IDeviceContext / IPipelineState / ISwapChain
    → Diligent WebGPU Backend
      → WebGPU C API
```

已有入口：

```text
GetEngineFactoryWebGPU()
CreateDeviceAndContextsWebGPU(...)
AttachToWebGPUDevice(instance, adapter, device, ...)
CreateSwapChainWebGPU(...)
```

UE 的 `FRHI*` 资源仍要封装对应的 Diligent 对象。UE PSO、UniformBuffer 和资源表需要映射为 Diligent ResourceSignature/SRB；Diligent 的 `AttachToWebGPUDevice` 还明确拒绝多个 immediate/deferred context。[D1]

接入前需完成：

- 固定 Diligent 所需 Dawn/Tint 与浏览器绑定版本，或迁移 Diligent 全部相关 API。
- 明确 WGPU 句柄引用所有权，不将裸 `void*` 跨版本或跨 Worker 使用。
- 验证 WGSL 绑定是否被二次重映射，最终布局必须与 UE 编译输出一致。
- 分析 Tint、SPIR-V 工具及反射进入 WASM 后的包体与启动成本。
- 验证 GPU Map/readback 和同步等待路径能在浏览器工作。

还发现一个应优先处理的启动问题：`CreateDeviceAndContextsWebGPU()` 的 Adapter/Device 请求路径使用 `while (!UserData.IsReady)`，而 `InstancePoolEvents()` 在 `PLATFORM_WEB` 下为空。[D1] 如果回调需要在被阻塞的同一个 JS 事件循环执行，这条同步创建路径就无法完成。浏览器应优先做回调驱动的初始化，然后用 `AttachToWebGPUDevice()` 接入；同时验证回调所属 Worker 与引用所有权。不能照搬桌面 Factory 调用顺序。

这是可评估路线，当前没有 UE5.8 适配层的运行证据。

### B：直接实现 WebGPURHI，参考多个后端

```text
FWebGPUDynamicRHI / FWebGPUCommandContext / FWebGPU*Resource
  → 固定版本 webgpu.h
    ├─ Win64：Dawn native
    └─ Web：同版本 emdawnwebgpu port
```

Diligent 提供大部分资源/PSO/cache/readback 的设计；GodotWebGPU 补 SPIR-V 改写、push constant 替代和异步读回案例；Filament 补预初始化设备、surface 和队列处理；bgfx 补紧凑绑定缓存。

本轮倾向 B：它减少第二套图形抽象和运行时编译器依赖，并能从开始采用同版本 native/browser WebGPU API。代价是要自己完整实现 UE RHI 合约，不能把这一点算成已有库已解决。

**选择依据应是同一组测试，而非项目宣传。** 先比较一个 textured draw、dynamic uniform、compute、copy/readback、resize 的适配量、编译依赖与浏览器执行结果；结果若支持 A，再决定整库接入。

## 8. Shader：离线链路是最大的接口工程

### 8.1 利用 UE 现有编译链，但定义自己的格式

用户分支 `CompileVulkanShader()` 已通过 ShaderConductor/DXC 编译 SPIR-V，并序列化 Vulkan Header、ShaderResourceTable、SPIR-V 长度和代码。[U9]

可借鉴其 HLSL 参数解析、资源计数、编译环境和 SPIR-V 工具调用。**不能把已序列化的整个 Vulkan ShaderCode 当成 SPIR-V 交给 Tint**；应在明确的 SPIR-V 输出层提取代码，并保留 UE ParameterMap/ResourceTable 的语义。

候选流程：

```text
UE Shader Preprocess / FShaderParameterParser
  → 针对 WebGPU 的编译环境与能力限制
  → DXC/ShaderConductor 的 SPIR-V 输出
  → 绑定布局、类型与 WebGPU 不兼容构造的处理
  → native Tint → WGSL
  → 在构建机使用 WebGPU 校验
  → 自定义 FWebGPUShaderHeader + WGSL + binding metadata
  → UE ShaderCodeLibrary / Cook / DDC
```

`WebGPUShaderFormat` 的版本应包含 UE 格式版本、DXC/Tint 版本、转换规则与绑定布局规则。否则 DDC 可能返回旧的、结构不匹配的 blob。

### 8.2 必须形成离线契约的元数据

| 字段 | 用途 |
| --- | --- |
| Magic / Version / Hash | 确认格式、缓存和一致性 |
| ShaderFrequency / EntryPoint | VS、PS、CS 及入口 |
| WGSL bytes | 浏览器实际 ShaderModule 的源码 |
| 参数和资源映射 | UE 名称/索引、group/binding、类型、阶段可见性 |
| Uniform layout | size、offset、align、矩阵布局、动态 offset |
| 纹理/存储资源说明 | view dimension、sample type、storage format、访问模式 |
| 顶点输入 | location、格式及输入语义映射 |
| RequiredFeatures / Limits | 运行时设备必须满足的能力 |

这份格式要同时由 ShaderFormat 生产、RHI 消费，并在 native/browser 用同一测试核对。

### 8.3 不能靠一次 Tint 转换解决的内容

- Descriptor set / binding 的编号与 pipeline 阶段合并。
- HLSL 的纹理与 sampler、typed buffer、RWTexture 的格式信息。
- uniform/storage 内存对齐、矩阵布局和动态 offset。
- push constant 或 shader root constant 的 Buffer 替代。
- 原生 API 特有功能、resource binding array、bindless。
- derivative uniformity、采样控制流和浏览器允许的 WGSL 扩展。
- 顶点语义、clip/depth 约定、反向 Z 与屏幕坐标方向。

Diligent 在 HLSL→SPIR-V 路径专门处理 image format；GodotWebGPU 有独立 SPIR-V 预处理和 push constant 改写。其函数名 `convert_push_constants_to_uniforms` 内部还存在 StorageBuffer 改写，不能只看名称就直接移植为 UE 的 uniform 实现。[D4][G1]

GodotWebGPU 的 Tint wrapper 允许广泛 WGSL 功能并处理非一致控制流导数。这可以参考，但 Web 平台应按目标浏览器功能白名单校验，不应默认“允许所有扩展”就可部署。[G2]

推荐先建立真实 UE Shader 小样本：clear/blit、基础纹理、LocalVertexFactory、简单 unlit/lit mobile material、简单 compute。每个样本都要检查 UE 参数映射、转换、WebGPU 校验与实际图像，不能只统计编译成功。UMG 绘制不再是验收项；如果首期视口呈现仍经过 SlateRHIRenderer，补测它实际需要的 Shader，而不是为了网页界面移植整套 Slate UI。

## 9. Core / Launch / 线程的接入

### 9.1 Core 平台层

参考 UE4 HTML5 的 Memory、Process、Time、TLS、RunnableThread、File、Misc、Atomics、PlatformCompiler 设置，按 5.8 接口重新落实。[H2]

首期重点：

- 分配器先评估 `FMallocAnsi`；旧 HTML5 正是这条路径，不能默认桌面虚拟内存/地址预留型 allocator 适用。
- 单调时钟、事件和 TLS 必须真实工作；不通过永久返回默认值绕过线程错误。
- Browser Process 接口对不可用的子进程/动态库能力做明确处理。
- 检查 UE/Chaos/第三方代码的 x86 intrinsics、ISPC 和平台专属优化。
- WASM、JS、GPU 所占内存分别统计；浏览器堆配置不等于设备总可用内存。

### 9.2 启动顺序

旧 HTML5 的实际启动链是 `GEngineLoop.PreInit()` → `Init()` → `emscripten_set_main_loop()` → 每帧 `Tick()`。[H3]

WebGPU 还需要异步 GPU 准备，建议设计明确的启动状态：

```text
环境检查 → 文件可读 → Adapter/Device ready → PreInit → Init → Tick
```

GPU 请求和下载都完成后，再进入可能同步读文件/创建资源的 UE 初始化。也可以让 bootstrap 的帧回调先处理准备状态，再切换到 UE Tick；不要在浏览器所属线程 busy-wait 等待 Promise。

### 9.3 线程与 GPU 所属环境

建议首期完整 UE 场景采取：

```text
Browser main：DOM、用户手势、输入转发、音频、下载/启动控制
Engine owner worker：UE Game + 串行 Render/RHI + WebGPU device
CPU pthread workers：TaskGraph / Chaos / CPU 工作
```

`PROXY_TO_PTHREAD` 可以帮助把 UE main 移出浏览器主线程，但它不自动解决 GPU 所属环境。WGPU 句柄不能按共享 WASM 内存中的普通整数理解为跨 Worker 通用设备；要在实际 GPU 所属 Worker 中创建/接入设备，并验证 OffscreenCanvas 与该 port 的 surface 支持。

如果先在浏览器主线程建立 `preinitializedWebGPUDevice`，随后把 main 移到 pthread，不能假定这个 JS 对象已自动随之迁移。Filament 的预初始化设备案例只能证明其特定初始化路径。[F1]

Emscripten 官方说明主浏览器线程上的 `pthread_join`/条件等待可能 busy-wait、冻结页面或与同步代理死锁。线程构建要求相应跨源隔离响应头；线程版和无线程版是不同构建产物。[W3]

UI 输入回调转成事件队列，由 UE owner 环境消费。首期先做键鼠、resize、焦点切换与 pointer lock；音频通过 SDL3 或独立 AudioMixerWeb 接口，并处理用户手势解锁。Godot 的 AudioWorklet 与 ring buffer 可作为线程/无线程两种路径参考。[G3]

### 9.4 原生网页 UI 与 UE 的双向消息桥

网页 UI 是正式架构选择：菜单、表单、属性面板、HUD、提示、加载进度和错误显示都由 HTML/CSS/TypeScript 实现。React、Vue 或普通 DOM 是网页层的实施选择，UE 不依赖特定前端框架。网页可以在 WASM 下载和场景启动前显示界面，UI 样式更新也不必重新 Cook UE 场景。

```text
DOM / 前端状态
  → WebSceneClient.send(command)
    → 异步 transport
      → 复制并入队
        → UE Game Thread 消费
          → WebSceneBridge / GameInstance / 已注册的 Blueprint 命令

UE Game Thread 的状态变化与结果
  → 事件批次/状态增量
    → 异步 transport
      → WebSceneClient 订阅
        → DOM / 前端状态
```

候选 `WebSceneBridge` 是游戏层桥接模块，依赖 Core/CoreUObject/Engine 等必要模块，不把 UObject 或业务逻辑塞进 Core 平台层。可用 `UGameInstanceSubsystem` 管理命令注册和生命周期，但应另行提供明确的 Game Thread 队列消费点；不能假定普通 Subsystem 自动 Tick。

首期命令/事件契约：

| 方向 | 示例 | 行为 |
| --- | --- | --- |
| 网页 → UE | `scene.load`、`object.select`、`material.set`、`camera.set` | 校验参数并入队，异步返回执行结果 |
| UE → 网页 | `engine.ready`、`scene.loaded`、`selection.changed`、`command.result` | 按订阅发布，包含对应 requestId |
| 连续状态 | 摄像机、标注投影、交互状态 | 合并更新，按需求限频；避免每帧遍历并序列化全部 Actor |
| 生命周期 | 初始化、地图切换、销毁、失败 | 明确 ready 状态和 scene generation，清理失效对象句柄 |

消息首期可用 UTF-8 JSON，包含 protocolVersion、requestId、type、payload；对象使用注册的稳定 ID/带代际的句柄。Blueprint 可通过显式注册的事件/函数适配，不把任意 UObject 地址或反射调用暴露为网页 API。

Emscripten 的 `ccall/cwrap` 或少量 `extern "C"` 导出可构成 native 入口；它们提供函数调用，**不会自动把执行切换到 UE Game Thread**。[W4] native 入口应立即复制消息并入队，不在浏览器回调中直接修改 World/Actor。

线程版 transport 可采用 bootstrap 管理的 MessagePort/消息通道配合原生队列，或 Emscripten 官方异步 proxying。实际连接到 engine owner pthread 的方式须随启动模型验证，不能假定 `PROXY_TO_PTHREAD` 创建的内部 Worker 可被页面任意调用。目标线程必须在 Tick 处理队列或返回 JS 事件循环；网页主线程不等待 UE 同步完成。[W5]

跨 WASM 内存边界时要明确字节长度、指针宽度、复制与释放责任。状态传回网页后保留 JS 自有副本，避免长时间保存 WASM heap view；允许内存增长时旧 view 可能失效。[W4]

输入按用途分别处理：

- 网页表单和按钮消费 DOM 事件，输入框内的文字、IME 和快捷键交给浏览器。
- canvas 获得场景操作焦点时，键鼠/触摸/手柄走 Web ApplicationCore 或专门输入适配，保留 UE Input/Enhanced Input 的业务语义。
- 打开 UI 面板、失焦、退出 pointer lock 时清除场景按键状态，避免移动卡住；不要把 UI 点击同时作为场景点击转发。
- 原生用户手势回调中处理 fullscreen/pointer lock/音频解锁，再通知 UE 状态。
- CSS 像素、canvas backing size、devicePixelRatio 和 viewport 尺寸统一换算，resize 后保持拾取一致。

三维对象旁的标签也可用 DOM：UE 输出视图内的屏幕投影与可见状态，网页定位元素。若需要几何遮挡、真实三维显示或对象交互射线，则由 UE 补充对应数据/场景对象，不能仅靠 CSS 自动获得这些效果。

### 9.5 UMG 保留依赖，问题路径局部禁用

Web 目标保留引擎现有 UMG/Slate 依赖，正常编译能工作的代码。UMG 完整功能适配和彻底删除模块都不是本项目的目标。已核对的依赖说明了为什么保留这条边界更合适：

- `Engine.Build.cs` 同时把 UMG 列为 private dependency 和 circular dependency。[U10]
- `GameViewportClient.cpp` 包含 `Blueprint/UserWidget.h`，软件光标路径调用 `CreateWidget()`、`TakeWidget()` 等。[U11]
- `GameEngine.cpp` 用 `SViewport`/`FSceneViewport` 创建游戏视口；Engine 和 Launch 仍依赖 Slate/SlateCore，Launch 还会加载 Slate renderer。[U12][U13]

产品界面使用网页 UI；UMG 相关代码仅在成为编译、链接或运行阻塞时处理。处理优先级是局部禁用、必要的最小替代，再考虑低成本修复；不为了未使用的 UMG 功能展开完整移植。

具体执行规则：

1. 不主动移除 Engine 的 UMG private/circular dependency，不要求 Web 的模块清单或链接产物完全没有 UMG。
2. 新产品界面在网页端实现；现有代码和资产按实际使用处理，不为减包而预先清理全部 Widget 引用。
3. 某个 UMG 功能出现网页兼容问题时，在 Web 平台条件下跳过具体实现、关闭该功能，或替换成最小实现；范围限定为实际阻塞点，其他平台继续使用原有代码。
4. 禁编译实现时保留调用方需要的类型和链接符号；必要时提供明确的“不支持”结果或安全空实现。只有依赖允许时才排除整个源文件，避免只是把编译错误变成链接错误。
5. 对被禁用功能的实际调用入口同步处理，例如问题出在 UMG 软件光标时改用浏览器光标。让项目停止请求该功能，避免地图加载或运行时继续依赖它。
6. 保留场景呈现必需的视口、焦点和输入路径。SlateRHIRenderer 等若仍参与场景呈现，按必要功能处理，不能随 UMG 控件问题一并关闭。

验收关注：Web 能编译链接并加载目标场景，网页 UI 与 UE 的消息和输入正常，被禁用路径不再阻塞或导致崩溃；记录具体停用的功能即可。UMG 模块/资产仍存在不算失败，不设置彻底剔除或包体下降指标。

## 10. 资源、Cook 与 UAT

### 10.1 主机 TargetPlatform

候选 `WebTargetPlatformSettings`/`Controls` 分别负责渲染格式与资源能力，以及 Cook/部署/设备操作。用户 5.8.3 源树中 Android/Linux/iOS 已分为 Settings、Controls 等模块；不要只移植 UE4 的单个 HTML5TargetPlatform 文件。

需要落实：

- 返回自己的 ShaderFormat，而非 Windows D3D/Vulkan 格式。
- 首期纹理使用明确可用的未压缩格式；之后按 WebGPU feature 做 BC/ETC2/ASTC 等资源变体，不能运行时直接上传设备不支持的已压缩块。
- 首期禁用音频或采用已移植解码器；避免自动选择只有目标原生二进制的音频格式。
- Cook 使用与目标 ABI 一致的类型布局、bulk data 与资源能力。
- 主机 ShaderCompileWorker 能发现 WebGPUShaderFormat。

### 10.2 第一版资源路径：完整下载后挂载

先将一个很小的地图所需 Stage 文件全部下载并挂载到 Emscripten 文件系统，保持 UE 的相对路径和读取行为。启动器清单记录 URL、目标虚拟路径、长度与内容 hash。

UE5.8 的数据可能包括 `.pak`、`.utoc`、`.ucas` 等，不能照搬 UE4 的“一份 .data/.pak”假设。首期可以保持该版本正常 Cook 的 IoStore 产物，并预加载为可读文件；如果试验 Pak-only，必须另验本版加载器是否支持这套配置。

这样先验证“UE 读到正确的 cooked 场景”，再研究分块下载。UE4 HTML5 的 IndexedDB 缓存、启动依赖和下载流程可参考，但应注意 ArrayBuffer、WASM FS、解压数据及 GPU 资源叠加造成的内存峰值。[H4]

后续流式资源路线：

```text
UE IPlatformFile / IoDispatcher
  → 按 offset/size 的请求、完成回调、取消、优先级
  → Fetch Range / 分块资源
  → OPFS 或其他浏览器缓存
```

浏览器 Fetch 是异步的。不能用阻塞等待把普通同步文件 API 伪装成任意 HTTP 读接口；Range、缓存、后台 Worker、加载超时与取消都需要形成实际合约。Emscripten WasmFS fetch/OPFS 后端可参考，不能假定已经自动适配 UE IoStore。

### 10.3 UAT 打包与自托管

Web Automation 负责 Cook 平台名称、Stage、最终链接产物收集、HTML/loader 模板、资源 manifest 和 archive。UE4 HTML5 的 `Package()`、`GetFilesToDeployOrStage()`、`GetFilesToArchive()` 是流程参考，具体 override 按 5.8 基类核对。[H5]

最终应能用静态 HTTP 服务托管。线程版服务需提供 COOP/COEP；WASM MIME、压缩响应与 URL 路径由部署配置保证。浏览器运行不依赖 GPU 渲染服务器。

候选打包命令，只有完成上述接入后才成立：

```powershell
RunUAT.bat BuildCookRun -project="Project.uproject" -platform=Web `
  -clientconfig=Development -build -cook -stage -package `
  -archive -archivedirectory="Output\Web"
```

## 11. 首期功能范围与验收顺序

先定一个小场景：普通 StaticMesh、基础材质、纹理、摄像机移动、少量 Blueprint，加一个能选对象/改材质的原生网页面板。UMG 从验收范围移除。使用普通网格和光照替代首期未覆盖的高级渲染路径。

| 阶段 | 实际工作 | 通过标准 |
| --- | --- | --- |
| P0 | 固定版本；独立 native/browser GPU probe；ABI probe | textured draw、uniform、compute、copy/readback、resize 在两端一致；报告真实 features/limits |
| P1 | 主机 WebGPUShaderFormat 与样本语料 | 真实 UE Shader 转 WGSL，绑定与对齐可验证，无被静默丢弃的资源 |
| P2 | Win64 WebGPURHI；利用 ImportedRHI 入口 | UE 测试资源/PSO/pass/提交正确；后续小场景有正确图像 |
| P3 | Web UBT + Core/ApplicationCore/Launch | UBT 识别平台；小 UE Program 可链接 WASM；内存、事件和输入检查通过 |
| P4 | Web TargetPlatform + UAT + 数据挂载 | 同一小地图 Cook/Stage 可复现；目标格式和虚拟路径正确 |
| P5 | 浏览器完整游戏链 + WebSceneBridge | UE 初始化、场景、网页 UI 命令/事件、键鼠、摄像机、resize/焦点正常，GPU validation 无错误 |
| P6 | Blueprint/Chaos/音频/保存；按需处理 UMG 阻塞点 | 分项验证子功能；确认局部禁用不影响场景和网页 UI；记录线程与内存峰值 |
| P7 | 大场景、流式 IO、更多渲染能力 | 按真实场景逐项打开能力，并满足下载/内存/帧率指标 |

首期不启用 Nanite、Lumen、RayTracing、Virtual Shadow Maps、bindless 和高级 wave/atomic 路径。之后是否支持取决于 shader、RHI、浏览器 feature 和具体算法适配，不由“WebGPU 有 compute”自动推出。

Niagara、SkeletalMesh、Chaos 都不能按一个总开关宣称完成。例如 Niagara 的 CPU/GPU simulation、Chaos 的基础刚体/高级功能，应分别验证。网页 UI 的验收是命令/状态往返与输入分流，独立于这些场景能力。

最值得先投入的是 **P0 + P1**：它们能验证 API/ABI 与真实 UE Shader 两个关键假设，成本明显小于先编译所有 UE Runtime。只有构建完成而没有 Cook、GPU 校验和实际图像，不能作为网页场景接入成功的证据。

## 12. 源码证据与本轮验证边界

以下链接对应已下载并实际阅读的固定提交源码；文件行号用于定位入口。

| 编号 | 源码入口 |
| --- | --- |
| U1 | [用户 UBT csproj](H:/ue_html/reference-engine/Engine/Source/Programs/UnrealBuildTool/UnrealBuildTool.csproj:25) |
| U2 | [UEBuildPlatform：注册、构造与静态 Shader 生成](H:/ue_html/reference-engine/Engine/Source/Programs/UnrealBuildTool/Configuration/UEBuildPlatform.cs:1498) |
| U3 | [UEBuildPlatformFactory](H:/ue_html/reference-engine/Engine/Source/Programs/UnrealBuildTool/Configuration/UEBuildPlatformFactory.cs:27) |
| U4 | [UnrealTargetPlatform / UnrealArch](H:/ue_html/reference-engine/Engine/Source/Programs/UnrealBuildTool/Configuration/UEBuildTarget.cs:674) |
| U5 | [DataDrivenShaderPlatformInfo：解析及未知平台处理](H:/ue_html/reference-engine/Engine/Source/Runtime/RHI/Private/DataDrivenShaderPlatformInfo.cpp:381) |
| U6 | [Windows ImportedRHI 与 ES31 映射](H:/ue_html/reference-engine/Engine/Source/Runtime/RHI/Private/Windows/WindowsDynamicRHI.cpp:39) |
| U7 | [FDynamicRHI 5.8 接口](H:/ue_html/reference-engine/Engine/Source/Runtime/RHI/Public/DynamicRHI.h:425) |
| U8 | [RHIContext 5.8 参数与命令接口](H:/ue_html/reference-engine/Engine/Source/Runtime/RHI/Public/RHIContext.h:749) |
| U9 | [CompileVulkanShader 与 SPIR-V 序列化](H:/ue_html/reference-engine/Engine/Source/Developer/VulkanShaderFormat/Private/VulkanShaderCompiler.cpp:273) |
| U10 | [Engine 的 UMG/Slate 模块依赖](H:/ue_html/reference-engine/Engine/Source/Runtime/Engine/Engine.Build.cs:159) |
| U11 | [GameViewportClient 的 UMG 软件光标入口](H:/ue_html/reference-engine/Engine/Source/Runtime/Engine/Private/GameViewportClient.cpp:1180) |
| U12 | [GameEngine 的 Slate 游戏视口](H:/ue_html/reference-engine/Engine/Source/Runtime/Engine/Private/GameEngine.cpp:213) |
| U13 | [Launch 的 Slate 与 renderer 依赖](H:/ue_html/reference-engine/Engine/Source/Runtime/Launch/Launch.Build.cs:50) |
| D1 | [Diligent EngineFactory：设备接入与 context 限制](H:/ue_html/reference-diligent-core/Graphics/GraphicsEngineWebGPU/src/EngineFactoryWebGPU.cpp:645) |
| D2 | [Diligent WebGPU 链接设置](H:/ue_html/reference-diligent-core/Graphics/GraphicsEngineWebGPU/CMakeLists.txt:182) |
| D3 | [Diligent 固定 Dawn 与 Tint 构建选项](H:/ue_html/reference-diligent-core/ThirdParty/dawn/CMakeLists.txt:17) |
| D4 | [Diligent Shader 初始化、SPIR-V 和 WGSL 反射](H:/ue_html/reference-diligent-core/Graphics/GraphicsEngineWebGPU/src/ShaderWebGPUImpl.cpp:161) |
| D5 | [Diligent staging buffer 与异步读回](H:/ue_html/reference-diligent-core/Graphics/GraphicsEngineWebGPU/src/WebGPUResourceBase.cpp:184) |
| D6 | [Diligent WGSL 绑定重映射](H:/ue_html/reference-diligent-core/Graphics/GraphicsEngineWebGPU/src/PipelineStateWebGPUImpl.cpp:331) |
| H1 | [UE4.27 HTML5ToolChain](H:/ue_html/reference-ue427-html5/Engine/Platforms/HTML5/Source/Programs/UnrealBuildTool/HTML5ToolChain.cs) |
| H2 | [HTML5PlatformMemory：FMallocAnsi](H:/ue_html/reference-ue427-html5/Engine/Platforms/HTML5/Source/Runtime/Core/Private/HTML5PlatformMemory.cpp:49) |
| H3 | [HTML5 Launch：PreInit/Init/帧循环](H:/ue_html/reference-ue427-html5/Engine/Platforms/HTML5/Source/Runtime/Launch/Private/LaunchHTML5.cpp:58) |
| H4 | [HTML5 loader：缓存与资源启动](H:/ue_html/reference-ue427-html5/Engine/Platforms/HTML5/Build/TemplateFiles/project_template.js:1206) |
| H5 | [HTML5 UAT 打包流程](H:/ue_html/reference-ue427-html5/Engine/Platforms/HTML5/Source/Programs/AutomationTool/HTML5Platform.Automation.cs:64) |
| G1 | [GodotWebGPU SPIR-V 预处理](H:/ue_html/reference-godot-webgpu/drivers/webgpu/spirv_preprocess.cpp:404) |
| G2 | [GodotWebGPU Tint wrapper](H:/ue_html/reference-godot-webgpu/drivers/webgpu/tint_wrapper.cpp:27) |
| G3 | [Godot Web AudioWorklet](H:/ue_html/reference-godot/platform/web/js/libs/library_godot_audio.js:1947) |
| F1 | [Filament WASM 预初始化设备](H:/ue_html/reference-filament/filament/backend/src/webgpu/platform/WebGPUPlatformWasm.cpp:50) |
| W1 | [Dawn emdawnwebgpu 官方包说明](H:/ue_html/reference-dawn/src/emdawnwebgpu/pkg/README.md:38) |
| W2 | [Emscripten MEMORY64 设置说明](H:/ue_html/reference-emscripten/src/settings.js:258) |
| W3 | [Emscripten 官方 pthread 文档](https://emscripten.org/docs/porting/pthreads.html) |
| W4 | [Emscripten JS/C++ 交互与内存边界](H:/ue_html/reference-emscripten/site/source/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.rst:51) |
| W5 | [Emscripten 官方线程 proxying API](H:/ue_html/reference-emscripten/site/source/docs/api_reference/proxying.h.rst:6) |

对应项目版本：

```text
UE html       396c9f059903aed5fec78ecd3d437a40c6415368
UE4 HTML5     c4e46c2d24c9e90241cef66db793731ed6aff479
DiligentCore  074060cfd1db73064d7a18cf40df86af6531520c
Dawn          bf94d83239d665b6ec546b58c06bd4ec560ac3fa
Emscripten    0bb26c10d3cd7d9327cf95c1d1cf8fd1252ea3bb
GodotWebGPU   f329e39ce8db7acaa5c9d6628a530fb769969228
Godot Web     befe24c83135da887e534504874d1dcea4ed1f1c
Filament      764fe6cac9bdb4ba24d3d852344dfa04a5f70f75
```

本轮已确认入口、接口差异及库内实现；未安装或配置 Emscripten SDK，未编译 UE/Dawn/Diligent，未得到 UE 网页运行包。Git 补充下载部分文件时出现 TLS 错误，未读到的 5.8 UAT 基类、TargetPlatform 接口细节和最终 .NET props，留为实施前的具体核对项。

本轮只新增接入设计文档并补充参考说明；没有改动、提交或推送引擎源码。UnrealWasm 仍作为附近 UE 版本接口参考；商业 WebGPU 二进制不进入这套方案的依赖。

2026-10-14 补充核对了 Engine/Launch Build.cs、GameEngine、GameViewportClient 及 Emscripten JS/C++/proxying 文档。按用户进一步澄清，设计已修正为保留 UMG 依赖、对网页问题路径局部禁用；尚未实现桥接插件或修改 UMG 源码。

2026-10-14 实施进展：P0 native/browser 与 ABI 探针已通过；P1 GlobalShader、真实材质图/LocalVertexFactory 已通过。主机 `WebGPUShaderFormat` 已输出版本化 WGSL 字节码，原始 ShaderCompileWorker 实际协议验证 79 个任务：63 个成功输出、16 个明确拒绝；Chrome/Edge 两个页面两个视口共 8/8 通过。见 [ShaderFormat/Worker 测试报告](H:/ue_html/UE58_P1_SHADERFORMAT_TEST_RESULTS.md)。本批编译器为安装的 5.8.0，Shader/include 与目标 5.8.3 提交核对。

后续主机注册已完成：`WebGPUShaderHostTargetPlatform` 通过官方 `CustomTargetPlatforms` 发现，配套主机 DeviceProfile，删除探针手工格式版本和输入哈希适配。官方格式缓存、预处理、job hash、Worker 版本表均通过；再次全量复现并完成 Chrome/Edge 8/8 测试。该平台明确禁用 Cook/打包/运行时构建，本批原有测试环境仍借用原生 Vulkan。

独立 ShaderPlatform 后续验证也已通过：UBT `AddPlatformStaticShaders` 生成 `SP_WEBGPU_ES31=46` / `SP_WEBGPU_SM5=47` 的静态表，在隔离 Editor/Worker 副本中重编译表，并加载 Web DDPI。79 个任务、63 个包、16 个明确拒绝和 Chrome/Edge 8/8 均通过；包带平台枚举与 DDPI 哈希，缓存版本和浏览器解码同步核对。旧 Worker / standalone 各 8/8 回归通过。见 [独立 ShaderPlatform 报告](H:/ue_html/UE58_P1_SHADERPLATFORM_TEST_RESULTS.md)。

这只完成安装主机条件下的隔离生成/映射验证：其他 BuildSettings 函数转发到原版 DLL，没有完成目标分支全源码引擎构建或完整 Web UBT factory/toolchain 注册。完整场景、WASM 引擎、Web UBT/Cook 和网页桥接尚未完成，UMG 策略保持上述约定。

2026-10-14 P2 首批实现：新增 Win64 `WebGPURHI` Runtime 模块和真实 `FDynamicRHI` / `IRHICommandContext`，消费独立 Web SM5 Worker 字节码，以 UE 资源/命令列表编码 Dawn 工作。25/25 检查通过，19 draw、2 dispatch、29 finalize/submit、164,352 个数值，GPU validation 无错误。覆盖参数与上传顺序、索引、scissor、深度/混合、UAV 范围与复制，详见 [P2 RHI 报告](H:/ue_html/UE58_P2_RHI_TEST_RESULTS.md)。

2026-10-14 P2 第二批实现：从 UE 导出真实 Uniform 布局，严格核对 Worker 的布局哈希；常量绑定改为使用 `bufferIndex`，材质纹理/采样器通过 UE SRT token 解析。四个 Web ES31 Worker Shader、两个 PSO 使用多顶点流完成四 MRT 绘制，新增 32/32 检查、19 draw、1,114,112 个通道值。两批合计 57 项、38 draw / 2 dispatch、115 finalize/submit、1,278,464 个数值，GPU validation 无错误；Chrome/Edge 8/8 网页回归通过。

2026-10-14 P2 第三批实现：新增单 Graphics 队列资源状态和 transition，覆盖 RTV / SRV / Copy / UAV、跨 submit 的 split Begin/End、批量原子拒绝、深度只读 pass、资源引用寿命及提交序号。新增 49/49 检查、5 draw / 3 dispatch、66,056 个数值；三批累计 106 项、43 draw / 5 dispatch、130 finalize/submit、1,344,520 个数值，GPU validation 无错误。24 个 transition 的创建、Begin、End、释放一致，未完成项为 0。全局 transition 分配和 marker cleanup 仍由宿主 NullRHI 管理，探针显式适配本地后端创建/释放，未完成全局 dispatch；async compute、aliasing 和高级 flags 明确拒绝。

2026-10-14 P2 第四批实现：隔离 commandlet 以模块 `CreateRHI(SM5)` 创建后端，临时接管 `GDynamicRHI`，使用真实 UE 全局资源入口、PSO cache、命令 executor 和 transition private storage / 自动释放。记录 / bypass 两模式各 22/22 项，新增 44 项、12 draw / 4 dispatch、132,096 个数值；普通命令列表排队覆盖顺序、读回后继续绘制、帧结束和恢复 NullRHI 验证通过。四批累计 150 项、55 draw / 9 dispatch、1,476,616 个数值，GPU validation 无错误。完整 ImportedRHI 选择、RHIInit / RHIPostInit、RenderResource 和视口启动仍未覆盖。

前三批 context 由隔离 commandlet 显式创建，第四批只临时接管全局 RHI，运行结束恢复 NullRHI。材质测试只覆盖 `WebVertexInput` 的编译 Shader 和显式顶点流，未连接完整 LocalVertexFactory 对象或 MeshDrawCommand；Native 配置的 BatchedPrimitive Uniform View、SRT SRV/UAV 仍缺。下一步接启动入口、初始化资源和 viewport / present；浏览器完整 UE Runtime、完整 Renderer 与 Cook 尚未完成。

2026-10-14 P2 第五批实现：临时全局 RHI 下的真实 RenderResource Init/Update/Release/重新初始化、ResourceArray 快照后 Discard、二维 RGBA8/BGRA8 texture initializer，以及真实隐藏 HWND 的 Dawn surface acquire / draw / present / resize / skip / resume 均通过。记录 / bypass 各 36 项，新增 72/72、8 draw、143,976 个核验值；五批累计 222 项、63 draw / 9 dispatch、1,620,592 个核验值，GPU validation 无错误。一键复现和 Chrome/Edge 8/8 网页回归通过。surface 验证包含 GPU 内容与呈现 API，没有验证可见扫描输出或浏览器 canvas。

真实启动入口也已试运行：隔离平台的 ImportedRHI 配置通过 `RHIInit -> Windows PlatformCreateDynamicRHI` 加载模块，在显式 `-WebRHIStartupProbe` 下创建 WebGPU Device；没有先启动 NullRHI 再交换指针。第五批修复 ResourceArray 和二维 texture initializer 的启动阻塞，当时停在预初始化 TextureSRV。启动进程退出 3，单独诊断报告记录 `startupSucceeded=false`，不将这个 Fatal 当作完整启动成功；全局 Shader 编译/加载禁用，Renderer 仍未进入。

2026-10-15 P2 第六批实现：二维单 mip/layer 的线性 RGBA8/BGRA8 TextureSRV 对象、默认/显式 view、Shader 直接绑定与引用生命周期通过。记录 / bypass 各 37 项，新增 74/74、12 draw、12,288 个通道值；六批累计 296 项、75 draw / 9 dispatch、1,632,880 个核验值，GPU validation 无错误。十二份四色/不同 alpha 的读回逐像素一致；范围/格式/能力、活动 attachment、错误访问与 split transition 之间的采样均明确拒绝。

第六批真实启动越过 TextureSRV，成功创建 `FWhiteTexture`、`FBlackTextureWithSRV`、`FBlackTexture` 三个默认 SRV，当时阻塞于 R32_UINT Typed BufferSRV：`resourceType=19 viewType=0 format=28 bufferType=1 stride=0 count=0 offset=0`。直接 TextureSRV 通过不代表 SRT SRV/UAV、Uniform View 或其他维度已完成。

本轮一键构建及四份原生独立验证全部通过，Chrome/Edge 的既有独立 Shader 页面在桌面及移动视口 8/8 回归通过。新增 TextureSRV 仍在原生宿主验证，完整 UE WASM Runtime、Cook 和浏览器场景尚未接入。

2026-10-15 P2 第七批实现：RHI Typed R32_UINT BufferSRV 映射到已反射的只读 uint32 storage array，默认全缓冲和对齐子范围、GPU 读取及资源生命周期验证通过。使用原始 `ByteBuffer.usf` 的现有 Structured 分支，经独立平台、原始 Worker IPC 编译，45 个 include 与目标提交核对；保留真实参数表和槽位。新增只读/元素类型反射，Shader 缓存版本同步更新。没有实现原始 HLSL `Buffer<T>` 的通用 lowering，DDPI Typed SRV 能力仍关闭，既有 Typed clear 拒绝项不变。

记录 / bypass 各 38 项，新增 76/76、8 dispatch、3,072 个 uint32 值；七批累计 372 项、75 draw / 17 dispatch、347 finalize/submit、1,635,952 个核验值，GPU validation 无错误。独立 Node 核对十二份二进制读回、哨兵、数据更新、只读源保持及源码/模块/字节码哈希。

第七批启动进一步创建 `EmptyVertexBuffer` 的 R32_UINT SRV，stride=4、count=4、offset=0，当时停在该资源的 Typed BufferUAV，`format=28 bufferType=1 stride=0 count=0 offset=0`。

2026-10-15 P2 第八批实现：R32_UINT Typed BufferUAV 使用已反射的可写 uint32 storage array，规范化省略 stride/count 的全缓冲 view 和对齐子范围。原始 `ByteBuffer.usf` 的 `FMemsetBufferCS` / `FMemcpyCS` 经真实 Worker 编译，保留原参数表，分别核对 45 个 include、Editor 字节码与独立 Tint 输出。没有实现通用 `RWBuffer<T>` lowering，其他 Typed 格式及 SRT UAV 仍缺。

recorded / bypass 各 41 项，新增 82/82、12 dispatch、3,584 个 uint32 值；八批累计 454 项、75 draw / 29 dispatch、395 finalize/submit、1,639,536 个核验值，GPU validation 无错误。覆盖同列表写入顺序、子范围哨兵、UAV→SRV 可见性、复制保留早期数据、引用释放后写入以及无效输入拒绝。一键构建与汇总退出 0，既有 Chrome/Edge Shader 页面桌面/移动视口 8/8 回归通过。

启动已创建 `EmptyVertexBuffer` 的 R32_UINT SRV/UAV，下一处阻塞为 `EmptyUInt4VertexBuffer` 的 `PF_R32G32B32A32_UINT` SRV，`format=48 bufferType=1 stride=0 count=0 offset=0`。预初始化资源、完整 RHIInit / Renderer 和浏览器 UE Runtime 仍未完成，`startupSucceeded=false`。

2026-10-15 P2 第九批实现：Typed R32G32B32A32_UINT SRV/UAV 使用反射的 uint4 storage array，规范化 16 字节元素、全缓冲和对齐子范围；新增 scalar/vector 元素格式混绑拒绝，Shader 缓存升至 v4。原始 ByteBuffer.usf 的 uint4 Memcpy/Memset Structured 分支经真实 Worker 编译，四个 scalar/vector 样本包分别核对 45 个 include、Editor 字节码和独立 Tint 输出。通用 Buffer<T>/RWBuffer<T> lowering 仍未实现。

recorded / bypass 各 39 项，新增 78/78、12 dispatch、53 finalize/submit、8,192 个值；九批累计 532 项、75 draw / 41 dispatch、448 finalize/submit、1,647,728 个核验值，GPU validation 无错误。覆盖四分量差异、哨兵范围、UAV→SRV 可见性、同 view 观察复制更新、引用释放后的读写及无效类型/状态/范围拒绝。前八批回归通过；Chrome/Edge 既有 Shader 页面桌面/移动视口 8/8 回归通过。

真实启动新增创建 EmptyUInt4VertexBuffer 的 SRV/UAV，格式=48、stride=16、count=1、offset=0；当前阻塞推进到 EmptyStructuredBuffer 的 Structured SRV，format=0、bufferType=2、stride/count/offset=0。后者的宿主资源描述为 size=16、stride=4；实际启动退出 3，仍未完成预初始化资源、进入 commandlet Main 或 Renderer。启动诊断单独验证这一确切阻塞，不计作启动成功。

2026-10-15 P2 第十批实现：新增 Structured BufferSRV，并让 Structured UAV 兼容默认省略 stride/count 的描述；从底层 Buffer 继承步长，完整资源与对齐子范围共用验证。ShaderFormat 反射 storageElementStride，缓存升至 v5；实际 SRV/UAV 绑定必须匹配反射步长与读写属性。仍不支持重解释 stride、counter/append、Raw 与 SRT views。

uint / uint4、recorded / bypass 共四组各 50 项，新增 200/200、24 dispatch、106 finalize/submit、20,480 个值；十批累计 732 项、75 draw / 65 dispatch、554 finalize/submit、1,668,208 个核验值，GPU validation 无错误。原始 ByteBuffer.usf 的实际 Worker 包验证默认 view、子范围拷贝/填充、更新与 UAV→SRV 可见性、引用寿命及非法输入拒绝，Node 独立核对三十二份完整 Buffer。全量构建与汇总退出 0，Chrome/Edge 既有 Shader 页面 8/8 回归通过。

真实启动本轮新增创建 EmptyStructuredBuffer（stride=4、count=4）和 BlackFloat4StructuredBuffer（stride=16、count=1）的 SRV/UAV；当前阻塞推进到 BlackFloat4VertexBuffer 的 Typed float4 SRV，format=1（PF_A32B32G32R32F）、bufferType=1、stride/count/offset=0。完整启动仍退出 3，尚未完成预初始化、commandlet Main 或 Renderer。Structured float4 view 的创建不代表浮点 Shader 运算已经测试。

下一步实现 Typed float4 SRV/UAV 的浮点元素反射、绑定与实际 GPU 样本，再继续预初始化资源和完整启动；随后推进其他格式、通用 Typed Shader lowering、Uniform View、MeshDrawCommand 和浏览器平台。默认禁止选择实验 RHI，UMG / Slate 策略保持不变。完整范围、构建工具 CPU 亲和性限制与复现命令见 [P2 测试报告](H:/ue_html/UE58_P2_RHI_TEST_RESULTS.md)。

2026-10-15 P2 第十一批实现：Typed `PF_A32B32G32R32F` SRV/UAV 使用反射的 float4 storage array，ShaderFormat 缓存升至 v6，拒绝 uint4/float4 混绑与不合法范围/状态。新增两个明确标记为测试专用的乘加/填充 Shader，经 UE 编译环境、真实 Worker IPC、独立 Tint 和源码哈希核对；它们验证浮点读写，不代表通用 Typed Buffer Shader lowering 完成。

recorded/bypass 各 41 项，新增 82/82、12 dispatch、53 finalize/submit、16,384 个浮点值；十一批累计 814 项、75 draw / 77 dispatch、607 finalize/submit、1,684,592 个核验值，GPU validation 无错误。覆盖四分量浮点乘加、子范围填充、底层更新后的读取、UAV→SRV 可见性、源数据保持和引用寿命。全量构建、独立核验与汇总退出 0，Chrome/Edge 既有 Shader/材质页面 8/8 回归通过。

真实启动新增创建 BlackFloat4VertexBuffer 的 SRV/UAV、WhiteVertexBuffer 和 BlackVertexBuffer 的 SRV，累计三个默认 TextureSRV、七个 BufferSRV、五个 BufferUAV；当前阻塞推进到 FDynamicRHI::LockBuffer_BottomOfPipe 的默认 checkNoEntry（宿主 DynamicRHI.h:903）。完整启动仍退出 3，预初始化、commandlet Main 和 Renderer 均未完成。下一步实现 Buffer Lock/Unlock 的上传、范围和命令顺序，再继续真实启动；WASM 引擎、Cook、完整浏览器场景和 HTML UI 桥接仍待实现。

2026-10-15 P2 第十二批实现：Buffer WriteOnly Lock/Unlock 用独立 staging Buffer 编码复制，保留更新前后的 GPU 命令顺序；ReadOnly 在原生宿主同步复制/map，观察真实 GPU 写入而非 CPU shadow。支持非空四字节对齐范围，拒绝 NoOverwrite、重入、越界、活动 render pass / split transition 和锁定期间 GPU 访问。活动锁保留底层资源；浏览器同步读锁和多线程生命周期仍缺。

recorded/bypass 与 UE 写锁缓存开/关四组各 40 项，新增 160/160、4 dispatch、108 finalize/submit、7,296 个 uint32 值。十二批累计 974 项、75 draw / 81 dispatch、715 finalize/submit、1,691,888 个核验值，GPU validation 无错误。三十二份二进制读回独立比较，四种模式同名文件哈希一致。全量构建与汇总退出 0，既有 Chrome/Edge Shader/材质页面 8/8 回归通过。

真实启动已完成 WhiteVertexBufferWithRDG 的 16 字节 WriteOnly Lock/Unlock 上传编码，尚未在该启动进程提交/读回；下一处阻塞是三维 BGRA8 的 BulkData 初始化，dimension=2、format=2、init=1、1x1x1。下一步补 Texture3D 分配、BulkData 快照/Discard、上传与实际采样读回，再继续预初始化资源。完整引擎、Renderer、WASM、Cook 与浏览器场景仍未完成，UMG/Slate 策略保持不变。

2026-10-15 P2 第十三批实现：新增单 mip 线性 RGBA8/BGRA8 三维纹理、BulkData 快照/Discard、初始化器和 Texture3D SRV。ShaderFormat 缓存升至 v7，反射 sampled texture 维度并在绑定前校验二维/三维匹配。两个测试专用 Load/SampleLevel Shader 经真实 UE Worker、每个 44 个 include 哈希及独立 Tint 核对。现有二维更新/复制/读回明确拒绝三维资源；整数体积、数组、立方体、多 mip 和三维更新/复制仍待实现。

recorded/bypass 各 71 项，新增 142/142、48 dispatch、143 finalize/submit、3,552 个值。3×2×3 非对称体素覆盖两个格式、两种初始化、直接/SRV Load、point、Z clamp/wrap、Discard 后的数据、参数引用与状态拒绝；48 份 uint4 GPU 读回由 Node 独立核验 3,456 个值，二维 BulkData 的 96 个通道在 UE 内核验。十三批累计 1,116 项、75 draw / 129 dispatch、858 finalize/submit、1,695,440 个核验值，GPU validation 无错误。前十二批回归通过，启动诊断更新阻塞后复跑退出 0，汇总退出 0；Chrome/Edge 既有 Shader/材质页面桌面及窄视口 8/8 回归通过。

真实启动确认两个 BlackVolumeTexture3D 的 BGRA8 BulkData 已执行 queue.writeTexture 上传，当前阻塞推进到 GBlackUintVolumeTexture 的 PF_R8G8B8A8_UINT，dimension=2、format=60、init=1、1x1x1。此启动没有读回默认纹理，完整预初始化、commandlet Main 与 Renderer 仍未完成；诊断仍为 startupSucceeded=false。下一步补整数纹理格式、Shader sample 类型与实际 Load 读回，再继续启动。Web UBT/Emscripten、Core/ApplicationCore/Launch、Cook/Stage/挂载、完整浏览器场景和 HTML UI 桥接均待接入，UMG/Slate 策略保持不变。

2026-10-15 P2 第十四批实现：PF_R8G8B8A8_UINT 映射为 RGBA8Uint，开放单 mip 三维 ShaderResource 的 Default/Initializer/BulkData 与整数 Texture3D SRV。ShaderFormat v8 增加 textureSampleType，与 Tint sampled kind 比较，并在 RHI 绑定时验证 float/uint/sint；未支持有符号格式、二维整数资源、整数过滤采样和三维更新/复制。

两个测试专用 Load/GetDimensions Shader 经真实 UE Worker、Editor 包、每个 44 个 include 哈希及独立 Tint 核对。recorded/bypass 各 60 项，新增 120/120、20 dispatch、59 finalize/submit、1,680 个整数值；20 份完整 Buffer 独立比较，覆盖 18 个体素、整数边界、逆序读取、尺寸/mip 数、哨兵、默认零、1x1x1 默认形状、Discard 与资源引用。十四批累计 1,236 项、75 draw / 149 dispatch、917 finalize/submit、1,697,120 个核验值，GPU validation 无错误。前十三批正向回归、更新后的启动诊断与汇总通过；既有 Chrome/Edge 页面 8/8 回归通过。

真实启动新增第三个 BlackVolumeTexture3D（format=60）上传，当前阻塞推进到二维数组纹理：dimension=1、format=2、extent=1x1、array=1、init=2，对应 RenderCore FBlackArrayTexture 的描述。启动仍退出 3，预初始化、commandlet Main、Renderer 和浏览器 UE Runtime 尚未完成。按本日范围调整，下一步检查该默认资源的消费者和 Web 条件禁用位置，优先裁剪最小场景不使用的路径；不再直接展开 Texture2DArray 的完整实现。WASM、Cook/Stage/挂载、场景与 HTML UI 桥接仍待实现，UMG/Slate 策略保持不变。

2026-10-15 最小启动裁剪：`WebGPURHI::Init` 仅在启动探针同时传入 `-WebMinimalStartup` 时，在 `InitPreRHIResources` 前调用公开的 `ReleaseResource()`，注销 `GBlackArrayTexture`、`GWhiteTextureCube`、`GBlackTextureCube`、`GBlackTextureDepthCube`、`GBlackCubeArrayTexture` 和 `GBlackUintTexture` 六项默认资源。保留资源对象，不用二维纹理伪装数组/立方体，也没有改变不支持的 RHI 接口。安装版引擎和目标分支源码均未修改。

对照启动确认：不带新开关仍停在原二维数组纹理；带开关时此前默认资源的创建/上传日志完全保留，并到达 `FNullColorVertexBuffer` 的 format=37 Typed SRV 请求。两种启动均退出 3，完整预初始化和 Renderer 仍未完成。数组、立方体和虚拟纹理对应的真实消费者没有据此变为可运行；View 参数仍引用这些默认对象，进入 Renderer 前需要对实际 Web 路径处理未使用字段与相关功能。下一步检查关闭 manual vertex fetch 时能否省略颜色缓冲的 SRV，同时保留基础网格所需的顶点缓冲；不展开通用 Typed Shader lowering。

2026-10-15 最小启动继续：仅在显式最小启动模式，对照 `GNullColorVertexBuffer` / `GNullVertexBuffer` 的资源指针、描述及已关闭的 manual vertex fetch / vertex shader SRV 能力，省略它们的 PF_R8G8B8A8 SRV。原顶点缓冲仍创建并上传，GPU 读回分别验证 16 字节全 255 和 12 字节全 0；没有补 Typed RGBA8 Shader lowering。Rasterizer、DepthStencil、Blend 对象只保留描述，Sampler 的原生创建延后至实际绑定；不支持的状态仍在 PSO 或绑定时拒绝。

最小启动进一步创建 `FPrimitiveIdDummyBuffer` 的 R32_UINT SRV，现停在 Renderer 的距离场默认 `FDFDummyByteAddress`。该资源为内部静态对象，不能通过已有公开全局资源注销方式跳过。Web ShaderPlatform 已声明不支持距离场；下一步应在目标源码同时禁用其初始化和消费路径，避免 `SetupAtlasParameters` 继续注册空的 pooled buffer，不实现 Raw Buffer。现有跳过仍是安装版宿主验证适配；SM5 Uniform 的空 SRV 字段、View 默认资源消费者及实际 Web 条件编译尚待接入。

2026-10-15 距离场源码裁剪：目标分支 `Renderer/Private/FXRenderingUtils.cpp` 新增 `defined(PLATFORM_WEB) && PLATFORM_WEB` 条件分支。Web 下不编译 `FDFDummyByteAddress` / `GDFDummyByteAddress` 及原对象/Atlas 参数绑定，`HasDataToBind` 返回 false；公开元数据与函数入口保留。空目标指针沿用无操作行为，实际请求绑定距离场参数则 Fatal 明确拒绝，不生成空资源或伪造距离场。非 Web 分支保留原实现。此边界不支持 Niagara 距离场效果。

`verify-web-renderer-source.cjs` 对完整修改文件分别编译桌面和 Web 条件分支，使用安装版 5.8.0 的真实头文件/Renderer 定义与 MSVC，生成 Win64 对象。桌面预处理代码在归一化空白及诊断文件名/行号后与目标 5.8.3 原文件一致；Web 对象中默认资源、静态初始化及到 `DistanceField::Setup*` 的依赖均消失，三个公开绑定入口仍存在。此验证不包含重新链接 Renderer、真实启动或 WASM 编译，Web 构建规则仍需定义 `PLATFORM_WEB=1`。后续优先推进 Web UBT/Emscripten 和最小 Core/Launch 构建，不以修改安装版 Editor 或补齐其默认资源为前提。
