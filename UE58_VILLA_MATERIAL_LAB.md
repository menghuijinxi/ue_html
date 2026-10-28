# 别墅模型材质对照关卡

2026-10-28。将别墅中的实际模型放入默认关卡副本，检查同光照下的材质表现，缩小原别墅亮度、反射和法线细节差异的排查范围。

浏览器地址：`http://127.0.0.1:8765/build/villa-material-lab-threads/index.html`。顶部可以选择总览及六个模型，勾选“近景”直接观察表面；取消后查看整个模型。保留现有自由相机操作。

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
