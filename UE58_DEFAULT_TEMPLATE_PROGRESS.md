# 默认关卡浏览器运行进度

验收目标：UE 自带 `/Engine/Maps/Templates/Template_Default` 完成 Web 打包，在浏览器显示原始 Lit 地面、方向光和天空球；单个 Unlit 立方体不满足验收。

## 2026-10-21：接入原始默认关卡

- 新增模板检查 commandlet，确认原始地图包含方向光（强度 6）、实时 SkyLight、SkyAtmosphere、天空球 `SM_SkySphere`、`M_SimpleSkyDome` 和使用 `MI_ProcGrid` 的 Lit 地面。
- 增加独立 DefaultTemplate Cook/Stage 配置；继续使用引擎原图，不用手工拼装的替代场景。只在运行时设置相机，不替换地图中的网格或材质。
- 原生编辑器模块、Web 增量编译链接成功；默认关卡 Cook 成功，零着色器转换失败。Stage 得到 381 个文件、94,343,997 字节的资源包。
- 浏览器首次复现：0 帧，加载体积云噪声 `VT_PerlinWorley_Balanced` 的 sRGB BGRA8 3D 纹理时触发能力校验。尚未完成默认关卡渲染验收。
- 运行入口：`/web-engine.html?rhi=webgpu&incremental=1&cook=default`。
- 验证脚本：`tests/web-platform/probe-web-default-scene.cjs`。此阶段的双浏览器脚本只检查原图启动与连续帧，不能替代后续光照、天空的图像与差异验证。
