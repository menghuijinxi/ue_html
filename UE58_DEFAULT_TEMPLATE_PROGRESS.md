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

## 默认关卡的复现入口

以下命令从工作区根目录执行，依次构建普通 UBT 目标、Cook 原图、Stage、生成独立目录、验收独立目录。`package-web-default-template.cjs` 要求普通 UBT 构建成功，不能用诊断链接冒充。

```powershell
& ./tests/web-platform/build-web-engine.ps1 -MaxParallelActions 8 -SkipHostPreparation
& ./tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-ES31 -Scene DefaultTemplate -StopOnShaderError
node tests/web-platform/stage-web-engine.cjs --default-template
node tests/web-platform/package-web-default-template.cjs
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-default-scene.cjs --packaged
```

- 独立目录：`tests/web-platform/build/ue-default-template`，含 `index.html`、JS、WASM、配置、资源清单和资源包。需通过 HTTP 服务运行。
- 当前工作区已有服务：`http://127.0.0.1:8765/build/ue-default-template/index.html`；服务不运行时可在独立终端执行 `node tests/web-platform/serve.cjs`。
- 构建、Cook、Stage、独立目录和浏览器验收报告分别为 `results/web-engine-full-build-results.json`、`web-engine-webgpu-es31-default-cook-results.json`、`web-engine-webgpu-es31-default-stage-results.json`、`web-default-template-package-results.json`、`web-default-scene-results.json`。
- 仍是开发验证流程，使用工作区隔离的 5.8.0 原生 Cook 主机和 5.8.3 Web 源码覆盖；尚未接入编辑器一键 Web 打包，也不代表桌面渲染功能已全部移植。
