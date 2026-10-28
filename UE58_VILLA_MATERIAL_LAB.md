# 别墅模型材质对照关卡

2026-10-28。将别墅中的实际模型放入默认关卡副本，检查同光照下的材质表现，缩小原别墅亮度、反射和法线细节差异的排查范围。

浏览器地址：`http://127.0.0.1:8765/build/villa-material-lab-threads/index.html`。顶部可以选择总览及六个模型，勾选“近景”直接观察表面；取消后查看整个模型。保留现有自由相机操作。

## 速度缓冲与相机修复

2026-10-28 后续修复。用户诊断中的第 55 帧报错为 `SceneVelocity` 的 `UnfilterableFloat` 与绑定声明 `Float` 不兼容。之前仅观察静止样本及预设相机，未触发真实速度缓冲，因此未覆盖该问题。

新增仅测试启用的 `-WebMaterialLabMotionTest`，持续平移砖墙，修复前在 Edge 150% 缩放下复现同一条 binding 6 / Compute 错误。实际目标为 `rg16unorm`，设备已启用 texture-formats-tier1/2 和 float32-filterable，不能靠重复请求这些能力解决。后端现将 TAA 的 `GBufferVelocityTexture` 声明为 unfilterable-float，相应点采样器声明为 non-filtering；保留真实速度数据和 TAA，不降低抗锯齿配置。

相机菜单原先调用测试接口创建固定 CameraActor，WASD 控制的 Pawn 与可见相机分离。现在仅在本测试关卡中让预设机位平移可控制的 Pawn，重置速度并设为 200 cm/s、加减速 800 cm/s²；选中模型后自动将键盘焦点交给画布。WASD 移动，按住鼠标右键拖动转向，切换模型后仍可继续自由观察。其他地图的固定机位接口行为保持原样。

```powershell
& tests/web-platform/build-web-engine.ps1 -Threads -MaxParallelActions 4 -SkipHostPreparation
node tests/web-platform/package-web-villa-material-lab.cjs
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-villa-material-lab.cjs --browser=Edge --scale=1.5 --resize-startup --motion --report=final-edge-motion
node tests/web-platform/probe-web-villa-material-lab.cjs --browser=Chrome --scale=2 --resize-startup --startup-movement --report=final-chrome-4k
```

完整正常 UBT 多线程构建和重新打包通过，无需重新 Cook。Edge 最终七视角及操作检查通过，运动测试从第 183 帧持续至第 1597 帧，实际绑定 6 为 unfilterable-float，采样器为 non-filtering；切换 2505×1409、1920×1080、2400×1350 原生尺寸且保留 TAA。Chrome 七视角及操作检查通过，主采样为 3200×1800（本命令采用 1600×900 CSS、DPR 2，名称不表示 3840×2160），启动时移动和缩放均覆盖。两端页面、GPU 验证和设备丢失错误为零。选择模型前后的 W、D 和右键拖动均检查实际相机坐标与旋转变化。

高 DPI 截图改用 Playwright 管理的 screenshot；直接 CDP 截图在此测试环境会重置模拟 DPR，曾导致后续分辨率断言失败，属于工具问题。本轮不使用该失败作为页面分辨率回退的证据。正式页面不启用模型运动；上述结果是短时定向回归。

新增证据均位于 `tests/web-platform/results/`：

- `villa-material-lab-browser-before-edge-results.json`：修复前 W 无法移动可见相机。
- `villa-material-lab-browser-before-real-motion-results.json`：修复前真实速度缓冲的原始 GPU 错误。
- `villa-material-lab-browser-final-edge-motion-results.json`：修复后运动、实际绑定、缩放及交互检查。
- `villa-material-lab-browser-final-chrome-4k-results.json`：修复后 DPR 2 及启动移动检查。
- `villa-material-lab-web-edge-1.5-*.png`、`villa-material-lab-web-chrome-2-*.png`：本轮截图。

## 资产与环境

关卡为 `/Game/WebVillaMaterialLab`，从 `/Engine/Maps/Templates/Template_Default` 复制。保留模板的太阳、天空、SkyLight、云、雾、地板和曝光，不带入别墅的灯光及后处理体积。只新增六组模型并移动 PlayerStart；样本不添加补光或新材质。

| 样本 | 原 Actor | 原网格 |
| --- | --- | --- |
| 橱柜门 | BP_CupboardDoor_826 | SM_CupboardDoor |
| 砖墙 | SM_Home_pCube23_163 | SM_Home_pCube23 |
| 橱柜柜体及木台面 | SM_CupboardBody_8 | SM_CupboardBody |
| 木餐桌 | SM_DiningTable_9 | SM_DiningTable |
| 水槽 | SM_Sink_32 | SM_Sink |
| 金属锅 | SM_Pans_polySurface43_20 | SM_Pot |

样本保持源组件的旋转、缩放、网格和全部材质槽位，仅平移到独立位置；使用 Movable 且禁用碰撞，便于观察。门板和砖墙原网格包含整排结构及开口，因此近景对准实体表面而非包围盒中心。生成清单记录源 Actor、变换、各材质及引用纹理的 sRGB、压缩和 LOD Bias。

项目副本位于 `tests/web-platform/build/projects/villa-material-lab/TriplexHouseVilla.uproject`，原项目和 `H:/UE_5.8` 不改动。准备阶段核验安装版模板文件哈希未变化。生成工程复用别墅的传统输入兼容配置。

Cook 使用默认关卡桌面配置，Web 使用已有 SM5 deferred 多线程运行时、TAA、原生窗口像素、4096 CSM 和本地纹理流送。保留原始纹理尺寸和 BC mip，不另设纹理分辨率上限；流送池为 256 MiB。只 Cook 新地图的依赖，最终包约 0.53 GB，包含运行时。

## 构建与验证

```powershell
& tests/web-platform/build-web-villa-material-lab.ps1
node tests/web-platform/serve.cjs
```

服务已在 8765 运行时无需重复启动。`-SkipBuild` 复用宿主模块，`-SkipCook` 只 Stage / Package，仍检查已生成资产的来源指纹。

```powershell
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-villa-material-lab.cjs
& tests/web-platform/capture-web-villa-material-lab.ps1
```

浏览器探针检查包及来源哈希、地图、SM5、TAA、实际渲染尺寸、真实相机位置、页面/GPU 错误以及窄窗口控件布局，保存总览和六个近景。桌面捕获使用同一个生成工程、相同的相机和 FOV，在安装版 UE 的实际 SM5 编辑器视口推进天空和曝光后截图；通过启动参数应用同一默认关卡 Web 配置，不保存修改。

本轮宿主编译、地图生成、BC Cook、Stage、打包、脚本语法检查和浏览器七视角验证通过。Chrome 实际 1600×900，最终采样帧号为 285 至 1136，页面及 GPU 错误为零，390×844 的顶部控件无横向溢出。桌面端七张 1600×900 对应截图生成完成。原生编辑器日志另有启动时 Automation Condition failed 和缺少 StarterContent.upack 的记录，未阻止加载及截图；不将该日志描述为无错误。

## 观察与边界

人工对照中，橱柜表面细纹、砖墙纹理、木桌的纹理高光、水槽拉丝和锅的金属反射在两端均可见，同配置画面较接近。这不支持“所有法线贴图整体失效”的直接结论，但没有通过 Normal 输出或关闭法线的单变量实验验证每个材质节点。

桌面截图主动使用 Web 的功能配置，不代表原别墅编辑器默认设置的画面。原别墅的 GI、反射、曝光、灯光和后处理差异仍待单独排查，本轮未修复这些功能。桌面冻结渲染时钟，正式网页保持实时，云不能按逐像素一致验收；浏览器截图也包含左上控件。短时检查不代表长期稳定性或全分辨率 mip 驻留验收。

结果保存在 `tests/web-platform/results/`：

- `villa-material-lab-layout.json`：资产来源及两组相机。
- `web-project-villa-material-lab-threads-package-results.json`：包、来源及产物指纹。
- `villa-material-lab-browser-results.json`：浏览器状态及截图指纹。
- `villa-material-lab-native-results.json`：原生捕获输入、日志和截图指纹。
- `villa-material-lab-web-*.png`、`villa-material-lab-native-*.png`：同视角画面。
