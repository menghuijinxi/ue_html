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

测试场固定 EV100 0、曝光补偿 0、Bloom 0；太阳保留原方向和强度 6，动态阴影距离设为 6000 cm、四级级联。固定曝光只用于这个关卡。顶部光照对照分别关闭太阳直射、天空光及其环境反射、太阳高光或阴影，切回完整光照恢复原始值。关闭直射只调整太阳的 DiffuseScale / SpecularScale，避免移除大气太阳后连带让天空与实时捕获变黑。

构建和检查：

```powershell
# 前置条件：现有 Web SDK、隔离 UBT 和宿主准备流程已配置。
& tests/web-platform/build-web-material-lab.ps1
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-material-lab.cjs
```

`-SkipBuild` 复用当前原生编辑器模块和完整 Web 构建；`-SkipCook -SkipBuild` 只重新 Stage / Package，并要求生成资产及来源指纹仍匹配。`cook-web-engine.ps1 -TemplateEnvironment` 仅对 ES3.1 项目显式启用默认天空的体纹理处理和蓝噪声资源，其他项目的默认 Cook 行为保持原样。

生成器支持覆盖自己先前生成的完整资产包。准备报告记录原模板未改变、20 个生成资产和材质参数；打包继续核验普通 UBT 完整构建、Cook、Stage、来源和产物哈希。使用 BC 纹理包及已有 OPFS 本地流送，不增加逐球网络请求。

浏览器探针对 Chrome / Edge 分别检查六种视图、四项光照关闭与恢复、竖屏和桌面恢复、真实 draw、页面与 GPU 错误，并保存每项截图和画面差异。对照测试冻结渲染时钟；正式页面保持实时运行。

本轮普通 Web UBT 完整编译链接、原生命令模块编译、覆盖已有资产后的生成和 BC Cook 均通过。Chrome 运行 1046 帧、Edge 运行 1036 帧，每个浏览器保存 20 张画布截图，页面和 GPU 错误均为零；四项关闭差异均明显高于恢复图之间的变化。原默认关卡重新 Cook / Stage / Package 后，也通过两个浏览器的光照/天空关闭恢复、窗口缩放和内容/配置破坏拦截回归。上述帧数属于短时工具验证，不代表长期稳定性验收。

本轮建立可复现的画质诊断基线。环境反射来自默认天空捕获，没有新增场景反射探针、SSR 或 Lumen；透明度是 Lit Alpha 混合，没有实现折射和透明着色阴影。已能观察粗糙度、高光形状、天空反射、透明混合与动态阴影，但不代表这些效果已达到桌面编辑器画质。球面自阴影边缘、环境反射细节等问题留在此小场景继续定位；本轮没有增加 AO。

结果位于 `tests/web-platform/results/web-material-lab-prepare-results.json`、`web-project-material-lab-package-results.json`、`web-material-lab-browser-results.json` 和 `material-lab-<browser>-*.png`。原生 `WebTemplateMap` 的 SceneCapture 截图没有完整推进实时天空捕获，不能作为编辑器同画质基准。
