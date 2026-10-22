# 外部项目 Web 打包进度

## 2026-10-23：修复室内照明

用户指出别墅网页几乎全黑。本轮对照关卡清单确认：原地图有强度 7 的指定 HDRI SkyLight、103 个聚光灯、4 个点光源和9个矩形灯；先前兼容性包在 Cook 时关闭了 SkyLight，配置也禁用了本地灯。这些设置直接影响画面，原有“非空白”检查却把窗外少量亮像素算作通过。

现在新增室内区域亮度检查，以及运行时 SkyLight 关闭、本地灯关闭、全部恢复三组画面对照。固定视点参数为 `--view=x,y,z,pitch,yaw`；该测试相机只在探针调用时启用。运行和开关灯后均检查页面错误、GPU 校验和设备丢失。本地灯验收使用逐像素 RMS、变化像素比例与恢复误差的对比；保留原地图自动曝光时，关闭灯光后曝光提高，不能要求全图平均亮度一定下降。

指定立方体 SkyLight 在原生 UE 中按原组件参数计算平均亮度及三阶 RGB 球谐，并保存 `WebSkyCaptures.bin`。浏览器核对组件路径、立方体、分辨率、旋转和下半球设置后读取系数；立方体 GPU 过滤继续执行，只绕开浏览器目前缺少的同步浮点读回。缺失、过期或损坏的数据使加载明确失败。光源强度、后处理曝光与原地图保持一致。

Web 移动前向路径接通本地灯网格；WGSL 不接受的 subgroup 裁剪变体在 Web 局部排除，编译和运行均选择每单元单线程路径，同时关闭 Web 的双层网格及 specialization constants 变体。Web 使用固定列表以减少存储缓冲绑定数量，每格容量至少覆盖当前可见灯光和反射捕获数量；不提高设备默认绑定上限。未接入的 GPU 灯网格调试反馈与灯名缓冲在 Web 局部排除。其他平台继续使用原逻辑。

IES 图集在 Web 选择 UE 现有栅格更新路径，避免 WebGPU 不支持的 R16F storage image；RHI 增加单 mip、线性 R16F 二维数组的分层渲染、采样视图和状态转换。仍拒绝该数组的 CPU 初始化和 UAV 用途。原生 `-WebTextureIESProbe` 只清除第二层并读回两层，验证第一层不受影响；和 BC 探针一起在记录、直通两种模式执行。

最终照明汇总 `verify-web-project-lighting.cjs` 已通过：核对 9,099 个审计条目、8,946 个不同文件，源码、构建、Cook、包和截图哈希均一致。普通 UBT Web 构建、原生 Renderer/RenderCore 构建、两个关卡重新 Cook 和打包均通过，安装引擎审计输入保持原样。之前关闭 SkyLight 的 BC 基线保留为历史记录。

对应独立引擎仓库提交为 `bd55e94ef`（恢复 Web 天空光与移动前向局部灯照明）；外围 RHI、打包与回归脚本由工作区根仓库保存。

原生纹理测试已通过 172 项；指定 HDRI 的平均亮度为 `0.535156`，球谐首项为 `(1.63477, 1.76367, 2.23242)`，准备文件为 310 字节。当前纹理审计仍为 667 张、607 张多 mip、60 张单 mip，压缩估算仍是 210,559,592 字节。这里的数字不表示实测总显存。

最终餐桌视角在 Chrome、Edge 均通过，室内采样可见比例约 98.4%，亮度均值约 155.3；关闭天空光后降到 36.5 / 40.5。关闭局部灯后逐像素 RMS 为 11.62 / 8.19，恢复误差仅 1.12 / 0.48，证明变化超过画面自身漂移。两次运行均无 GPU 校验错误或设备丢失。缺少天空光数据的故障注入在两浏览器均于第 0 帧明确失败；默认关卡的灯光、窗口恢复及损坏包/配置拦截回归通过。

当前独立目录 6 文件共 562,698,698 字节。最终双浏览器累计纹理创建描述估算均为 500,972,160 字节，展开等价估算为 1,536,155,628 字节；含运行时光照/阴影目标，不是实际驻留显存。固定餐桌视角短时约 5.25 / 5.03 FPS，尚未达到可用帧率。

额外冷启动及不同取景中遇到浏览器页面崩溃和 GPU 设备失效，保留 `lighting-chrome-crash`、`lighting-kitchen-angle` 等失败记录；不能声明稳定性验收通过。Lumen 间接光、桌面反射、接触阴影和部分材质仍与编辑器有差异，未完成同视点原生画质匹配。低帧率、8 GB 总显存预算与长期稳定性继续单独验收。

本轮证据位于 `tests/web-platform/results`：`web-project-triplex-house-villa-lighting-final-results.json`、对应原图/开关灯/恢复截图、`web-project-triplex-house-villa-skylight-cache-results.json`、`triplex-textures-lighting-final.json` 和 `triplex-house-villa-lighting-audit-results.json`。原生 172 项纹理结果位于 `tests/web-platform/build/lighting-native-texture/texture-srv-results.json`。

当前照明包的复现命令如下；需要先完成普通 UBT Web 构建及原生 Renderer/RenderCore 宿主构建。与历史压缩基线相比，项目 Cook 不再传 `-DisableProjectSkyLight`。

```powershell
& tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-ES31 -Scene Project -Project H:/ue_html/tests/web-platform/build/projects/triplex-house-villa/TriplexHouseVilla.uproject -Map /Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla -Profile H:/ue_html/tests/web-platform/cook-profiles/TriplexHouseVillaEngine.ini -ReportId triplex-house-villa -TextureCompression BC -CompressHDRCubemaps -StopOnShaderError -SkipBuild
node tests/web-platform/stage-web-engine.cjs --project=triplex-house-villa
node tests/web-platform/package-web-project.cjs --project=triplex-house-villa
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-project.cjs --project=triplex-house-villa --smoke=1 --warmup-frames=10 --seconds=15 --lighting=1 --local-lights=1 --report=lighting-final --view=-175,-80,160,-5,50
node tests/web-platform/probe-web-project-skylight-cache.cjs
node tests/web-platform/audit-cooked-textures.cjs --cook-report=tests/web-platform/results/web-project-triplex-house-villa-cook-results.json --output=tests/web-platform/results/triplex-textures-lighting-final.json
node tests/web-platform/verify-web-project-lighting.cjs
```

## 2026-10-22：历史 BC 兼容性基线

以下为关闭天空光时的压缩验证记录，保留其数据与失败边界，不代表当前照明包的验收结论。

本轮继承 TriplexHouseVilla 打包工作，按用户要求先接通 GPU 纹理压缩，再处理帧率。所有项目准备、Cook 和构建输出均在 `H:/ue_html`；原项目 `H:/TriplexHouseVilla` 和安装引擎源码保持原样。`reference-engine` 本轮无修改。

准备脚本复制内容项目，复用现有编辑器宿主和 Web 插件；运行时按 `/Game` 地图参数加载原关卡，保留原有 GameMode、PlayerController 和输入配置。当前入口是 `http://127.0.0.1:8765/build/triplex-house-villa/index.html`。

### 纹理路径

- `-TextureCompression BC` 让 Cook 保留 DXT1/DXT5、BC4/BC5、BC6H/BC7，使用 UE 自带 DXT 和 Intel ISPC 编码器；不在浏览器解压回 BGRA8。颜色的 sRGB 标志、法线的 BC5 编码和原有 mip 链保留。
- `-CompressHDRCubemaps` 明确允许把 HDR 立方体的 RGBA16F 改为 BC6H；仍尊重资产的 `CompressionNone`。这是有损处理，尚未完成同视点原生画质比较。
- WebGPURHI 在适配器提供能力时请求 `texture-compression-bc`。压缩纹理只具有采样和复制用途，不能当作渲染目标或存储纹理。上传和复制按实际块数处理，包括 2x2、1x1 的尾部 mip，以及立方体六面。
- 压缩包在下载引擎及场景前检查 BC 能力；不支持时显示具体原因。当前仅接通 BC 包，ASTC/ETC2 包和实际手机验收待做，不能把桌面 BC 包当成通用手机版。

在相同的 Web LOD 512 配置下，对全部 667 个项目 2D/立方体纹理平台头进行统计：

| 项目 | 未压缩基线 | 最终 BC 包 |
| --- | ---: | ---: |
| 纹理数据估算，含 mip 和立方体六面 | 1,241,770,628 字节 | 210,559,592 字节 |
| 多 mip 纹理 | 607 | 607 |
| 单 mip 纹理 | 60 | 60 |
| Stage 内容包 | 1,419,511,380 字节 | 374,756,614 字节 |
| 独立网页目录，6 个文件 | 1,602,238,226 字节 | 557,485,463 字节 |

最终项目格式为 438 个 DXT1、199 个 BC5、18 个 DXT5、2 个 BC6H、9 个 BGRA8 和1个 RGBA16F。BGRA8 保留包括不能按 BC 块对齐的原尺寸资源；单 mip 资源不会因为 LOD 上限自动生成低分辨率 mip。单看原贴图目录为 642 个，其中 607 个具有多级 mip，35 个单 mip；其余项目纹理是 UI 等其他目录资源。

上述数字来自 Cook 平台头与块大小，不是驱动实测显存，也不包括顶点、索引、uniform、深度和后处理缓冲。不能仅凭纹理小于 8 GB 宣称整场景通过显存预算。

### 验证与边界

- 普通 UBT Web 目标完整编译、实际链接通过；安装版编辑器插件编译通过。
- Cook 为每次运行保存宿主准备报告快照；共用宿主的 BuildSettings 表编译/链接启用可复现输出，连续默认关卡和别墅 Cook 的 DLL 哈希一致，避免后一次重链使前一次证据失效。首次汇总发现的旧指纹不匹配保留为失败报告。
- 最终严格汇总通过：核对 11,313 个审计条目、11,234 个不同文件，源码、产物和截图哈希零不匹配；逐项比较压缩前后全部项目纹理的尺寸、mip 数与立方体面数一致。历史未压缩 Cook 只复核保存的资产字节，不要求旧版源码指纹与当前修改相同。
- 原生 TextureSRV 回归及可选 `-WebTextureBCProbe` 已执行。BC 探针在记录和直通两种模式共通过 160 项，验证七种 BC 格式的四级 mip 上传、BC1 分级采样、跨纹理复制、立方体六面各级采样、sRGB 直接采样和非法创建拒绝，无 GPU 校验错误。
- Chrome、Edge 已实际渲染最终 BC 包，GPU 创建描述中包含 BC1/BC3/BC5/BC6H，而非仅在 Cook 报告中声称压缩。两浏览器累计纹理描述估算均为 299,514,544 字节，同批纹理展开估算为 1,334,698,012 字节，GPU 校验和设备丢失均为零。浏览器探针把纹理描述估算与累计缓冲分配分开记录；未达到 60 帧时统计模块尚未发布堆大小，保持空值，不把缺失值记为零增长。
- Chrome、Edge 均通过实际压缩能力预检和模拟缺少 BC 的拦截，共四组。加载进度与失败处理的双浏览器回归 24 项通过。
- 默认关卡重新 Cook、Stage 和生成完整网页目录；Chrome、Edge 原图、方向光/天空关闭与恢复、竖屏及窗口恢复检查通过，内容和配置哈希破坏均在开始渲染前拦截，无页面或 GPU 错误。首次 `--packaged --runtime-only` 组合虽然两浏览器启动和原图通过，却因该选项跳过了打包验收必需的画面对照和窗口检查而汇总失败，失败报告另存；最终使用完整 `--packaged` 路径通过，没有删除断言。
- 当前只是兼容性基线：显式 Cook 开关关闭别墅 SkyLight，原因是其捕获需要尚未实现的同步浮点 GPU 回读。方向光和 Lit 静态网格仍加载；室内明显偏暗，不能作为完整画质验收。默认关卡不使用这个项目专用开关。
- `M_GlassBlur` 依赖移动路径不支持的 SceneColor，仍回落到默认材质；相关运行错误保留在报告中。音频、本地灯、桌面反射、Lumen、虚拟阴影等不在当前项目配置范围，UMG/Slate 依赖继续保留。
- 单帧约 6253 次 draw、每帧大量临时 uniform 缓冲分配仍是显著问题；短时性能很低，尚未处理或验收。本轮探针通过状态表示压缩上传、启动与实际渲染检查通过，不表示帧率、长期稳定性或 8 GB 总显存预算通过。

主要证据保存在 `tests/web-platform/results`：

- `triplex-textures-uncompressed.json`、`triplex-textures-bc-final.json`：项目纹理清单、格式、mip 和估算。
- `web-project-triplex-house-villa-cook-results.json`、`web-project-triplex-house-villa-stage-results.json`、`web-project-triplex-house-villa-package-results.json`：Cook、Stage、独立目录和来源/产物哈希。
- `web-project-triplex-house-villa-bc-final-results.json`：最终包桌面浏览器的真实 GPU 格式、渲染截图和短时性能观测。
- `web-project-triplex-house-villa-bc-preflight-results.json`：桌面实际能力与缺少 BC 的故障注入。
- `web-default-scene-results.json`、`web-startup-transfers-bc-current-results.json`：默认关卡完整包与加载流程回归。
- `triplex-bc-final-audit-results.json`：当前来源、产物、截图和同尺寸纹理清单的严格汇总。
- `build/bc-native-texture/texture-srv-results.json`：原生压缩纹理回归，位于 `tests/web-platform`。

### 复现

从工作区根目录执行；普通 UBT 完整构建必须先成功，不能用诊断链接冒充。

```powershell
node tests/web-platform/prepare-web-project.cjs --project=H:/TriplexHouseVilla/TriplexHouseVilla.uproject --id=triplex-house-villa --texture-size=512 --input-profile=tests/web-platform/cook-profiles/TriplexHouseVillaInput.ini
& tests/web-platform/build-web-engine.ps1
& tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-ES31 -Scene Project -Project H:/ue_html/tests/web-platform/build/projects/triplex-house-villa/TriplexHouseVilla.uproject -Map /Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla -Profile H:/ue_html/tests/web-platform/cook-profiles/TriplexHouseVillaEngine.ini -ReportId triplex-house-villa -TextureCompression BC -CompressHDRCubemaps -StopOnShaderError -DisableProjectSkyLight
node tests/web-platform/stage-web-engine.cjs --project=triplex-house-villa
node tests/web-platform/package-web-project.cjs --project=triplex-house-villa
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-texture-compression.cjs --project=triplex-house-villa
node tests/web-platform/probe-web-project.cjs --project=triplex-house-villa --smoke=1 --warmup-frames=10 --seconds=15 --report=bc-final
node tests/web-platform/verify-web-project-compression.cjs --project=triplex-house-villa
```

10 帧预热仅用于当前压缩链路检查。脚本默认仍为 120 帧，历史 120 帧超时失败保留，不以降低预热帧数消除性能问题。独立目录需要提供跨源隔离响应头的 HTTP 服务；现有 `serve.cjs` 继续监听 8765。
