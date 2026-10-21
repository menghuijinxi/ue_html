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
