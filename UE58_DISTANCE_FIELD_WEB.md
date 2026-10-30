# 桌面 WebGPU 距离场候选版

日期：2026-10-30。原生收益与实施依据见 [UE58_DISTANCE_FIELD_RESEARCH.md](UE58_DISTANCE_FIELD_RESEARCH.md)。

对应独立参考引擎提交：`5beee8ed1`；正常启动采样修复：`dd11b7507`；双面法线与桌面 LTC 修复：`2825faf2f`。

## 本轮实现

接通桌面 SM5 的网格距离场 Cook、稀疏砖块图集、全局距离场和 UE 原有 DFAO 天空光链路。没有用屏幕 AO、统一压暗或修改材质替代。ES3.1 不参与本轮；Lumen、距离场阴影和体积纹理原子仍未作为支持项交付。

Cook 必须显式传入 `-DistanceFields`，打包必须显式传入 `--distance-fields`；打包校验 Cook、配置、平台能力和源码哈希匹配。候选输出目录带 `distance-fields`，未覆盖原发布目录。

底层新增或补齐：

- R8/G8、R32_FLOAT、R32_UINT 三维纹理视图及非零清除。
- G8 上传缓冲的明确 UNORM8 字节解码；float/int 标量存储缓冲和 Raw UAV。
- GPU 间接派发、非索引间接绘制及 16/32 位索引间接绘制，保留参数范围和资源状态校验。
- 像素 UAV 所需的 UE 既有占位渲染目标路径。
- DFAO 分块索引使用 32 位布局；缺少体积原子时不编译 Lumen coverage atlas 排列。
- Web 着色器显式存储格式和全屏插值声明。
- 大缓冲清除使用二维派发，避免 4K 下超过 WebGPU 单维工作组上限。

距离场流送沿用 UE 的 BulkData 和现有本地 OPFS IO，没有新增逐网格网络下载。贴图继续保持全分辨率与原有 1 GiB 纹理流送池。

## 验证与边界

真实 WebGPURHI GPU 回读通过 30 项检查，两个命令模式合计核验 33,587,298 个值。其中包含实际 Cook 的距离场上传着色器、非连续砖块、未覆盖区域、非零哨兵、间接参数偏移，以及跨越 65,535 个工作组边界的大缓冲清除。诊断着色器包由实际 Cook 的元数据和未修改 WGSL 重建；该测试与浏览器实际加载 Cook 着色器库的测试分别记录。

默认关卡和别墅均已完成桌面 Cook 与多线程运行时打包。别墅候选：

- 591 个有效唯一网格距离场。
- CPU 距离场资源 1,139,392 字节，可流送 BulkData 13,406,176 字节。这是 Cook 后计量，不应和未 Cook 原生资产大小强行等同。
- 网格图集实际尺寸 1024×1024×32，R8，约 32 MiB；全局场页图集 1024×1024×16，约 16 MiB。
- 4K 的 DistanceFieldNormal、BentNormal 历史纹理分别可达到 1920×1080 RGBA16F。日志按标签记录最后一次创建的纹理描述，**不是完整当前/峰值增量显存账本**。
- 本地 IO 读缓存上限仍为 16 MiB；BulkData 未完整复制进 MEMFS。复用持久化缓存的 Chrome 1080p 复验下载量为 0。

首次 Chrome / Edge 的别墅 4K 实测均为内部 3840×2160、输出 3840×2160，开关、镜头移动、瞬移及返回原机位均通过，没有 GPU 验证错误或设备丢失。**这些首次图像和计时测试使用了 `-WebVisualTestClock`，冻结渲染时间，不能作为正常启动验收。** 测试保留多线程，但 Game 与 Render/RHI 未分离。

默认关卡在 Chrome / Edge 的 1280×720 回归分别运行 981 / 965 帧通过，恢复残差分别为 0.035 / 0。默认关卡没有在本轮按 4K 验收。

客厅同机位 `(-20,200,130,12,-35)`，测试相机使用手动曝光、请求 EV100=-1。off → on → off 的平均 RGB 差约 81/255；恢复残差约 0.49/255。该差异不是画质评分，也不能证明与原生逐像素一致。网页和已有原生同机位图都能看到相近的楼板、墙面遮蔽分布及块状伪影。冰箱颜色差异未追查。

本机 RTX 3070 8 GB 的短时采样：

| 浏览器 / 分辨率 | 关闭中位数 | 开启中位数 | 恢复中位数 |
| --- | ---: | ---: | ---: |
| Chrome / 1920×1080 | 8.36 ms | 9.28 ms | 8.07 ms |
| Chrome / 3840×2160 | 27.57 ms | 28.92 ms | 26.66 ms |
| Edge / 3840×2160 | 27.27 ms | 29.66 ms | 27.46 ms |

每项为 12 帧 GPU 通道时间之和，遗漏复制和通道间空隙；不是完整 GPU 帧时间，也不是性能保证。整适配器显存采样约 6.8～7.7 GiB，包含浏览器和其他应用，不能用于推导 DFAO 净增量。尚未完成长期运行、后台恢复、精确资源寿命账本、不同显卡能力分级和完整桌面画质对齐。

## 正常启动修复

用户诊断 `ue-startup-diagnostics-2026-10-29T11-21-22-796Z.json` 中，别墅在第 4 帧因 `SceneVelocity` 的 `UnfilterableFloat` / `Float` 采样声明不匹配中止。在 Edge 1668×938、原入口、不注入冻结时间的条件下已复现同一错误。构建产物哈希核验通过，失败发生在完成资源加载后的渲染阶段。

实际速度纹理为 `rg16unorm`，DFAO 的 `FUpdateHistoryDepthRejectionPS` 使用双线性采样；此前 RHI 只兼容了 TAA 的速度纹理绑定名。修复为：

- RHI 将 `VelocityTexture` 声明为不可硬件过滤的浮点纹理。
- 只在 Web 着色器分支，用四次带边界夹取的 texel load 和双线性插值保留 UE 原有采样语义。使用实际纹理尺寸，也兼容未生成速度时的 1×1 黑色回退纹理。
- 重编多线程运行时，重新 Cook、Stage、打包别墅与默认关卡。安装引擎未修改。
- 浏览器测试默认使用正常渲染时间；`--visual-clock` 仅显式用于静态图像对比。`--startup-only` 禁止冻结时间，要求 DFAO 历史纹理绑定持续执行，并检查缩放后恢复；别墅回归附加 `--require-velocity`，要求同时绑定真实 `SceneVelocity`。默认关卡只有静态物体，可以合法使用黑色速度回退纹理。

修复后，Edge 别墅 1668×938 正常运行 972 帧、记录 878 次速度/距离场历史绑定，通过镜头移动、瞬移和返回。Chrome 别墅 3840×2160 正常运行 1311 帧、记录 927 次绑定，并通过 960×540 → 3840×2160 的窗口缩放恢复。均没有 GPU 验证错误或设备丢失。具体报告：

- `tests/web-platform/results/web-distance-field-triplex-house-villa-df-distance-fields-threads-msedge-normal-clock-before-results.json`：修复前相同报错。
- `tests/web-platform/results/web-distance-field-triplex-house-villa-df-distance-fields-threads-msedge-normal-clock-fixed-results.json`：修复后 Edge。
- `tests/web-platform/results/web-distance-field-triplex-house-villa-df-distance-fields-threads-chrome-normal-clock-4k-results.json`：修复后 Chrome 4K，含缩放恢复。

最终测试脚本复验：Edge 默认关卡 1280×720 运行 597 帧、1192 次历史绑定；Edge 别墅 1668×938 运行 1167 帧、822 次真实速度/历史绑定。两者均通过 960×540 缩小后恢复原窗口，别墅额外通过镜头移动和瞬移，无 GPU 错误或设备丢失。报告分别为 `web-distance-field-ue-default-template-distance-fields-threads-msedge-normal-clock-final-results.json` 和 `web-distance-field-triplex-house-villa-df-distance-fields-threads-msedge-normal-clock-final-results.json`。

本次验证启动兼容性和距离场链路持续运行，不代表已完成距离场块状伪影、冰箱颜色或长期稳定性的画质验收。

## 双面材质与反射修复

本轮针对车库纸箱发黑、客厅地毯及虎纹布发黑、门厅高光缺失，使用相同场景、相机、90 度 FOV 和手动 EV100=-1，对照原生 D3D12 SM5 与浏览器。两端均使用正常渲染时间；诊断用的着色器替换未进入发布包。

纸箱和布料的根因是双面法线方向错误。WebGPU 经 Vulkan 编译器生成着色器，继承了 `GetFloatFacingSign` 的 Vulkan 翻转补偿；WebGPURHI 实际使用的前面约定与 D3D 相同，因而重复翻转。错误法线使天空光方向错误，也使 DFAO 向物体内部追踪。仅关闭 DFAO 能改善纸箱，但不能修复布料。纹理 GPU 回读、直接输出材质原有 BaseColor、只修正 facing sign 的对照均排除了贴图丢失、POM 坐标和像素深度偏移作为这次发黑的根因。

`MaterialTemplate.ush` 现在仅对 `COMPILER_WEBGPU` 排除上述 Vulkan 补偿。Cook 覆盖脚本逐字校验这个局部分支，安装引擎未修改；原生、Nanite、光追及其他 Vulkan 路径保持原有行为。

反射缺失包含两处独立原因：

- 别墅配置此前是 `r.ReflectionMethod=0`，现在设为 2，执行 UE 原有 SSR。测试按实际创建的 SSR 着色器统计绘制，并检查最终后处理设置。
- 早期 Web 最小平台曾跳过矩形灯和布料 BSDF 的 LTC 初始化。现在桌面 SM5 恢复原有 CPU 查找表上传及绑定：`GGX.LTCMat` 为 64×64 RGBA16F、`GGX.LTCAmp` 为 64×64 RG16F、`Sheen.LTC` 为 32×32 RGBA16F。ES3.1 保留原分支，本轮未验收移动矩形灯。原生关闭 SSR 后，木门上的亮块依旧存在，证明这部分来自矩形灯高光，不能仅靠开启 SSR 恢复。

别墅同时由 FXAA 改为 TAA，保持 100% 内部分辨率和原有 DFAO 设置，让细碎边缘参与时域积累。没有降低 AO 强度、关闭全局距离场、替换材质或修改资产距离场分辨率。原生同机位也有粗块遮蔽；本轮修复错误法线造成的异常自遮挡，并改善抗锯齿差异，不能据此宣称所有 DFAO 粗块已消除或完整桌面画质已经对齐。

新增 `villa-lighting-quality-cases.json` 固定车库、客厅、门厅三处机位，检查实际像素区域、DFAO 开启、TAA、SSR 绘制和 LTC 纹理。旧包首先在纸箱区域失败：平均 RGB 约 23，低于阈值 45。最终包在 Chrome / Edge 的 1280×720 正常时钟回归均通过：

| 区域 | 修复前 | 修复后 Chrome / Edge |
| --- | ---: | ---: |
| 纸箱平均 RGB | 23 | 67.64 / 67.68 |
| 地毯平均 RGB | 约 8 | 231.48 / 231.47 |
| 地毯近黑像素比例 | 约 99% | 0 / 0 |
| 门厅矩形灯高光平均 RGB | 无对应高光 | 213.63 / 213.63 |

这里的亮度与阈值用于阻止发黑和高光丢失回归，不是画质评分。两个最终回归均无 GPU 验证错误或设备丢失。报告为 `web-distance-field-triplex-house-villa-df-distance-fields-threads-{chrome,msedge}-quality-final-results.json`。原生对照为 `villa-distance-fields-quality-native-final-capture.json` 及对应 PNG。

额外负例在最终 TAA/SSR 包中，仅于测试拦截器反向注入旧 facing 错误，相同最终用例再次在纸箱阈值失败（23.06 < 45），没有 GPU 报错。这证明图像断言能捕获法线回归，也证明 TAA 未把错误法线掩盖掉。报告后缀为 `msedge-quality-facing-negative-results.json`，它是明确标记的诊断替换运行，不是发布包失败。

默认关卡的新包在 Edge 1280×720 正常运行 647 帧，通过缩放恢复；别墅的新包在 Edge 3840×2160 正常运行 1305 帧，记录 921 次真实速度纹理/DFAO 历史绑定，通过移动、瞬移和 960×540 → 3840×2160 缩放恢复。两项均无 GPU 验证错误或设备丢失，报告后缀分别为 `msedge-lighting-final-default-results.json` 和 `msedge-lighting-final-4k-results.json`。

并行启动两浏览器时，Chrome 曾在初始化阶段丢失设备，原始报告保留为 `web-distance-field-triplex-house-villa-df-distance-fields-threads-chrome-quality-concurrent-loss-results.json`；串行复验通过，原因尚未确定，不能把本轮结果当作并行多实例稳定性验收。

2026-10-30 用户另外报告 Edge `STATUS_ACCESS_VIOLATION`。12:17 的本机转储已定位到 renderer 内 WebGPU `createBindGroup()` 的 Blink 参数转换路径；四轮可见窗口启动、刷新和缩放未重现，尚无可验证修复。详见 `UE58_BROWSER_CRASH_DIAGNOSIS.md`，不能将上面的画质回归通过作为该崩溃已解决的依据。

## 入口

别墅当前配置、已恢复的历史项、代码特性排除及缝隙阴影单项对照，完整清单见 `UE58_VILLA_RENDERING_OVERRIDES.md`。接触阴影配置现为 1，但其画面贡献尚未恢复；点光源和矩形灯立方体阴影仍被 Web 分支跳过。

服务根目录为 `tests/web-platform`，端口 8765：

- `/build/ue-default-template-distance-fields-threads/index.html`
- `/build/triplex-house-villa-df-distance-fields-threads/index.html`

运行时诊断增加 `__webDistanceFields`。`WebDistanceFieldTest(0/1)` 和 `WebDistanceFieldTestExposure(EV100)` 仅用于测试，后者要求已通过 `WebProjectViewTest` 创建测试相机；正常进入关卡不会覆盖原曝光。

`WebLightingQualityTest` 也仅对已创建的测试相机开放：参数 0～8 分别控制 AA、反射方法、对象距离场、全局距离场、镜面遮蔽、AO 历史、SSR 质量、DFAO、阴影质量；9 切换 Lit/Unlit；-1 只采集最终视图设置。材质诊断应使用 GPU 采样或实际 BaseColor 对照，单独切换 Unlit 不能证明 POM 与布料着色正确。

## 复现

以下命令在工作区根目录执行。Cook 的 `-SkipBuild` 要求已有与当前源码匹配的隔离 Cook host / shader worker / RenderCore / Renderer 构建；不匹配时会拒绝运行。

```powershell
& tests/web-platform/build-web-engine.ps1 -Threads -MaxParallelActions 4
& tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-SM5 -Scene DefaultTemplate -DistanceFields -SkipBuild -StopOnShaderError
node tests/web-platform/stage-web-engine.cjs --desktop --default-template
node tests/web-platform/package-web-default-template.cjs --desktop --threads --distance-fields

& tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-SM5 -Scene Project `
  -Project H:/ue_html/tests/web-platform/build/projects/triplex-house-villa-df/TriplexHouseVilla.uproject `
  -Map /Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla `
  -Profile H:/ue_html/tests/web-platform/cook-profiles/TriplexHouseVillaFullresDesktopEngine.ini `
  -ReportId triplex-house-villa-df -TextureCompression BC -CompressHDRCubemaps `
  -DistanceFields -SkipBuild -StopOnShaderError
node tests/web-platform/stage-web-engine.cjs --desktop --project=triplex-house-villa-df
node tests/web-platform/package-web-project.cjs --desktop --threads --distance-fields --project=triplex-house-villa-df

$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-distance-fields.cjs --startup-only
node tests/web-platform/probe-web-distance-fields.cjs --edge --startup-only
node tests/web-platform/probe-web-distance-fields.cjs --folder=triplex-house-villa-df-distance-fields-threads `
  --startup-only --require-velocity --camera=-20,200,130,12,-35 --width=3840 --height=2160
node tests/web-platform/probe-web-distance-fields.cjs --folder=triplex-house-villa-df-distance-fields-threads `
  --visual-clock --camera=-20,200,130,12,-35 --fixed-ev=-1 --width=1920 --height=1080
node tests/web-platform/probe-web-distance-fields.cjs --folder=triplex-house-villa-df-distance-fields-threads `
  --cases=tests/web-platform/villa-lighting-quality-cases.json --tag=quality-final
node tests/web-platform/probe-web-distance-fields.cjs --edge --folder=triplex-house-villa-df-distance-fields-threads `
  --cases=tests/web-platform/villa-lighting-quality-cases.json --tag=quality-final
```

测试使用 H 盘独立持久化浏览器配置；大型关卡不适用临时隐身配置的较小配额。报告、PNG 和二进制回读在忽略的 `tests/web-platform/results` / `build` 中。`probe-distance-field-rhi.ps1` 需要预先准备距离场 probe 的 float/uint worker 着色器和 `prepare-distance-field-probe.cjs --conversion=<实际Cook的ShaderConversion目录列表>`；缓存命中的 Cook 不一定重新导出所有着色器，可用分号连接多个实际 Cook 输出目录。

`--shader-capture` 可记录浏览器实际创建的 WGSL；`--shader-overrides=<JSON>` 与 `--renderer-settings=<JSON>` 仅用于可追溯的隔离诊断，报告会记录输入哈希和覆盖边界，后者还校验配置请求及引擎 Set CVar 日志。使用这些覆盖的运行不能验收正式默认产物。`--engine-args=<JSON>` 只适用于启动器明确解析的开关；任意 UE 参数并不转发，`-ini:` 会被测试脚本拒绝。原生 `capture-villa-distance-fields.ps1 -CasesFile <JSON>` 接受自定义机位及每例整数 CVar，结果记录在对应报告中。过渡用材质图遍历、硬编码着色器绑定抓取和独立全局场夹具已移出正式测试脚本。
