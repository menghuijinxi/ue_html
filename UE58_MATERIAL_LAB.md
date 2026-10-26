# 默认关卡材质测试场

2026-10-26。测试场从 `/Engine/Maps/Templates/Template_Default` 复制，保留默认太阳、SkyAtmosphere、实时 SkyLight、天空球、云和高度雾。生成的关卡和材质位于工作区 `tests/web-platform/build/projects/material-lab/Content`，不修改安装引擎和原始默认关卡。

浏览器地址：`http://127.0.0.1:8765/build/material-lab/index.html`。顶部选择全景或单组近景；单组模式隐藏其他组。参数从画面左至右递增。

| 组 | 固定参数 | 四个球的变量 |
| --- | --- | --- |
| 非金属粗糙度 | BaseColor 线性灰 0.5、Metallic 0、Specular 0.5 | Roughness 0.05 / 0.25 / 0.6 / 1 |
| 金属粗糙度 | BaseColor 线性灰 0.5、Metallic 1、Specular 0.5 | Roughness 0.05 / 0.25 / 0.6 / 1 |
| 非金属高光 | BaseColor 线性灰 0.5、Metallic 0、Roughness 0.12 | Specular 0 / 0.25 / 0.5 / 1 |
| 透明度 | 蓝色 Default Lit、Translucent、Surface Per Pixel Lighting、Roughness 0.12 | Opacity 0.15 / 0.35 / 0.65 / 1 |

所有球材质均使用 UE 实际材质图，没有连接 Emissive。透明球背后有红白条纹；左侧立柱接地，另一个球离地 125 cm，分别观察接触和分离投影。测试地面使用中性粗糙材质。

测试场固定 EV100 0、曝光补偿 0、Bloom 0；太阳保留原方向和强度 6，动态阴影距离设为 3000 cm、四级级联，Shadow Bias 为 1。固定曝光和阴影参数只用于这个关卡。顶部光照对照分别关闭太阳直射、天空光及其环境反射、太阳高光或阴影，切回完整光照恢复原始值。关闭直射只调整太阳的 DiffuseScale / SpecularScale，避免移除大气太阳后连带让天空与实时捕获变黑。

阴影菜单可切换每级 1024、2048、4096，默认 2048。四级 Depth32Float 图集的纹素存储分别为 16、64、256 MiB；这些数字不包括驱动开销、其他渲染目标及切换时渲染目标池保留的旧图集。4096 是可选测试场画质档，没有全局提升默认关卡和别墅的阴影分辨率；它在一次 Chrome 短时采样中有明显性能下降，不能按另一浏览器的流畅结果推断没有成本。

构建和检查：

```powershell
# 前置条件：现有 Web SDK、隔离 UBT 和宿主准备流程已配置。
& tests/web-platform/build-web-material-lab.ps1
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-material-lab.cjs
node tests/web-platform/probe-web-material-shadows.cjs --both --verify-limits
```

`-SkipBuild` 复用当前原生编辑器模块和完整 Web 构建；`-SkipCook -SkipBuild` 只重新 Stage / Package，并要求生成资产及来源指纹仍匹配。`cook-web-engine.ps1 -TemplateEnvironment` 仅对 ES3.1 项目显式启用默认天空的体纹理处理和蓝噪声资源，其他项目的默认 Cook 行为保持原样。

生成器支持覆盖自己先前生成的完整资产包。准备报告记录原模板未改变、20 个生成资产和材质参数；打包继续核验普通 UBT 完整构建、Cook、Stage、来源和产物哈希。使用 BC 纹理包及已有 OPFS 本地流送，不增加逐球网络请求。

浏览器探针对 Chrome / Edge 分别检查六种视图、四项光照关闭与恢复、竖屏和桌面恢复、真实 draw、页面与 GPU 错误，并保存每项截图和画面差异。对照测试冻结渲染时钟；正式页面保持实时运行。

本轮普通 Web UBT 完整编译链接、原生命令模块编译、覆盖已有资产后的生成和 BC Cook 均通过。最终完整材质探针中 Chrome 运行 1062 帧、Edge 运行 1047 帧，每个浏览器保存 20 张画布截图，页面和 GPU 错误均为零；四项关闭差异均明显高于恢复图之间的变化。原默认关卡复用已验 Cook、重新打包同一 Web 运行时后，也通过两个浏览器的光照/天空关闭恢复、窗口缩放和内容/配置破坏拦截回归。上述帧数属于短时工具验证，不代表长期稳定性验收。

阴影检查确认此前已有四级 2048 CSM：实际图集 8192×2048，每帧四个独立视口都有深度 draw，接收材质包含手动 3×3 PCF。锯齿有两个可复现来源：测试场 60 m 覆盖范围使金属球落在较稀的级联；WebGPU 初始化漏设 `GMaxShadowDepthBufferSizeX/Y`，请求 4096 时被 UE 初始的 2048 上限截断。后端现按设备 `maxTextureDimension2D` 上报阴影上限，不预先分配大图集。回归先观察到“4096 请求实际仍为 2048 视口”的失败，再验证修复后的实际视口、四级接收矩阵、分割距离和三档分辨率。

同一 2048×1152、FOV 90、16:9 金属视角下，原 60 m / 2048 的可见第三级约 2.353 cm/texel；现 30 m / 2048 约 1.180 cm/texel，密度约提高 2 倍而图集大小相同；可选 4096 档约 0.589 cm/texel，线性密度约提高 3.995 倍。该数值由实际绑定的 ScreenToShadow 矩阵还原，不能代表所有视角。单独提高分辨率会暴露球面自阴影条纹，测试场 Shadow Bias 0.5→1 的对照减少了这些条纹；偏移没有全局套用。探针保存同视角旧参数和新参数截图，检查参数恢复、非法输入及实际 GPU 错误；`--controls` 另外保留距离、分布、级数和偏移的单变量诊断。最终两个浏览器三档各采样至少 120 帧，均约 120 fps，受当前帧率上限约束，不能说明三档 GPU 耗时相同，也不抵消前述短时下降的观察。

本轮继续建立可复现的画质诊断基线。环境反射来自默认天空捕获，没有新增场景反射探针、SSR 或 Lumen；透明度是 Lit Alpha 混合，没有实现折射和透明着色阴影。阴影仍是移动前向 CSM + PCF，未新增 VSM、PCSS 或物理半影，不能据此宣称达到桌面编辑器画质；环境反射细节等问题继续留在此小场景定位，没有增加 AO。

结果位于 `tests/web-platform/results/web-material-lab-prepare-results.json`、`web-project-material-lab-package-results.json`、`web-material-lab-browser-results.json`、`web-material-shadow-results.json` 和相应 PNG。阴影上限修复前失败报告为 `web-material-shadow-cap-failure.json`；局部前后对照为 `material-shadow-<browser>-comparison.png`，左旧右新。原生 `WebTemplateMap` 的 SceneCapture 截图没有完整推进实时天空捕获，不能作为编辑器同画质基准。
