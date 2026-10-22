# UE Web 平台独立验证

更新日期：2026-10-22。当前默认关卡的构建、打包、画面及回归结果见 [默认关卡进度](H:/ue_html/UE58_DEFAULT_TEMPLATE_PROGRESS.md)。P0 结果见 [测试报告](H:/ue_html/UE58_P0_TEST_RESULTS.md)，工具链和早期移植记录见 [P3 报告](H:/ue_html/UE58_P3_WEB_RUNTIME_TEST_RESULTS.md)。

当前已用普通 UBT 构建的 wasm64 Engine 打包并运行原始默认关卡，支持原生 Pawn 交互、移动 Lit、天空大气、HDR、FXAA、Bloom、自动曝光、原材质体积云和指数高度雾。云已接入原生低分辨率步进、历史重建和深度合成；Chrome/Edge 完整效果与窗口缩放回归通过。冷启动回归曾在 Chrome 遇到浏览器 DXC 断言后设备丢失，整体稳定性验收尚未通过，具体证据见默认关卡进度。当前采用 ES3.1 移动渲染，体积雾、云影等效果仍未接入。没有使用像素流或收费 Web SDK，保留引擎 UMG/Slate 依赖。

启动故障现已在不加载 UE 的实际管线回放及独立 DXC 中复现。受限核心条件下完整效果对照可以通过，默认调度也有长循环通过的反例，尚不能据此认定硬件损坏或编译器并发缺陷；诊断复现见 [DXC 主机对照](H:/ue_html/tests/web-platform/diagnostics/README.md)。限制核心仅用于测试，不改变发布包或正常页面。

## 天空性能对照

`probe-web-default-performance.cjs` 在当前独立包上，通过原有组件测试接口分别关闭云、高度雾及两者，再恢复原始状态。默认视角和实际鼠标输入转到约 70 度的抬头视角各测四种组合，两轮反转顺序；位置、太阳、天空大气及画质设置保持一致。每个组合先预热十帧，再记录指定时长内 UE 完成 Tick 的间隔。这里的 FPS 是引擎帧率，不是显示器实际扫描帧率。

```powershell
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-default-performance.cjs --seconds=3 --dpr=2 --report=chrome-dpr2-ordinary
node tests/web-platform/probe-web-default-performance.cjs --seconds=3 --dpr=1 --gpu-timing --report=chrome-dpr1-verified-gpu
node tests/web-platform/probe-web-default-performance.cjs --seconds=3 --dpr=2 --gpu-timing --report=chrome-dpr2-verified-gpu
```

`--gpu-timing` 只给测试设备增加 `timestamp-query`，在每个组合另抽样五帧，记录真实渲染/计算通道的 GPU 时间；不在 FPS 采样期间逐帧读回。通过 Cook 作业中的入口映射识别原始云和雾着色器，按真实绘制命令断言云通道及高度雾排列跟随组件开关。关闭高度雾后 `FMobileFogPS` 仍使用不含高度雾的排列计算大气透视，不应要求整条通道消失。GPU 通道时间之和不包括 CPU 提交、通道间空隙和显示等待；高度雾与 BasePass 共享通道，不能把该通道整体算作高度雾耗时。浏览器时间戳精度有限，接近零的短通道不用于比较微小差异。

测试使用默认 CPU 调度、不添加 GPU 后端开关，固定 CSS 视口为 1848×1120；画布为 16:9，DPR 1 实际为 1848×1040，DPR 2 为 3696×2079。普通对照不启用 GPU 时间戳。每份报告记录包与探针哈希、浏览器、相机、实际像素尺寸、错误和原始样本，写入 `results/web-default-performance-<report>-results.json`；截图保存在同目录。

2026-10-22 的本机 RTX 3070 测试复现旧路径高 DPI 下约 10～13 FPS。新包使用原生模式 0 的低分辨率云和历史重建；3696×2079 下云链路由约 72～90 毫秒降至 7.3～9.4 毫秒。普通设备请求默认视角约 75～79 FPS，抬头约 95～100 FPS，场景及 FXAA 保持原分辨率。GPU 时间戳会话与普通请求分别记录；详细波动、测试条件和兼容边界见默认关卡进度。

新路径的回归与同一二进制内的原路径对照：

```powershell
node tests/web-platform/probe-web-default-performance.cjs --seconds=2 --dpr=2 --gpu-timing --require-cloud-reconstruction --max-cloud-ms=20 --report=cloud-reconstruction-dpr2-validated
node tests/web-platform/probe-web-default-performance.cjs --seconds=3 --dpr=2 --gpu-timing --full-resolution-clouds --report=cloud-full-resolution-dpr2-validated
node tests/web-platform/probe-web-default-performance.cjs --seconds=4 --dpr=2 --report=cloud-reconstruction-dpr2-ordinary
node tests/web-platform/probe-web-cloud-reconstruction-quality.cjs
```

重建检查不仅核验设置和纹理创建，还要求原生半分辨率深度、云历史重建及合成着色器实际绘制，且云步进目标保持四分之一宽高。云链路统计包含深度降采样、步进、重建和合成；`--max-cloud-ms` 必须配合 GPU 时间戳使用。该探针只改变测试会话，不修改发布包；此前一分钟的默认视角交互测试不能代替高 DPI 天空性能验收。

画面对照探针冻结材质时间，按“原路径→重建→原路径”截图，保留真实曝光时间步长。天空平均 RGB 差异要求小于 3/255、明显变化像素小于 10%，地面及恢复对照平均差异各小于 1/255；实际差异和截图见 `results/web-cloud-reconstruction-quality-results.json`。这不等于逐像素无损或快速转动残影验收。

以下为历史检查点，不能作为当前独立包的验收结果。

**2026-10-20 第四十八轮：RenderCurve/Nanite 默认资源阻塞已越过。** 三个文件共新增 16 行 Web 分支，曲线扩展在 Web 禁用、默认参数清零，Nanite 材质/ownership 默认参数清零；注册、已有 Nanite 能力检查和其他平台正文保留。没有增加毛发、Nanite 或缓冲类型支持。重编原有材质提供者解决链接缺符号后，最终 28 单元/415 项诊断链接通过；完整正常 Web Engine UBT 仍待验收。

Chrome/Edge 真实地图 BeginPlay、NullRHI 各 10 个有效 Tick；WebGPU 当前停在 GetDefaultSkinningParameters 的默认 Raw Buffer，Init 未返回、完成 Tick 与深度 pass 为 0。ApplicationCore 正常构建与 68 项窗口测试、4 组 marker ABI 正反例、原 40 项及阶段回归通过，原生/Cook 沿用有效哈希证据。新增 `node tests/web-platform/verify-web-render-curve-defaults.cjs`，随后运行 `verify-web-es31-runtime-integration.cjs`；阶段通过不等同完整 Runtime。下一步只排除未用蒙皮默认初始化并核对消费者，不移植骨骼动画。详见 P3 第四十八轮。

以下为历史检查点。

**2026-10-20 第四十七轮：局部雾及 BasePass 的未用默认资源阻塞已越过。** 仅 Web 清零局部雾默认数据、关闭的 DBuffer 参数和反射参数，未用阴影数组、QuadOverdraw/遮挡反馈默认 UAV 设空；保留 DBuffer 关闭检查及普通二维阴影资源，不增加雾、数组、Cube 或 Raw Buffer 功能。去掉本轮分支后保留原有局部雾源码，BasePass 恢复完整安装版正文。最终 25 单元/415 项诊断链接通过，准备脚本已加入 BasePass 覆盖。

ApplicationCore 正常构建及四组双浏览器窗口/DPR 共 68 项重新通过，原 40 项、纹理/平台回归、PSO 对照和阶段汇总通过。共享 RHI 与 Cook 内容本轮未改，沿用上一轮有效原生深度/综合/二维/视口/静态/Unlit 与真实地图 Cook 的哈希证据。Chrome/Edge 真实地图均 BeginPlay，NullRHI 各 10 个有效 Tick；WebGPU 当前在完整深度预通道构建网格命令时，由 HairStrands/RenderCurve 的场景 Uniform 默认回调创建 Raw Buffer 失败。Init 未返回、完成 Tick 和实际深度 pass 仍为 0，首帧未验收。

新增 `node tests/web-platform/verify-web-local-fog-defaults.cjs`，要求实际浏览器越过保存的局部雾、DBuffer、反射 Cube 三处旧失败，核验关闭的 Shader 变体、消费方、源码保留与真正链接对象；最后运行 `verify-web-es31-runtime-integration.cjs`。下一步只排除未用 RenderCurve 默认初始化，不移植毛发功能。首帧/连续 Tick、单 Unlit 网格、相机/HTML UI 和完整正常 Web UBT 仍待验收。完整复现和证据见 P3 第四十七轮。

以下为历史检查点。

**2026-10-20 第四十六轮：SceneDepthZ 格式阻塞已越过，原生深度/模板实测通过。** 共享后端接入 Depth24PlusStencil8 附件、DepthOnly/StencilOnly 视图和只读通道语义；recorded/bypass 共 18 项新检查通过，真实 GPU 读回深度 0.75 和模板清值 37，reversed-Z 遮挡和宿主格式恢复通过。完整原生 RHI 探针重新通过，43 次 draw/5 次 dispatch/1,344,520 个值。未实现 MSAA、模板比较/写入管线或深度拷贝。

仅 Web 排除三个未用移动数组默认值，并用已有清零构造初始化 dummy 灯光参数，避免补数组和 Raw/Structured 灯光缓冲。正常原生构建、二维/视口/静态绑定/Unlit、ApplicationCore 四组 68 项、24 单元/415 项诊断链接及原 40 项和阶段回归均通过。本轮未重新 Cook，复核既有真实地图 Cook/Stage 哈希有效。

当前 Chrome/Edge 都加载 `/Game/WebMinimal` 并 BeginPlay，NullRHI 各 10 个有效 Tick；WebGPU 在局部雾默认数组 `GetZeroUIntArrayDummy` 的外部资源注册失败，Init 未返回、完成 Tick 为 0。观察到的实际深度分配和深度 pass 仍为 0，不能将原生通过算成浏览器首帧。下一步局部排除未用局部雾初始化并核对消费方，不移植雾或数组功能。首帧、单 Unlit 网格、相机/HTML UI、完整正常 Web UBT 仍未验收。

新增 `node tests/web-platform/verify-web-scene-depth.cjs`，核验修改前失败、18 项原生检查、完整探针、源码保留、真实链接对象和双浏览器；最后再运行 `verify-web-es31-runtime-integration.cjs`。报告将格式阻塞修复、实际深度分配、深度通道和局部雾阻塞分别记录。完整 `web-engine-webgpu-es31-results.json` 仍 false，阶段通过不能替代 Runtime，通过范围与复现详见 P3 第四十六轮。

以下为历史检查点。

**2026-10-20 第四十五轮：真实最小地图已 BeginPlay，连续 Tick 按更严格条件验收。** `prepare-web-minimal-map.ps1` 通过新 Commandlet 生成并审计 `/Game/WebMinimal`，两个 Cook 使用相同源地图。ES31 为 164 包/329 挂载文件，NullRHI 为 326 文件；浏览器记录实际 World、BeginPlay、退出状态，Tick 前后检查退出请求。双浏览器 NullRHI 已在真实地图上完成连续 Tick，WebGPU 首帧仍独立验收。

RHI 接入 UE 原有最终呈现转换、RHITick 和延迟初始化 UniformBuffer；原生视口 72 项、静态绑定 38 项、新空 UniformBuffer 8 项及二维/Unlit 像素回归通过。Web 跳过当前不使用的 GPU 消息、光照 Profile、VSM、天空反射和对应 View 参数消费，没有增加数组、Cube 或 Raw Buffer 功能。详细证据和当前首帧阻塞见 P3；正常完整 Web Engine UBT 仍未验收。

本轮最终 23 单元/415 项诊断链接、原 40 项 Shader 和阶段回归通过，ApplicationCore 正常构建及四组浏览器输入/DPR 共 68 项重新通过。真实 WebGPU 地图在 BeginPlay 后、Init 内主动重绘时，创建 `SceneDepthZ` 因 DepthStencil 格式 Supported 检查失败；两浏览器硬件 Init 尚未返回、完成 Tick 为 0。下一步先接最小深度附件并验证 reversed-Z/浏览器首帧。`web-es31-runtime-integration-results.json` 为阶段通过，完整 `web-engine-webgpu-es31-results.json` 仍为 false，两者不可混同。

**2026-10-20 第四十四轮：实际 WebGPU Init 已返回，Ready 为 ES3.1/834 Shader/GPUScene 关闭。** Web 配置选择引擎原有同步 PSO 合并，Chrome/Edge 同一二进制切换 CVar 的对照复现原异步保护并验证同步路径越过；保护、原子操作和调度实现不改。另用既有 Web GPUScene 能力判断排除单独的灯光上传，未新增 Buffer 功能。

新增 `probe-web-pso-consolidation.cjs`、`verify-web-pso-consolidation.cjs`。首次 Tick 仍在 EndDrawingViewport 因 RTV 0x1000/Present 0x2 状态不符失败，完成帧数 0；默认 OpenWorld 未打包也已请求退出，不能把 Init 返回算作场景成功。22 单元/415 项诊断链接通过；Cook 校验增加 -noshaderddc，避免整个 ShaderMap 命中缓存却没有本轮作业记录。后续先处理呈现状态与真实最小地图，再验收连续 Tick/Unlit/HTML UI；完整正常 Web Engine UBT 待验收。详见 P3，以下为历史检查点。

最终强制 Cook 为 163 包/零失败，1,049 个作业 WGSL 和 834 个归档 Shader 哈希/映射保持一致，327 文件/51,157,974 字节。双浏览器各 2 次 draw、25 个命令缓冲、队列完成，无 GPU validation；各 35 张/107 mip/9,454,164 字节读回一致，NullRHI 各 10 次回调及文件缓存通过。原 40 项和新 PSO/当前阶段核验通过，完整 Runtime 仍 false；本轮原生 RHI 未改，其前一轮有效证据沿用哈希核验。

**2026-10-20 第四十三轮：真实 Engine 已完成首次浏览器清屏 draw 提交。** Web Cook 输出未压缩 Shader，834 条归档的哈希/映射及 1,049 个作业的 WGSL 全部保持一致；共享 RHI 兼容 UE 附加数据封装，16 项正反例通过。默认光栅 MSAA 许可不再阻断单采样清屏，仍强制 NumSamples=1；原生两模式绘制和像素对照通过。

Chrome/Edge 各 2 个 ShaderModule、1 条图形管线、1 次 draw、15 个命令缓冲，队列完成且无 GPU validation；各 35 张/107 mip/9,454,164 字节读回、NullRHI 各 10 帧通过。原生正常构建、二维 232 项、视口 72 项、静态绑定 38 项、两套 Unlit 和原 40 项回归通过。当前仍为 0 Engine 帧，完整启动 false，准确阻塞为 pipeline-cache-consolidation-guard：PipelineStateCache.cpp:1797，具体调度/计数原因待查。清屏像素、场景首帧和完整正常 Web Engine UBT 未验收。

新增 `node tests/web-platform/verify-web-shader-payload.cjs`，配合最终阶段汇总均通过。重新标准 Cook/Stage 为 163 包、327 文件、51,157,974 字节；本轮先打通未压缩路径，体积优化另行处理。最终链接 415 项，21 个单元重编；RenderCore.3 保留本轮此前有效编译并核对最终对象。复现、失败边界快照和后续 PSO 合并定位见 P3，以下为历史检查点。

**2026-10-20 第四十二轮：实际 Engine 已越过首次视口结束和窗口区域查询，进入 Shader 归档解压。** Web 保持浏览器 FIFO，接受 UE 非 VSync 请求；原生约束保留。GetFullScreenInfo 返回单 Canvas 的 CSS 虚拟显示区域，正常 ApplicationCore UBT 与四组 DPR/输入/缩放回归共 68 项通过。新增 `node tests/web-platform/verify-web-browser-fifo.cjs`，核验修复前记录、原生回归和当前实际浏览器调用。

Chrome/Edge 各完成一次视口结束、两次后缓冲获取、14 个真实命令缓冲提交，纹理读回前队列完成检查通过；开始一个 CanvasClear pass，随后 TOneColorVS 读取在 Oodle 解压处失败。仍为 0 Engine 帧、0 ShaderModule、0 draw，没有已验证的场景首帧或物理呈现。最终 22 单元重编、415 项诊断链接通过；原生二维 232 项、视口 72 项、静态绑定 38 项和两套 Unlit、原 40 项 Shader 与双浏览器标记正反例回归通过。各 35 张/107 mip/9,454,164 字节读回、NullRHI 各 10 帧通过。

下一步处理 Web Shader 归档的未压缩或免费压缩格式，再验证真实 Shader 创建和 Unlit 首帧；完整正常 Web Engine UBT 未验收。Canvas 观察脚本本轮增加真实提交/绘制计数与队列完成检查，因此需重跑 verify-web-marker-abi.cjs 后再验证 breadcrumb 和阶段汇总。详细复现、历史失败边界与未完成项见 P3，以下为历史检查点。

**2026-10-20 第四十一轮：实际 Engine 已越过 RDG 静态 UniformBuffer 绑定，进入首次视口呈现入口。** 共享 RHI 实现整批与单槽更新/清空、强引用释放、运行时布局哈希到静态槽的解析；原生两种命令模式共 38 项通过。静态 View 与直接绑定各 19 次真实 Unlit 绘制、各比对 1,114,112 个通道值，图像一致；二维 232 项、原生视口 72 项重新通过。旧综合探针的深度格式检查失败未计入通过项，材质定向入口与具体边界见 P3。

新增 `./tests/web-platform/probe-web-static-uniforms.ps1` 和 `node tests/web-platform/verify-web-static-uniforms.cjs`，前者使用正常构建后的原生 RHI（可先运行 probe-web-system-textures.ps1），后者核验原生与双浏览器证据。22 个 Web 单元重编、415 项诊断链接通过；Chrome/Edge 实际空绑定、640×360 BGRA8 后缓冲获取、三条标记通过，仍是 0 Engine 帧，当前阻塞为首次 Slate 非 VSync 请求与后端固定 FIFO 约束不符。各 35 张/107 mip/9,454,164 字节读回及 NullRHI 各 10 帧通过。下一步处理 Web 呈现参数，字节码、场景首帧和完整正常 Web Engine UBT 仍未验收。以下为历史检查点。

**2026-10-20 第四十轮：实际 Engine 已取得 Canvas 后缓冲并发送 GPU breadcrumb。** 仅 Web 排除当前未用的 GGX/sheen LTC 默认初始化；补齐 Emdawn 两个 InsertDebugMarker 的 WASM64 指针签名，通过仓库内 port 保证元数据晚于生成签名表加载，SDK 和共享 C++ 实现未修改。没有扩展 RG16F、高级光照、数组或材质层。

新增 `build-web-marker-abi.ps1` / `verify-web-marker-abi.cjs` 的 Chrome/Edge 正反例，两种接口各覆盖定长截断、中文 UTF-8、空字符串并完成真实 GPU 提交。实际 Engine 两浏览器各 640×360 BGRA8、一次后缓冲获取、两条 RDG 标记，GPU validation 为 0；18 单元重编、415 项诊断链接通过。各 35 张/107 mip/9,454,164 字节读回、NullRHI 各 10 帧、ApplicationCore 60 项、原 40 项及当前材质条件回归通过。新增 `verify-web-ltc-defaults.cjs` / `verify-web-breadcrumb-abi.cjs`，阶段汇总 true；完整启动仍 false、0 帧，当前为 `RHISetStaticUniformBuffers` 未实现。下一步补 RDG 通用静态 UniformBuffer 绑定，再继续字节码和首帧；完整正常 Web Engine UBT 未验收，复现与边界见 P3。以下为历史检查点。

**2026-10-20 第三十九轮，15:10：实际 Engine 已接通 Web 窗口与 Canvas WebGPU 配置。** 修正空标识、强制全屏、10 位后缓冲三项问题；Chrome/Edge 实际配置为 640×360 BGRA8、usage=17，无 GPU validation。Emdawn 未填写 surface usages 的差异仅在 Web 处理，原生能力和非法参数检查保留。尚未获取后缓冲、0 Engine 帧，新阻塞为 GGX.LTCAmp 的 PF_G16R16F；下一步先排查不需要的 LTC 光照初始化。

新增 `capture-web-canvas.cjs` / `node tests/web-platform/verify-web-canvas-viewport.cjs`。正常 ApplicationCore UBT 和四组 DPR 输入回归共 60 项、原生二维 232 项、隐藏 HWND 72 项/143,976 个通道值通过；浏览器二维读回各 36 张/108 mip/9,486,932 字节一致，NullRHI 各 10 帧，原 40 项及材质条件回归通过。18 个真实链接单元重编、415 项诊断链接，新增未链接对象拒绝检查。视口/阶段报告 true 不代表完整启动通过；正常完整 Web Engine UBT、字节码解压/创建和 Unlit 场景首帧仍待验收。复现和边界见 P3，以下为历史检查点。

**2026-10-20 第三十八轮，14:39：已越过系统纹理和引擎默认资源初始化，进入 Canvas 视口创建。** Web 局部排除未用系统数组/立方体、Perlin 体噪声更新及 Landscape 权重数组默认加载；补齐必要二维整数、半浮点、R8/RG8，预积分纹理使用已有 RG8 回退。没有扩展通用数组/三维更新，两份引擎源码只增加 25 行条件，桌面源码和安装版文件不变。

新增 `./tests/web-platform/probe-web-system-textures.ps1` 与 `node tests/web-platform/verify-web-system-textures.cjs`。原生 UBT 构建和 recorded/bypass 共 232 项检查通过，其中本轮 112 项新检查；既有计算回归 20 次派发、1,680 个值。两浏览器各 35 张二维纹理、107 mip、9,454,164 字节读回一致，NullRHI 各 10 帧及原材质证据回归通过；`web-system-textures-results.json` 和阶段汇总为 true。完整启动仍 false、WebGPU 0 帧，阻塞为 `viewport-window-or-dimensions-invalid`；下一步接 Web 窗口/Canvas 视口。WASM 链接明确保留旧 Renderer unity 分组，完整正常 Web UBT 和实际 Shader 执行仍未验收，完整复现与边界见 P3。以下为历史检查点。

**2026-10-20 第三十七轮，14:06：已越过 VolumeToRender 调试体纹理阻塞。** 完整错误栈定位到 LevelSet 调试 Actor 默认对象构造；仅 Web 不加载它的两个默认资源并禁用调试后处理，桌面源码保持一致。工作区 GeometryCollectionEngine 改为本地覆盖，受影响单元重编及 415 项增量链接通过；Cook 沿用上一轮已审计的成功产物。

新增入口 `node tests/web-platform/verify-web-debug-defaults.cjs`。两浏览器到达 ObjectSystemReady/系统纹理初始化，各 12 张二维纹理、54 mip、7,487,500 字节读回一致，NullRHI 各 10 帧及原材质证据回归通过。新阶段报告为 true；完整启动仍 false、0 帧，当前卡在 BlackArrayDummy。下一步先核对并排除不用的系统数组占位初始化，不扩展通用数组纹理。Shader 解压/实际创建、场景、完整正常 Web UBT 仍未验收。详细证据见 P3，以下为历史检查点。

**2026-10-20 第三十六轮，13:50：默认贴花缺少 Mobile 变体的问题已修复，Chrome/Edge 均已越过。** 原生 Cook 改为 WebCook 配套设置模块，修复管理器未注册设置导致的 DBuffer 掩码错误；新增显式移动 DBuffer/Substrate/完整深度预通道配置。v13 重编 838 Global、211 材质作业，163 包、0 错误、13 警告；327 个运行文件、23,907,500 字节。完整作业差异有独立检查，不把减少的 DBuffer 专用变体计为丢失的普通场景功能。

新增验收入口：

```powershell
./tests/web-platform/probe-web-material-policy.ps1
./tests/web-platform/probe-web-vertex-factories.ps1
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-engine-webgpu.cjs --incremental --es31
node tests/web-platform/verify-web-texture2d.cjs
node tests/web-platform/verify-web-material-completion.cjs
node tests/web-platform/verify-web-material-policy.cjs
node tests/web-platform/verify-web-es31-runtime-integration.cjs
```

`web-material-policy-results.json` 与阶段汇总为 true；真实完整启动仍 false、0 帧，当前为 EngineDebugMaterials/VolumeToRender 的 RGBA16F 体纹理创建失败。二维 53 mip 读回和 NullRHI 各 10 帧通过；原 40 项的 Emissive 测试明确使用历史成功产物，当前工厂排除另有新 Cook/原生检查。下一步优先排查不需要的体纹理调试初始化，不扩展体渲染；解压、实际 Shader 创建及场景仍未验收。详细证据见 P3，以下为历史检查点。

**2026-10-20 第三十五轮，12:26：普通二维纹理初始化和 GPU 读回通过。** 补齐尺寸估算、RGBA8/BGRA8 线性/sRGB、字体 R8、多 mip 创建和写入锁；设备限制替代单 mip 上限。两浏览器各从实际 C++ WebGPURHI 上传的 11 张二维纹理读回 53 个 mip、7,487,496 字节，逐级 SHA256 相同，GPU validation 为 0；不代表采样/过滤或场景绘制已通过。

新增 `capture-web-texture-uploads.cjs` 与 `verify-web-texture2d.cjs`；观察器转发真实 GPU 调用，独立验收报告 `web-texture2d-results.json` 为 true。原 40 项及 NullRHI 各 10 帧重验通过，Cook 沿用原成功产物。完整探针仍 false、0 帧，阻塞改为默认贴花材质缺 FDeferredDecalMobilePS；下一步核对 Cook/运行时条件，不跳过材质完整性检查。Shader 解压、创建、单 Unlit 网格、相机和网页 UI 仍待完成。

本轮复现入口：

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-engine-webgpu.cjs --incremental --es31
node tests/web-platform/verify-web-texture2d.cjs
node tests/web-platform/verify-web-material-completion.cjs
node tests/web-platform/verify-web-es31-runtime-integration.cjs
```

完整探针在材质检查失败时返回非零；两个阶段报告只验收已经通过的库加载和纹理上传。详细证据及未验收边界见 P3，以下为历史检查点。

**2026-10-20 第三十四轮，11:58：实际浏览器引擎已对齐 ES3.1 并打开 Global/项目材质库。** 两浏览器均识别 726/125 个 Shader，Global 映射加载越过；重新 Cook 为 838 个 Global、213 个材质作业全部通过，163/163 个包。运行包为 327 个文件、24,042,244 字节，配置与内容哈希逐项核验。

修正冻结布局描述、ES3.1 顶点资源条件和 Web 单线程缓存清理；两浏览器各通过 387 个块读取、3 个跨块读取及句柄释放，原 40 项与 115 个静态网格 WGSL 保留检查通过。阶段验收为 `web-es31-runtime-integration-results.json`（true），完整启动为 `web-engine-webgpu-es31-results.json`（false）：NullRHI 各 10 帧，WebGPU 在普通贴图尺寸查询 `RHICalcTexturePlatformSize` 未实现处停止，0 帧。解压、RHI Shader 创建和场景绘制尚未验证。

本轮入口：

```powershell
node tests/web-platform/stage-web-engine.cjs --es31
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-engine-webgpu.cjs --incremental --es31
node tests/web-platform/verify-web-material-completion.cjs
node tests/web-platform/verify-web-es31-runtime-integration.cjs
```

浏览器探针在整体启动未通过时仍返回非零；阶段验收单独检查成功的库加载边界和明确的当前阻塞。下一步只补普通二维纹理的必要接口，再处理可运行的字节码打包/创建和最小场景。旧 SM5 浏览器报告及前轮大汇总属于历史记录。完整证据见 P3，以下为历史检查点。

**2026-10-20 第三十三轮，11:21：原 40 个失败已全部处理，默认资源 ES3.1 Cook 完整通过。** 39 项未用顶点工厂在任务提交前排除，1 项贴花修复；原 115 个普通静态网格作业全保留。新缓存键下 838 个 Global、213 个材质作业全部成功，163/163 包、退出 0。两浏览器贴花三轴各 48 个读回值、原生工厂三组 24 项检查、资源专用绑定正反例和既有 GPU 回归均通过。汇总 `evidenceVerified=true`、`materialRegressionVerified=true`，整体 `pass=false`；WebGPU Engine 仍为 SM5、缺库、0 帧。

当前主线复现入口：

```powershell
./tests/web-platform/build-native-rendercore.ps1
./tests/web-platform/build-web-material-host.ps1
./tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-ES31 -ValidateShaderJobCache -SkipBuild
./tests/web-platform/probe-web-vertex-factories.ps1
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/verify-web-material-completion.cjs
node tests/web-platform/verify-web-resource-only-uniform.cjs
```

`verify-web-material-completion.cjs` 检查原 40 项、精确作业保留/排除、新缓存版本、实际 Cook、WASM 链接及浏览器读回。旧 `replay-web-material-cook.ps1` / `publish-web-material-cook.cjs` 和 `web-material-cook-results.json` 属于上一轮诊断，不再是当前主线；旧报告保留作对照。

下一步统一 WASM 到已通过的 ES3.1 配置，按实际文件名接入 Global 映射/共享库，验证解压和引擎加载，再测试单静态网格第一帧。完整边界和证据见 P3，以下为历史检查点。

**2026-10-20 第三十二轮，10:48：修复两个普通静态网格材质绑定失败，Cook 已进入实际材质阶段。** 关闭逐作业 DDC、保留全作业校验避开 `Job` 断言；只含纹理/采样器的 `Material` 参数改用严格资源表校验。两个合法输入、13 个错误配置以及 Chrome/Edge 各两个实际 Shader、24 个读回值通过。新入口为 `build-web-material-host.ps1`、`replay-web-material-cook.ps1`、`verify-web-resource-only-uniform.cjs`，`publish-web-material-cook.cjs` 将真实重放结果接入主 Cook 报告。

839 个 Global 作业仍全部成功；285 个材质作业中 245 成功、40 失败，失败 42→40、无新增失败，本次记录的 115 个 FLocalVertexFactory 作业全部转换成功。Renderer 参数 ensure 已确认来自 DLL/源码字段名差异，尚未修复。既有 GPU、策略、归档及汇总检查已刷新，`evidenceVerified=true`、整体 `pass=false`。完整 Cook 仍退出 3；NullRHI 各 10 帧，WebGPU Engine 缺匹配 SM5 库、0 帧。下一步约束未用顶点工厂的编译/消费者、完成最小材质 Cook，随后统一 Cook/WASM 配置和加载库；不扩展骨骼、粒子等可选功能。详细证据见 P3，前轮 17 份报告已留快照。以下为历史检查点。

**2026-10-20 第三十一轮，10:15：ES3.1 Global Shader 转换失败 2→0，839 个独立作业全部通过。** 两处局部 Web 数值修正避免零法线归一化及无穷深度常量，编译范围和设置不变，没有新增排除。新增 `verify-web-finite-capture-shadow.cjs`：两浏览器各通过 10 个相关模块、四个实际 GPU 用例和 256 个读回值；既有缓冲、纹理、色调映射回归通过。

新增 `verify-web-global-archive.cjs` 核验首次生成的 ES3.1 Global 文件：映射 333,357 字节、字节码库 2,891,378 字节，库内 92 个 ShaderMap、730 个引用、727 份 Oodle 压缩字节码结构与元数据/日志相符。未验证解压、映射反序列化或引擎加载。Cook 仍有 `ConservativeDepthFillSize` 参数结构 ensure 和材质缓存 `Job` 断言、退出 3；NullRHI 两浏览器各 10 帧，WebGPU Engine 仍缺匹配 SM5 库、0 帧。`evidenceVerified=true`、整体 `pass=false`。本轮无 C++ 修改或构建，旧产物哈希重验；前轮 15 份报告以 `-before-finite-capture-shadow-20261020-1008.json` 保留。下一步处理主机参数/材质 Cook、实际库命名及 Cook/浏览器配置统一，再验证场景，详细边界见 P3。下文为历史检查点。

**2026-10-20 第三十轮，09:58：同步关闭 Web 立方体阴影缓存复制，失败 3→2。** 编译及直接入口复用已有点光源阴影能力，原生策略按文件和入口精确限制；保留普通全屏、二维和滚动复制，这三个作业本轮重新转换通过。直接立方体复制在缓存/图资源准备前报错，移除新增保护后完整函数与安装版一致；真实拒绝及普通复制 GPU 执行未验证。

完整校验为 839 个独立作业、837 个转换通过、2 个失败。两个类型退出 2 个变体，包含一个旧失败和一个旧成功；其余 1,508 个类型的变体数及 16 项设置不变，无新增失败。原生 RenderCore、两个 WASM 单元、链接、六份声明/全屏实现文件和两浏览器回归通过。NullRHI 各 10 帧、0 页面错误；WebGPU Engine 仍缺 Global 库、0 帧。`evidenceVerified=true`，整体 `pass=false`；快照后缀为 `-before-cube-shadow-copy-policy-20261020-0952.json`。下一步处理场景捕获和屏幕阴影，再统一配置、加载匹配库并验证场景，详细边界见 P3。下文为历史检查点。

**2026-10-20 第二十九轮，09:48：同步关闭 Web GPU 粒子编译、运行查询和预缓存，失败 4→3。** 十个类型退出 10 个变体，包含一个顶点旧失败和九个旧成功；其余 1,500 个类型的变体数及 16 项设置不变，无新增失败。既有 FX 初始化、调度及创建读取公共能力，PSO/向量场调试网格跳过，曲线分配受限，直接使用明确报错；系统记账和释放保留。CPU 粒子未改，实际旁路、控制台覆盖和原生粒子材质/资产 Cook 未验证。

完整校验为 841 个独立作业、838 个转换通过、3 个失败。原生 RenderCore、四个 WASM 单元及链接通过，415 个链接输入、八份声明/消费者文件和两浏览器 Shader 回归通过。NullRHI 各 10 帧、0 页面错误；WebGPU Engine 仍缺 Global 库、0 帧。`evidenceVerified=true`，整体 `pass=false`；快照后缀为 `-before-gpu-particle-policy-20261020-0944.json`。剩余阴影分层复制顶点、场景捕获和屏幕阴影三个失败；后续还需统一配置、加载匹配库并验证场景，详细边界见 P3。下文为历史检查点。

**2026-10-20 第二十八轮，09:32：同步关闭 Web 虚拟纹理页表，失败 6→4。** 八个类型退出 8 个变体，包含两个顶点旧失败和六个像素旧成功；其余 1,502 个类型的变体数及 16 项设置不变，无新增失败。Shader 编译、公共平台/纹理构建查询同步关闭；四个直接页表入口在准备前明确报错，既有消费者、记账、释放和更新结束逻辑核验通过。普通纹理未改；实际 VT 旁路、资产 Cook/拒绝及普通场景纹理绘制未验证。

完整校验为 851 个独立作业、847 个转换通过、4 个失败。原生 RenderCore、两个 WASM 单元及链接通过，415 个链接输入、八份声明/消费者文件和两浏览器 Shader 回归通过。NullRHI 各 10 帧、0 页面错误；WebGPU Engine 仍缺 Global 库、0 帧。`evidenceVerified=true`，整体 `pass=false`；快照后缀为 `-before-vt-page-table-policy-20261020-0927.json`。剩余粒子顶点、阴影分层复制顶点、场景捕获和屏幕阴影四个失败；后续还需统一配置、加载匹配库并验证场景，详细边界见 P3。下文为历史检查点。

**2026-10-20 第二十七轮，09:20：同步跳过 Web 移动遮挡反馈，失败 8→6。** 两个类型退出 3 个变体，包含两个像素旧失败和一个顶点旧成功；其余 1,508 个类型的变体数及 16 项设置不变，无新增失败。Shader 和两处资源初始化读取共享能力，控制台开启也不能绕过；直接初始化/绘制明确报错，普通 HZB/查询选择保留，运行行为尚未场景验证。

完整校验为 859 个独立作业、853 个转换通过、6 个失败。原生 RenderCore、四个 WASM 单元及链接通过，8 份声明/消费者文件和两浏览器 Shader 回归通过。首次 Edge NullRHI 资源加载错误报告已保留，复测两浏览器各 10 帧、0 页面错误；WebGPU Engine 仍缺 Global 库、0 帧。`evidenceVerified=true`，整体 `pass=false`；快照后缀为 `-before-occlusion-feedback-policy-20261020-0915.json`。下一步核对虚拟纹理、粒子及阴影分层复制顶点，详细边界见 P3。下文为历史检查点。

**2026-10-19 第二十六轮，21:12：同步跳过 Web 地形纹理输出及 IES 调试，失败 12→8。** 四个类型共退出 7 个变体，包含 4 个旧失败及 3 个旧成功；其余 1,506 个类型的变体数及 16 项设置不变，无新增失败。地形公共纹理输出入口返回 false，渲染消费者同步限制，普通地形绘制未修改但未验证。IES 调试与更新共文件、共入口，按类型及文件精确筛选；两个调试入口在资源准备前退出，普通更新 CS 本轮重新转换通过，实际 IES GPU 执行仍未验证。

完整校验为 862 个独立作业、854 个转换通过、8 个失败。原生 RenderCore、三个 WASM 单元及链接通过，Landscape 已成为工作区独立副本，4 份声明文件及既有两浏览器回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；`evidenceVerified=true`，整体 `pass=false`。快照后缀为 `-before-landscape-ies-policy-20261019-2054.json`，下一步核对遮挡反馈、虚拟纹理和粒子等剩余路径，详细边界见 P3。下文为历史检查点。

**2026-10-19 第二十五轮，20:45：同步跳过 Web 调试/编辑器图元合成及 HMD 畸变，失败 15→12。** 四个类型共排除 6 个变体，包含 3 个旧失败及 3 个旧成功；其余 1,506 个类型的变体数和 16 项设置不变，无新增失败。编译、公共合成开关、HMD 后处理与资源初始化同步限制；HMD 直接入口保留颜色或拷贝到指定输出，直接合成调用明确报错。编辑器专用入口仅源码核验，运行旁路尚未实际场景验证。

完整校验为 869 个独立作业、857 个转换通过、12 个失败。原生 RenderCore、三个 WASM 单元及链接通过，6 份声明文件及保留路径核验通过；缓冲、纹理、色调映射两浏览器回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；`evidenceVerified=true`，整体 `pass=false`。快照后缀为 `-before-composite-hmd-policy-20261019-2036.json`，下一步核对地形合并与 IES 调试用途及调用条件，详细边界见 P3。下文为历史检查点。

**2026-10-19 第二十四轮，19:43：同步跳过 Web 粒子 GPU 排序的编译、资源初始化和任务接收，失败 22→15。** 七个类型共排除 7 个旧失败变体，其余 1,503 个类型的变体数和 16 项设置不变，无新增失败。任务在分配前拒绝，Cascade 保留未排序索引；直接排序明确报错，渲染事件通知保留。当前目标不含 Niagara；回退和资源旁路尚未实际场景验证。

完整校验为 875 个独立作业、860 个转换通过、15 个失败。原生 RenderCore、两个 WASM 单元及链接通过，8 份排序声明/调用文件和保留路径核验通过；缓冲、纹理、色调映射两浏览器回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；`evidenceVerified=true`，整体 `pass=false`。快照后缀为 `-before-gpu-sort-policy-20261019-1929.json`，下一步核对编辑器合成深度、地形编辑和 HMD 等路径，详细边界见 P3。下文为历史检查点。

**2026-10-19 第二十三轮，18:12：同步限制稀疏体积更新的 Web 编译和流送能力，失败 25→22。** 两个类型共排除 4 个变体，包含 3 个旧失败及 1 个旧成功；其余 1,508 个类型的变体数和 16 项设置不变，无新增失败。流送入口读取同一能力，直接上传保留解锁及释放，只跳过派发；尚未实际场景验证。

完整校验为 882 个独立作业、860 个转换通过、22 个失败。原生 RenderCore、两个 WASM 单元及链接通过，4 份流送实现/上传声明文件和保留路径审计通过；缓冲、纹理、色调映射两浏览器回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；`evidenceVerified=true`，整体 `pass=false`。快照后缀为 `-before-sparse-volume-policy-20261019-1803.json`，详细进度、剩余及版本/配置边界见 P3。下文为历史检查点。

**2026-10-19 第二十二轮，18:00：同步限制灯光形状与 HDR 调试显示的 Web 编译和调用，失败 29→25。** 三个类型共排除 5 个变体，包含 4 个旧失败及 1 个旧成功；其余 1,507 个类型的变体数和 16 项设置不变，无新增失败。状态更新、调试资源准备、后处理序列和直接入口同步限制，HDR 指定输出拷贝保留，尚未实际 GPU 执行。

完整校验为 886 个独立作业、861 个转换通过、25 个失败。原生 RenderCore、四个 WASM 单元及链接通过，6 份声明/调用文件及保留路径审计通过；缓冲、纹理、色调映射两浏览器回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；`evidenceVerified=true`，整体 `pass=false`。快照后缀为 `-before-render-debug-policy-20261019-1752.json`，详细进度、剩余及版本/配置边界见 P3。下文为历史检查点。

**2026-10-19 第二十一轮，17:47：同步限制天空大气编译、资源准备及绘制入口，失败 32→29。** 七个类型共排除 103 个变体，包含 3 个旧失败及 100 个旧成功，其余 1,503 个类型的变体数和 16 项设置不变，无新增失败。九个目标编译条件和消费者共用能力判断，可选采样缓冲跳过 Web 初始化；必要记账保留，默认视图资源仅作源码审计。

完整校验为 891 个独立作业、862 个转换通过、29 个失败。原生 RenderCore、两个 WASM 单元及链接通过，10 份调用/声明文件和保留路径审计通过；缓冲、纹理、色调映射两浏览器回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；天空旁路和默认绑定未在场景执行，`evidenceVerified=true`，整体 `pass=false`。快照后缀为 `-before-sky-atmosphere-policy-20261019-1738.json`，详细进度、剩余及版本/配置边界见 P3。下文为历史检查点。

**2026-10-19 第二十轮，17:32：同步限制移动自动曝光编译与消费者，失败 37→32。** 按四个曝光入口精确排除五个旧失败，同文件其余 41 个变体重新转换通过；其他 1,505 个类型的变体数及 16 项设置不变，无新增失败。公共运行判断和直接入口同步限制，原有固定曝光回退保留，尚未实际 GPU 验证。

完整校验为 994 个独立作业、962 个转换通过、32 个失败。原生 RenderCore、两个 WASM 单元和链接通过；保留路径及缓冲、纹理、色调映射两浏览器回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；`evidenceVerified=true`，整体 `pass=false`。快照后缀为 `-before-mobile-exposure-policy-20261019-1726.json`，详细证据、剩余与配置/版本边界见 P3。下文为历史检查点。

**2026-10-19 第十九轮，17:20：同步限制 SMAA 编译、后处理序列及纹理加载，失败 41→37。** 仅跳过网页配置未启用的抗锯齿；八个类型共 18 个变体退出编译，包含 4 个旧失败和 14 个旧成功，其他 1,502 个类型的变体数及 16 项设置不变，无新增失败。指定输出目标的直接调用旁路保留，尚未执行 GPU 验证。

完整校验为 999 个独立作业、962 个转换通过、37 个失败。原生 RenderCore、四个 WASM 单元及增量链接通过；普通阴影/HZB/单采样产物和既有两浏览器 Shader 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；`evidenceVerified=true`，整体 `pass=false`。快照后缀为 `-before-smaa-policy-20261019-1714.json`，详细证据、剩余与版本/配置边界见 P3。下文为历史检查点。

**2026-10-19 第十八轮，17:07：同步限制 OIT 三角形排序编译、索引分配和调度，失败 46→41。** 恰好排除 4 个类型、5 个旧失败，其余 1,506 个类型和 16 项设置不变，无新增失败；普通透明混合及原有网格索引路径保留，未增加 RHI 格式。

完整校验为 1,017 个独立作业、976 个转换通过、41 个失败。原生 RenderCore、两个 WASM 单元及最终链接通过，3 个消费者共 6 份文件审计通过；普通阴影/HZB/单采样产物和既有两浏览器 Shader 回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；真实透明绘制及场景入口未验证。`evidenceVerified=true`，整体 `pass=false`；快照后缀为 `-before-oit-policy-20261019-1700.json`，两次链接与首次编译证据均已保留，详细边界见 P3。下文为历史检查点。

**2026-10-19 第十七轮，16:53：精确限制点光源立方体阴影编译与消费者，失败 56→46。** 仅排除共用文件的 `MainOnePassPointLightPS` 入口，共 10 个旧失败；其他 1,500 个类型和 16 项设置不变，无新增失败。同文件 15 个普通/调制阴影投影作业全部重新转换通过，没有增加 RHI 格式。

完整校验为 1,022 个独立作业、976 个转换通过、46 个失败。原生 RenderCore、三个 WASM 单元及增量链接通过；缓冲、纹理、色调映射两浏览器回归通过。NullRHI 各 10 帧；WebGPU Engine 仍缺 Global 库、0 帧。普通阴影 GPU 绘制和实际场景入口未验证，目标材质深度条件仅编译、未完成实际材质 Cook；`evidenceVerified=true`，整体 `pass=false`。快照后缀为 `-before-point-shadow-policy-20261019-1645.json`，详细进度和边界见 P3。下文为历史检查点。

**2026-10-19 第十六轮，16:36：4 个间接派发参数 Shader 修复，失败 60→56。** 完整校验为 1,032 个独立作业、976 个转换通过、56 个失败；全部 1,510 个类型和 16 项设置不变，无新增失败或裁剪。仅改 Web Shader 缓冲声明及共享参数函数，累计 10 个覆盖文件均受严格副本检查，未修改 C++。

`verify-web-buffer-cook.cjs` 现覆盖 26 个旧失败作业、34 个用例。Chrome/Edge 各核对 18,757 个值，并用生成参数执行 29 次真实 `dispatchWorkgroupsIndirect`，0 GPU 错误；纹理、色调映射、HZB/单采样产物回归通过。既有原生/WASM 构建证据哈希有效，本轮未重编。NullRHI 各 10 帧；WebGPU Engine 仍缺 Global 库、0 帧，Engine RHI 间接调度与场景尚未验证。`evidenceVerified=true`，整体 `pass=false`；快照后缀为 `-before-indirect-args-20261019-1629.json`。剩余及版本/配置边界详见 P3。下文为历史检查点。

**2026-10-19 第十五轮，16:19：同步关闭局部雾、体积雾的 Web 编译和消费条件，失败 67→60。** 配置开关原本已关闭；8 个类型的 28 个变体退出编译，包含 7 个旧失败和 21 个旧转换成功作业，其余 1,502 个类型及 16 项设置不变，无新增失败。保留局部雾空资源初始化，没有新增 RHI 格式。

完整校验为 1,032 个独立作业：972 个转换通过、60 个失败。原生 RenderCore、三个相关 WASM 单元编译通过；补编既有保守深度实现所在第四个单元后链接通过，首次链接签名不一致的失败已保留。50 个 HZB 作业、两种单采样产物和既有缓冲/纹理/色调映射两浏览器回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；雾效空资源与实际场景消费者、体积材质 Cook 未验证。`evidenceVerified=true`，整体 `pass=false`；本轮前快照后缀为 `-before-fog-policy-20261019-1611.json`，后续按最小场景需要处理阴影、缓冲和后处理，边界详见 P3。下文为历史检查点。

**2026-10-19 第十四轮，16:06：同步限制 Web 未启用的 MSAA/resolve 编译和运行入口，失败 84→67。** 普通单采样深度、独立颜色解析和色调映射保留。精确移除 13 个类型的 18 个变体，包含 17 个旧失败及 1 个不用的 HDR 顶点作业；其他 1,497 个类型及 16 项设置不变，无新增失败。没有新增 RHI 格式或多重采样能力。

完整校验为 1,060 个独立作业：993 个转换通过、67 个失败。原生 RenderCore、五个 WASM 单元和增量链接通过；两种保留单采样产物、50 个 HZB 作业及缓冲/纹理/色调映射两浏览器回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧。深度/解析尚未执行 GPU 绘制或场景调用；`evidenceVerified=true`，整体 `pass=false`。裁剪前快照后缀为 `-before-msaa-policy-20261019-1557.json`，下一步按最小场景需要处理剩余阴影、缓冲及后处理路径，边界详见 P3。下文为历史检查点。

**2026-10-19 第十三轮，15:42：同步关闭 Web 胶囊阴影的编译、准备和调度条件，失败 96→84。** 三个类型共 20 个变体退出编译，精确包含 12 个旧失败；其余 1,507 个类型和 16 项设置不变，无新增失败。普通静态网格阴影保留，未新增 RHI 格式。

完整作业检查记录 1,078 个独立作业：994 个转换通过、84 个失败。原生 RenderCore、胶囊调度与 ShadowSetup 所在 WASM 单元、增量链接通过；50 个保留 HZB 作业全部本轮转换通过。22 项缓冲计算、6 项纹理更新和 96 项色调映射两浏览器回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；场景中的胶囊准备与调度未执行。当前 `evidenceVerified=true`、整体 `pass=false`；下一步核对 MSAA/resolve 条件并保留普通单采样深度，边界详见 P3。下文为历史检查点。

**2026-10-19 第十二轮，15:21：排除 HZB 的 12 个 Web R64 可见性变体，失败 108→96，普通深度归约保留。** 原生 Cook 临时读取安装版 Renderer 自身的具名变体信息，目标编译条件和运行入口共用平台限制，Web R64 输入明确报错；未新增 RHI 格式。仅一个类型变化，其余 1,509 个类型和 16 项设置不变。

完整作业检查覆盖 1,098 个独立作业：1,002 个转换通过、96 个失败；48 个 HZB 计算变体和 2 个像素变体全部本轮转换通过，无新增失败。原生 RenderCore、三个 WASM 单元及增量链接通过，首次旧 Glint 对象缺符号失败已留档，补编已有实现后通过。22 项缓冲计算、6 项纹理更新和 96 项色调映射两浏览器回归通过。NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧；HZB GPU 深度归约和实际场景未验证。当前 `evidenceVerified=true`、整体 `pass=false`，配置与版本边界详见 P3。下文为历史检查点。

**2026-10-19 第十一轮，15:05：6 个纹理更新/拷贝 Shader 修复并在真实 GPU 验证，失败 114→108。** Web 分支使用 storage buffer 和只写纹理标记；没有新增 RHI 格式、功能裁剪或修改 C++。首次转换后的四个纹理管线失败单独保留，最终 Chrome/Edge 各执行 6 项、核对 11,063 个值、0 错误，并各通过 4 个旧产物拒绝检查。新入口为 `verify-web-texture-update-cook.cjs`。

完整作业检查记录 1,110 个独立作业，1,002 个转换通过、108 个失败；变体及 16 项设置不变，无新增失败。22 项缓冲计算和 96 项色调映射本轮重新转换，两浏览器回归通过；NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧。直接 GPU 执行尚未验证 Engine RHI 调度或场景，HZB 的 12 个失败仍保留。当前证据核验通过、整体 `pass=false`；版本和配置边界详见 P3。下文为历史检查点。

**2026-10-19 第十轮，14:50：GPU 崩溃测试和 ShaderPrint 的 Web 编译/运行条件已同步。** 精确排除 14 个类型、22 个调试变体；其他 1,496 个类型及 16 项设置不变。失败 131→114，恰好排除 17 个旧调试失败，无新增失败。完整作业检查覆盖 1,110 个独立作业，996 个转换通过、114 个失败；完整 Global 库尚未生成。

原生 RenderCore 和三个 WASM 单元重编译、增量链接通过，安装版输入哈希不变。22 项缓冲计算和 96 项色调映射本轮全部重新转换，两浏览器回归通过；NullRHI 各 10 帧，WebGPU Engine 缺库、0 帧。调试入口未在真实场景执行，直接缓冲计算也未验证 Engine RHI 调度。当前 `evidenceVerified=true`、整体 `pass=false`；下一步核对 HZB 64 位变体、必要纹理更新和绑定。混合版本、ES3.1 Cook/SM5 运行端及普通完整 UBT 未验收边界保留，详见 P3。下文为历史检查点。

**2026-10-19 第九轮，14:33：22 个旧缓冲 Shader 失败已修复，并通过真实 GPU 计算检查。** 三个目标 Shader 仅添加 Web storage buffer 声明分支，保持参数、索引与 64/512 线程组。完整作业缓存校验覆盖 1,132 个独立作业，1,001 个转换通过、131 个失败；本轮没有新增裁剪。Chrome/Edge 各执行 22 项、核对 18,002 个值、0 GPU 错误；测试直接执行真实 ES3.1 Cook 产物，尚未验证 Engine RHI 调度和场景，512 线程组限制的 Engine 设备协商仍待接入。

96 个色调映射作业本轮重新转换并通过两浏览器模块验证；NullRHI 各 10 帧，WebGPU Engine 仍缺 Global 库、0 帧。没有修改 RHI C++ 或新增视图格式。当前证据核验通过、整体 `pass=false`；混合源码、ES3.1 仅 Cook、SM5 Engine 运行端和普通完整 UBT 未验收边界保留，详见 P3。下文为历史检查点。

缓冲 Shader 本轮复现入口（需已有原生模块及本机 Playwright 依赖）：

```powershell
& .\tests\web-platform\cook-web-engine.ps1 -Mode WebGPU-ES31 -ValidateShaderJobCache -SkipBuild
# 完整 Cook 仍预期退出 3，随后检查 22 个修复产物。
node .\tests\web-platform\verify-web-buffer-cook.cjs
```

**2026-10-19 第八轮，14:10：GPUScene、骨骼场景扩展已按最小场景范围关闭并实测。** 原生 RenderCore 和 WASM 共用平台条件，Cook/运行配置同步关闭两个开关。仅 11 个类型改变，排除 71 个变体，其他 1,499 个类型保持一致；ES3.1 可编译范围 1,203→1,132，完整 Cook 仍失败，记录 150 个独立失败、280 条诊断。五个 WASM 编译单元及增量链接通过，安装目录哈希未变。

Chrome/Edge NullRHI 各 10 帧、0 错误，并实际读回两个功能关闭、配置均为 0；WebGPU 仍在缺 Global 库处停止、0 帧，失败的 SM5 Cook 被 Stage 拒绝。71 个基础 Shader/Worker 样本重跑通过；96 个色调映射作业只引用历史证据，未计为本轮重编译或重验。当前 `evidenceVerified=true`、整体 `pass=false`；设置读回不等于场景绘制验证。下一步处理必要缓冲清理/拷贝及绑定问题，再统一 Cook/运行配置并接真实库和场景。ES3.1 仅 Cook、浏览器 SM5、混合源码和普通完整 UBT 未验收边界保留，详见 P3。下文为历史检查点。

**2026-10-19 第七轮，13:47：原生 Cook 和 WASM 共享 LightGrid、MobileFog 编译条件，精确排除 334 个变体。** `build-native-rendercore.ps1` 使用隔离主机重建 RenderCore，并检查构建输出路径和安装版输入哈希；Cook 实际加载该独立 DLL。运行端同步跳过对应渲染入口，三个 WASM 编译单元和增量链接通过。`verify-web-minimal-shader-policy.cjs` 核验 1,510 个注册类型中其他 1,504 个类型变体数不变，两组转换作业均为 0；运行时入口及空资源仍未实测。

ES3.1 可编译范围 1,537→1,203，完整 Cook 仍退出 3，记录 208 个独立失败、388 条诊断；SM5 首错复跑也未通过。NullRHI Cook/Stage 为 324 文件，Chrome/Edge 各 10 帧、0 错误；WebGPU 仍缺 Global Shader 库、0 帧。当前 `evidenceVerified=true`、整体 `pass=false`。上轮 96 个色调映射产物本轮来自明确标注的历史批次，重新验证两浏览器模块通过，未计作本轮重编译；同文件另有 4 个输入附件变体失败。下一步核对实例裁剪、骨骼和后处理的必要条件，不扩展未使用功能。ES3.1 仍是 Cook 试验、浏览器仍 SM5；混合源码和普通完整 UBT 边界保留。下文为历史检查点。

本轮复现入口：

```powershell
& .\tests\web-platform\build-native-rendercore.ps1
& .\tests\web-platform\cook-web-engine.ps1 -Mode WebGPU-ES31 -SkipBuild
# 上一命令当前预期失败；随后核验裁剪范围及已编译的 WASM 产物。
node .\tests\web-platform\verify-web-minimal-shader-policy.cjs
```

**2026-10-19 第六轮，12:25：此前失败的 96 个 ES3.1 色调映射作业已全部修复并重编译验证。** WebGPU 条件分支用 `sign()` 代替无限常量乘法，其他平台保留原逻辑；ShaderFormat/DDC 升为 v9。`prepare-web-cook-shaders.cjs` 为两个 Cook 主机准备独立的 1,227 文件 Shader 副本，并验证仅有该目标补丁，安装版 Shader 哈希未改变。`verify-web-tonemap-cook.cjs` 对比真实旧失败作业、检查 SPIR-V 常量和转换结果；Chrome/Edge 各验证 96 份 WGSL 模块、0 错误。模块验证不等于渲染管线或场景验证。

完整 Cook 仍退出 3，记录 374 个独立失败、716 条诊断，Global Shader 库尚未生成；基础 Shader/Worker 71 样本通过。NullRHI Cook/Stage 保持 324 文件、两浏览器各 10 帧、0 错误；WebGPU 完成设备和预初始化资源后仍缺库、0 帧。当前证据核验 `evidenceVerified=true`、整体 `pass=false`。ES3.1 仍为 Cook 试验，运行端仍 SM5；下一步同步同源 Cook/运行端的必要 Shader 范围，再接真实库与场景。没有扩展可选 RHI 功能。下文为历史检查点。

**2026-10-19 第五轮，11:49：ES3.1 最小 Cook 配置已实跑，仍未生成完整 Shader 库。** `cook-web-engine.ps1 -Mode WebGPU-ES31` 使用独立 Web/46 主机；原 SM5 的 4,395 个可编译变体降到 ES3.1 的 1,693 个，最小配置再降到 1,537 个。最终记录 469 个独立转换失败、908 条诊断，14 个关键设置的主机/目标值一致。浏览器仍为 SM5；不能把枚举数量、重复诊断或 WGSL 文件数当作成功 Shader 数。

基础 Shader/Worker 重新通过 71 样本、55 转换/绑定和 16 预期拒绝；55 份 Editor/Worker 字节码相等，两项版本负例通过。NullRHI Cook/Stage 为 324 文件、19,952,703 字节，两浏览器各 10 帧、0 错误；WebGPU 完成设备和预初始化资源后仍缺 Global Shader 库、0 帧。`analyze-web-shader-cook.cjs` 输出清单和去重失败，`verify-web-shader-cook-regression.cjs` 输出独立证据核验；当前 `evidenceVerified=true`、整体 `pass=false`。下一步同步 Cook/运行端的必要编译裁剪及源码版本，之后再接真实 Shader 库、场景与 HTML UI；未扩展可选 RHI 功能。下文为历史检查点。

**2026-10-19 第四轮，11:12：真实 WebGPU Shader Cook 已接入标准 CookCommandlet，尚未通过。** 新隔离主机实测 Web/47 和目标 DDPI 注册，最终首错为稀疏体积纹理 Shader 的 `SampledBuffer` capability，此前复跑也复现了 `FWriteToSliceGS` 的 `Layer` builtin。具体源码、入口、SPIR-V、反射和错误已保存，首错停止实测退出 3；早先批次的可选 Shader 失败归并记录于 `web-engine-webgpu-cook-blockers-results.json`。下一步同步 Cook 与运行端的最小 Shader 范围及源码版本，不扩大可选功能。WebGPU Stage/挂载已实现但成功路径未实测，失败 Cook 已被拒绝。

NullRHI Cook/Stage 保持 330 文件、23,633,819 字节，两浏览器各 10 帧、0 页面错误；WebGPU 仍缺 Global Shader 库、0 帧。71 个基础 Shader/Worker 样本通过，材质回归被旧原生主机的 `ConservativeDepthFillSize` 参数不匹配阻塞，未计通过。普通完整 UBT 仍未验收，保留混合 5.8.3/5.8.0 边界。下面为历史检查点。

**2026-10-19 第三轮，10:35：WebGPU 的预初始化资源阶段已在 Chrome/Edge 通过。** 当前增量诊断报告 `deviceCreationVerified=true`、`preRHIResourcesInitialized=true`、`nullRHITickVerified=true`，两个 NullRHI 路径各 10 帧、无页面错误。硬件路径仍 0 帧，共同阻塞为 `global-shader-library-missing`，报告整体仍 `pass=false`；下一步接真实 WebGPU Shader Cook/挂载。默认资源按最小场景局部排除，普通顶点缓冲与天空辐照度缓冲保留；没有增加可选 RHI 格式。当前为混合 5.8.3/5.8.0 诊断，普通完整 UBT 构建未验收，视口/硬件 Tick/地图/HTML UI 尚未完成。下文为历史检查点。

**2026-10-19 第二轮：Chrome/Edge 已在完整 Engine 增量诊断产物中创建 WebGPU Device 并进入真实 RHI 初始化。** 同产物 NullRHI 各 10 帧、无页面错误；WebGPU 仍 0 帧，当前阻塞 `FDummyFloatBuffer::InitRHI` 的标量浮点 SRV。Web 平台 Geometry Cache 默认资源与消费者已局部裁剪并越过。原生核心/材质/状态 106 项、全局 44 项和视口 72 项回归通过。本轮普通完整 UBT 构建主动中止后未完成验收，增量诊断独立记录 `fullNormalUBTBuildVerified=false`；没有渲染场景或 Shader Cook。详细证据见 P3 报告。下面 09:31 及 10 月 16 日内容为历史检查点。

**2026-10-19 09:31：NullRHI Web Cook/Stage 与真实 Engine PreInit/Init/Tick 通过。** 标准 CookCommandlet 生成 330 个启动资源文件、23,633,819 字节，网页整包与逐文件 SHA256 验证后挂载；Chrome 155.0.8059.84、Edge 155.0.4283.45 各运行到 10 帧，无页面错误。两项资源损坏拒绝检查及原 Shader Worker 主机回归通过。本轮没有 WebGPU 场景或渲染 Shader Cook，混合 5.8.3/5.8.0 边界保留。

严格汇总 `web-engine-cook-summary-20261019.log` 退出 1：当前完整构建、Cook/Stage、浏览器 Tick 三项为 true，但旧源码探针记录的安装版 GameEngine.cpp 已被外部变更，哈希失效，未改写旧证据。详细经过和剩余主线见 P3 报告。下列 10 月 16 日记录保留为历史。

**21:13：完整 Engine Target 首次最终链接成功，旧的 41 个未解析符号已解决。** `web-engine-full-20261016-192300.log` 为 89/89、退出 0，包括 UMG；当前产物后续增量构建 `web-engine-full-20261016-211014.log` 也退出 0。Chrome 已实际执行 wasm64 Engine，补齐程序名查询、挂载四份原始配置、选择 NullRHI `-sm5` 并将测试栈从 64KB 增至 4MB 后，越过 NullRHI 初始化，停在缺少 Cook 默认材质的 `UMaterialInterface::AssertDefaultMaterialsExist()`。当前 0 帧，PreInit/Init/Tick 尚未通过，Engine 的 Edge 验收尚未执行。报告为 `web-engine-full-build-results.json`、`web-engine-runtime-results.json`。下一步转向 Cook/Stage 与资源挂载；不屏蔽材质断言，不扩展 Nanite、数组纹理等功能。详细边界见 P3 报告。

21:21：综合回归 `web-ubt-integrated-20261016-211359.log`、12 对象/5 符号日志的实现排除及保留检查通过；修正哈希函数作用域后的严格汇总 `web-engine-linked-summary-20261016-212128.log` 退出 0。当前源码与完整构建匹配，`webEngineTargetBuildSucceeded=true`；真实 Engine Tick 和 P3 完成标记仍为 false。P0/P1/P2 GPU 检查没有重跑。

21:28 最终刷新：`web-engine-full-20261016-212618.log` 重新链接通过，并保存实际链接参数 `.log.link.rsp`，后续探针不能覆盖这份证据。库运行和对象/链接输入检查重新通过，最终汇总 `web-engine-linked-summary-20261016-212838.log` 退出 0。Chrome 一次页面崩溃记录单独保留，再次运行复现默认材质缺失断言、0 帧，运行仍未通过。

此前 19:22：16:54 完整构建在 166/254 后被系统异常重启中断，无退出结果或链接，证据为 `results/web-engine-system-interruption-20261016-1817.json`。之后改为单任务、相同 CPU 限制续编；安装目录未修改。

16:53 历史检查点：目标分支自带 BLAKE3 1.3.1 portable 库已生成，35 组向量、三种模式、两种输入分段方式在 Node/Chrome/Edge 各 210 项通过。libPNG 同样使用目标分支自带的 1.6.44，8/16 位 RGBA、元数据往返和损坏 IDAT 拒绝在三个环境各 8 项通过，并核对与引擎头/配置一致；保留 PNG 开关。UDP 探测回调不支持，补丁验证复用同步分支。以下链接失败及 16:17 回归记录保留为历史过程，最新状态以上文及 P3 报告为准。

16:14 历史链接：`web-engine-full-20261016-161416.log` 当时剩余 41 个符号（BLAKE3 3、PNG 34、ICMP 字节序 3、限时信号量 1），旧分类保留为 `results/web-engine-link-blockers-results-20261016-161836.json`。后续已链接成功，没有移除 UMG/Slate 依赖。

2026-10-16 最新回归：上述链接修复后，`build-web-ubt.ps1` 综合回归与严格汇总均退出 0。ApplicationCore 的 Chrome/Edge 桌面及窄视口四组各 15 项通过；Core Program 6 组、基础服务 7 组均在 Node/Chrome/Edge 通过；Engine 十个关键源码与额外检查重新编译通过，标准入口符号、解码器链接排除和 SlateCore/Sockets 对象检查通过。日志为 `results/web-ubt-integrated-20261016-161752.log`、`results/web-engine-link-reduction-summary-20261016.log`。完整 Engine 链接仍失败，本轮未重跑 P0/P1/P2 GPU 检查。

## 目录

| 文件 | 用途 |
| --- | --- |
| `probe.cpp` | 原生 Dawn 与浏览器 emdawnwebgpu 共用的 C++ GPU 样本 |
| `abi.cpp` | 指针、size_t、结构体布局、线程原子操作 |
| `build-native.ps1` | 构建并运行 Win64 GPU/ABI；复制对应 DXC DLL |
| `build-web.ps1` | 构建 wasm32/64、单线程/线程版本 |
| `build-shaders.ps1` | 从固定 UE 提交提取原始 .usf，执行 DXC → SPIR-V → Tint → WGSL 与反射 |
| `shader-fixtures/` | 精简的 Common include；不是完整 UE Shader 环境 |
| `shader-runtime.js` | 在浏览器执行生成的 Shader，检查绑定、Uniform、图像和计算读回 |
| `serve.cjs` | 默认监听所有 IPv4 地址的本机/局域网服务，提供 WASM MIME、COOP、COEP |
| `run-browser.cjs` | 用本机 Chrome/Edge 自动执行、截图和检查 Canvas 像素 |
| `summarize.cjs` | 汇总原生/浏览器实际结果，交叉比较读回哈希 |
| `toolchain-lock.json` | 实测工具版本、UE 提交与下载包 SHA256 |
| `build-web-ubt.ps1` | 编译隔离 UBT，验证 Web SDK，执行编译/归档/链接及普通 Core Program 的 Node/浏览器验证 |
| `web-ubt/` | 隔离 UBT 工程和测试专用动作执行模式 |
| `verify-web-ubt.cjs` | WASM、动作依赖、头文件依赖、Node/Chrome/Edge 计算及 SDK 缺失拒绝 |
| `prepare-web-core-host.ps1` | 将目标 5.8.3 Core/TraceLog/ApplicationCore/CoreUObject/Launch/AtomicQueue 复制到隔离宿主，补齐 UHT 配置并核验源码、着色器与 DotNet 联接 |
| `web-core-types.cpp` / `verify-web-core-types.cjs` | 真实 UE 核心类型头的 wasm64、布局与高位参数测试 |
| `web-core-services.cpp` / `verify-web-core-services.cjs` | 链接普通 Target 的真实 Core 字符串对象，Node/Chrome/Edge 验证 7 组基础服务 |
| `build-web-blake3.ps1` / `web-blake3.c` / `verify-web-blake3.cjs` | 构建引擎自带 BLAKE3 portable 静态库，并在 Node/Chrome/Edge 对照三种模式的完整测试向量 |
| `build-web-libpng.ps1` / `web-libpng.c` / `verify-web-libpng.cjs` | 构建引擎自带同版 libPNG，核对头/配置，验证像素/元数据往返及损坏数据拒绝 |
| `verify-web-core-compression-source.cjs` | 五个 Core 文件的桌面/Web 条件 Win64 编译、基线与符号检查 |
| `probe-web-core-target.cjs` | 26 个 Core 对象和入口强制重编、链接对象审计及普通 Target 成功构建验证 |
| `web-core-program.html` / `verify-web-core-program.cjs` | 普通 Target 同一份 JS/WASM 在 Node、Chrome、Edge 执行 6 组真实 Core 检查，包括 Transform FPU |
| `probe-web-application-target.cjs` | 普通 ApplicationCore Program 构建、208 份目标模块源码与隔离副本、平台源码和 WASM 对象哈希审计 |
| `web-application.html` / `verify-web-application.cjs` | canvas 帧回调与真实 UE 消息接口，Chrome/Edge 两视口各 15 项检查 |
| `probe-web-engine-target.cjs` | Engine Target 的 UHT、十个关键源码强制编译、FEngineLoop 方法定义和源码/对象哈希；完整链接另由 `build-web-engine.ps1` 验证 |
| `prepare-web-cook-host.cjs` | 独立原生 Cook 主机、Web/47 静态平台表和目标 DDPI；不代表完整源码引擎构建 |
| `cook-web-engine.ps1` / `stage-web-engine.cjs` | 分别执行 NullRHI 与 WebGPU Cook/Stage，保留真实 Shader 库、二进制文件包和哈希清单；WebGPU 完整 Cook 待通过 |
| `web-engine.html` / `verify-web-engine.cjs` | 完整产物审计、九份配置与 Cook 数据的 MEMFS 挂载；Chrome/Edge 真正 Init/Tick 及两项资源损坏拒绝检查 |
| `link-web-engine-webgpu.ps1` / `probe-web-engine-webgpu.cjs` | 独立增量链接诊断，记录全部链接输入与选定重编单元；分别报告 NullRHI Tick、浏览器设备创建和硬件启动失败 |
| `verify-web-engine-exclusions.cjs` | 当前完整目标对象的 SDF/BSD/UDP/补丁限时等待排除、PNG 保留与两个 portable 库的链接输入检查 |
| `build/` | 生成的原生程序、JS/WASM、SPIR-V、WGSL、反射 |
| `results/` | 实测 JSON、日志、截图，包括保留的失败记录 |

## 当前机器复跑

PowerShell 7，工作目录 `H:\ue_html`。本机依赖已下载到 `.tools`，没有永久修改系统 EMSDK。

WebGPU Shader Cook 的当前诊断命令：

```powershell
.\tests\web-platform\cook-web-engine.ps1 -Mode WebGPU-SM5 -StopOnShaderError
```

当前预期因真实 Shader 转换错误退出 3，报告 `web-engine-webgpu-cook-results.json` 仍为 false。`-StopOnShaderError` 只缩短诊断等待，不使失败通过；省略它会等待整批编译汇总错误。只有完整 Cook 通过后才能继续：

```powershell
node .\tests\web-platform\stage-web-engine.cjs --webgpu
node .\tests\web-platform\probe-web-engine-webgpu.cjs --incremental --shader-cook
```

浏览器内容选择参数为 `cook=webgpu`；当前没有成功 WebGPU 内容包，不能用这个参数宣称已验证挂载。基础样本 Worker 在重建插件后须重新应用其原有 WebGPU/46/47 静态平台表；标准 WebGPU Cook 使用另一套 Web/47 主机，不能混用。

已有完整 Engine WASM 产物时，复跑本轮无渲染启动检查：

当前 WebGPU 接入正在使用独立增量诊断，不能直接把旧完整构建报告当作当前源码通过。其复跑命令为：

```powershell
.\tests\web-platform\link-web-engine-webgpu.ps1
$env:NODE_PATH = 'C:\Users\wap80\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node .\tests\web-platform\probe-web-engine-webgpu.cjs --incremental
```

第一步要求本轮模块与必要 Engine 合并单元已编译；修改源码后应先重编对应单元，单纯链接不会补编。后一步硬件未完成时退出 1，报告分别保留 NullRHI 和 WebGPU 结果。当前网页硬件诊断为 `http://127.0.0.1:8765/web-engine.html?rhi=webgpu&incremental=1`，无渲染回归为 `rhi=null`。当前完整普通 UBT 构建仍需补验收。下列完整验收流程仅在报告与当前源码匹配时使用：

```powershell
.\tests\web-platform\cook-web-engine.ps1
node .\tests\web-platform\stage-web-engine.cjs
$env:NODE_PATH = 'C:\Users\wap80\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node .\tests\web-platform\verify-web-engine.cjs
```

最后一步要求下述 localhost:8765 服务已运行。网页为 `http://127.0.0.1:8765/web-engine.html`。当前是 NullRHI 检查页，画布不会显示场景；验证结果显示 ready 和真实 Tick 帧数。`-SkipBuild` 仅可在 Cook 主机模块已编译后使用。完整渲染场景和 UAT 发布链路仍待接入。

```powershell
Set-Location H:\ue_html
& .\tests\web-platform\build-native.ps1
& .\tests\web-platform\build-web.ps1
& .\tests\web-platform\build-shaders.ps1
```

浏览器测试要求本机服务可用。服务默认监听 `0.0.0.0:8765`，本机仍可访问 `127.0.0.1:8765`，启动日志同时列出网卡地址。服务停止后可在独立终端运行：

```powershell
node .\tests\web-platform\serve.cjs
```

当前物理网卡地址为 `10.1.1.200`，同一局域网设备可访问 `http://10.1.1.200:8765/build/ue-default-template/index.html`。IP 变化时以启动日志中的物理网卡地址为准；`HOST`、`PORT` 环境变量可覆盖监听地址和端口，例如设置 `$env:HOST='127.0.0.1'` 可恢复仅本机访问。

局域网 HTTP 地址不是安全上下文，直接访问时 WebGPU、`crypto.subtle` 和跨源隔离不可用。仅用于局域网开发测试时，可在测试设备的 Chrome 打开 `chrome://flags/#unsafely-treat-insecure-origin-as-secure`，在 **Insecure origins treated as secure** 中填入完整来源 `http://10.1.1.200:8765`，选择 **Enabled** 后重启浏览器。Edge 使用对应的 `edge://flags/#unsafely-treat-insecure-origin-as-secure`。配置只填写来源，不包含页面路径；正常分发应使用受设备信任的 HTTPS。此方式来自 [Chrome WebGPU 故障排查文档](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips)；测试设备还需支持当前包使用的 WebGPU 和 wasm64。

独立包会在加载引擎前检查安全上下文、WebGPU、跨源隔离和 Web Crypto；条件不满足时显示具体原因和当前来源的配置步骤，不下载引擎与大资源包。局域网回归命令为 `node tests/web-platform/probe-web-lan.cjs --origin=http://10.1.1.200:8765`，需先设置下方的 `NODE_PATH`。它检查本机/局域网资源响应头、双浏览器未信任来源的明确提示，以及信任后真实渲染和 Pawn 移动；不会修改用户浏览器配置。报告写入 `results/web-lan-results.json`，本机对网卡地址的验证不能替代其他设备的实际连通测试。

自动化使用本机已经具备的 Playwright 和 pngjs；它们位于 Codex 的共享依赖目录：

```powershell
$env:NODE_PATH = 'C:\Users\wap80\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node .\tests\web-platform\run-browser.cjs
$env:P0_RESULTS = 'shader-browser-tier2-results.json'
node .\tests\web-platform\run-browser.cjs shaders

$env:P0_BROWSER = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$env:P0_RESULTS = 'edge-results.json'
node .\tests\web-platform\run-browser.cjs
$env:P0_RESULTS = 'shader-edge-tier2-results.json'
node .\tests\web-platform\run-browser.cjs shaders
node .\tests\web-platform\summarize.cjs
```

默认 GPU 测试使用浏览器默认 Device limits，没有启用实验性浏览器开关。线程版本编译为 `PROXY_TO_PTHREAD`，GPU 测试同时传递 OffscreenCanvas；服务的隔离响应头使 SharedArrayBuffer 可用。Shader 测试单独显式请求 `texture-formats-tier2`。

复现 Shader 的能力差异：

```powershell
$env:P0_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:P0_RESULTS = 'shader-browser-default-results.json'
$env:P0_SHADER_FEATURES = 'default'
node .\tests\web-platform\run-browser.cjs shaders

$env:P0_RESULTS = 'shader-browser-tier1-results.json'
$env:P0_SHADER_FEATURES = 'tier1'
node .\tests\web-platform\run-browser.cjs shaders
Remove-Item Env:P0_SHADER_FEATURES
```

这两次命令预期退出码为 1：本例的 `rgba32float/read_write` 在默认 Device 和 tier1 Device 上被 GPU 校验拒绝。它们是保留的能力差异证据，不能混入 tier2 的通过统计。

可在浏览器打开：

```text
http://127.0.0.1:8765/?variant=gpu64-thread
http://127.0.0.1:8765/shaders.html
http://127.0.0.1:8765/shaders.html?features=default
```

窄屏测试只是 Windows 浏览器的 390×844 视口；不是 Android/iOS 真机兼容测试。工具脚本目前按本机 VS 2026 路径配置，跨机器使用需对应修改路径。

## P1：真实 UE Global Shader 环境

P0 的精简 include 测试保持独立。P1 工程位于 `tests/ue-shader-host`，通过本机安装的 UE 5.8.0 构建 Editor commandlet，在进程内调用真实 GlobalShader 编译环境和 Vulkan `IShaderFormat`。本节保留独立转换基准；后续 WebGPUShaderFormat/真实 Worker 测试见文末。

输入 Shader/include 按 Git blob 比较目标 `html` 分支的固定 5.8.3 提交，仅统一 CRLF/LF。本批依赖闭包 47 个文件全部一致；generated uniform 和平台编译环境来自 5.8.0 主机，不能据此宣称目标分支整引擎已经编译。

```powershell
& .\tests\web-platform\build-ue-shaders.ps1 -Engine H:/UE_5.8

$env:NODE_PATH = 'C:\Users\wap80\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:P0_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:P0_SHADER_FEATURES = 'tier2'
$env:P0_RESULTS = 'ue-full-chrome-results.json'
node .\tests\web-platform\run-browser.cjs ue-shaders

$env:P0_BROWSER = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$env:P0_RESULTS = 'ue-full-edge-results.json'
node .\tests\web-platform\run-browser.cjs ue-shaders
node .\tests\web-platform\summarize.cjs
```

打开 `http://127.0.0.1:8765/ue-shaders.html` 可以运行同一批测试。55 个 Shader module 校验、50 次 pipeline 创建，每次通过时逐项核验 475,904 个数值。2 个额外 Shader 只验证 module，没有单独执行对应 pipeline。

56 个原始 Shader 中，40 个直接转换，15 个 typed-buffer Clear Shader 和 1 个数组层输出 VS 拒绝。额外 15 个 Clear 降级实验使用 UE 自带 `RESOURCE_TYPE=4` 分支，并把线程组 X 定为 64；降级前后 UE ParameterMap 保持一致，WGSL 变为 storage buffer。这个适配仅覆盖本批 Clear，不代表任意 typed-buffer SRV/UAV、格式视图或整引擎 dispatch 已完成。

| 文件 | 用途 |
| --- | --- |
| `../ue-shader-host/` | 真实 UE 编译环境、Vulkan 字节码反序列化、SPIRV-Reflect、`--strip-reflect` |
| `prepare-ue-shaders.cjs` | 比较安装 Shader 与目标分支 blob，生成校验清单 |
| `build-ue-shaders.ps1` | 输入校验、构建工程、运行 commandlet、转换 WGSL |
| `convert-ue-shaders.cjs` | Tint、绑定类型与成员偏移核对、降级合约核对、manifest |
| `ue-shader-runtime.js` | 按真实 UE ParameterMap 装填 Uniform、绑定资源、GPU 读回 |
| `results/ue-full-shader-build-results.json` | 编译、反射、47 个 include 与编译器 DLL SHA256 |
| `results/ue-full-chrome-results.json` / `ue-full-edge-results.json` | 四组最终通过记录和截图 |
| `results/ue-full-chrome-default-results.json` | 默认 Device 的 15 项预期读写纹理拒绝 |
| `results/ue-full-*-dispatch-failure-results.json` | 修正无 Bounds LargeBuffer 调度前的失败记录 |

默认 Device 的拒绝可复现：

```powershell
$env:P0_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:P0_SHADER_FEATURES = 'default'
$env:P0_RESULTS = 'ue-full-chrome-default-results.json'
node .\tests\web-platform\run-browser.cjs ue-shaders
```

这条命令预期退出 1，记录 RGBA32Float/Uint/Sint 读写 storage texture 的 capability 拒绝。正式成功测试请求 `texture-formats-tier2`。实际 Web 平台还需 capability gate 或编译器证明后的只写访问降级。

GlobalShader 的完整结论见 `H:/ue_html/UE58_P1_TEST_RESULTS.md`。后续 LocalVertexFactory/material 测试见下节；Win64 WebGPURHI 核心探针见末节，Web UBT/Cook 或完整 UE 网页场景尚未完成。UMG 依赖没有改动。

## P1：真实材质图和 LocalVertexFactory

`MaterialProbe` 在 UE 中构造 Unlit 颜色参数和纹理参数材质图，运行真实材质翻译、Mobile BasePass VS/PS 与 LocalVertexFactory 编译环境。Numeric Uniform 数据由 UE `FUniformExpressionSet::FillUniformBuffer` 求值，包含默认值和自定义 RenderProxy 参数覆盖；只导出数值数据，不把主机 RHI 指针写入浏览器文件。

此轮使用目标 5.8.3 提交的完整 Shader 快照：1,191 个文件按 Git blob 核对，18 个与安装版本不同的文件从目标提交缓存中提取。材质样本的保守 include 闭包 188 个文件全部匹配。材质翻译器、generated 环境、编译器仍来自安装的 UE 5.8.0 主机。

```powershell
& .\tests\web-platform\build-ue-material.ps1 -Engine H:/UE_5.8

$env:NODE_PATH = 'C:\Users\wap80\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:P0_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:P0_RESULTS = 'ue-material-chrome-results.json'
node .\tests\web-platform\run-browser.cjs ue-material

$env:P0_BROWSER = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$env:P0_RESULTS = 'ue-material-edge-results.json'
node .\tests\web-platform\run-browser.cjs ue-material
node .\tests\web-platform\summarize.cjs
```

打开 `http://127.0.0.1:8765/ue-material.html` 可运行同一批测试。浏览器只请求默认 Device，未请求 tier2 或使用实验开关。两个材质、两个 VF profile、VS/PS 共 8 个 Shader，绑定合约全部通过。四组浏览器运行每组创建 5 个 pipeline，执行 31 次 draw，核验 1,835,008 个数值。

验证 uint16/uint32 索引、颜色参数覆盖、纹理 UV、PreExposure、模型变换、视图投影、LWC 高低部分抵消、Native profile 的 instance index、reversed-Z 深度遮挡，以及 4 个 MRT 的颜色读回。

这是使用真实 UE 材质 Shader 的独立网格探针：顶点/索引由测试程序提供，模型和视图 Uniform 由测试程序按 UE 反射装填。它尚未经过 UE StaticMesh 资源加载、MeshDrawCommand 或 Cook；没有完整 UE 场景 Runtime。

`build-ue-material.ps1` 需要 `-AllowCommandletRendering`。`NullRHI` 会跳过共享采样器初始化，而完整 `FillUniformBuffer` 包含 RHI 资源求值，不能在该上下文直接调用。开启主机渲染只服务于测试数据生成；浏览器中的图像由本地 WebGPU 渲染。

| 文件 | 用途 |
| --- | --- |
| `../ue-shader-host/Source/UEShaderHost/Private/MaterialShaderProbe.cpp` | 材质图、Preshader、VF/permutation 环境和真实编译 |
| `prepare-material-shaders.cjs` | 提取并校验目标分支 Shader 快照 |
| `build-ue-material.ps1` | 构建、运行材质 commandlet、转换与核对 |
| `convert-ue-material.cjs` | Uniform padding、ParameterMap、资源表 token、WGSL 绑定核对 |
| `ue-material-runtime.js` | 索引网格、Uniform、纹理、4 MRT 和深度读回 |
| `results/ue-material-build-results.json` | 8 个 Shader、188 个 include、资源绑定和数值文件 SHA256 |
| `results/ue-material-chrome-results.json` / `ue-material-edge-results.json` | 四组运行结果与截图 |

结果及下一步接入位置见 `H:/ue_html/UE58_P1_MATERIAL_TEST_RESULTS.md`。

## P1：WebGPUShaderFormat 与独立 Worker

新增插件 `../ue-shader-host/Plugins/WebGPUShader` 实现 `IShaderFormat`，输出带版本、反射、UE ParameterMap/SRT 和 WGSL 的二进制字节码。原始安装版 ShaderCompileWorker 加载独立 DLL，执行真实批量任务协议；浏览器直接解析返回的 `.webshader` 文件。

```powershell
& .\tests\web-platform\build-ue-webformat.ps1 -Engine H:/UE_5.8

$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
$env:P1_SHADER_SOURCE = 'worker'
$env:P0_SHADER_FEATURES = 'tier2'
$env:P0_BROWSER = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
$env:P0_RESULTS = 'ue-webformat-chrome-results.json'
node .\tests\web-platform\run-browser.cjs ue-shaders ue-material
$env:P0_BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
$env:P0_RESULTS = 'ue-webformat-edge-results.json'
node .\tests\web-platform\run-browser.cjs ue-shaders ue-material
node .\tests\web-platform\summarize.cjs
```

页面入口 `http://127.0.0.1:8765/ue-material.html?source=worker` 和 `http://127.0.0.1:8765/ue-shaders.html?source=worker`。省略 source 保留既有独立转换路径；自动化用 `P1_SHADER_SOURCE=standalone` 切回。

79 个 Worker 任务核对通过，其中 63 个成功字节码、16 个明确不支持诊断。版本负向测试返回 code 3/2；字节码解码执行 252 个负向测试。Chrome/Edge 两个页面、两个视口共 8/8 通过；原有页面另外 8/8 回归通过。

安装版 UBT 不支持 Program target；构建脚本使用 UBT 生成的 include/toolchain 参数和安装 Worker 导入库编译 Program flavor DLL，在工作区隔离目录运行。原始 Worker executable 未修改，DLL 无 Editor 导入。尚未在目标 5.8.3 全源码 Worker target 上构建。

主机格式注册已接通：`WebGPUShaderHostTargetPlatform` 通过 `DefaultEditor.ini` 的 `CustomTargetPlatforms` 提示两个 Web 格式，并配套主机 DeviceProfile。探针现在使用官方格式发现、`PreprocessShader`、输入哈希和 `WriteTasks` 版本表，已删除手工版本/哈希适配。有效任务正文原样保留，Zlib 仅是外层协议帧；负向测试仍修改错误版本并验证 Worker 拒绝。完整构建/编译复现与 Chrome/Edge 8/8 浏览器测试再次通过。

`WebGPUShaderHost` 明确禁用 Cook、打包和运行时构建；本节原有测试的 Shader 平台环境仍为原生 Vulkan。完整边界、协议见 `H:/ue_html/UE58_P1_SHADERFORMAT_TEST_RESULTS.md`。独立 Web ShaderPlatform 的隔离接入见下节，Web UBT/Cook 和 RHI 尚未完成。

## P1：独立 Web ShaderPlatform 与 DDPI

新增 `SP_WEBGPU_ES31=46`、`SP_WEBGPU_SM5=47` 的静态名字表与能力配置。使用真实 UBT `AddPlatformStaticShaders` 生成表，在工作区隔离 Editor/Worker 中编译加载；其他 BuildSettings 函数转发到保留的原版 DLL，其他主机模块仍为安装版 5.8.0。没有覆盖安装引擎或完成目标 5.8.3 整引擎源码构建，也没有注册完整 Web UBT factory/toolchain。

GlobalShader 的真实环境改用 Web SM5，材质/VF 的真实环境改用 Web ES31。对外 Target 保持 Web 枚举，离线前端复用 Vulkan 编译生成 SPIR-V，最终格式输出 WGSL。字节码 metadata 和缓存版本包含 DDPI 属性哈希；浏览器逐包验证平台与 manifest 一致。

```powershell
& .\tests\web-platform\build-ue-platform.ps1 -Engine H:/UE_5.8

$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
$env:P1_SHADER_SOURCE = 'platform'
$env:P0_SHADER_FEATURES = 'tier2'
$env:P0_BROWSER = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
$env:P0_RESULTS = 'ue-platform-chrome-results.json'
node .\tests\web-platform\run-browser.cjs ue-shaders ue-material
$env:P0_BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
$env:P0_RESULTS = 'ue-platform-edge-results.json'
node .\tests\web-platform\run-browser.cjs ue-shaders ue-material
node .\tests\web-platform\summarize.cjs
```

入口 `http://127.0.0.1:8765/ue-material.html?source=platform` 和 `http://127.0.0.1:8765/ue-shaders.html?source=platform`。79 个任务、63 个包、16 个明确拒绝全部符合预期，8/8 浏览器运行通过；252 个包损坏检查、252 个平台混用检查和 2 个缺配置检查通过。原有 Worker / standalone 页面分别 8/8 回归通过。

`build-ue-webformat.ps1` 会把隔离 Worker 恢复成 stock 映射；重新运行独立平台编译前执行 `build-ue-platform.ps1`。三套浏览器产物互不覆盖。

`results/summary.json` 的 `p1IndependentShaderPlatformProbePass` 和 `webShaderPlatformMappingVerifiedInIsolatedHost` 记录隔离主机验证；`fullSourceEngineBuildCompleted`、`webRuntimeShaderPlatformRegistered`、`webCookPackagingImplemented` 仍为 false。完整结果和复现边界见 `H:/ue_html/UE58_P1_SHADERPLATFORM_TEST_RESULTS.md`。

## P2：Win64 WebGPURHI 核心、材质与状态探针

截至 2026-10-15 第十四批，P2 累计 1,236/1,236 项、75 draw / 149 dispatch、917 finalize/submit、1,697,120 个核验值通过。后续最小启动保留原顶点缓冲、略过未使用资源，并延后状态校验。距离场默认缓冲和消费路径现已在目标源码按 Web 条件排除，通过双分支 Win64 单文件编译；尚未链接，旧宿主仍停在 FDFDummyByteAddress。完整引擎及浏览器 UE Runtime 尚未启动；下文保留各批次历史，最新范围见 [P2 报告](H:/ue_html/UE58_P2_RHI_TEST_RESULTS.md)。

2026-10-15 范围调整：优先让静态网格、基础 Unlit 颜色/二维贴图材质、相机与输入、Cook 资源加载组成的最小 UE 场景在浏览器运行，再接 HTML UI。数组纹理、材质层及其他未使用功能按需再做。默认初始化阻塞先核对消费者和 Web 条件禁用位置，确认无法绕过才补最小依赖；不以通用 RHI 功能齐全作为进入 WASM 的前置条件。已有测试保留，历史批次中的后续计划以此调整为准。

新增 Runtime 模块实现自己的 `FDynamicRHI` / `IRHICommandContext`，通过实际 UE 资源、参数和命令列表执行离屏绘制、计算和复制。六个 Shader 来自独立 Web SM5 Worker 字节码，GPU 为 Native Dawn D3D12；宿主全局 RHI 仍为 Null。

```powershell
& .\tests\web-platform\build-ue-rhi.ps1 -Engine H:/UE_5.8
node .\tests\web-platform\summarize.cjs
```

脚本构建 Dawn C API DLL，全量复现 P1、刷新隔离 Editor/Worker，再运行 RHI commandlet 和独立像素核验。25/25 检查，19 draw / 2 dispatch，29 finalize / submit，164,352 个数值通过；GPU validation 无错误。覆盖索引、Uniform/loose 参数快照、纹理更新与复制顺序、scissor、reversed-Z、混合、颜色写入掩码、UAV 子范围、计算与缓冲复制，以及错误输入拒绝。

第二批新增真实材质资源表：按 UE `bufferIndex` 区分多个 Uniform，验证实际布局哈希，通过 TextureMap / SamplerMap token 解析材质纹理和采样器。材质布局由 UE 导出，数值仍来自 `FillUniformBuffer`；View / Primitive 的实际 C++ 成员偏移与 Shader 反射逐项核对。两个 Web ES31 材质、四个 Shader、两个 PSO，采用两/三个 float 顶点流，完成四 MRT 离屏绘制。新增 32/32 检查、19 draw、1,114,112 个通道值，覆盖常量/纹理引用更新和资源寿命。两批合计 57 项、38 draw / 2 dispatch、115 finalize / submit、1,278,464 个数值通过。

第三批新增 Buffer / Texture 访问状态和单 Graphics 队列 transition，覆盖 RTV / SRV / Copy / UAV 复用、跨 submit 的 split Begin/End、批量原子拒绝、深度写转只读、资源寿命及提交顺序。49/49 检查通过，新增 5 draw / 3 dispatch、66,056 个数值；三批合计 106 项、43 draw / 5 dispatch、130 finalize / submit、1,344,520 个数值，GPU validation 无错误。24 个 transition 创建、Begin、End、释放数量一致，未完成项为 0。

`results/ue-rhi-build-results.json` 记录结果和各项 SHA256，`results/ue-rhi-indexed-64x64.png`、`ue-rhi-UnlitColor-64x64.png`、`ue-rhi-UnlitTexture-64x64.png`、`ue-rhi-transition-sampled-64x64.png` 来自真实读回。材质 PNG 为便于查看将 alpha 显示为不透明，原始 RGBA 保留 Shader 输出的 alpha=0。`p2CoreRHIProbePass`、`p2MaterialRHIProbePass`、`p2TransitionRHIProbePass` 分别记录三批；`p2Complete`、`globalWebGPURHIReplaced`、`completeBrowserUERuntime` 保持 false。

材质探针只测试 `WebVertexInput` 编译配置的 LocalVertexFactory Shader 和显式 UE 顶点流，未接入完整 `FLocalVertexFactory` 对象、MeshDrawCommand。原生配置的 BatchedPrimitive Uniform View、SRT 的 SRV/UAV、活跃共享 Wrap/Clamp sampler Shader 尚未验证。第三批 transition 的 UE 分配/marker cleanup 通过 NullRHI，本地后端创建/释放由探针显式适配；第四批另行验证全局调用。异步队列/aliasing/高级 flags 明确拒绝。模块 `IsSupported()` 暂时禁用完整引擎选择；不应使用 `-rhivalidation` 或 ImportedRHI 把本批探针当作完整后端。UMG / Slate 依赖保持原样。完整报告见 `H:/ue_html/UE58_P2_RHI_TEST_RESULTS.md`。

第四批新增 `-WebGlobalRHIProbe`，在独立进程中从模块工厂创建 RHI，临时接管 `GDynamicRHI`，真正使用 UE 全局资源入口、PSO cache、命令 executor 和 transition private storage / 自动释放。记录模式与 bypass 各 22/22 项，新增 44 项、12 draw / 4 dispatch、132,096 个数值；普通非 recursive 命令列表排队后的覆盖顺序、读回后继续绘制、帧结束和宿主恢复均验证。四批累计 150 项、55 draw / 9 dispatch、1,476,616 个数值，GPU validation 无错误。

第四批新增结果为 `results/ue-rhi-global-build-results.json`、`build/ue-rhi-global/global-rhi-results.json`；两个全局模式的采样 RGBA 及 PNG 哈希一致。`p2GlobalDispatchProbePass` / `temporaryGlobalWebGPURHIDispatchVerified` 表示临时接管成功。第三批本地探针仍通过 NullRHI 分配 marker，第四批独立验证全局分配/释放。

第五批新增 `-WebViewportRHIProbe`：真实 RenderResource 的 Init/Update/Release/重新初始化、ResourceArray 上传与 Discard、3×2 RGBA8/BGRA8 texture initializer，以及隐藏 HWND 的 Dawn surface 取帧、绘制、呈现、缩放、跳过与恢复。两个模式各 36 项，新增 72/72、8 draw、143,976 个核验值；五批累计 222/222、63 draw / 9 dispatch、1,620,592 个核验值。GPU validation 无错误，Chrome/Edge 桌面及移动视口 8/8 回归通过。surface 检查覆盖实际 present API 和读回，没有验证可见桌面扫描输出或浏览器 canvas。

当前一键脚本编译六个 Buffer Shader（四个引擎分支、两个测试专用），再运行十个正向 RHI commandlet 和各自 Node 验证，最后执行 `probe-ue-rhi-startup.cjs`。隔离 `WebGPUEngine.ini` 配置 ImportedRHI，默认禁止选择模块，显式 `-WebRHIStartupProbe` 才允许 SM5 实验。当前真实启动停在三维 BGRA8 纹理的 BulkData 初始化，退出 3；诊断核对默认 views、白色 RDG Buffer Lock/Unlock 和确切纹理描述，不计入正向通过项。

第五批产物为 `results/ue-rhi-viewport-build-results.json`、`build/ue-rhi-viewport/viewport-rhi-results.json` 和八份 surface RGBA/PNG。`p2ViewportRHIProbePass` / `nativeWebGPUSurfacePresentationVerified` / `webGPURenderResourceLifecycleVerified` 为 true；`importedWebGPUModuleSelectionVerified=true`，`importedWebGPURHIStartupVerified=false`。完整 RHIInit、Renderer、WASM、Cook 和浏览器场景仍未完成。构建工具访问冲突的 CPU 亲和性限制复现命令见完整 P2 报告。

2026-10-15 第六批新增 `-WebTextureSRVProbe`：二维单 mip/layer 线性 RGBA8/BGRA8 的默认/显式 TextureSRV、真实 Shader 直接绑定、纹理与 view 的引用生命周期、直接 Texture 重新绑定、录制与 bypass、状态/反馈/范围拒绝。两个模式各 37 项，新增 74/74、12 draw、12,288 个通道值；六批累计 296/296、75 draw / 9 dispatch、1,632,880 个核验值。原始 `FScreenVS` / `FScreenPS` 对四色及不同 alpha 纹理的十二份读回逐像素一致，GPU validation 无错误。

结果为 `build/ue-rhi-texture-srv/texture-srv-results.json`、`results/ue-rhi-texture-srv-build-results.json` 及十二份 RGBA/PNG，独立验证器为 `verify-ue-rhi-texture-srv.cjs`。`p2TextureSRVProbePass` / `webGPUTextureSRVDirectBindingVerified` 表示直接纹理 SRV 范围通过；SRT SRV/UAV 和 Uniform View 仍未实现。第六批真实启动已通过 `FWhiteTexture` / `FBlackTextureWithSRV` / `FBlackTexture` 的三个 SRV，当时停在 R32_UINT Typed BufferSRV；第七批继续推进，见下段。

第六批一键构建退出 0，四份原生独立验证合计 296 项全部通过；Chrome/Edge 既有独立 Shader 页面在桌面及移动视口 8/8 回归通过。

2026-10-15 第七批新增 `-WebBufferShaderProbe` / `-WebBufferSRVProbe`：Typed R32_UINT BufferSRV 通过反射的只读 uint32 storage array 绑定，支持默认全缓冲与对齐子范围。Shader 来自原始 `ByteBuffer.usf` 的已有 Structured 分支，经真实 Worker IPC 编译，45 个 include 与目标提交核对；Worker/Editor 字节码、原始参数表和独立 Tint 输出一致。新增只读/元素类型反射并更新格式缓存版本。

两模式各 38 项，新增 76/76、8 dispatch、3,072 个 uint32 核验值；七批累计 372/372、75 draw / 17 dispatch、347 finalize / submit、1,635,952 个核验值。覆盖子范围和哨兵、CopyBufferRegion 更新后的读取、只读源保持、资源引用寿命、录制执行次序、访问状态和无效描述拒绝。结果为 `results/ue-buffer-shader-build-results.json`、`results/ue-rhi-buffer-srv-build-results.json`，独立验证器 `verify-ue-rhi-buffer-srv.cjs` 逐项核对十二份二进制读回。

`p2BufferSRVProbePass` / `webGPUTypedR32UintStorageSRVVerified` 只表示这一明确表示通过，通用 HLSL `Buffer<T>` lowering 仍未实现；DDPI 的 `SupportsTypedBufferSRVs` 保持 false，既有 Typed clear 拒绝项不变。第七批启动创建 `EmptyVertexBuffer` 的 SRV（stride=4 / count=4），当时停在同一资源的 Typed BufferUAV；第八批继续推进，见下段。完整预初始化、Renderer、WASM、Cook 和浏览器场景仍未完成，`startupSucceeded=false`。

第七批最终一键构建和 `summarize.cjs` 均退出 0，五份 RHI 独立验证合计 372 项通过；Chrome/Edge 的既有独立 Shader 页面在桌面/移动视口 8/8 回归通过。新增 BufferSRV 在原生宿主测试，没有将 UE Runtime 编译成 WASM。

2026-10-15 第八批新增 `-WebBufferUAVProbe`：R32_UINT Typed UAV 规范化全缓冲与对齐子范围，严格匹配可写 uint32 storage 反射，使用真实 UE `FMemsetBufferCS` / `FMemcpyCS` Worker 包执行写入。既有 Structured UAV 路径保留；两个 Buffer Shader 各核对 45 个目标 include、原始参数表、Editor/Worker 字节码与独立 Tint 输出。

两模式各 41 项，新增 82/82、12 dispatch、3,584 个 uint32 值；八批累计 454/454、75 draw / 29 dispatch、395 finalize/submit、1,639,536 个核验值，GPU validation 无错误。覆盖写入顺序、子范围哨兵、UAV→SRV 可见性、复制保留早期数据、释放调用方引用后的写入，以及状态/反射/范围拒绝。`verify-ue-rhi-buffer-uav.cjs` 独立比较十四份二进制读回；结果为 `results/ue-rhi-buffer-uav-build-results.json` 和 `build/ue-rhi-buffer-uav/buffer-uav-results.json`。

`p2BufferUAVProbePass` / `webGPUTypedR32UintStorageUAVVerified` 表示这一 storage 表示通过，通用 `RWBuffer<T>`、其他 Typed 格式和 SRT UAV 仍未实现。启动已创建 `EmptyVertexBuffer` 的 SRV/UAV，下一处阻塞为 `EmptyUInt4VertexBuffer` 的 `PF_R32G32B32A32_UINT` SRV（format=48），完整启动仍未成功。

第八批一键构建和汇总均退出 0，六份原生独立验证合计 454 项通过；Chrome/Edge 桌面/移动视口 8/8 回归通过。新增 UAV 仍在原生宿主验证，浏览器只运行既有独立 Shader 页面。

2026-10-15 第十一批新增 `-WebFloat4Probe`：在第九批 uint4、第十批 Structured views 的基础上，支持 Typed `PF_A32B32G32R32F` 的格式反射、规范化和直接绑定。两个明确标记的测试专用 float4 Shader 经 UE/Worker 编译，分别核对 43 个目标引擎 include 和一个测试文件、真实参数表、Editor/Worker 字节码及独立 Tint 输出。通用 `Buffer<T>` / `RWBuffer<T>` lowering 仍未实现。

recorded/bypass 各 41 项，新增 82/82、12 dispatch、53 finalize/submit、16,384 个有限浮点核验值；覆盖四分量乘加、子范围填充、底层更新、UAV→SRV 可见性、调用方释放资源后的读写及格式/状态/范围拒绝。独立验证器为 `verify-ue-rhi-float4.cjs`，输出 `results/ue-rhi-float4-build-results.json`；`p2Float4ViewsProbePass=true`。全量构建与汇总退出 0，前十批回归通过，Chrome/Edge 既有页面 8/8 回归通过。

真实启动新增创建 `BlackFloat4VertexBuffer` 的 SRV/UAV、`WhiteVertexBuffer` 与 `BlackVertexBuffer` 的 SRV，当前阻塞为 Buffer Lock。下一步实现 Lock/Unlock 的上传与排队顺序；预初始化、Renderer、WASM、Cook 和完整浏览器场景仍待接入。

2026-10-15 第十二批新增 `-WebBufferLockProbe`：实现四字节对齐 WriteOnly Buffer Lock/Unlock，以独立 staging copy 保留命令顺序；原生 ReadOnly 先提交较早命令并同步复制/map 真实 GPU 数据。活动锁保留 Buffer，锁定期间拒绝 GPU 访问/transition；NoOverwrite、未对齐范围和浏览器同步读锁尚未接入。

recorded/bypass 与 UE 写锁缓存开/关共四组，各 40 项，新增 160/160、4 dispatch、108 finalize/submit、7,296 个值。覆盖更新前快照、部分及重叠更新、GPU 写后读锁、只读 CPU 修改不回写、Index16 Buffer、独立资源同时锁定和引用寿命。`verify-ue-rhi-buffer-lock.cjs` 独立核对三十二份二进制读回；结果为 `results/ue-rhi-buffer-lock-build-results.json`，`p2BufferLockProbePass=true`。全量构建与汇总退出 0，已有原生和浏览器 8/8 回归通过。

真实启动已编码 `WhiteVertexBufferWithRDG` 的 16 字节 WriteOnly 上传，下一处阻塞为 Texture3D/BGRA8/BulkData，描述 `dimension=2 format=2 extent=1x1 depth=1 array=1 mips=1 samples=1 init=1 flags=0x8`。该启动尝试尚未提交/回读白色 RDG Buffer；单独 GPU 探针核验上传正确性，完整预初始化和引擎启动仍未完成。

2026-10-15 第十三批新增 `-WebTexture3DProbe`：支持单 mip 线性 RGBA8/BGRA8 三维纹理、BulkData 快照/Discard、Initializer 和 Texture3D SRV；ShaderFormat v7 反射并校验 sampled texture 的维度。两个测试专用 Shader 经 UE/真实 Worker 编译，每个核对 44 个 include 与独立 Tint 输出。

recorded/bypass 各 71 项，新增 142/142、48 dispatch、143 finalize/submit、3,552 个值。3×2×3 体素覆盖两个格式、两种初始化、直接/SRV Load、point/clamp/wrap、状态拒绝与资源寿命。`prepare-texture-worker.cjs` 准备包，`verify-ue-rhi-texture-3d.cjs` 独立核对 48 份 uint4 Buffer；结果为 `results/ue-texture-shader-build-results.json` 和 `results/ue-rhi-texture-3d-build-results.json`，`p2Texture3DProbePass=true`。前十二批回归、更新后的启动诊断与汇总通过，Chrome/Edge 既有页面 8/8 回归通过。

真实启动已越过两个 `BlackVolumeTexture3D` 的 BGRA8 BulkData 上传，当前停在 `PF_R8G8B8A8_UINT` 的三维 BulkData 创建，描述 `dimension=2 format=60 extent=1x1 depth=1 array=1 mips=1 samples=1 init=1 flags=0x8`。下一步实现整数体积纹理和 Shader sample 类型验证；数组、立方体、多 mip、完整预初始化/Renderer、WASM/Cook 与浏览器 UE 场景仍未完成。

2026-10-15 第十四批新增 `-WebTextureUintProbe`：支持单 mip RGBA8_UINT 体积纹理的 Default/Initializer/BulkData 和整数 SRV，ShaderFormat v8 反射 textureSampleType，绑定时拒绝 float/uint/sint 不匹配。两个测试专用 Shader 经 UE/真实 Worker 编译和独立 Tint 核对，每个验证 44 个 include，实际执行 uint4 Load 与 GetDimensions。

recorded/bypass 各 60 项，新增 120/120、20 dispatch、59 finalize/submit、1,680 个值。覆盖 3×2×3 各层分量、整数边界值、逆序读取、输出哨兵、默认零、1×1×1 默认资源形状、BulkData Discard 和资源寿命。`prepare-texture-worker.cjs --uint` 生成包，`verify-ue-rhi-texture-uint.cjs` 独立比较 20 份 Buffer；结果为 `results/ue-texture-uint-shader-build-results.json` 和 `results/ue-rhi-texture-uint-build-results.json`，`p2IntegerVolumeProbePass=true`。前十三批、更新后的启动诊断及汇总通过，既有浏览器页面 8/8 回归通过。

真实启动已越过格式为 60 的第三个 `BlackVolumeTexture3D`，当前阻塞为 BGRA8 Texture2DArray Initializer：`dimension=1 format=2 extent=1x1 depth=1 array=1 mips=1 samples=1 init=2 flags=0x8`。下一步核对 `FBlackArrayTexture` 的消费者，优先尝试在 Web 路径禁用最小场景未使用的功能；本次范围调整尚未修改该路径，也未实现数组纹理。完整预初始化、Renderer、UE WASM、Cook/Stage 和浏览器场景仍未完成。

2026-10-15 最小启动裁剪：显式 `-WebRHIStartupProbe -WebMinimalStartup` 在 `InitPreRHIResources` 前注销 `GBlackArrayTexture`、三个默认 Cube、`GBlackCubeArrayTexture` 和 `GBlackUintTexture` 六项资源。仅为安装版宿主的启动验证适配，资源对象保留、RHI 不支持项继续拒绝；没有增加数组/立方体/二维整数纹理功能，实际 Web 源码条件编译与消费者裁剪尚未完成。

首次对照验证不带开关仍停在数组纹理，带开关保留此前默认资源创建/上传并到达 FNullColorVertexBuffer 的 Typed RGBA8 SRV。两种启动仍退出 3，诊断通过不代表启动成功。

2026-10-15 最小启动继续：仅对两个确切的默认顶点缓冲，在 manual vertex fetch / vertex shader SRV 关闭的前提下省略未使用的 RGBA8 SRV；保留原缓冲并逐字节 GPU 读回验证 16 字节全 255、12 字节全 0。状态对象先保存描述，Sampler 在实际绑定时才创建原生对象，PSO/绑定继续拒绝未实现的绘制状态。启动新增创建 FPrimitiveIdDummyBuffer SRV，现停在距离场 FDFDummyByteAddress 的 ByteAddress SRV，没有增加 Raw Buffer。

`node H:/ue_html/tests/web-platform/probe-ue-rhi-startup.cjs` 现验证两种启动对照、顶点缓冲读回标记、已保留默认资源及新增 primitive ID SRV，并用两个独立进程验证线框 PSO / bilinear sampler 在使用时被拒绝。四个进程都要求预期退出 3 和确切错误/调用栈，不计入正向测试数量；`minimalStartup` 记录全部证据。下一步在 Web 源码同时禁用距离场初始化与消费者，并处理 View / LocalVertexFactory / SM5 Uniform 未使用字段。完整 Renderer、WASM、Cook 和浏览器场景仍待接入。

2026-10-15 距离场源码裁剪：目标分支 `FXRenderingUtils.cpp` 的 `PLATFORM_WEB=1` 分支不再编译距离场默认 ByteAddress 类/全局对象及原对象/Atlas 参数绑定。`HasDataToBind` 返回 false，公开接口与元数据保留；空目标指针保持无操作，实际距离场参数绑定明确 Fatal 拒绝。非 Web 沿用原实现，没有增加 Raw Buffer 或距离场功能。

`node H:/ue_html/tests/web-platform/verify-web-renderer-source.cjs` 使用真实 Renderer/RDG 头文件编译完整文件的桌面与 Web 条件分支，并检查预处理代码与对象符号。桌面除诊断路径/行号外与原代码一致，Web 对象不含默认资源及原消费依赖，公开入口仍在。结果为 `results/ue-web-renderer-source-results.json`；一键 RHI 脚本已接入此步骤。当前是安装版 5.8.0 头文件下的 Win64 条件源码验证，尚未链接 Renderer、运行修改后的启动路径或进行 WASM 编译。

后续优先 Web UBT/Emscripten、`PLATFORM_WEB=1` 的真实构建入口和最小 Core/Launch Runtime，不以桌面 Editor 完整启动为前提。默认纹理/顶点 SRV、View/Uniform 消费者裁剪、完整 Renderer、Cook 和浏览器 UE 场景仍待接入；本轮 RHI 插件未变，未重复运行既有 GPU 和浏览器回归。

## P3：Web UBT 与 Core 基础服务

2026-10-15：目标分支 `Engine/Platforms/Web` 已接入 Web/wasm64 注册、SDK 固定及 Emscripten 工具链。真实 5.8.3 的 `Platform.h` 要求 64 位指针，因此编译和链接改用 `-m64`。隔离工程编译安装版 5.8.0 UBT 源码并包含目标 Web 平台文件，真实 UBT action 完成 C++20 编译、静态库归档、JS/WASM 链接并记录 `.d` 依赖。Node、Chrome、Edge 的标准样本结果一致，浏览器再次调用导出函数通过；SDK 缺失按预期拒绝。

新增 `-CoreTypes` 模式编译目标 5.8.3 的真实 `CoreTypes.h`、HAL/GenericPlatform 及 Web 类型头。Node、Chrome、Edge 均验证 8 字节指针/`SIZE_T`、2 字节 `TCHAR`、结构体布局；浏览器 BigInt 调用还验证超过 32 位范围的参数往返。该诊断样本不链接完整 Core。

普通 Core-only Program 由正常 UBT Target 完成编译、链接和 WriteMetadata。同一份 wasm64 在 Node、Chrome、Edge 执行 6 组检查：4096 元素 TArray 的扩缩容与释放、64 字节对齐重分配和内容保持、64KiB 对齐底层分配、中文文件名二进制读写/重命名/删除、根路径与单线程模式，以及新增的 float/double Transform FPU 旋转/缩放/逆变换/组合和高坐标精度。数组校验和为 25,188,352；没有调用 FEngineLoop 或启动场景。

回归脚本另强制重编 23 个关键 Core 文件、3 个 Web 平台实现及入口，覆盖字符串、压缩、内存/容器分配、平台服务、ParkingLot/WordMutex 和任务队列等。真实字符串对象通过 `-CoreObject` 加入既有诊断样本，Node、Chrome、Edge 的 7 组服务、16 字节 `FInt128` 对齐和高位参数回归通过。未启用 128 位原子。zlib 往返和损坏拒绝通过；普通 Program 未调用两份 UE 压缩对象的压缩接口。

```powershell
& H:/ue_html/tests/web-platform/build-web-ubt.ps1
node H:/ue_html/tests/web-platform/summarize.cjs
```

运行前保持 `serve.cjs` 的 localhost:8765 服务可用。`web-ubt-smoke.html` 是标准工具链页面，`web-core-types.html` 是真实核心类型头页面，`web-core-services.html` 是 Core 服务子集页面；新增 `http://127.0.0.1:8765/web-core-program.html` 加载普通 Program 产物的相同哈希副本。均未启动完整 UE Runtime。对应四份 `results/web-*-results.json` 保留结果与哈希；`p3WebToolchainFoundationPass`、`p3CoreTypeHeadersPass`、`p3CoreServicesSubsetPass`、`p3CoreProgramPass` 分别表示各自范围通过。

目标 Core 已按 Web 条件排除 Oodle SDK 依赖、实现与直接消费者。五个完整源码文件的桌面/Web 条件对象编译和符号检查通过，桌面预处理逻辑与固定基线相同；该项使用 Win64/MSVC 和安装版头文件，没有验证 WASM 压缩运行时。结果为 `results/web-core-compression-source-results.json`，汇总标记 `webCoreOodleConditionalSourceVerified`。

普通 `tests/ue-web-smoke/UEWebSmoke.uproject` 使用目标 5.8.3 Core/TraceLog/AtomicQueue，UBT 和其他依赖仍为 5.8.0，不代表 5.8.3 整引擎构建。`probe-web-core-target.cjs` 逐一移除 27 个指定旧对象并重新编译，核对源码、对象、21 个关键覆盖层文件与平台哈希，再执行普通 Target，审计全部 wasm64 链接对象。结果仍保存为 `results/web-core-target-diagnostic.json`，但现要求 `buildSucceeded=true`、`ordinaryProgramLinked=true`、缺失符号为空，退出 0；不再接受预期链接失败。`-WriteOutdatedActions` 只导出当时待构建动作，动作或对象数量不代表功能完成比例。

原 6 类链接依赖已解决：Web 提供 libc 对齐分配/释放和根路径 `/`，Core-only Program 定义项目名，单线程 Web 排除通用 pthread 线程创建分支，并复用目标 Unix 文件实现及平台文件入口。Unix 时间戳转换改用字段实际类型，避免 glibc 私有类型。隔离宿主核验 DotNet 运行时联接以执行 WriteMetadata，没有修改安装引擎。普通产物位于 `tests/ue-web-smoke/Binaries/Web/UEWebSmoke.js` 和 `.wasm`。

当前仍为单线程；pthread TLS/递归锁接口可用不代表 UE 工作线程已接入。UE 分配器基本成功路径已验证，物理内存统计、OOM 和竞争访问尚未验证；文件检查仅覆盖 Emscripten MEMFS，不包括持久化、异步挂载和 mapped-file。Web 关闭 OS 虚拟内存能力并排除未使用的虚拟栈，ParkingLot 后备路径改用现有 `TNoDestroy` 模式；通用手动事件和 pthread 信号量仅通过源码编译。Web 关闭 Trace 并排除其 CPU yield 头依赖；通用进程与 AtomicQueue 的自旋提示使用编译器屏障，不能据此让出浏览器事件循环。

`webCoreTargetBuildVerified=true`、`p3CoreProgramPass=true`、`webCoreTargetBuildSucceeded=true`、`webOrdinaryCoreProgramLinkedAndExecuted=true`；`webCoreModuleWasmCompiled=true` 仅表示当前 Core-only 配置，没有独立 Core archive。Cook/Stage 必须选用 Web 支持的资源格式，已有 Oodle 数据不能直接加载；数组纹理、材质层继续延后。ApplicationCore 的后续进度见下节。

## P3：ApplicationCore、帧回调与基础输入

新增独立 `UEWebApplication` Program Target，正常 UBT 编译、链接和 WriteMetadata 成功；原 Core-only Target 保留。隔离宿主新增目标分支 5.8.3 ApplicationCore 的本地副本，其他依赖和 UBT 仍来自 5.8.0；没有修改安装引擎。

Web 平台实现 `FWebApplication`、单 canvas 窗口和 `FPlatformApplicationMisc` 入口。Emscripten 将 DOM 输入写入队列，逐帧回调通过 UE 消息泵派发到真实 `FGenericApplicationMessageHandler`。`StartMainLoop` 使用 requestAnimationFrame 调用 Program 提供的 UE 回调；目前只执行应用 Tick，尚未调用 Launch/FEngineLoop。

Chrome/Edge 各测试桌面 1280x800 / DPR 1 和窄视口 390x844 / DPR 2，共四组、每组 15 项通过，页面和控制台无错误。验证持续帧回调、Shift+W/重复键/字符/释放、鼠标位置及 canvas 外松开、滚轮与实际 DOM 数值一致、失焦释放按住的键、HTML 输入框不向 UE 派发按键、尺寸/DPI 更新、停止/销毁后的帧和事件清理，以及重复停止。窄视口不代表移动设备支持。

打开 `http://127.0.0.1:8765/web-application.html` 可运行同一份普通 Target 产物。`results/web-application-target-results.json` 记录 208 份目标模块源码及其隔离副本、5 份平台文件、20 个模块对象与产物哈希；对象数不是功能进度。`results/web-application-results.json` 保留四组检查、DOM 滚轮与 UE 事件。`build-web-ubt.ps1` 已包含构建和浏览器检查；单独运行时先准备隔离宿主及平台副本，并设置与构建脚本相同的 SDK 环境。

本轮仅增加两个通用软件光标的 Web 条件守卫，跳过依赖桌面 RECT 的未使用实现；启动画面复用通用空实现。单 canvas、旧 DOM keyCode、ASCII 字符及聚合修饰键为当前范围，IME、左右修饰键区分、触摸、手柄、指针锁定、全屏、光标外观和隐藏页生命周期尚未验证。没有移植 UMG/Slate 或扩展可选 RHI 功能。

新增汇总 `webApplicationTargetBuildVerified=true`、`p3ApplicationCoreBrowserPass=true`、`webBrowserMainLoopVerified=true`、`webApplicationCoreInputVerified=true`。Engine 编译进展见下节；ApplicationCore 测试页仍不调用真实 FEngineLoop。

## P3：Engine Target 与真实主循环源码

新增 `UEWebEngine` 普通 Program Target，启用 Engine/CoreUObject、使用已 Cook 数据、NullRHI 和单线程。保留 UMG 模块及 UHT 反射生成；字体使用已有关闭开关，不移植网页 UMG。

隔离宿主补齐着色器目录引用和 UHT 配置副本，避免缺失委托参数表导致所有带参委托解析失败。Web 工具链在关闭 ISPC 时沿用引擎的空输出行为；ImageWrapper 移除 Oodle 依赖，Launch 同步排除其初始化调用。Blueprint 上下文在无虚拟内存的平台不实例化虚拟栈，使用已有 alloca 路径。Web 启用 FPU 寄存器式 Transform API，CPU SIMD 仍关闭；float/double 行为由 Core Program 的新增第六组运行检查覆盖。

`probe-web-engine-target.cjs` 已接入 `build-web-ubt.ps1`：正常 UBT 导出待构建动作并执行 UHT，再强制编译 LaunchEngineLoop、Launch、ScriptCore、UObjectBase、GameEngine、Preshader2、SkeletalRenderCPUSkin、InputCoreTypes、WebPlatformInput 和入口十个源码。检查 `WITH_ENGINE=1`、wasm64 对象、实际 FEngineLoop PreInit/Init/Tick/Exit 定义以及无 Oodle 初始化引用；记录源码副本、生成代码、对象/响应/日志哈希。InputCore 的调用方和新增网页键码实现分别编译。

结果为 `results/web-engine-target-results.json`。`p3EngineCompileProbePass` 只代表 UHT 与选定对象的编译验证；`webEngineTargetBuildSucceeded=false`、`webEngineLoopBrowserTickVerified=false`。尚未完整编译链接 Engine、初始化或 Tick，也没有新增可运行的 Engine 网页。CoreUObject/Launch、Preshader2、SparseVolumeTextureData 与 MovieSceneSkeletalAnimationSection 为目标 5.8.3，GameEngine、SkeletalRenderCPUSkin、InputCore 原始源码和其他依赖仍为安装版 5.8.0。下一步处理完整构建的实际依赖，再接配置/资源挂载、真实浏览器引擎循环和最小场景。

### 完整 Engine Target 构建

准备好隔离 UBT 后运行：

```powershell
& H:/ue_html/tests/web-platform/build-web-engine.ps1
```

脚本使用普通 UBT 编译整个 `UEWebEngine` Target，平台配置和源码只复制到隔离目录。每次删除当前 Target 的单个 Makefile 缓存，确保新增的平台规则生效；复用已编译的对象。Engine 使用 UE 自带 Unity 编译，十对象诊断使用 `-WebEngineCompileProbe` 保留逐文件编译。Core/ApplicationCore 原有设置保持不变。

`WebEngine.BuildConfiguration.xml` 在首个失败后停止调度，`results/web-engine-full-时间.log` 和对应 `.ubt.txt` 保留普通输出与详细退出原因。`results/web-engine-full-build-results.json` 记录退出码、错误、源码哈希和是否进入链接；动作数不表示功能完成比例。完整构建失败会让脚本退出非零，十对象诊断成功不掩盖该结果。

完整构建成功且 localhost 服务已启动后，运行 Engine 启动验收：

```powershell
$env:NODE_PATH = 'C:\Users\wap80\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node H:/ue_html/tests/web-platform/verify-web-engine.cjs
```

脚本先核验完整构建退出码、源码及三个产物哈希，再复制 JS/WASM 到测试服务目录，并生成四份原始配置的挂载清单。启动器在 MEMFS 内核对配置字节哈希。Chrome/Edge 必须收到真实 `FEngineLoop::PreInit/Init` 后的就绪标记并连续 `Tick`；abort、启动返回失败和页面错误均记为失败。失败日志包含带函数名的堆栈，读取页面状态最多等五秒。当前已执行 Chrome：NullRHI `-sm5`、4MB 栈启动停在缺少 Cook 默认材质的断言，0 帧；脚本在首个浏览器失败后停止，Engine 的 Edge 验收尚未执行。即使后续通过，也只验证 NullRHI 启动，不代表 WebGPU、Cook 场景或 HTML UI 桥接完成。

当前 HTTP Web 平台头复用 `FGenericPlatformHttp`，关闭默认事件循环和本地服务器支持。它的 `ProcessRequest` 返回 false，尚不支持浏览器网络请求；没有引入 Curl 或 WinHTTP。此处理只解决 Engine 统计等依赖的编译入口。

脚本沿用基础回归的两个逻辑核心并在结束后恢复亲和性。扩大核心范围时曾出现 Clang 和 CLR 原生崩溃，原先失败的 AppFramework 合并单元在两个核心下重放通过，未因此保留任何 UMG/控件代码裁剪；崩溃根因尚未确定。

AnimGraphRuntime 编译暴露的 Chaos FPU 头问题，仅修复两处参数名、double 构造调用和 Core 的四分量算术右移。隔离宿主新增目标 5.8.3 ChaosCore 副本，Core Program 第六组增加有符号右移检查；不据此宣称物理系统运行通过。

此前完整构建通过音频、Chaos 和 CoreUObject，停止于 LLM 模板的互斥内联属性。Web 使用 `PLATFORM_SUPPORTS_LLM=0` 关闭该分析器，Engine 诊断额外编译 `TagTrace.cpp`。完整构建报告保留最近一次完整尝试的结果；汇总区分历史构建日志是否有效与源码是否仍匹配。只有当前源码匹配、完整构建退出 0 且三个产物哈希有效时才标记完整构建成功。

关闭 LLM 后完整构建已通过 Core，并进入 Engine 本体。`web-engine-full-20261015-214936.log` 在 `Module.Engine.47.cpp` 的 Preshader Move 解码遇到六处 `int` 到 `uint8` 的列表收窄。只给已经掩码为 0–3 或 0–1 的值增加显式转换，不修改编码、计算逻辑或全局诊断设置。隔离 Engine 模块改为安装版源码的本地副本，仅覆盖目标分支 `Preshader2.cpp`；4,037 份文件比较确认唯一差异是该文件，安装版原件未修改。

第二次完整构建 `web-engine-full-20261015-224419.log` 已通过 `Module.Engine.47.cpp`，后续在 `Module.Engine.49.cpp` 的 CPU 蒙皮调用处停止。Core FPU 的 `VectorLoadURGBA16N` 只读四个 `uint16`，将参数及读取指针改为 const，修正与原调用的类型不匹配；不移植蒙皮新功能。两个原始调用源码纳入当时的八对象探针。

上述修复后的上一轮 `build-web-ubt.ps1` 与 `summarize.cjs` 均退出 0。Core 的 6 组、基础服务的 7 组在 Node/Chrome/Edge 通过；ApplicationCore 四组各 15 项通过；Engine 八个源码和额外 TagTrace 强制重编通过，包含实际 CPU 蒙皮调用方。

2026-10-16 继续完整构建：`web-engine-full-20261015-231703.log` 已通过原 CPU 蒙皮合并单元，随后在 `SparseVolumeTextureData.cpp` 遇到两处 `int32` 到 `SIZE_T` 的列表收窄，仅补两个显式转换。`web-engine-full-20261016-001504.log` 已通过该单元，越过 Engine 本体和 HTTP 编译，停于 InputCore 缺少 `WebPlatformInput.h`。隔离 Engine 现覆盖目标分支的这两个文件；4,037 份文件哈希核对仅 Preshader2、SparseVolumeTextureData 不同，安装原件未修改。没有移植稀疏体积纹理功能。

新增 InputCore Web 平台头、模块规则和基本键码表，承接现有 ApplicationCore 派发的 DOM keyCode；字符映射复用 UE 通用表。范围为常用键盘输入，不包含 IME、左右修饰键区分或手柄。完整构建与本轮综合回归的最终结果见 [P3 报告](H:/ue_html/UE58_P3_WEB_RUNTIME_TEST_RESULTS.md)。

2026-10-16 后续完整构建已通过 InputCore 和 Launch 合并单元。`Engine_Web.Build.cs` 仅排除可选 IoStoreOnDemand 下载实现，保留 IoStoreOnDemandCore；构建图与基础回归通过，完整目标已越过原 IoStoreHttpClient 错误。MovieSceneTracks 三处列表收窄只补显式转换，五个合并单元均通过；其隔离本地副本的 393 份文件仅这一目标文件与安装版不同。

最新阻塞为 RHIValidation 调试层的整数列表收窄。`RHI_Web.Build.cs` 公开定义 `ENABLE_RHI_VALIDATION=0`，让 RHI 与消费者布局保持一致；不修复可选校验层，也不改变现有 Dawn/WebGPU 测试配置。诊断增加原失败源文件强制编译、排除校验实现符号，以及 Launch/Engine/入口定义一致性检查。后续仍需重编所有受影响的完整 Engine 依赖并完成链接，再验证浏览器引擎启动。

最终综合回归及汇总通过，原失败的 RHIValidation.cpp 编译通过，校验符号被排除，消费者定义一致。原 RHI.3 合并单元按原响应参数串行重放也退出 0，生成 2,400,739 字节 WASM 对象；见 `results/web-rhi3-replay-results.json`。完整 Engine 结果保持未完成，不以单元重放代替整程序链接。

后续 `web-engine-full-20261016-134047.log` 已在完整目标通过全部 RHI，停在 ShaderCodeArchive.cpp 两处列表收窄。目标文件只补两个显式 `int32` 转换；隔离 RenderCore 的 212 份本地副本仅此文件与安装版不同。`web-engine-full-20261016-145300.log` 已通过全部剩余 RenderCore 单元，随后在 Renderer.27 的 SceneCullingRenderer.cpp 停止。

SceneCullingRenderer.cpp 只补数组索引到 `uint32` 字段的一处显式转换；Renderer 隔离本地副本的 781 份文件仅此目标文件与安装版不同，安装版哈希未变。目标 FXRenderingUtils.cpp 的距离场裁剪未覆盖到此副本，不能据此宣称该裁剪已通过 WASM 编译。`web-engine-full-20261016-150743.log` 已通过 Renderer 的全部普通源码合并单元，随后在 SignalProcessing.1 停止；生成代码单元仍待编译。

FloatArrayMath.cpp 的 ArrayInt16SwapBytes 只用向量能力条件包住向量循环，非 SIMD 平台继续使用已有逐元素循环，不补两个未实现 FPU 宏。SignalProcessing 隔离副本 199 个文件中仅此目标文件不同，安装版未修改；`web-engine-full-20261016-152211.log` 已通过三个普通源码合并单元，音频运行时未验证。

SlateCore 缺失 msdfgen 时，Web 仅关闭字体 SDF 功能查询/生成器和相应几何算法，保留字体序列化。327 份文件仅三个目标文件不同；`web-engine-full-20261016-152754.log` 已通过五个普通源码合并单元、SlateNullRenderer 和 SlateRHIRenderer。随后 Slate.1 缺失 AHEasing，AttributeInterpolator 在 Web 保留 Linear 分支、排除非线性曲线并在实际请求时明确拒绝，未移植第三方算法。当前继续完整构建，未验证控件或字体运行。

Slate 后续补 WebPlatformTextField.h，复用引擎通用空实现；两个桌面光标锁定函数在 Web 不编译 RECT 路径。465 个原文件中仅三个目标文件不同，新增一个平台头，安装版原件哈希未变。`web-engine-full-20261016-154027.log` 已通过七个普通源码合并单元。

Sockets 的 Web 扩展仅用模块私有定义关闭 BSD/IPv6 实现，平台工厂返回 NAME_None；不注册原生 Socket，不声称支持浏览器网络。`web-engine-full-20261016-154438.log` 已通过原失败模块、剩余依赖和 UMG，完整 C++ 阶段结束，最终链接失败。Engine 十源码探针与额外 TagTrace/RHIValidation 检查本轮重新通过，ApplicationCore 构建与对象审计也重新通过。

`node H:/ue_html/tests/web-platform/verify-web-engine-exclusions.cjs` 已执行通过，五个 SlateCore 合并对象的 SDF 算法/任务实现和 Sockets 的 BSD 实现已排除，字体数据接口、平台工厂入口仍在。报告记录源码、对象与符号哈希；完整 Engine 链接、启动和浏览器运行标记保持 false。

16:00 历史检查点的汇总退出 1：ApplicationCore 新旧 JS/WASM 哈希相同，但旧浏览器报告引用的是旧构建报告哈希；当时 localhost 服务后台启动被自动批准审核拒绝，原因仅为 `blocked by policy`，未修改旧运行报告冒充通过。用户随后要求验证，16:06 服务正常恢复，16:07 浏览器回归通过并生成实际报告，严格汇总退出 0；日志为 `results/web-validation-summary-20261016.log`。`webEngineTargetCompileStageCompleted=true`、`p3ApplicationCoreBrowserPass=true`，完整 Engine 构建与浏览器 Tick 仍为 false。

随后修复标准应用入口、Web 崩溃清理与 RHI 工厂入口，并移除当前无声目标的可选解码器；`web-engine-full-20261016-161416.log` 记录五个 C++ 动作通过后最终链接失败，未解析符号减少 27 个，剩余 41 个。RHI 硬件分支明确拒绝调用，当前仅准备 NullRHI 启动验证。此轮综合回归、入口符号/解码器排除和严格汇总全部通过，运行 Engine、WebGPU 和 Cook 的标记保持 false。
