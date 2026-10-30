# 别墅 Web 渲染覆盖清单

核查日期：2026-10-30。对象为桌面 SM5、多线程、距离场入口：
`/build/triplex-house-villa-df-distance-fields-threads/index.html`。

此前把最小启动阶段的裁剪配置继续用于画质比较，且没有及时向用户列清差异，是这次排查成本的来源。SSR 关闭、FXAA 替代时域 AA、LTC 初始化缺失、接触阴影关闭和局部灯立方体阴影排除，都属于需要明确披露的实现选择，不能笼统描述成“网页已经保留桌面光照”。

## 生效来源

- 场景配置：`tests/web-platform/cook-profiles/TriplexHouseVillaFullresDesktopEngine.ini`。
- Cook 使用 `-DistanceFields`，生成独立 `DistanceFieldsEngine.ini`，把距离场生成从基础配置的 0 改成 1，并加入硬件光追关闭时仍支持距离场的选项。
- Stage 将上述 Cook 配置写入 `config-files.json` 的 `/Engine/Platforms/Web/Config/WebEngine.ini`。运行时加载此文件。
- 该入口没有使用 `TriplexHouseVillaDesktopEngine.ini`、移动配置或参考源码中的最小 `WebEngine.ini`。这些旧配置仍有不同值，不能据此判断当前页面。
- 当前打包报告为 `tests/web-platform/results/web-project-triplex-house-villa-df-distance-fields-threads-package-results.json`。报告及构建产物位于 Git 忽略目录。

上轮恢复当前别墅配置的 `r.ContactShadows=1`。本轮补齐 Web SM5 点光源/矩形灯的六面阴影生成与原有 PCF 投影，保持 SSR、TAA、AO 和灯光参数不变。实现、最终验证及边界见 [UE58_WEB_CUBE_SHADOWS.md](UE58_WEB_CUBE_SHADOWS.md)。没有修改资产、后处理体积、灯光组件或安装目录 `H:/UE_5.8`。

## 当前配置完整表

下表列出该入口的显式渲染配置。数值为 0 的枚举不一定代表关闭整个功能。

| 选项 | 当前值 | 行为及边界 |
| --- | ---: | --- |
| `r.pso.EnableAsyncCacheConsolidation` | 0 | 关闭 PSO 缓存异步合并；调度选择 |
| `r.TextureStreaming` | 1 | 保留贴图流送 |
| `r.Streaming.PoolSize` | 1024 | 贴图池 1 GiB，会影响驻留 mip；原图未统一降至 256 |
| `r.Streaming.MaxTempMemoryAllowed` | 32 | 流送临时内存 32 MiB |
| `r.Shadow.MaxCSMResolution` | 4096 | CSM 分辨率上限 |
| `r.NumBufferedOcclusionQueries` | 2 | 两帧硬件遮挡查询缓冲，遮挡查询仍执行 |
| `r.ForwardShading` | 0 | 采用桌面延迟渲染 |
| `r.DBuffer` | 0 | 关闭 DBuffer 贴花；其他贴花路径没有因此全部删除 |
| `r.Substrate` | 0 | 关闭 Substrate，使用传统材质路径 |
| `r.ScreenPercentage` | 100 | 保留原内部渲染比例 |
| `r.ScreenPercentage.Default.Desktop.Mode` | 0 | 手动比例模式 |
| `r.DynamicRes.OperationMode` | 0 | 关闭动态分辨率 |
| `r.AntiAliasingMethod` | 2 | TAA；此前为 1/FXAA，早期最小配置曾为 0 |
| `r.Histogram.UseAtomic` | 0 | 使用非原子直方图路径，曝光没有被整体关闭 |
| `r.SSS.Scale` | 0 | 关闭后处理次表面散射 |
| `r.MotionBlurQuality` | 0 | 关闭运动模糊 |
| `r.TranslucencyLightingVolume` | 0 | 关闭半透明光照体积，会影响半透明受光 |
| `r.HeterogeneousVolumes` | 0 | 关闭异质体积 |
| `r.RayTracing` | 0 | 关闭硬件光追；原项目配置为 True |
| `r.DynamicGlobalIlluminationMethod` | 0 | 无动态 GI；原项目同样为 0，不能把全部 GI 差异归为新增关闭 |
| `r.ReflectionMethod` | 2 | SSR；此前显式为 0；原项目全局配置也为 0，场景/视图最终设置仍需对照 |
| `r.ReflectionEnvironment` | 1 | 保留反射环境，历史版本曾关闭 |
| `r.ReflectionCapture.CookBakedCaptures` | 1 | Cook 反射捕获，历史版本曾关闭 |
| `r.Shadow.Virtual.Enable` | 0 | 关闭虚拟阴影贴图，原项目也为 0 |
| `r.SupportSkyAtmosphere` | 1 | 保留天空大气 |
| `r.SupportSkyAtmosphereAffectsHeightFog` | 1 | 保留大气影响高度雾 |
| `r.VolumetricCloud.Support` | 0 | 关闭体积云 |
| `r.SupportLocalFogVolumes` | 0 | 关闭局部雾体积 |
| `r.VolumetricFog` | 0 | 关闭体积雾；普通高度雾不是同一个开关 |
| `r.ContactShadows` | 1 | 上轮由 0 恢复为 1；本轮未单独验证其最终贡献，不能宣称链路已修复 |
| `r.AllowStaticLighting` | 0 | 关闭静态光照支持，烘焙光照/相关阴影不能作为已对齐项 |
| `r.VirtualTextures` | 0 | 关闭虚拟纹理 |
| `r.GenerateMeshDistanceFields` | 1 | 基础配置为 0，`-DistanceFields` 的实际 Cook/运行配置覆盖为 1 |
| `r.DistanceFields.SupportEvenIfHardwareRayTracingSupported` | 1 | 距离场 Cook 附加项 |
| `r.SkinCache.CompileShaders` | 0 | 关闭 Skin Cache 着色器 |
| `r.AllowGlobalClipPlane` | 0 | 关闭全局裁剪平面支持，影响需要它的平面反射；原项目为 True |
| `landscape.SupportGPUCulling` | 0 | 关闭 Landscape GPU 剔除；地形顶点工厂另有排除 |
| `r.GPUSkin.UseSceneExtension` | 0 | 关闭 GPU Skin 场景扩展 |
| `bAllowHighDPIInGameMode` | True | 游戏高 DPI 开启 |

没有在此配置中关闭 SSAO。`r.AmbientOcclusion.Method=0` 表示 SSAO 方法，不是 AO 禁用；`r.AmbientOcclusionLevels=-1` 是自动层级。DFAO 当前为 1，运行时装载 591 个网格距离场对象。AO 着色器执行不等于最终合成已与桌面完全一致。

## 配置以外的功能排除

### 与当前画面关系较大的项

1. **点光源和矩形灯的立方体阴影已在本轮恢复。**
   此前 `RenderCore/Public/WebShaderPlatform.h` 与 `Renderer/Private/ShadowSetup.cpp` 直接排除此类阴影，并未自动转为六遍绘制。
   现在 `SupportsPointLightShadows()` 包含 Web SM5 六遍路径；`SupportsOnePassPointLightShadows()` 仍对 Web 返回 false，表示不使用分层输出。
   复用 UE 原有灯光矩阵、材质透明裁剪、静态阴影缓存和 PCF 投影，通过独立二维深度面复制生成立方体。
   `Engine/Private/RectLightSceneProxy.cpp` 的桌面矩形灯同样设置该标志。
   本场景有 4 个点光源和 9 个矩形灯，其中 1 个点光源、5 个矩形灯启用了 CastShadows。
   LTC 提供光照/高光查表；本轮独立补齐了此前缺失的阴影。门把手与花盆投影已实际恢复，墙脚仍未达到完整桌面对齐。
2. 胶囊阴影被 `SupportsCapsuleShadows()` 排除。
3. 运动模糊、半透明光照体积注入、局部雾和体积雾除配置关闭外，相关着色器/运行路径也被局部排除。
4. Web 的体积云只保留有限像素变体，云阴影/AO 等多个变体不编译；当前别墅配置整体关闭体积云。
5. HairStrands/RenderCurve 场景扩展直接返回 false，Hair LUT 使用 1×1 回退。普通网格材质与完整发丝渲染不是同一个支持范围。
6. `SystemTextures.cpp` 省略 PerlinNoise3D；PreintegratedGF 强制 R8G8，未采用桌面可用的 G16R16 精度。GreenDummy 和 BlackDepthCube 初始化也被省略。桌面 SM5 的黑色 cube 和 LTC 已恢复。

### 其他明确的 Web 特性裁剪

`WebShaderPlatform.h` 中还排除了以下能力：

- GPU 粒子模拟、GPU 排序、ParticleSprite/GPUSprite 顶点工厂。
- GPUScene、SkinningScene；默认/Unlimited GPU Skin 和 APEX Cloth 顶点工厂。
- Landscape 顶点工厂和 Landscape 纹理捕获。
- Sparse Volume Texture 更新、虚拟纹理更新。
- OIT 三角形排序、SMAA、MSAA 和对应多采样 resolve。
- 移动遮挡反馈路径；桌面异步硬件遮挡查询仍保留。
- 编辑器/调试图元合成、HMD 畸变、灯形可视化、IES Atlas 调试、HDR 调试视图、VisualizeTexture、ShaderPrint 和 GPU DebugCrash 着色器。IES 灯光实际采样仍保留。
- 原子直方图变体；运行时使用非原子替代。

LightGrid 保留，但 Web 选择不使用 16 位 buffer、链表/两级剔除、部分 GPUScene 上传和调试灯名 buffer 的实现，工作负载模式固定为兼容路径。这些算法替代不等于删除所有局部灯。

3D 体积纹理没有接通原生的体积纹理流送。全局距离场保留；平台没有 VolumeTextureAtomics 时不生成对应 coverage atlas，不能因此描述成“全局距离场已关闭”。

### SM5 平台声明

`reference-engine/Engine/Platforms/Web/Config/DataDrivenPlatformInfo.ini` 声明下列能力为 false 或 Unsupported，因此其他 UE 编译/运行分支也会裁剪它们：

```ini
bSupportsMSAA=false
bSupportsGPUScene=false
bSupportsManualVertexFetch=false
bSupportsTypedBufferSRVs=false
bSupportsVertexShaderSRVs=false
bSupportsVertexShaderUAVs=Unsupported
bSupportsShaderPipelines=false
bSupportsSpecializationConstants=false
bSupportsVertexShaderLayer=false
bSupportsRTIndexFromVS=false
bSupportsClipDistance=false
bSupportsVolumeTextureAtomics=false
bSupportsInstancedStereo=false
bSupportsMobileMultiView=false
bSupportsIndexBufferUAVs=false
bSupportsUnrestrictedHalfFloatBuffers=false
bSupportsDOFHybridScattering=false
bSupportsHZBOcclusion=false
bSupportsWaterIndirectDraw=false
bSupportsNanite=false
bSupportsLumenGI=false
bSupportsRayTracing=false
bSupportsRayTracingShaders=false
bSupportsInlineRayTracing=false
bSupportsPathTracing=false
bSupportsMeshShadersTier0=false
bSupportsMeshShadersTier1=false
bSupportsWaveOperations=Unsupported
bSupportsBindless=false
bSupportsUInt64ImageAtomics=false
bSupportsVariableRateShading=false
bSupportsDualSourceBlending=false
bSupports4ComponentUAVReadWrite=false
```

另外限制 `MaxSamplers=16`、`NumberOfComputeThreads=256`。这些是本 Web 后端目前的接入范围，不能全部归为浏览器硬件的固有限制。`bSupportsDistanceFields=true`，ComputeFramework 也保留。HZB Occlusion 关闭不能解释为 AO/HZB 深度金字塔全部关闭；DOF Hybrid Scattering 关闭也不能解释为所有景深关闭。

## 渲染之外的运行限制

`UEWebEngine.cpp` 构造固定启动参数，包含 `-nosound`、`-norhithread`，当前不启用渲染线程。Target 禁用了 FreeType、Recast/导航网格链接和开发工具；Slate/UMG 依赖保留。准备项目会设置 `DisableEnginePluginsByDefault=true`，只启用明确列出的插件。它们不解释本次墙脚阴影，但属于当前移植与原项目运行环境的差异。

## 补齐阴影前的单项对照

同机位 1280×720、FOV 90、TAA、SSR、手动 EV100=-1，保持正常渲染时间：

- 原生 `contact-audit`：基线、仅关接触阴影、仅关 SSAO、仅关 DFAO、恢复，共 5 例。
- 原生 `cube-shadow-audit`：基线、仅设 `r.AllowPointLightCubemapShadows=0`、恢复，共 3 例。禁用立方体阴影后，门把手旁投影消失，部分墙面/地面遮蔽也改变。
- 网页 `contact-audit-baseline`：正式旧包，接触阴影为 0。
- 网页 `contact-audit-on-verified`：只在配置请求中覆盖 `r.ContactShadows=1`；配置哈希及引擎 Set CVar 日志确认覆盖到达引擎，无 GPU 错误。与旧包全图平均绝对 RGB 差仅 0.000060/255，未观察到对应阴影恢复。
- 网页 `contact-audit-no-ssao-verified`：只覆盖 `r.AmbientOcclusionLevels=0`；全图平均绝对 RGB 差为 0.12559/255，说明原网页 SSAO 对最终像素有贡献。这个全图均值不能证明用户圈出的细缝已正确合成。
- 原生关 DFAO 后视图大幅变亮，进一步证明 DFAO 是当前场景的主要天空光遮蔽来源之一。

当时确认的缺项是接触阴影默认关闭，以及点/矩形灯立方体阴影被排除。现已恢复接触阴影配置并实现局部灯立方体阴影，仍不能把截图全部差异归到 AO，也不能把接触阴影配置恢复称为完整修复。静态光照关闭也是对照差异，但截图有未构建光照警告，不能仅凭配置推断缺失了多少有效烘焙贡献。

初次 `contact-audit-on` / `contact-audit-no-ssao` 使用 HTML `--engine-args` 注入 `-ini:`，但启动器不转发任意 UE 参数，日志证明值未变化。这两组是**无效开关对照**，不能用于判断画面根因。测试脚本现明确拒绝 `-ini:`，应改用 `--renderer-settings=<JSON>`。这类诊断拦截不会修改发布包，报告标记其不能验收正式默认设置。

结果在 `tests/web-platform/results`：

- `villa-distance-fields-contact-audit-capture.json`、`villa-distance-fields-cube-shadow-audit-capture.json` 及对应 PNG。
- `web-distance-field-triplex-house-villa-df-distance-fields-threads-msedge-contact-audit-{baseline,on-verified,no-ssao-verified}-results.json`。
- `villa-crevice-shadow-audit-metrics.json`：描述性像素统计，不是桌面一致性评分。
- `villa-crevice-shadow-audit-comparison.png`：从左到右为原生基线、原生关接触阴影、原生关立方体阴影、网页接触阴影配置开启；上排墙面，下排墙脚。

`villa-crevice-shadow-cases.json` 固定这次向下观察墙脚的机位，记录墙面/墙脚区域并要求 SSAO、DFAO、SSR、LTC 实际路径保留。未设置假定已经修好的阴影像素阈值。原有三机位画质用例也新增 SSAO 绘制断言。

## 恢复配置后的验证

别墅重新完成 Cook、Stage 和打包。最终配置包校验通过，实际值为 ContactShadows=1、TAA=2、ReflectionMethod=2、GenerateMeshDistanceFields=1，未使用 SkyLight 排除选项。

| Edge 正式包测试 | 结果 |
| --- | --- |
| `lighting-audit-shipped` | 834 帧；车库/客厅/门厅通过；每例 SSAO 绘制 380/372/368 次 |
| `crevice-shipped` | 429 帧；SSAO 绘制 486 次、SSR 243 次；DFAO=1、LTC 纹理检查通过 |
| 两项 GPU 检查 | 无 GPU 验证错误、设备丢失或页面异常 |
| `ssao-audit-negative` | 诊断配置关闭 SSAO 后，绘制计数为 0，按预期在 `SSAO must draw during this case` 失败 |
| 无效 `-ini:` 参数负例 | 在启动浏览器前拒绝，提示改用 `--renderer-settings` |

该轮正式包两次启动日志均记录 `Set CVar [[r.ContactShadows:1]]`。这些结果验证默认配置恢复和现有路径未回归；**没有验证墙缝阴影已达到桌面效果**。该轮没有改动参考引擎代码；后续立方体阴影实现则同时修改了参考引擎和 RHI。

## 复测

```powershell
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-distance-fields.cjs --edge `
  --folder=triplex-house-villa-df-distance-fields-threads `
  --cases=tests/web-platform/villa-crevice-shadow-cases.json --tag=crevice-shipped
node tests/web-platform/probe-web-distance-fields.cjs --edge `
  --folder=triplex-house-villa-df-distance-fields-threads `
  --cases=tests/web-platform/villa-lighting-quality-cases.json --tag=lighting-audit-shipped
```

局部灯阴影现已补齐，六面复制和实际投影计数、开关像素对照及三机位回归均通过，详见 `UE58_WEB_CUBE_SHADOWS.md`。下一步应检查接触阴影和 AO 合成，以及静态光照的实际贡献。恢复单个配置值、无 GPU 报错、SSR/TAA 通过，都不能替代这些验收。
