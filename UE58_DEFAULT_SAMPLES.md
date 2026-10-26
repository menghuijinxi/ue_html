# 原默认关卡材质球对照

2026-10-26。地址保持 `http://127.0.0.1:8765/build/ue-default-template/index.html`。

在原 `/Engine/Maps/Templates/Template_Default` 运行时仅增加八个球。保留原灯光、天空、云、雾、SkyLight、自动曝光、Bloom、后处理、棋盘地面、阴影配置以及相机行为。安装引擎和原始地图不写入；没有复制世界或套用材质实验关卡的曝光、地面、阴影和相机设置。

| 原相机下的位置 | Metallic | 从左至右 Roughness |
| --- | --- | --- |
| 前排非金属 | 0 | 0.05 / 0.25 / 0.6 / 1 |
| 后排金属 | 1 | 0.05 / 0.25 / 0.6 / 1 |

八个球均使用实际 Default Lit 材质图，线性 BaseColor 为 `(0.5, 0.5, 0.5)`，Specular 为 0.5，不透明，没有 Emissive 输入。半径 120 cm，球底贴合原地面上表面，参与现有实时光照和阴影。相机先按原流程设置，之后才添加球，避免新增网格影响原相机的目标计算。正式页面仍使用原始启动参数和实时时钟。

`WebDefaultSamples` 原生命令生成 `/Game/DefaultTemplateSamples` 的八个材质包和高密度测试球网格，不加载、复制或保存任何世界。默认关卡 Cook 自动生成这些资产，将球网格及材质加入原有包列表，报告包含生成器、材质包、网格、参数清单及原地图的指纹。生成资产不提交 Git，可由源码重建。其他场景的 Cook 包列表不变。

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

## 阴影分辨率调整

随后按用户要求，仅将共享默认关卡渲染配置中的 `r.Shadow.MaxCSMResolution` 显式设为 4096。原地图、级联数量、阴影距离和偏移保持原值。重新 Cook、Stage、Package 后，原地址直接使用 4096 配置。

前述配置完全一致和旧画面对照对应添加球时的 2048 版本。此次用户明确授权改变阴影配置，执行 `probe-web-default-samples.cjs --no-baseline` 保留历史基准并跳过旧配置/旧截图比较，逐球像素、隐藏恢复、原 Actor 参数保护和双浏览器错误检查仍执行。

4096 版本重新 Cook、Stage、Package 通过。Chrome / Edge 的真实 GPU 检查均记录到 Depth32Float 的 8192×8192 图集，四个不同位置的 4096×4096 视口均有深度 draw；每次浏览器运行记录 16 个阴影 pass，页面和 GPU 错误为零。图集为四级 2×2 排布，纹素存储为 256 MiB。逐球/隐藏恢复检查分别运行 911 / 915 帧并通过。GPU 尺寸检查结果位于 `tests/web-platform/results/web-default-shadow-4096-results.json`。

4096 下的原关卡完整回归分别运行 1097 / 1095 帧，光照开关与恢复、竖屏/桌面缩放及内容/配置损坏拦截均通过。当前构建、Cook、Stage、Package 及两项浏览器回归共 838 项来源/产物/证据指纹通过核验，服务返回 HTTP 200。

## 球面分块与条纹自阴影

2026-10-26。用户报告的明暗交界处大块台阶与细条纹可在 UE 原生 CSM 中复现。使用安装好的 `H:/UE_5.8`，另起本工作区 `UEShaderHost` 工程，在内存中的同一个默认世界添加相同材质、位置和尺寸的球。不会操作用户已经打开的其他 UE 工程，也不保存源世界或安装引擎资产。

诊断包含关闭投影、单独增大灯光 bias/slope、切换球网格三个变量。关闭投影时台阶和条纹消失；增大 bias 能减轻条纹，但原球的粗块仍存在。原 `/Engine/BasicShapes/Sphere` 为 960 三角面，平滑法线与实际投影几何不一致，形成可见的分块终止边界。仅换成密集球能消除大台阶，但原生 ES3.1 与 Web 仍有细条纹，不能把问题全归于网格。

最终修改：

- 用 UE 自带 `FSphereGenerator` 生成 128×65、16128 三角面的 `SM_TestSphere`，保留径向平滑法线，八个球共享一份网格；不再用粗网格评估材质。
- 在 Web 的 `ShadowProjectionPixelShader.usf` 移动方向光 CSM 投影中，以屏幕导数求接收面在阴影 UV 上的深度梯度，根据实际 PCF 核半径和阴影纹素大小进行保守深度补偿。补偿限制为归一化深度 0.001，仅进入 WebGPU 移动路径的非调制方向光阴影。
- 不增大原灯光 bias/slope，保留 0.5/0.5、四级 4096、原天空、曝光、地面和启动相机。源码只改参考引擎与工作区 Cook 覆盖，安装目录不写入。

首次像素回归在旧实现上失败。固定近景 `(-1000,-70,230)`、pitch -8、yaw 65、实际水平 FOV 75；画布为 1600×900。先用球上受光区域校正自动曝光差，再统计球内部相对于关闭投影的额外暗化。旧实现大于 6/255 的像素比例约 11.17%；修复后 Chrome / Edge 分别约 0.0013% / 0.0020%，平均正向误差约 0.79/255。旧粗网格在新补偿下也降至约 0.27% / 0.25%。地面投影和球底接触区域相对于关闭投影仍有约 118 / 119 级亮度差，未靠禁用阴影通过测试。上述指标只对应固定近景，不代表任意场景均无漏光。

两个浏览器均确认真实 8192×8192 Depth32Float 图集中，四个不同位置的 4096×4096 tile 有 indexed draw，页面和 GPU 错误为零。新增材质球隐藏/恢复与原 Actor 参数保护回归、原默认关卡太阳/天空开关、竖屏/桌面尺寸恢复及包损坏拦截均通过。原地图 SHA256 仍为 `c8fd7ff6cb85d620c9cf1865786854f5185f53b0459068465d985bccd858675c`。

本轮八球回归在 Chrome / Edge 分别运行 935 / 930 帧，恢复画面平均通道差约 0.76 / 0.74。构建、Cook、Package、浏览器及原生对照报告共 837 项现有来源与产物指纹核验通过。参考引擎阴影修复提交为 `e3bd9d828`。

桌面对照通过持续渲染的真实编辑器视口获取，预热曝光与天空捕获；分别显式选择 SM5 和 ES3.1 预览，记录实际 feature level、FOV、相机、网格三角面数，校验截图的新鲜度与哈希。测试使用 CSM，关闭 VSM，不启用 Lumen；这不是桌面最高画质的等价证明。相机实际 FOV 从 `PlayerCameraManager::GetFOVAngle()` 读取，不能仅使用 CameraCache 中的 90 度值，后者会被玩家视图覆盖为锁定的 75 度。

复现新阴影与原生对照：

```powershell
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-default-shadow-artifacts.cjs
node tests/web-platform/probe-web-default-shadow-artifacts.cjs --edge
& tests/web-platform/capture-web-default-native.ps1 -Mode desktop
& tests/web-platform/capture-web-default-native.ps1 -Mode mobile
node tests/web-platform/compare-web-default-native.cjs
```

需先按上文重新构建、Cook、Stage、Package，并编译当前 `UEShaderHostEditor` 模块。原生捕获使用专用启动参数，无参数时模块不添加球或改变视口。浏览器 `_WebDefaultShadowControl` 和 `_WebProjectViewTest` 仅供探针显式调用，不改变正式页面默认参数。

结果：

- `tests/web-platform/results/web-default-shadow-artifacts-results.json`
- `tests/web-platform/results/web-default-shadow-artifacts-edge-results.json`
- `tests/web-platform/results/default-shadow-native-desktop-results.json`
- `tests/web-platform/results/default-shadow-native-mobile-results.json`
- `tests/web-platform/results/default-shadow-native-web-comparison-results.json`
- `tests/web-platform/results/default-shadow-native-web-comparison.png`

对照仍能看到桌面 SM5 金属球有云和地面反射，Web 更接近移动预览；天空云形状与环境反射也存在差异。本轮未补齐这些反射或实时 GI 能力，不能据此宣称整体效果已达到桌面端。
