# 原默认关卡材质球对照

2026-10-26。地址保持 `http://127.0.0.1:8765/build/ue-default-template/index.html`。

在原 `/Engine/Maps/Templates/Template_Default` 运行时仅增加八个球。保留原灯光、天空、云、雾、SkyLight、自动曝光、Bloom、后处理、棋盘地面、阴影配置以及相机行为。安装引擎和原始地图不写入；没有复制世界或套用材质实验关卡的曝光、地面、阴影和相机设置。

| 原相机下的位置 | Metallic | 从左至右 Roughness |
| --- | --- | --- |
| 前排非金属 | 0 | 0.05 / 0.25 / 0.6 / 1 |
| 后排金属 | 1 | 0.05 / 0.25 / 0.6 / 1 |

八个球均使用实际 Default Lit 材质图，线性 BaseColor 为 `(0.5, 0.5, 0.5)`，Specular 为 0.5，不透明，没有 Emissive 输入。半径 120 cm，球底贴合原地面上表面，参与现有实时光照和阴影。相机先按原流程设置，之后才添加球，避免新增网格影响原相机的目标计算。正式页面仍使用原始启动参数和实时时钟。

`WebDefaultSamples` 原生命令只生成 `/Game/DefaultTemplateSamples` 的八个材质包，不加载、复制或保存任何世界。默认关卡 Cook 自动生成材质，将球网格及材质加入原有包列表，报告包含生成器、材质包、参数清单及原地图的指纹。生成资产不提交 Git，可由源码重建。其他场景的 Cook 包列表不变。

复现命令：

```powershell
# 复用已配置的 Web SDK、隔离宿主及 UBT。
& tests/web-platform/build-web-engine.ps1 -MaxParallelActions 4 -SkipHostPreparation
& tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-ES31 -Scene DefaultTemplate -StopOnShaderError
node tests/web-platform/stage-web-engine.cjs --default-template
node tests/web-platform/package-web-default-template.cjs
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-default-samples.cjs
node tests/web-platform/probe-web-default-scene.cjs --packaged
```

需已运行 `node tests/web-platform/serve.cjs`。Cook 的 `-SkipBuild` 仅在原生命令模块已编译后使用。

新增探针检查实际八个球的材质参数、UE 投影位置和逐球画布像素，隐藏并恢复新增球，核验对应操作前后原 Actor 及其组件的非瞬态可编辑属性和 Actor 变换。每次比较紧贴添加或隐藏操作；不要求实时世界跨多个 Tick 的运行状态完全不变。测试用 `_WebDefaultSamplesVisibility(0/1)` 仅作用于新增球，不增加页面控制面板。投影位置直接读取 UE 的 `ProjectWorldLocationToScreen`，不根据相机请求值推算实际视场角。

本轮打包前先对旧页面执行 `probe-web-default-samples.cjs --baseline`，保存原始相机、画面和配置包哈希。正常探针若发现这份可用基准，额外要求配置包字节完全一致、原相机一致，且隐藏球后的画面与原始基准平均通道差小于 5/255。基准采集只适用于尚未加入球的旧页面；没有基准时仍执行逐球和隐藏恢复检查。对照测试冻结渲染时间，正式页面实时运行。

原生编译、Web UBT 完整编译链接、Cook、Stage 和 Package 均通过。原地图 SHA256 保持 `c8fd7ff6cb85d620c9cf1865786854f5185f53b0459068465d985bccd858675c`，配置包哈希与添加前一致。Chrome / Edge 分别运行 952 / 961 帧，八个球的真实像素检查全部通过，页面和 GPU 错误为零。隐藏球后与旧场景的平均通道差为 0.752 / 0.745；重新显示球后与本轮初始图的差为 0.749 / 0.750。上述为短时验证，不是长期稳定性结论。

原默认关卡完整回归另运行 1617 / 1642 帧，两款浏览器的太阳和天空关闭/恢复、390×844 竖屏及 1440×900 桌面恢复均通过，页面和 GPU 错误为零。内容包与配置哈希破坏均在渲染前被拦截；840 项当前来源、产物和证据指纹核验通过，服务返回 HTTP 200。

结果在 `tests/web-platform/results/web-default-samples-results.json`、`web-default-samples-baseline.json` 和 `default-samples-<browser>-visible/hidden/restored.png`。原关卡回归报告仍为 `web-default-scene-results.json`。

此处用于在用户认可的原光照条件下比较材质。未增加烘焙、Lumen、光照反弹或新的反射算法；后续以此实时光照基准继续定位效果问题。
