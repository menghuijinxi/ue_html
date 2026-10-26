# 默认关卡浏览器运行进度

验收目标：UE 自带 `/Engine/Maps/Templates/Template_Default` 完成 Web 打包，在浏览器显示原始 Lit 地面、方向光和天空球；单个 Unlit 立方体不满足验收。

## 2026-10-21：接入原始默认关卡

- 新增模板检查 commandlet，确认原始地图包含方向光（强度 6）、实时 SkyLight、SkyAtmosphere、天空球 `SM_SkySphere`、`M_SimpleSkyDome` 和使用 `MI_ProcGrid` 的 Lit 地面。
- 增加独立 DefaultTemplate Cook/Stage 配置；继续使用引擎原图，不用手工拼装的替代场景。只在运行时设置相机，不替换地图中的网格或材质。
- 原生编辑器模块、Web 增量编译链接成功；默认关卡 Cook 成功，零着色器转换失败。Stage 得到 381 个文件、94,343,997 字节的资源包。
- 浏览器首次复现：0 帧，加载体积云噪声 `VT_PerlinWorley_Balanced` 的 sRGB BGRA8 3D 纹理时触发能力校验。尚未完成默认关卡渲染验收。
- 运行入口：`/web-engine.html?rhi=webgpu&incremental=1&cook=default`。
- 验证脚本：`tests/web-platform/probe-web-default-scene.cjs`。此阶段的双浏览器脚本只检查原图启动与连续帧，不能替代后续光照、天空的图像与差异验证。

## 2026-10-21：默认天空着色器 Cook 通过

- DefaultTemplate 独立配置开启 `r.SupportSkyAtmosphere=1`，Cook 和浏览器共用该配置。
- Web ES3.1 开放 SkyAtmosphere；天空查找表与实时天空捕获使用可存储的 RGBA16F，天空缓冲声明转换为 `StructuredBuffer<float4>`，保留原生平台路径。
- ShaderFormat v16 恢复静态 uniform buffer 资源元数据，反射存储纹理格式，并对生成的 View 天空缓冲声明进行定向转换。失败时保留预处理 HLSL，便于核对实际输入。
- 原生 RenderCore、ShaderFormat 编译通过。`20261021-090302` Cook 通过，941 个全局着色器排列，零转换失败；Stage 通过，381 个运行文件、107,827,886 字节。
- 当前运行时尚未验收：浏览器暴露了新增立方体初始化中面索引与数组索引传反的问题，已定位并正在修复、回归。打包成功不代表默认场景已渲染成功。
- 默认 VolumetricCloud 仍保留在地图中；UE 移动渲染路径本身不绘制体积云。Web 不加载不支持的 VolumeTexture 资产，天空大气直接创建的线性 3D 查找表仍保留。

## 2026-10-21：天空资源与默认地图运行回归

- 修正立方体初始化中面索引、数组索引传反导致的内存覆盖；支持天空所需的六面 mip、RGBA16F 纹理 UAV、线性 3D 查找表、异步缓冲回读和 GPU fence。
- 按 mip、面及深度/模板平面追踪资源状态；允许不同 mip 的天空下采样，以及只读深度附件采样。阴影深度采用 Depth32Float，显式管线布局保留深度纹理的非过滤采样要求。
- 修正带颜色附件的纯深度绘制管线；补齐默认天空静态 uniform buffer 资源解析。半分辨率局部雾关闭时使用引擎黑色默认纹理，默认配置关闭可选 ContactShadows，保留普通阴影路径。
- 最新原生模块编译通过；Dawn/D3D12 立方体六面各三级 mip 的 18 项像素回读及 1 项异步缓冲回读全部通过。原有材质回归通过：19 次绘制、1,114,112 个数值校验。
- Chrome、Edge 均加载原始默认地图并运行 61 帧，含 1 个 Lit 网格、1 个天空球、方向光及 SkyLight；零 GPU 校验错误。但截图天空仍黑、地面顶面受光不正确，尚未达到验收目标。
- 已定位增量链接中的共享头文件旧对象问题：另有 25 个实际链接输入依赖 `WebShaderPlatform.h`，旧内联实现会覆盖新天空开关。正在重编译全部相关对象，再验证天空查找表及默认场景图像。

## 2026-10-21：默认天空和 Lit 地面首次完成双浏览器图像验证

- 重编译遗漏的共享头文件依赖，并刷新 unity 分组已变化的 Landscape 对象；SkyAtmosphere 已进入实际查找表计算。正常 UBT 构建正在刷新全部依赖，后续以其产物复验，不能把这次诊断链接当成正常构建通过。
- 法线诊断确认旧正面设置绘制了地面背面，导致大面法线朝下。修正为 WebGPU 逆时针正面，与 UE `CM_CW` 剔除顺时针三角形的语义一致；未改关卡网格、法线、材质或方向光。
- 补入软引用未自动进入精简 Cook 的移动端标量蓝噪声纹理 `FastBlueNoise_scalar_128x128x8`，Stage 检查其存在。Cook/Stage 通过，383 个运行文件、107,960,567 字节。
- 新增默认关卡测试导出，只供验收脚本切换原有方向光、天空球及大气组件可见性；正常页面不调用它。脚本验证天空、地面像素，关闭太阳、关闭天空、恢复原图，避免仅凭帧数认定渲染成功。
- Chrome、Edge 均显示原图蓝天与受光棋盘地面：全画布 230,400 个非黑像素，上部 56,782 个蓝天像素，地面平均亮度约 203。关太阳后地面均值为 0；关天空后上部蓝天为 0；恢复后图像通过，零 GPU 校验错误。
- 最新原生编译、天空资源 19 项检查、材质 19 次绘制回归通过。曾有一次启动报外部 Instance 引用失效，后续独立运行超过 2,800 帧及双浏览器对照未复现；正常构建复验时继续留意，不能作为已定位修复的问题。
- 正常构建显式并行数同时控制 CPU 亲和范围，避免设置多编译任务却全部固定在两个逻辑核上；默认单任务仍保持较小 CPU 范围。

## 2026-10-21：普通构建与独立包最终验收通过

- 普通 UBT Web 目标构建成功，退出码 0，完成实际链接；最终续编的 227 项任务全部通过。最终验收使用这次普通构建产物，已不依赖诊断增量链接。
- 定位并规避 Clang 24 在 wasm64 `TriangleMeshImplicitObject.cpp` 上的优化崩溃：通过 UBT 源码映射识别对应 Chaos 编译单元，仅该单元使用 `-O1`，其他优化单元仍使用 `-O2`。参考引擎提交 `a00bee989`，普通 UBT 构建已验证。
- 原始 `/Engine/Maps/Templates/Template_Default` Cook/Stage 通过，383 个运行文件、107,960,567 字节。独立目录含 6 个文件，总计 289,906,690 字节，包含正常构建的 JS/WASM 及该关卡资源；打包时校验构建、Cook、Stage 和产物的来源及哈希。
- Chrome `155.0.8059.86`、Edge `155.0.4283.62` 均通过独立包验收，各连续运行至 484 帧。截图显示原有天空球、天空大气和受光 Lit 地面；关闭方向光、关闭天空、恢复原图的差异检查全部通过，页面错误和 GPU 校验错误均为 0。
- 两个浏览器均通过 `390x844` 竖屏窗口及恢复 `1440x900` 窗口的图像检查，继续正常渲染。修正 Web 视口调整时在浏览器主线程同步等待 GPU 的问题，原生等待路径保留；原生视口记录/直通两种模式共 72 项检查通过。
- 独立包只请求自身目录内的文件；资源包哈希和配置哈希的破坏测试均在 UE 开始渲染前拒绝启动。
- 最终报告：`tests/web-platform/results/web-default-scene-results.json`，`pass`、`completeUEScene`、`fullNormalUBTBuildVerified`、`packaged` 均为 `true`。截图：`tests/web-platform/results/web-default-scene-chrome.png`、`web-default-scene-edge.png`。
- 本次目标已完成：默认带光照和天空球的原始关卡已打包并在浏览器运行。当前仍为 ES3.1 移动渲染路径，未启用体积云，也尚未接入编辑器一键 Web 打包。

## 2026-10-21：修复交互缺失及运行后停帧

- 用户实际运行发现页面不能操作，并在一段时间后停住。原包的相机固定；浏览器日志另有 `FGenericPlatformMemory::OnOutOfMemory`，调用栈落在统计历史数组扩容。之前数百帧的图像验收不能证明持续交互运行。
- 定位内存原因：Web RHI 的 `RHIEndFrame` 忽略了 `StatsFrame`，没有 GPU profiler 的 EOP 工作线程代为上报帧结束；`CurrentEndOfPipeFrame` 不前进，UE 无法回收统计历史。现在通过 `FEndOfPipeStats` 上报并刷新实际提交的帧标记，保留统计系统，不靠关闭统计或扩大内存上限绕过。
- 默认关卡改为使用已存在的 UE 默认 Pawn 和 PlayerController 控制视点，沿用原生飞行移动与鼠标轴输入。保留原始地图和材质；不新增 JS 相机或替换渲染画面。
- Web ApplicationCore 接入鼠标捕获、高精度相对移动和 pointer-lock 状态。锁定与普通鼠标移动只分发一次，丢弃进入锁定时的首个跳变；解除锁定和失焦时释放按下的输入。
- 运行页面在真实点击事件内请求鼠标锁定，处理拒绝及不支持的情况；锁定不可用时可按住右键拖动视角。WASD 移动、E/Q 升降，Esc 解除锁定。
- 新增 `probe-web-default-interaction.cjs`：旧包按 W 后图像变化比例为 0，明确复现失败；新包检查实际 UE 位置、角度及画面变化，还检查横移、升降、失焦释放和重新点击恢复操作。另有拒绝锁定的控制测试。
- 普通 UBT 编译链接、原生 RHI 编译通过。原生视口记录/直通两种模式共 72 项检查通过；ApplicationCore 在 Chrome/Edge 的桌面及窄窗口共 68 项输入、焦点、HTML UI、销毁检查通过。独立包的原图光照、天空及缩放验收重新通过。
- 持续运行测试通过：Chrome 运行 600.973 秒、68,768 帧；Edge 运行 600.995 秒、68,705 帧，结束后再次移动也通过。两个浏览器的历史统计始终为 14 帧，线性内存保持 193,331,200 字节，预热后增长为 0，页面及 GPU 校验错误为 0。这是 10 分钟测试结果，不代表无限时长稳定性已验证。
- 上述报告分别为 `tests/web-platform/results/web-default-interaction-chrome-results.json`、`web-default-interaction-edge-results.json`。拒绝锁定的备用操作报告 `web-default-interaction-chrome-drag-results.json` 也通过；内置浏览器已刷新，实际按 W 后画面改变，无页面错误。参考引擎的输入修改提交为 `e1b5fc089`。

## 2026-10-21：接入 HDR、色调映射与 FXAA

- 默认关卡独立配置改为 `r.MobileHDR=1`、`r.Mobile.AntiAliasing=1`、`r.AntiAliasingMethod=1`。Cook 和浏览器使用同一份配置，保持原始地图、光源和材质；当前抗锯齿为 FXAA，没有启用 TAA/TSR。
- Web 不支持默认的 R11G11B10 浮点场景目标时，使用已支持的 RGBA16F；移动后处理的 Bloom、亮度及太阳光遮罩中间目标同样使用 RGBA16F，原生平台继续原有格式。
- 补入 ACES 色调映射表所需的 R32_FLOAT 二维纹理创建及更新，采样布局使用不要求可选过滤能力的浮点加载。调色 LUT 在 Web 使用 RGBA16F 三维纹理，并在着色器显式声明存储格式，避免创建格式与反射信息不一致。
- 补齐 RDG 批量缓冲上传的临时转换：只接受缓冲的 `Unknown ↔ CopyDest` 与 `IgnoreAfterState` 组合，保留逻辑访问状态和资源生命周期；仍不允许在实际活动渲染通道内执行转换。原生探针验证两份上传数据及状态保留，原有非法转换检查继续通过。
- 纹理回归发现 SRV 范围校验在拒绝非法描述前调用了会断言的 `GetViewInfo`，改为先检查原始 mip/数组范围。同步修正旧探针对 RGBA16F 三维纹理范围的过时预期。
- 普通 UBT 构建、实际 Web 链接和原生 RHI 编译通过。默认关卡 Cook 成功，零着色器转换失败；Stage 得到 383 个文件、108,218,956 字节的资源包，独立目录为 6 个文件、290,172,727 字节。
- 新增 `probe-web-default-postprocess.cjs`，拦截真实 WebGPU 绘制和计算提交，并按着色器入口查回 Cook 的转换产物。Chrome、Edge 均确认 RGBA16F `SceneColor`、`FTonemapPS`、`FFXAAPS`、Bloom 的 setup/down/up 和 `FLUTBlenderCS` 实际执行，不仅检查配置或着色器已编译。
- 原生回归通过：材质探针 19 次绘制、1,114,112 个数值检查，转换探针 66,064 个数值检查；纹理记录/直通模式各 124 项、840 个数值检查全部通过。
- 首次 HDR 图像检查通过，天空和地面继续可见，地面亮度均值约 103。当前固定曝光下画面比编辑器截图暗，不能据此认定光照、曝光或颜色已经对齐。
- 尚未接入：自动曝光、体积云。雾、间接光照及与编辑器相同视点和曝光的图像对比仍需后续验证。浏览器仍为 ES3.1 移动前向渲染，不代表桌面 Lumen、TSR 或体积云已经移植。
- 最终包双浏览器回归通过：后处理实际提交、原图光照/天空/缩放均通过；两边各 7 项交互通过。Chrome 持续测试 60.779 秒、最终 7,870 帧，Edge 61.552 秒、最终 7,985 帧；预热后线性内存增长为 0，统计历史保持 14 帧，页面错误和 GPU 校验错误均为 0。本次 HDR 包只完成约一分钟持续测试，之前 LDR 包的十分钟结果不作为 HDR 包长时稳定性的证明。
- 新增报告为 `tests/web-platform/results/web-default-postprocess-results.json`，截图为同目录 `web-default-postprocess-chrome.png` 和 `web-default-postprocess-edge.png`；原图及交互报告也已更新为最终 HDR 独立包。参考引擎修改提交为 `b5d55f12e`。

## 2026-10-21：接入 UE 移动端直方图自动曝光

- Web ES3.1 开放引擎原有的移动自动曝光编译及运行开关，保留原图、灯光和材质。实际执行 `TMobileHistogramCS<true>` 与 `FMobileHistogramEyeAdaptationCS`，没有使用网页端亮度滤镜。
- 曝光着色器在 Web 使用结构化整数存储缓冲，原生平台继续原有声明；直方图归约循环保留循环，避免完全展开后超过 WGSL 解析深度。RHI 根据实际设备上限设置共享内存能力，Chrome、Edge 本次均为 16,384 字节，正确选用低共享内存排列。
- GPU 数值复现发现低共享内存排列原先重复写部分奇数桶、漏写后半部分偶数桶；Web 分支改为每线程分别写入 `2*i`、`2*i+1`。修复前五档亮度中三档失败，修复后 Chrome、Edge 的五档亮度、每档 64 桶全部通过，每档权重总和均为 100,000。
- 补齐曝光直方图所需的整数缓冲 UAV 清零，仅支持全零值，并按视图范围清零；原生探针分别验证整段 typed 缓冲及局部 structured 缓冲，范围外哨兵和逻辑访问状态保留。非零清除和纹理清除仍不在本次范围。
- 亮度中间目标保留单通道 R16F，增加相应 RHI 纹理映射，修正此前统一回退 RGBA16F 与单通道像素输出不匹配的问题。补齐 `RHIUnlockStagingBuffer`，曝光异步回读完成后通过相同 RHI 入口解锁并允许再次锁定。
- 原生 RenderCore、RHI 编译通过；普通 UBT Web 编译及链接通过。使用 `-ValidateShaderJobCache` 禁用着色器 DDC 后重新 Cook 原图，配置一致性通过，枚举 947 个全局着色器排列，零转换失败。Stage 为 383 个文件、108,307,218 字节；独立目录为 6 个文件、290,264,812 字节。
- 原生回归通过：材质 1,114,112 个数值检查、资源转换及清零 66,576 个数值检查；天空资源及回读共 20 项检查，视口记录/直通两种模式共 72 项检查通过。
- 浏览器测试直接回读实际曝光 GPU 输出：Chrome 正常曝光倍率 1.2055，原太阳强度临时降低至十分之一后为 11.8249，恢复后为 1.2116；测得平均亮度从 0.29896 降为 0.02991，再恢复为 0.29895。Edge 对应值几乎相同。测试要求曝光收敛、暗场倍率提高、恢复误差小于 5%，两边均通过，页面及 GPU 校验错误均为 0。
- 完全关闭太阳会让默认图接近全黑，并受 UE 忽略黑色直方图桶的规则影响；曝光测试改为降低原灯光强度，不改变曝光算法。新增测试模式只在验收脚本调用，正常页面使用原始灯光强度。原图测试改为等待图像亮度稳定后截图，保留原有天空、地面及恢复差异阈值。
- 新增数值报告为 `tests/web-platform/results/web-mobile-histogram-results.json`；实际曝光及后处理报告为 `web-default-postprocess-results.json`，截图为同目录 `web-default-postprocess-chrome.png`、`web-default-postprocess-edge.png`。
- 最终独立包原图对照通过：两浏览器关闭太阳、关闭天空、恢复原图、竖屏及恢复窗口检查全部通过；恢复后天空/地面平均像素差均小于 0.54，沿用小于 5 的验收阈值。资源包和配置哈希破坏测试也通过。
- 自动曝光包持续运行及交互通过：Chrome 61.526 秒、最终 7,280 帧，Edge 60.591 秒、最终 7,143 帧；各 7 项交互通过。预热后线性内存增长为 0，保持 193,331,200 字节，统计历史保持 14 帧，页面及 GPU 校验错误均为 0。本批验证时长约一分钟，不沿用旧包的十分钟结果。
- 参考引擎修改提交为 `fad5ed078`。本轮同时修正原生 RenderCore 构建受插件目标缓存影响而缺失模块输出的问题：仅移除工作区内该目标的 `Makefile.bin` 后重新生成，安装引擎输入哈希检查通过。
- 仍未接入体积云；当前仍是 ES3.1 移动前向渲染，自动曝光通过不代表与桌面 Lumen、TSR、体积云或编辑器全套画面一致。下一项为默认天空中的云。

## 2026-10-21：修复高 DPI 启动时的 unreachable

- 用户报告自动曝光版本出现 `Uncaught RuntimeError: unreachable`。使用不安装 GPU 拦截器的普通独立包页面复现：CSS 窗口 `1848x1120`、DPR 1.5 时，第 4 帧先报已销毁的交换链纹理被提交，第 5 帧在 `FViewInfo::UpdatePreExposure` 的 `FinalPreExposure > 0` 断言中终止。DPR 1 对照正常。原始失败记录保留在 `results/web-default-startup-before-fix-results.json`，对应包记录为 `web-default-template-package-before-dpi-fix-results.json`，这些是历史证据，不是当前产物验收报告。
- 根因是尺寸管理冲突：ApplicationCore 向 UE 报告 CSS 尺寸，WebGPU 依此配置交换链；ApplicationCore 又在消息轮询中把同一画布改为 CSS 尺寸乘 DPR，销毁尚待提交的帧纹理。新增曝光回读消费了失效帧的输出，使问题表现为曝光断言。
- 统一窗口、显示范围、缩放事件及绝对鼠标坐标为实际像素；ApplicationCore 只报告窗口变化，由 RHI 配置表面时设置画布缓冲区。保留高 DPI 分辨率和原有相对视角输入，没有关闭自动曝光或放宽曝光断言。独立 ApplicationCore 探针没有 RHI，由探针自身的画布消费者应用上报尺寸。
- 新增 `probe-web-default-startup.cjs`，直接打开普通页面，覆盖 Chrome/Edge、DPR 1/1.5/2、每档重复三次；每次检查启动、竖屏、恢复窗口三个状态，各等待至少 180 帧，再验证实际 UE Pawn 移动。检查画布实际尺寸、完整非黑画面、页面错误及 GPU 错误，报告记录当前包和产物哈希。
- 普通 UBT Web 编译、链接及独立包生成通过；本次没有修改着色器、Cook 配置和资源，复用已校验的原图 Cook/Stage。独立目录仍为 6 个文件，本次总计 290,263,846 字节。
- 普通页面回归全部通过：18 次独立启动、54 个窗口状态，所有状态的非黑像素比例均为 100%，实际尺寸均为 CSS 尺寸乘 DPR 后取整，页面及 GPU 错误为 0。原有 ApplicationCore 四组回归共 68 项通过；相应旧汇总脚本的尺寸断言也改用实际像素约定。
- 原图光照、天空、恢复、缩放与资源破坏控制测试通过；实际 HDR、FXAA、Bloom、LUT 和直方图曝光提交及回读通过。曝光正常/暗场/恢复倍率：Chrome 为 1.2075 / 11.8053 / 1.2104，Edge 为 1.2042 / 11.8945 / 1.2083。
- 最终包持续交互通过：Chrome 120.807 秒、最终 10,882 帧；Edge 121.581 秒、最终 13,768 帧。两边各 7 项交互通过，预热后线性内存增长为 0，保持 193,331,200 字节，统计历史为 14 帧，页面及 GPU 错误为 0。内置浏览器已刷新并确认完整画面，错误显示为空。
- 参考引擎修复提交为 `3090741d9`；普通页面回归报告为 `results/web-default-startup-results.json`，各 DPI 截图为同目录的 `web-default-startup-{chrome,edge}-dpr{1,1.5,2}.png`。
- 本次 DPI 与竖屏组合均在 Windows 桌面浏览器验证，不代表真机移动端兼容；持续测试时长约两分钟，不作为无限时长稳定性的证明。体积云仍未接入。

## 2026-10-21：接入默认关卡的原始体积云

- Web 移动渲染器在天空大气初始化后准备原生云参数，并在后处理前执行引擎原有的体积云光线步进。保留 `/Engine/Maps/Templates/Template_Default`、`m_SimpleVolumetricCloud_Inst` 及其纹理，没有增加网页云贴图或替换关卡。
- 原云父材质的 `Shading Path Switch` 移动分支将消光设置为常量，导致最初只有均匀白雾。源码编译器仅对 Web 体积云选择原材质的完整分支；隔离的已安装版本 Cook 主机在内存中选择相同输入，不保存原始资产。最终 WGSL 中实际保留并采样两张材质三维纹理，截图出现完整云层形状。
- 体积纹理 Cook 为线性 RGBA16F，Web 关闭该资源的流送和 sRGB 创建标志；补齐三维纹理 mip 链及云深度目标所需的 RG16F。沿用已有逐 mip 上传路径，未扩展数组纹理等无关功能。
- 新增隔离原生 Renderer 模块构建，用于注册 Web 体积云着色器。原生 Renderer 42 项构建任务、RenderCore 8 项构建任务通过，安装目录输入哈希未变。Cook 主机依赖更新为与本次编译所用安装源码匹配的 DLL，替换前解除工作区硬链接，未修改安装引擎。
- 普通 UBT Web 构建和实际链接通过；禁用着色器 DDC 后重新 Cook，947 个全局着色器排列、零转换失败，新增云相关设置的宿主/目标一致性检查。最终 Stage 为 383 个文件、118,153,220 字节，独立目录为 6 个文件、300,121,394 字节。
- 最新独立包 Chrome、Edge 均实际执行 `FCloudRenderViewPS000`；`VT_PerlinWorley_Balanced` 为 128³、1 级 mip，`VT_Lightning` 为 64³、7 级 mip。每张纹理每一级各取 3 点 GPU 回读，分别为 3 点和 21 点，全部与上传的半精度字节一致；这不是全部体素逐个校验。
- 关闭原云组件后云绘制为 0，天空区域平均像素差约 9.31，约 29.8% 像素明显改变；恢复后继续绘制，平均差约 2.30/2.29。HDR、FXAA、Bloom、LUT 与自动曝光回归通过，两浏览器页面和 GPU 校验错误为 0。最终包曝光正常/暗场/恢复倍率：Chrome 约 1.148/11.281/1.152，Edge 约 1.148/11.305/1.153。
- 首次高 DPI 重复测试在 Chrome 第 9 次启动时遇到整机死机，随后 D3D12 设备丢失，`nvidia-smi` 报 `GPU is lost`，Chrome/Edge 均无可用适配器。用户确认当时电脑死机，已重启恢复；保留 `results/web-default-startup-cloud-device-reset-results.json` 等历史记录，不将此认定为已定位的云渲染缺陷，也不将恢复系统当作代码修复。
- 重启后云包的 18 次启动、54 个窗口状态全部通过，包含 Chrome/Edge、DPR 1/1.5/2、每档重复 3 次及原生 Pawn 移动。原云接入提交为参考引擎 `51c345340`。
- 增加仅供验收的材质时间开关并重新链接后，最终独立包再跑 6 次启动、18 个窗口状态，均通过；报告明确检查普通页面没有启用该开关，三个 DPR 下材质保持真实时间动画，画面非黑比例均为 100%。最新 `results/web-default-startup-results.json` 对应最终包；之前 18 次重复检查保存在 `web-default-startup-cloud-before-test-clock-results.json`，不冒充最终构建的重复次数。
- 云材质随游戏时间移动，旧静态截图的天空恢复差约 10，地面约 0.47。画面对照脚本仅在验收加载时启用 `-WebVisualTestClock`，使用 UE 已有的 `r.RenderTimeFrozen=1` 冻结材质动画，同时保留真实帧时间供曝光适应；不修改独立包页面和资产，不放宽原有阈值。报告确认开关生效，Chrome/Edge 天空恢复差分别约 1.033/1.030，地面分别约 0.460/0.458，均小于原有阈值 5。窗口恢复及两项资源哈希破坏测试通过。真实时间的启动、云、曝光和交互另行验证。
- 最终包真实时间持续运行通过：Chrome 121.879 秒、11,371 帧，Edge 122.298 秒、10,233 帧，各 7 项交互检查通过。线性内存均保持 231,997,440 字节、预热后增长为 0，统计历史稳定为 14 帧，页面和 GPU 错误均为 0。云纹理使内存基线高于之前无云版本；当前结果只证明约两分钟的持续测试。
- 鼠标锁定被拒绝时的备用右键拖动及 7 项交互检查通过；该备用流程未另外做长时间持续测试。最终证据为 `web-default-postprocess-results.json`、`web-default-scene-results.json`、`web-default-startup-results.json` 与 `web-default-interaction-{chrome,edge,chrome-drag}-results.json`，均对应当前独立包。
- 范围：当前仅开放单方向光的像素云步进及原材质密度/散射。云影、云 AO、云进入 SkyLight 实时捕获、体积云时域重建、高质量逐像素大气透射和复杂透明物体组合均未验收；当前直接按视图分辨率绘制云，高分辨率成本需关注。普通构建没有编译原生编辑器 Engine 模块，Cook 使用上述内存适配，不代表完整源码编辑器构建通过。
- 原图的 `ExponentialHeightFog` 密度为 0.0436，高度衰减为 0.2，`bEnableVolumetricFog=false`。后续先接入该指数高度雾；体积雾的光照体素、历史重投影和局部光散射不在本次云接入范围。

## 2026-10-21：局域网访问与启动条件检查

- 测试服务由 `127.0.0.1` 改为默认监听 `0.0.0.0:8765`，保留原本机入口，支持 `HOST`、`PORT` 覆盖，启动日志列出网卡地址。当前物理网卡地址为 `10.1.1.200`。
- 复现局域网 HTTP 的 `TypeError: Cannot read properties of undefined (reading 'digest')`：该来源未被浏览器视为安全上下文，`crypto.subtle` 和 WebGPU 不可用。独立页改为启动前检查并显示当前来源对应的浏览器配置步骤，避免下载大资源后才失败。
- `probe-web-lan.cjs` 检查本机和局域网地址的六个包文件、WASM MIME、COOP/COEP，验证 Chrome/Edge 未信任来源的提示以及信任后原始关卡的连续渲染和真实 Pawn 移动。浏览器例外只传入自动化进程，不修改用户配置。
- 本轮重新生成六文件独立包，通过 12 次本机/网卡地址的文件响应检查。Chrome、Edge 的可信网卡来源均完成 182 帧且实际移动超过 1,000 单位，无脚本或 GPU 校验错误；Chrome 原本机入口另验收 121 帧。首次启动曾出现此前记录的 `A valid external Instance reference no longer exists`，复跑通过，仅保留为既有偶发问题，未将其宣称为修复。
- 局域网 HTTP 测试设备仍需手动将 `http://10.1.1.200:8765` 加入可信开发来源并重启浏览器，或部署受该设备信任的 HTTPS。验证仅使用本机访问网卡地址，其他设备及路由连通性需实际测试。

## 2026-10-22：接入原始默认关卡的指数高度雾

- 开放 Web 移动平台原有的 `MobileFog.usf` 编译和运行入口，保留 UE 指数高度雾及天空大气散射计算。继续使用原始关卡的 `ExponentialHeightFog`，密度 0.0436、高度衰减 0.2、起始距离 0、高度 -6850；不改地图、灯光、材质或组件参数。
- 默认配置显式启用像素雾深度测试和天空大气影响高度雾。实际 WebGPU 管线使用 reversed-Z `greater-equal`、天空模板位 8 的 `not-equal` 测试，以及 `src + dst * src-alpha` 透射率混合，保留天空材质自身处理雾的路径。
- 只在 Web 排除未使用的体积雾、局部雾和雾散射立方体贴图排列；其他平台保持原有编译条件。原图 `bEnableVolumetricFog=false`，本次没有接入体积雾光照体素、历史重投影、局部光散射或光柱。
- 隔离原生 RenderCore、Renderer 构建分别完成 8、40 项任务，安装目录输入哈希未变；普通 UBT Web 构建及真实链接通过，最终日志 `web-engine-full-20261022-004957.log`。首次续编中 Clang 编译已有 Engine 单元曾崩溃，降低本次并行数至 4 后该单元通过；不将重试当作修复 Clang。
- 禁用着色器 DDC 后 Cook 通过，配置一致性通过、零转换失败；全局排列由 947 增至 966，包含 18 个 `FMobileFogPS` 和 1 个 `FMobileFogVS`，19 个 WGSL 模块另经真实 Chrome 解析通过。Stage 为 383 文件、119,327,535 字节；独立包为 6 文件、301,303,376 字节。
- 新增仅供验收的组件参数导出，正常页面不调用。`probe-web-default-postprocess.cjs --clouds --exposure --fog` 在 Chrome、Edge 验证原始参数、关闭雾、密度翻倍、起始距离改为 50000、高度衰减四倍及恢复六组控制。地面开关平均像素差约 7.35，参数控制差约 4.03、2.20、5.21；恢复差分别约 0.005、0.444，低于开关差的四分之一，随后至少 60 帧继续绘制雾。
- 自动曝光会改变全图亮度，远近检查改用棋盘格相邻像素对比度，不把绝对亮度变化误认为雾量。开雾/关雾对比度比值：远处约 0.959，近处约 0.979；远处棋盘格衰减更明显。对照仅冻结材质动画，曝光继续使用真实时间收敛，普通页面保持真实时间。
- 双浏览器曾在同一运行包实际执行高度雾、原云、HDR、FXAA、Bloom、LUT 和直方图自动曝光；云纹理每级抽样回读继续通过。曝光正常/太阳降至十分之一/恢复倍率约 1.155 / 11.568 / 1.155。那些通过运行中的页面错误、GPU 校验错误、设备丢失均为 0；本阶段最后一次完整复验在 Chrome 启动时再次失败，当时 `web-default-postprocess-results.json` 为 `pass=false`。后续诊断结果另见下一节，不将后续成功视为该故障已修复。
- 当前包的原图光照、天空关闭和恢复、竖屏、恢复窗口，以及两项资源/配置哈希破坏测试均重新通过，报告为 `web-default-scene-results.json`。效果截图为 `web-default-fog-{on,off,dense,start-distance,height-falloff,restored}-{chrome,edge}.png`。
- 当前包真实时间持续交互通过：Chrome 61.001 秒、4,413 帧，Edge 62.975 秒、4,532 帧，各 7 项操作通过；WASM 线性内存均为 231,997,440 字节，预热后增长为 0，统计历史为 14 帧。报告为 `web-default-interaction-{chrome,edge}-results.json`。这只证明成功启动后的约一分钟运行，不证明冷启动可靠，也不沿用旧包十分钟的结果。
- 普通页面启动回归有未通过项：Chrome DPR 1、1.5 的启动/竖屏/恢复及实际移动通过，DPR 2 首次启动在第 3 帧设备丢失，该轮汇总保持 `pass=false`。Edge DPR 1/1.5/2 的三次启动、九个窗口状态及实际移动全部通过，单独报告为 `web-default-startup-fog-edge-results.json`。Chrome DPR 2 诊断对照中正常设置一次失败、一次成功；关闭雾、只关闭雾深度测试各两次成功，样本不足以证明雾管线就是根因，不改变发布配置。
- 已缩小但未修复的启动问题：Chrome 多次在启动第 3～4 帧退出 GPU 进程，随后设备丢失并报 `A valid external Instance reference no longer exists`，没有先行 GPU 校验错误。抓取自有自动化 GPU 进程的异常转储后，确认 `0xC000001D` 来自 Chrome `155.0.8059.86` 内的 `dxcompiler.dll + 0x14248a0`，该位置为编译器断言后的 `ud2`；不是凭 Instance 文本判断 C++ 引用生命周期。
- 转储中还能找到原天空 `FCubeDownsamplePS` 的入口，但这不足以确认触发着色器。该 WGSL 的 20 个独立管线变体通过；从成功的 Dawn 着色器日志提取 53 份真实 HLSL，再用隔离复制的同一 Google DXC 独立编译，53 份全部成功。未替换安装浏览器或引擎中的 DLL，也未以浏览器启动参数绕过发布包中的校验。
- 持续订阅控制台的完整探针失败较多，简化探针及普通页面也有成功；Chrome DPR 2 普通页面的失败说明问题不只发生在效果探针。另有一次启动在配置加载中报 WASM 内存越界，原因同样未定位。历史失败保留在 `web-default-fog-first-start-instance-failure.json`、`web-default-fog-second-start-instance-failure.json`、`web-default-fog-dxc-instance-failure.json`、`web-default-startup-fog-dpr2-failure-results.json`；转储及模块判断为 `results/fog-crashes/chrome.exe_261022_013151.dmp`、`web-default-fog-gpu-crash-module.json`。后续成功不代表这些启动问题已修复。
- 效果探针新增设备丢失记录、`--browser=Chrome|Edge` 和 `--console=page` 诊断选项。默认保留原 CDP 控制台订阅；页面模式仅保存最近 24 条日志并照常转发 console。页面模式也曾复现启动失败，不能作为修复；真实 GPU 调用、页面异常、GPU 校验和设备丢失判定均保留。参考引擎提交为 `ba9aae129`。下一步优先缩小编译器断言的输入与触发条件，暂不扩大体积雾范围。

## 2026-10-22：分离启动编译器故障与主机执行条件

- 本轮只增加诊断及报告能力，没有改变 UE 运行代码、雾/云算法、发布配置或独立包；沿用上一轮通过哈希核验的普通构建、Cook、Stage 和打包产物。没有重新编译引擎，也没有修改安装引擎或浏览器 DLL。
- 新增 `probe-web-pipeline-compile.cjs`，记录默认关卡实际创建的设备请求、WGSL 和布局，再在不加载 UE 的空白页面重建 30 条实际管线。最初同步回放 3 次中 2 次设备丢失；逐条等待异步编译的 5 次中也有 1 次失败，不能将问题归结为 UE 帧循环或管线并发。单独重放云管线 12 次、LUT 管线 30 次均通过，不能凭失败位置认定某个着色器必然错误。
- 回放可独立获取 Dawn HLSL 转储，新增提取器读取 DXIL 中实际的 shader profile。确认浏览器使用 `vs_6_8` / `ps_6_8` / `cs_6_8`；上一轮逐份 HLSL 测试使用的 6.0 只能作为历史对照，不能充当实际后端参数的完整验证。原先误标为 VS 的一份计算着色器改为依据 DXIL 类型提取。
- 新增 `diagnostics/dxc-batch.cpp` 和 `probe-dxc-host.ps1`，通过同一份 Google DXC 的 `IDxcCompiler3` 重放 53 份实际 HLSL，不需要 UE、浏览器或 GPU。每次新建编译器实例也曾失败，不能视为实例复用已定位。脚本记录 DLL、输入、可执行文件和来源哈希、CPU 拓扑及退出状态，整批超时只结束自己创建的子进程；一秒超时负例已验证。
- Windows 拓扑确认本机 i9-14900KF 的逻辑核心 0–15 为效率等级 1、16–31 为等级 0。实际 SM 6.8 输入只允许前一组运行时，4.47 秒后以 `0xC000001D` 退出，日志为 `Function.cpp:719` 的 `UNREACHABLE`；报告为 `web-default-dxc-host-sm68-pcores-results.json`。相同输入限制到后一组时，100 轮、5,300 次编译完成，耗时 113.06 秒。这是运行条件差异，不等于已经证明 CPU 损坏。
- 默认调度也有通过反例：独立编译的 5,300 次 SM 6.0 测试通过；SM 6.8 两个独立进程各 30 轮、1,590 次同时测试也通过，执行日志显示任务多次落在后一组核心。普通 Chrome 单独运行的 100 次完整管线回放全部通过，报告为 `web-default-pipeline-sync-default-stress-results.json`；更早与独立编译同时运行的 20 次回放有 1 次失败。不能用后续通过覆盖之前失败，也不能将同时运行与故障直接认定为因果。
- 一次默认调度的 SM 6.8 长循环在第 55 轮第 45 份输入处停止前进，进程仍持续占用单线程 CPU；保存 `results/fog-crashes/dxc-sm68-default-hang.dmp` 后手动结束。转储线程在 `dxcompiler.dll + 0xb46045`；该次退出码 `-1` 来自手动结束，不是编译器原始异常码，也不记作成功或自动超时。
- 受限核心组下，Chrome DPR 2 普通关卡连续 5 次启动、各至少 180 帧及原生 Pawn 移动通过。两浏览器的高度雾六组参数控制、云开关、三维纹理各 mip 抽样回读、HDR、FXAA、Bloom、LUT 和曝光对照再次通过，报告为 `web-default-postprocess-cpu-affinity-results.json`，其中 `hostCondition` 明确标记 `0xffff0000`，截图也使用独立后缀。受限条件只能用于诊断，不能替代默认浏览器稳定性验收；本轮为效果探针增加 `--report=`、独立截图后缀和 `hostCondition`，避免不同条件相互覆盖。
- 最后一次普通 Chrome 全效果对照也通过，最终 1,699 帧，页面错误、GPU 校验错误和设备丢失均为 0；正常/暗场/恢复曝光约 1.1546 / 11.5682 / 1.1545，高度雾恢复后继续绘制 60 帧。当前 `web-default-postprocess-results.json` 只包含这次默认调度的 Chrome 结果，两浏览器受限条件报告另存；单次成功不表示已修复冷启动，普通页面高 DPI 回归中的失败记录仍保留。
- 复现说明见 `tests/web-platform/diagnostics/README.md`。目前没有可宣称完成的启动修复；证据指向需要重点核对的主机 P 核执行条件，仍需另一台机器对照，区分主机稳定性、编译器内部缺陷及其交互。暂不通过关闭高度雾、云、抗锯齿或校验来改变验收条件。

## 2026-10-22：定位看天空时的持续低帧率

- 本轮针对用户“看天空卡成 PPT”做性能对照，没有继续扩大效果范围，也没有修改引擎、关卡、发布配置或包。新增 `probe-web-default-performance.cjs`，在相同位置、固定视角和分辨率下对比云/高度雾四种开关组合；两轮反转测试顺序，分别测默认 -15 度视角和实际鼠标输入转到约 70 度的抬头视角。每组预热十帧后采样三秒，不把首次编译时的停顿当作持续性能。
- 使用本机 RTX 3070、Chrome 155.0.8059.86、默认 CPU 调度；CSS 视口为 1848×1120，画布保持 16:9。DPR 1 实际为 1848×1040，DPR 2 为 3696×2079。正常材质时间继续推进，因此不同运行之间的云形态及精确耗时会变化；这不是完全冻结场景下的缩放效率测试。
- 当前云配置为 `r.VolumetricRenderTarget=0`、`r.VolumetricCloud.DisableCompute=1`。移动入口直接调用原生全分辨率像素步进，`FCloudRenderViewPS000` 直接混合到场景颜色；尚未接入低分辨率云目标、历史重投影及重建。地平线附近光线穿过云层更长，不能用“正上方一定最慢”推断瓶颈。
- 首次 GPU 抽样在 DPR 1 得到开云约 31～40 FPS、关云约 118～120 FPS；DPR 2 默认和抬头视角开云均约 10 FPS，关云约 119～120 FPS。只关闭高度雾仍约 10 FPS。云通道在高 DPI 下约 92～99 毫秒，其他通道合计约 1～2 毫秒，已经足以解释持续低帧率。
- GPU 探针只给测试设备申请 `timestamp-query`，每种组合另抽样五帧，不在 FPS 采样期间逐帧读回。记录真实渲染/计算通道起止时间及实际 draw/dispatch 的入口，再依据 Cook 作业映射回原始着色器；云开关必须实际移除/恢复云通道。GPU 通道之和不含 CPU 提交、通道间空隙与呈现等待，报告中的 FPS 是引擎 Tick 完成速率。
- 探针开发时保留了四份失败：UE 角度使用 0～360 度表示及鼠标输入合并使两次相机目标断言失败，之后改为角度归一化和实际输入反馈；两次雾断言误将 `FMobileFogPS` 整体等同高度雾。源码表明关闭高度雾后仍执行大气透视排列，最终按排列第一位识别 `FSupportHeightFog`：原高度雾排列为 49，大气透视排列为 32。高度雾与 BasePass 共享 GPU 通道，不将整个通道时间算作高度雾成本。这些探针错误没有修改运行包。
- 未启用 GPU 时间戳的普通设备请求对照也得到 DPR 2 开云约 10～11 FPS、关云约 117～120 FPS；只关闭高度雾仍约 10～11 FPS。由此确认持续卡顿主要来自当前体积云实现，高度雾不是主要瓶颈。实际体积雾仍是关闭状态，不能将本次结果称为“体积雾性能”。
- 最终版本 GPU 探针两档分辨率共 32 组、160 帧 GPU 抽样全部通过，包、探针、截图及着色器来源哈希核验有效。DPR 1 默认视角全开约 31.4～32.2 FPS、云约 28.0～28.9 毫秒；抬头全开约 43.8～45.6 FPS、云约 19.4～20.2 毫秒。DPR 2 默认视角全开约 10.6～10.9 FPS、云约 85.0～87.9 毫秒；抬头全开约 12.1～12.7 FPS、云约 73.4～78.6 毫秒。四组关云但保留高度雾的 GPU 通道总耗时分别约 0.68、0.43、1.88、1.01 毫秒，均约 119～120 FPS；只关闭高度雾没有同等提升。报告为 `results/web-default-performance-chrome-dpr{1,2}-verified-gpu-results.json`，错误及设备丢失均为零。
- 最终代码的普通设备请求再测 DPR 2 共 16 组，通过且错误、设备丢失为零：默认视角全开 10.6～10.8 FPS、只关雾 10.6～10.8 FPS；抬头全开 11.9～12.4 FPS、只关雾 12.3 FPS。两种视角只关云或全关均为 119～120 FPS。报告为 `results/web-default-performance-chrome-dpr2-final-ordinary-results.json`，与最终探针哈希一致。本轮最终三份报告合计 48 组，仅验证本机桌面 Chrome 的短时性能归因，不代表其他设备或长期稳定性。
- 优化方向：优先移植云的低分辨率步进、深度感知合成，再处理历史重建与转动残影；保留原始云材质及场景，不全局降低地面和 FXAA 分辨率。现有 `VolumetricRenderTarget.cpp` 只对 SM5 以上开放相关排列及视图入口，因此不能仅改一个配置就声称接入。当前本轮只完成诊断，没有宣称云性能已修复，也没有修复上一节的冷启动编译器异常。

## 2026-10-22：云低分辨率重建及高 DPI 性能验证

- 复用 UE 原生 `VolumetricRenderTarget` 模式 0：以场景四分之一宽高步进，在半分辨率重建历史，再以双边深度感知方式合成。云步进像素数量为全分辨率的约 1/16；这不等于保证整个云链路加速 16 倍。场景、地面和 FXAA 保持原分辨率，原始云材质、三维纹理和光线采样数不变。
- 移动渲染入口接入原生视图初始化、棋盘式半分辨率深度、云步进、历史重建及合成；隐藏云后重置历史。Web 只开放默认路径需要的五个全局着色器排列：深度一个、历史有无两个、合成高度雾开关两个。未开放云计算、MinMax 深度、局部雾、水下合成或 MSAA。
- 移动端不生成桌面 PartialDepth，因此 Web 云合成单独创建带默认资源的场景纹理参数，仅替换实际场景深度。新包含顺序暴露了 Web 能力函数与引擎全局函数的同名查找冲突，已将粒子判断限定为 `UE::WebGPU::SupportsGPUParticles`，不改变该判断的行为。
- 默认关卡配置启用 `r.VolumetricRenderTarget=1`、`Mode=0`、`UpsamplingMode=4`；保留 `DisableCompute=1` 以及原有其他效果设置。原生与 Web 构建覆盖、Cook 来源审计和设置清单同步加入重建、深度源码及配置。
- 扩展性能探针：`--require-cloud-reconstruction` 要求实际执行深度、四分之一宽高步进、重建及合成；`--max-cloud-ms=20` 约束包含上述阶段的云链路平均 GPU 耗时。`--full-resolution-clouds` 通过受限测试接口，在同一个二进制内切回原全分辨率路径作对照。性能测试仍使用正常推进的材质时间。
- 修改前的独立包在新增重建检查中失败，未创建低分辨率云目标；报告为 `results/web-default-performance-before-cloud-reconstruction-results.json`。首帧接入另外暴露两处 RHI 问题：没有清除绑定的半分辨率深度被强行读取清除值，及 RGBA16F 云深度被名称规则误判为不可过滤的硬件深度。现在只在 UE 明确要求清除时读取绑定值，NoAction 使用合法的确定清除值，并将云深度按可过滤颜色纹理绑定。失败记录保留在 `cloud-reconstruction-dpr2`、`cloud-reconstruction-dpr2-final` 报告，成功结果使用 `-validated` 后缀。
- 云合成着色器在移动端没有 `GetScreenSpaceData`，Web 移动分支复用桌面前向渲染的保守深度处理，不读取 GBuffer。该分支通过独立着色器快照的逐项差异审计，不修改安装目录。
- 最终原生 RenderCore、Renderer 及正常 Web UBT 编译/完整链接通过，安装输入哈希未变。强制关闭 ShaderMap/作业 DDC 的 Cook 完成，全局排列为 971，新增五个排列全部转换为 WGSL；Stage 为 383 文件、119,523,805 字节，独立包为六文件、301,503,516 字节。RHI 修改后重建原生插件，全局 recorded/bypass 各 63 项、视口各 36 项及静态/直接材质探针全部通过，包括原有深度 0.75、模板清值 37 和遮挡验证。
- RTX 3070、Chrome 155、默认 CPU 调度、3696×2079 画布下，同一新二进制切回全分辨率路径复现：默认视角云 GPU 平均 85.38～89.60 毫秒，抬头 72.43～75.10 毫秒，约 10.6～12.6 引擎 FPS。重建路径的完整云链路分别为 9.27～9.36、7.27～7.59 毫秒，含深度、步进、重建及合成；实际目标为 924×520 步进、1848×1040 重建，场景仍为完整分辨率。两份 GPU 报告共 32 组、160 帧抽样通过，错误及设备丢失均为零：`web-default-performance-cloud-{full-resolution,reconstruction}-dpr2-validated-results.json`。
- GPU 时间戳测试中，重建路径的短时 FPS 曾在 40～96 间波动，关云控制也有瞬态低帧，不将其混入普通设备结果或隐去。随后不申请时间戳、每组采样四秒的普通请求共 16 组通过：完整效果下默认视角 75.21～78.51 FPS，抬头 95.15～99.83 FPS，关云约 115.7～119.2 FPS；报告为 `web-default-performance-cloud-reconstruction-dpr2-ordinary-results.json`。材质时间正常推进，精确 GPU 耗时会随云形变化；结果不是完全冻结场景的缩放效率。
- 新增 `probe-web-cloud-reconstruction-quality.cjs`，在固定材质时间、同一相机下按“全分辨率→重建→全分辨率”对照，曝光仍按真实帧时长更新。1100×620 画布的天空区域平均 RGB 差异为 1.55/255，差异大于每通道平均 10 的像素约 0.72%；地面差异 0.47/255，恢复原路径的全图差异 0.60/255，均通过既定阈值且无 GPU 错误。该检查是静态画面对照，不代表逐像素无损或快速转动残影的定量验收。
- Chrome/Edge 完整效果回归通过：HDR、FXAA、Bloom、LUT、曝光明暗恢复、原始云开关、两张三维纹理各 mip 抽样回读和高度雾六组参数。曝光正常/暗场/恢复约 1.153 / 11.55 / 1.153；云恢复后天空平均差异约 0.65/255、0.002/255。报告为 `web-default-postprocess-cloud-reconstruction-results.json`。双浏览器默认关卡的太阳/天空开关、恢复、竖屏、窗口恢复及资源/配置哈希负例也通过，见 `web-default-scene-results.json`。
- DPR 1、1848×1040 下另测 16 组、80 帧 GPU 抽样通过：完整效果默认视角 120.0 FPS、云链路 2.84～2.92 毫秒，抬头 119.5 FPS、3.17～3.39 毫秒，错误及设备丢失均为零。报告为 `web-default-performance-cloud-reconstruction-dpr1-validated-results.json`。
- Chrome 连续交互 61.4 秒、7,762 帧通过，原生 Pawn 移动、转向、升降、失焦释放和恢复均正常，测试后段线性内存增长为 0。Edge 七项交互检查也通过；Edge 本次未重复一分钟持续测试。报告分别为 `web-default-interaction-chrome-results.json`、`web-default-interaction-edge-results.json`。
- 提交前核对最终构建、Cook、Stage、独立包、原生 RHI、性能、画面及交互共 16 份成功报告：1,286 个来源/产物/截图审计条目、1,006 个不同文件的 SHA-256 均与当前文件一致；修改的 CJS、PowerShell 语法检查及两个仓库的 `git diff --check` 均通过。
- 目前只承诺默认关卡所用的模式 0；云计算、MinMax 深度、云影、SkyAO、体积雾、水下云合成及 MSAA 仍未接入，场景继续使用 FXAA。此前独立 DXC 冷启动异常没有在本轮得到根治，本轮通过的浏览器会话不替代跨设备、长时间稳定性验收。

## 2026-10-22：密集云性能与纹理通道优化

- 用户指出默认视角和头顶正常不能代表整片天空的性能。新增 20 度仰角、四个朝向的密集云，以及地平线、40 度仰角和俯视；所有视角通过真实鼠标定位，不改变 Pawn 位置。旧包在密集云复现约 16～17 毫秒的完整云链路，先前 7.3～9.4 毫秒的两个视角不作为本轮验收。
- Web 模式 0 新增 `r.VolumetricRenderTarget.WebTracingDownsampleFactor`，默认关卡取 4：在场景八分之一宽高步进，沿用原生 4×4 时域顺序，在半分辨率重建并合成到完整场景。同步修正采样抖动中心，步进尺寸改变时使旧历史失效；其他平台及其他模式保持原分辨率选择。地面、场景颜色和 FXAA 分辨率不变。
- 首次通道诊断将纹理槽对应关系判断错误：真正的 `Material_VolumeTexture_0` 是 Lightning，只读取红；`Material_VolumeTexture_1` 才是 PerlinWorley，会读取红、绿。将 PerlinWorley 缩成 R16F 虽然明显变快，却让云形消失。`cloud-dense-r16-*` 的低耗时及同一错误资源内的重建差异通过均作废，不作为优化成果。人工截图复核及原有云开关图像检查发现了此问题。
- 修正为 PerlinWorley 的 RG16F 和 Lightning 的 R16F。增加独立 Win64 Cook 模块 `TextureFormatWebCloud`，只从原生线性 RGBA16F 输出逐位保留红、绿；不修改安装引擎的纹理编码器。格式选择要求显式默认关卡 Cook 标志及两个资产的完整路径，其他体纹理保留 RGBA16F，不泛化丢弃任意资源的通道。
- 对当前单 mip 的 PerlinWorley Cook 产物逐项核对：2097152 个体素、4194304 个红绿半浮点值与旧 RGBA16F 包逐位相同；资源导出从 16777485 字节降到 8388875 字节。Lightning 的七级 mip 导出为 599521 字节。没有降低体纹理尺寸或将密度量化到八位。
- 实际 GPU 检查增加渲染通道的纹理视图及绑定槽记录，按 Cook 反射解析每个 `Material_VolumeTexture_N` 实际绑定的资产，再核对 WGSL 读取通道均在存储格式内；不再从纹理变量序号推断资产。每张体纹理、每级 mip 仍抽样三点回读验证上传。这不是全部体素逐个 GPU 回读。
- 隔离主光线、阴影采样和空密度步长：空密度倍步对默认材质没有明显帮助。48/2 虽更快，但密集云和地平线平均差异约 3.90、4.11/255，转向后约 3.64/255，超过原有阈值，未采用。48/4 通过五个视角及转向后检查，故默认配置使用主光线最多 48 次、阴影最多 4 次，保留原始云材质、灯光和地图。
- 性能探针新增视角选择、采样预算对照、实际步进目标尺寸及云链路预算检查。相机测试修正 UE 的 0～360 度表示，并在多次定位间连续使用锁定鼠标，避免重复点击造成累积跳转；失败记录保留。诊断 JS/WASM 通过正常 HTTP 覆盖加载，修正大文件经 CDP 响应正文超出容量的问题；正式包验收不使用运行时或纹理覆盖。
- 最终普通 UBT Web 编译及实际链接通过，原生 Renderer 的 40 项构建任务通过，安装引擎输入未改动；原生 RHI 静态 uniform 与视口记录/直通回归通过。最终 `20261022-132633` Cook 禁用着色器 DDC 后通过，枚举 971 个全局排列，零着色器转换失败；Stage 为 383 个文件、109337625 字节，独立目录为 6 个文件、291324584 字节。
- 正式包 Chrome、Edge 的云、HDR、FXAA、Bloom、LUT、自动曝光及高度雾回归通过。实际绑定验证 PerlinWorley 使用 RG16F、Lightning 使用 R16F，每个浏览器分别完成 3 和 21 个体纹理采样回读；云开关的天空平均差异约 9.90～9.93/255，恢复差异小于 0.025/255，确认云形未丢失。雾密度、起始距离、高度衰减及恢复控制均通过，页面/GPU 错误为零。
- 最终发布设置的 Chrome 五视角画面对照通过：天空平均差异最高 2.7663/255，明显变化像素最高约 4.25%，默认视角地面平均差异 0.5175/255，恢复平均差异均小于 0.673/255；转向后平均差异 2.2190/255。报告为 `web-cloud-reconstruction-quality-cloud-dense-rg16-packaged-results.json`，参考是同一二进制内的四分之一宽高、原采样预算路径。
- 普通设备请求的六视角、48 组 FPS 对照保留在 `web-default-performance-cloud-dense-rg16-ordinary-results.json`。本轮存在明显并发负载：掉帧期间另一 UnrealEditor 进程的 3D GPU 计数约 58%，整卡约 99%，显存约 7320/8192 MiB；开云、关云均有波动，不能从这批数据承诺稳定 120 FPS。后续 GPU 计时现场快照另存 `web-cloud-dense-host-context.json`，它是一个时间点的外部负载记录，不是完整运行期间的连续采样。
- 严格 2.5 毫秒门槛的首次正式包测试失败，默认视角一组达到 3.9059 毫秒，保留 `web-default-performance-cloud-dense-rg16-packaged-results.json` 的失败，不改阈值冒充通过。随后不设耗时门槛的全九视角观测完成 72 组、360 个 GPU 帧，实际云/雾开关、八分之一尺寸、深度降采样、重建及合成执行检查均通过；其通过状态只代表这些功能检查。该次所有开云组的五帧均值为：默认 1.1010～1.1797、地平线 1.5335～1.7040、四个密集云方向 1.8612～2.2414、40 度仰角 1.8874～2.1365、头顶 1.2451～1.8220、地面 0.3407～0.3539 毫秒。报告为 `web-default-performance-cloud-dense-rg16-loaded-results.json`，完整云链路包含深度降采样、步进、重建和合成；这些组均值不能代表每帧上限。
- Edge 三视角及转向后画面对照通过，天空平均差异最高 2.6745/255，默认地面 0.2389/255，转向后平均差异 1.2610/255。Edge 严格 GPU 预算测试仍有一组达到 6.9599 毫秒而失败，同场关云控制组的一个整帧 GPU 通道和达到 58.5236 毫秒；保留 `web-default-performance-cloud-dense-rg16-edge-results.json`，不据此宣称跨浏览器稳定达到 2.5 毫秒。
- 最终独立包的 Chrome、Edge 原图、方向光/天空开关与恢复、竖屏及窗口恢复图像检查通过，资源包与配置哈希破坏测试通过。Chrome 的七项交互及 61.233 秒持续运行通过，最终 8051 帧，线性内存为 231997440 字节、预热后增长为零，统计历史保持 14 帧；本轮只验收该时长，不沿用旧包的十分钟结果。参考引擎修改提交为 `72998ded0`。
- Edge 七项交互检查通过，未追加长时间运行。提交前对 14 份当前成功报告、2 份预算失败报告及复用的历史 RenderCore 构建记录核对 1331 个审计条目、1054 个不同文件；本轮报告的来源、产物和截图均匹配。历史 RenderCore 报告唯一不再匹配的是后来由 Renderer 构建刷新的共享 UBT 工具 DLL，RenderCore 源码及模块产物仍匹配，未改写历史报告或把旧工具指纹当成本轮工具验证。结果保存在 `web-cloud-dense-final-audit-results.json`，其中明确记录性能验收尚未完成。修改的 CJS、PowerShell 语法及两个仓库的 `git diff --check` 通过。
- 仅验收默认关卡所需的模式 0。八分之一宽高及较低光线预算会降低云细节，并非桌面画面的逐像素复现；转向检查只比较转向完成后的图像，不代表运动中每一帧均无残影。此前独立 DXC 冷启动异常仍未修复，也未做同视点、同分辨率的原生桌面计时对照。

## 2026-10-22：手机启动诊断与脚本正文检查

- 原先 `error` 事件统一回落为 `Engine script failed`，脚本资源错误没有 `message` 时丢失了 URL 和阶段。独立页面现在保留首个失败原因，区分资源、JavaScript、Promise、安全策略及 GPU 错误，提供手机可滚动查看、复制和下载的 JSON 报告；正常页面失败时自动展开。
- 引擎加载前检查 WebGPU、安全上下文、跨源隔离、Web Crypto、BigInt 数组和最小 memory64 模块。轻量模式 `?diagnostics=1` 只检查六个文件的 HEAD、下载约 348 KB 的引擎 JS，以及六种小纹理和一个空计算管线；不执行引擎脚本或下载约 181 MB 的 WASM、109 MB 的内容包。`?debug=1` 才启动真实 UE，并记录实际适配器、设备要求、运行日志及帧数。
- 用户真机 Edge 报告中的基础能力全部为 true，但在 `engine-script-loading` 资源事件失败，日志为空、帧数为零。2026-10-22 06:19:40.795Z 开始，到 06:32:02.003Z 报错相差约 12 分 21 秒；没有原始请求时间和前后台记录，不能直接把整段时间认定为网络传输耗时。HEAD 200 不能证明正文或脚本加载成功；当前尚无证据指向云、雾、完整 WASM 编译或手机内存。
- 报告版本 2 增加实际 JS GET、正文长度和 SHA-256、最终 URL、重定向、下载耗时及页面前后台记录。JS 探针限制为 1 MiB / 12 秒，区分 HTTP 错误、网络失败、HTML 正文和错误 MIME；原始脚本请求另记录结果、耗时及浏览器提供的 Resource Timing。普通页面只在脚本加载失败后补发 HEAD / GET，不改变成功启动时的加载方式。
- 测试先复现 HEAD 200 / GET 失败及正文可达但脚本加载失败的不同情况：旧版本缺少正文证据，新增断言有 12 项失败。补充诊断后，Chrome、Edge 共 40 项故障注入、首因保留、预检、导出和 360×626 布局检查全部通过；包括真实 CSP 脚本阻止与 GET 重定向检查。服务 HEAD 分支只返回响应头，不打开资源正文。
- 独立包重新生成，保留六文件及原有 JS、WASM、Cook 资源；当前总大小为 291341184 字节。两浏览器均通过真实轻量资源 / GPU 检查，JS 全文长度与本地 SHA-256 一致；各自调试启动至少 120 帧，实际 GPU 设备已创建、UE ready，无页面或 GPU 错误。证据为 `web-default-diagnostics-current-results.json`；历史失败为 `web-default-diagnostics-before-results.json`、`web-default-diagnostics-before-body-probe-results.json`。
- 最终包的 Chrome、Edge 原图、方向光 / 天空开关与恢复、竖屏 / 窗口恢复及内容 / 配置哈希破坏测试通过，见 `web-default-scene-results.json`。局域网回归完成本机 / 网卡地址共 12 次资源响应检查；两浏览器使用受信任的网卡来源均渲染 187 帧并实际移动约 425 单位，未信任来源提示也通过，见 `web-lan-results.json`。这是本机访问网卡地址，不能替代其他设备的实际测试。
- 当前修改仅涉及启动页面、测试服务、诊断回归与说明；未改引擎运行代码、渲染效果或安装目录。本机服务继续监听 `0.0.0.0:8765`。轻量检查及桌面缩小窗口不代表真机能够编译完整 WASM、渲染场景或满足性能要求；当前没有 ADB 真机连接，下一步需要手机在新版页面导出包含 JS GET 的报告，手机故障尚未宣称修复。

## 2026-10-22：继承手机报告并补齐实际下载与编译记录

- 继续核对原会话最后的真机 Edge 轻量报告：`mode=diagnostics-only`、`stage=diagnostics-complete`、`pending=0`、无错误。347637 字节 JS 正文完整、长度一致、SHA-256 与当前本地构建一致，GET 耗时 9559 毫秒；Adreno 适配器、六种小纹理及空计算管线均通过。`frames=0`、`ready=null` 是未执行引擎的结果，不据此判为渲染失败，也不把基础通过当作完整手机验收。
- 本地分段 HTTP 复现发现旧页没有真实 WASM 请求和进度记录，脚本 onload 还会覆盖已进入的下载阶段。版本 3 在 `?debug=1` 记录 WASM、内容包和两份清单的状态、正文实收字节、完成标志、最近进度时间和耗时；分别记录原生 `instantiateStreaming` 与 ArrayBuffer 实例化的结果和原始异常。流式编译与下载可能重叠，阶段不解释为严格串行计时。
- 调试观察转发原始读取流并保留背压，不 clone 大响应、不额外下载引擎；MIME 等流式失败时释放弃用请求，保留引擎原有回退。普通页面不安装 fetch 或 WebAssembly 包装器。`settled` 只在轻量检查完成、UE ready 或失败时置为 true，不再把脚本 onload 当作启动完成。
- 轻量检查成功后启用“启动引擎”按钮，跳转同页 `?debug=1`；用户也可直接打开该参数。导出报告增加 `elapsedMs`，长下载期间仍可复制或下载未完成报告。下一份手机报告可区分脚本资源事件、WASM 下载、实例化异常及内容下载/挂载。
- 新增 `probe-web-startup-transfers.cjs`：本地服务先发送部分真实 WASM 格式字节并暂停，再检查中途进度、完成、截断、404、MIME 回退、编译错误和取消。旧页双浏览器 12 项诊断失败、2 项普通加载对照通过；版本 3 的 14 项全部通过。该报告明确为小样本诊断夹具，不冒充完整引擎测试。
- 独立包重新生成，仍为六文件，共 291347418 字节，JS/WASM 和 Cook 资源未变。Chrome、Edge 原有 40 项诊断回归通过；真实轻量检查后点击启动及直接调试启动共四次，各至少连续渲染 120 帧，无页面或 GPU 错误。真实 WASM 和内容包分别实收 181003078、109337625 字节，完整标志与长度检查通过。报告为 `web-default-diagnostics-current-results.json`、`web-startup-transfers-current-results.json`。
- 当前独立包普通页面的原图、方向光/天空关闭与恢复、竖屏与窗口恢复，以及内容包/配置哈希破坏检查均在 Chrome、Edge 重新通过，报告为 `web-default-scene-results.json`。360×626 诊断面板的自动布局检查及截图检查通过；仍是桌面浏览器小窗口，不作为手机真机证明。本轮没有重跑长时间稳定性或性能验收。
- 当前无 ADB 真机连接，尚未收到手机实际调试启动报告；手机脚本加载故障、完整 WASM 编译和场景性能均未宣称修复。本轮只修改外围启动诊断、回归与文档，未改参考引擎或安装目录。原有桌面 DXC 冷启动偶发故障也不在本轮修复范围。

## 2026-10-22：默认关卡增加单指触屏旋转

- 用户确认之前启动失败来自网络问题，手机现在可以渲染，并要求先补触屏旋转视角。本轮按此继续，不再针对已澄清的网络报告推测渲染兼容故障；手机帧率、画质和长时间稳定性仍未验收。
- 独立启动页使用 Pointer Events 跟踪首根手指，按 CSS 像素计算增量，映射为已有右键按下/相对鼠标移动/释放事件，经原有 Web ApplicationCore 和 UE 摄像机输入处理。不直接修改摄像机，也不重建或替换 JS/WASM。画布内设置 `touch-action: none` 并禁用文本选择；触控点击不请求鼠标锁定，诊断面板继续保留自身滚动和按钮。
- 手指抬起、触摸取消、指针捕获丢失、焦点丢失及切到后台时释放拖动；重新落指从当前位置建立起点。焦点丢失时同时清除活动画布焦点，保证下次触摸能重新激活 UE。第二根手指不接管视角，不引入移动摇杆或双指缩放。
- 新增 `probe-web-default-touch.cjs`，用真实完整独立包和 Chromium 原生触控模拟验证实际 UE 摄像机。改动前 Chrome、Edge 的横竖屏四组均复现拖动后摄像机不动；改动后 DPR 3、360×626 和 844×390 四组共 32 项检查通过，覆盖双轴旋转、抬手停止、重触/轻点不跳变、第二指、取消、焦点释放和恢复，以及无滚动/缩放/指针锁定。每次检查实际位置未平移，四张渲染截图非黑比例至少 99%，无页面或 GPU 校验错误。报告为 `web-default-touch-current-results.json`，历史失败保留为 `web-default-touch-before-results.json`。
- 初轮自动化发现窗口失焦后再次触摸无法恢复，补齐画布失焦后通过；截图尺寸断言另修正为先核对画布实际 DPR 像素尺寸，再允许截图 CSS 裁剪取整。摄像机旋转与无错误阈值未放宽。最终四组图片尺寸和画布尺寸均检查通过，横竖屏截图已人工查看。
- 独立包仍为六文件，共 291349553 字节；仅 HTML 改变，沿用已审计的 JS、WASM 和 Cook 资源。Chrome 正常鼠标锁定模式和 Edge 拒绝锁定后的右键拖动各七项原有键鼠交互检查通过，40 项启动诊断/导出/面板布局回归通过。相关报告为 `web-default-interaction-chrome-results.json`、`web-default-interaction-edge-drag-results.json` 和 `web-default-diagnostics-current-results.json`；本轮未追加持续运行时间。
- 当前变更已由原服务提供，刷新普通页即可使用；调试页需要先关闭诊断面板以触摸画布。最终检查发现网卡已切换为 WLAN `10.199.199.245`，原 `10.1.1.200` 已不存在；新地址返回 HTTP 200 并包含触控逻辑，服务保持原进程监听 `0.0.0.0:8765`。已更新当前入口说明；未改系统网络或浏览器来源配置。自动化使用桌面浏览器触控模拟，新增触屏功能仍待手机试用；没有修改参考引擎和安装目录。

## 2026-10-22：默认关卡增加加载界面

- 用户反馈每次打开页面长时间黑屏，要求显示加载进度。普通页面现在从 HTML 首次显示起覆盖加载界面，显示当前阶段、实际下载容量、单个文件的百分比和等待秒数；横屏、竖屏及桌面布局均可使用。
- 普通页面复用已有的流式请求观察，分别显示 WASM 和场景包的真实已读取字节，不合成虚假的全程百分比。无 Content-Length 或压缩响应只显示已读取容量；脚本、编译、场景校验装载和关卡启动显示具体步骤。继续保留原生流式实例化及其回退，不增加完整引擎下载或第二份 WASM 缓冲。
- 资源完整性检查保持启用，装载阶段另记录已处理/总文件数。通过 Emscripten 现有 setStatus 在同步引擎启动前显示阶段；UE ready 且帧计数达到 2 后才隐藏界面。主线程同步初始化仍可能暂时影响动画刷新，本轮未修改引擎启动线程。
- 普通页面出错时在加载界面保留首个原因，提供“重新加载”和“查看详情”；调试模式保持自动展开诊断。轻量模式仍只显示诊断面板，不下载完整引擎。已有报告版本 3、复制和下载功能继续可用。
- 分段 HTTP 回归扩展为双浏览器 24 项，全部通过：普通/调试实时进度、脚本等待计时、未知长度、横竖屏及桌面布局、首帧前不隐藏、失败与详情、404、断流、编译错误、MIME 回退和取消。加载界面的三档视口截图已查看。初次运行的两个失败来自测试在诊断面板已关闭后重复点击关闭按钮，修正测试后通过，未放宽实际进度或首帧断言。
- 完整独立包重新生成，仍为六文件、291356910 字节，仅 HTML 更新，JS/WASM、Cook 和安装引擎未改。Chrome、Edge 共 40 项原有诊断/导出检查及四次真实启动通过，各次实际引擎至少运行 120 帧；横竖屏 DPR 3 的四组触屏回归共 32 项通过，真实 UE 相机继续可旋转。
- 最终独立包在两浏览器的原图、方向光/天空关闭与恢复、竖屏/窗口恢复检查通过，无页面或 GPU 错误；内容包和配置哈希破坏均在开始渲染前拦截。完整画面证据为 `web-default-scene-results.json`，加载、诊断和触屏分别见 `web-startup-transfers-current-results.json`、`web-default-diagnostics-current-results.json`、`web-default-touch-current-results.json`。
- 当前服务继续监听 `0.0.0.0:8765`，普通入口刷新后即可显示加载界面。桌面模拟及短时回归不代表手机真机或长期性能验收，本轮没有重新测试真机。

## 2026-10-27：默认关卡桌面 SM5 首版已发布

- 首版目标仍是 `/Engine/Maps/Templates/Template_Default`。新增独立 SM5 延迟渲染 Cook、Stage 和候选包，启动参数与资源清单共同区分桌面和 ES3.1，防止仅改页面标签或混用着色器档案。原地图、灯光和材质资源不修改，八个测试球继续以运行时附加方式创建。
- Web RHI 增加桌面 GBuffer/速度缓冲所需格式、立方体数组、数组各层 mip 初始化、整数纹理局部清零和设备限额申请。修正 GBuffer sRGB 目标、没有像素输出的附件写掩码和不透明覆盖的混合状态；存储纹理布局使用实际反射的格式及读写权限。桌面包启动前检查 Tier1、Tier2、RG11B10 可渲染和 Float32 可过滤能力。
- 着色器转换 v23 增加桌面 32 位类型缓冲映射、保留纹理隐式 mip 选择的导数诊断策略，以及仅删除已无对应指令的扩展 gather 能力声明。天空大气存储纹理使用实际可写的 RGBA16F；曝光使用非原子直方图和匹配的 RGBA32F 存储目标。Subsurface Profile 默认查找表使用可过滤的半浮点编码。
- 保留 UE 桌面 BRDF、直接光和天空反射代码，Web 分支只处理 Tint 导入限制。TAA 的 NaN 检测改用等价的位检测；全局排列筛选正确识别布尔维度，按平台能力排除未实现的 MSAA 扭曲和双源混合变体。未实现的可选桌面通道仍通过 Web 局部能力限制处理。
- Bloom 使用 UE 原有手工边界权重处理黑色边界，空间放大沿用着色器现有的视口内采样约束；两处仅为 Web 选择 Clamp sampler，没有在 RHI 全局把 Border 改为 Clamp。
- 原生 RenderCore、Renderer、RHI 和普通 UBT WASM 编译链接通过，安装引擎来源哈希保持不变。无着色器 DDC 的完整 SM5 Cook 通过：202 包、零错误、15 个警告；3160 条转换作业记录中有 3158 份成功模块产物。Chrome、Edge 分别验证全部 3158 个模块，零编译错误；实际关卡另行验证管线和绘制，模块数不作为场景成功的替代。
- Stage 为 425 个文件、223013548 字节，候选独立包为八个文件、405286077 字节。`probe-web-desktop-resources.cjs` 在 Native Dawn/D3D12 的记录/直通模式各校验 6228 个纹理值、1792 个缓冲值，包含数组所有层和 mip、只清除指定层/mip 且相邻内容不变、Raw Buffer SRV 范围和生命周期的真实 GPU 回读。未在本轮运行旧 IES 负例组合；其中“数组不接受 CPU 初始化或多 mip”的旧断言已不适用于扩展后的能力，后续应更新，不能把本轮定向回归写成全部旧探针通过。
- 候选包在 Chrome、Edge 分别通过八球、原图、同视角截图、390×844 竖屏、窗口恢复、实际 Pawn 移动/转向和失焦释放；均完成一分钟持续运行，最终约 4070 帧，预热后线性内存增长为零、统计历史保持 14 帧，页面和 GPU 校验错误为零。观察到真实 GBuffer、`FDeferredLightPS`、`FReflectionEnvironmentSkyLightingPS`、`FTonemapPS` 和计算派发。
- 使用安装版 UE 只读启动原生 D3D12 SM5，采用相同地图、首版渲染配置、测试球材质/位置及相机，生成 `results/default-shadow-native-desktop-baseline.png`。`verify-web-default-desktop-comparison.cjs` 的四个区域对照均通过：Chrome/Edge 全图平均 RGB 通道绝对误差分别约 1.288/1.278（满量程 255），材质区约 1.127/1.126，地面约 0.765/0.764，天空约 2.051/2.022。这是同配置 SM5 对照，不是与开启 Lumen 的编辑器默认全效果等价。
- 已发布到 `http://127.0.0.1:8765/build/ue-default-template/index.html`；旧 ES3.1 发布包保留在 `build/ue-default-template-before-desktop-ece9934f7aaa`。发布器要求候选双浏览器、资源回读、原生对照和文件哈希全部通过，最后复制 HTML。实际发布地址复验通过：Chrome 4073 帧、Edge 4067 帧，均含一分钟持续运行、缩放及交互，预热后线性内存增长为零、无页面/GPU 校验错误。
- 冷启动稳定性尚未解决：发布后首次 Edge 检查在第 5 帧报 `A valid external Instance reference no longer exists.`，未出现先行 GPU 参数校验错误；原始失败保留为 `results/web-default-desktop-published-edge-cold-start-failure.json`。随后单独启动 Edge 通过，不足以证明双浏览器压力或实例生命周期就是原因，也不能覆盖既有 DXC/设备丢失问题。正常页面未限制 CPU 核心、未关闭云规避故障；本次一分钟测试不等于长期稳定性验收。
- 首版配置关闭 Lumen、VSM、光追和 Substrate，使用 SM5 桌面延迟渲染、4096 CSM、动态天空及天空环境光/反射，保留本地 IO 和纹理流送。当前不宣称具有完整实时多次反弹 GI，不等同于移植 UE 的全部 SM6 功能，也未完成别墅桌面路径或 8 GB 总显存验收。手机版及按能力自动选择构建留待后续独立实现。

桌面版本的复现命令（浏览器验收顺序执行）：

```powershell
& ./tests/web-platform/build-native-rendercore.ps1 -Module RenderCore
& ./tests/web-platform/build-native-rendercore.ps1 -Module Renderer
& ./tests/web-platform/build-web-engine.ps1 -MaxParallelActions 4
& ./tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-SM5 -Scene DefaultTemplate -StopOnShaderError -ValidateShaderJobCache
node tests/web-platform/stage-web-engine.cjs --default-template --desktop
node tests/web-platform/package-web-default-template.cjs --desktop
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-desktop-resources.cjs
node tests/web-platform/probe-web-default-desktop.cjs
node tests/web-platform/probe-web-default-desktop.cjs --edge
& ./tests/web-platform/capture-web-default-native.ps1 -Mode desktop
node tests/web-platform/verify-web-default-desktop-comparison.cjs
node tests/web-platform/publish-web-default-desktop.cjs
node tests/web-platform/probe-web-default-desktop.cjs --published
node tests/web-platform/probe-web-default-desktop.cjs --published --edge
node tests/web-platform/verify-web-default-desktop-delivery.cjs
```

`probe-web-desktop-resources.cjs` 需要最新普通原生 RHI 插件构建及既有 Worker 测试着色器；其报告记录 DLL、源码、构建日志和 GPU 回读哈希。全部转换模块检查另用 `probe-web-desktop-shader-modules.cjs --input=<本次 Cook 的 ShaderConversion 目录>`，再加 `--edge` 检查另一个浏览器。最终验收报告为 `results/web-default-desktop-delivery-results.json`，同时核验构建、Cook、Stage、包、模块、资源、原生截图、候选和发布实测的来源；`startupStabilityVerified=false` 明确保留冷启动边界。

## 移动路径的历史复现入口

以下命令从工作区根目录执行，是 ES3.1 历史流程；默认发布地址现已为桌面 SM5。运行旧流程的打包命令会覆盖当前默认目录，应先保留桌面包，或在完成后重新发布已经验收的桌面候选包。首次接入云或更新相应源码后，先重建隔离的原生 RenderCore、Renderer；已有来源和产物哈希一致的成功报告时可复用。`package-web-default-template.cjs` 要求普通 UBT 构建成功，不能用诊断链接冒充。

```powershell
& ./tests/web-platform/build-native-rendercore.ps1 -Module RenderCore
& ./tests/web-platform/build-native-rendercore.ps1 -Module Renderer
& ./tests/web-platform/build-web-engine.ps1 -MaxParallelActions 4
& ./tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-ES31 -Scene DefaultTemplate -StopOnShaderError -ValidateShaderJobCache
node tests/web-platform/stage-web-engine.cjs --default-template
node tests/web-platform/package-web-default-template.cjs
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-mobile-histogram.cjs
node tests/web-platform/probe-web-default-startup.cjs --runs=3
node tests/web-platform/probe-web-default-postprocess.cjs --clouds --exposure --fog
node tests/web-platform/probe-web-default-scene.cjs --packaged
node tests/web-platform/probe-web-default-interaction.cjs --browser=Chrome --seconds=600
node tests/web-platform/probe-web-default-interaction.cjs --browser=Edge --seconds=600
node tests/web-platform/probe-web-default-interaction.cjs --browser=Chrome --pointer-lock=denied --seconds=0
```

- 独立目录：`tests/web-platform/build/ue-default-template`，含 `index.html`、JS、WASM、配置、资源清单和资源包。需通过 HTTP 服务运行。
- 当前工作区已有服务，默认监听 `0.0.0.0:8765`：本机入口 `http://127.0.0.1:8765/build/ue-default-template/index.html`，当前局域网入口 `http://10.199.199.245:8765/build/ue-default-template/index.html`。服务不运行时可在独立终端执行 `node tests/web-platform/serve.cjs`；可用 `HOST`、`PORT` 覆盖绑定。局域网 HTTP 运行 WebGPU 需在测试浏览器单独信任该来源，具体步骤见 `tests/web-platform/README.md`；直接公开分发需受信任 HTTPS。
- 构建、Cook、Stage、独立目录和浏览器验收报告分别为 `results/web-engine-full-build-results.json`、`web-engine-webgpu-es31-default-cook-results.json`、`web-engine-webgpu-es31-default-stage-results.json`、`web-default-template-package-results.json`、`web-default-scene-results.json`。
- 仍是开发验证流程，使用工作区隔离的 5.8.0 原生 Cook 主机和 5.8.3 Web 源码覆盖；尚未接入编辑器一键 Web 打包，也不代表桌面渲染功能已全部移植。
