# 别墅原项目设置构建

日期：2026-11-02。源项目：`H:/TriplexHouseVilla/TriplexHouseVilla.uproject`。
地图：`/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla`。

## 配置来源

准备、Cook 和运行配置使用现有的项目设置模式：

```powershell
node tests/web-platform/prepare-web-project.cjs --project=H:/TriplexHouseVilla/TriplexHouseVilla.uproject --id=triplex-project --project-settings
& tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-SM5 -Scene Project -Project H:/ue_html/tests/web-platform/build/projects/triplex-project/TriplexHouseVilla.uproject -Map /Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla -UseProjectSettings -ReportId triplex-project -StopOnShaderError -SkipBuild
node tests/web-platform/stage-web-engine.cjs --project=triplex-project --desktop
node tests/web-platform/package-web-project.cjs --project=triplex-project --desktop --threads --distance-fields
```

没有传入渲染 Profile、贴图尺寸、压缩覆盖、输入 Profile、距离场覆盖或环境替换参数。不复用旧自定义配置 Cook。项目默认插件策略保留；仅追加 Cook 主机模块、插件路径及不含画质 CVar 的平台注册配置。原项目运行配置逐字节复制，WebEngine.ini 只含一行注释。

原项目在本轮运行期间保存过配置，因此在正式 Cook 前重新准备副本并核对 1633 个源文件的摘要。原始内容、项目描述及配置不由构建脚本修改。

Cook 着色器清单记录到的设置：

| 设置 | 值 |
| --- | --- |
| 动态 GI / 反射方式 | 0 / 0 |
| 默认抗锯齿方式 | 4（TSR） |
| 网格距离场 | 项目启用 |
| 虚拟阴影 | 0 |
| DBuffer / 静态光照 | 1 / 1 |
| 体积雾 / 体积云支持 | 1 / 1 |
| 虚拟纹理支持 | 1 |

这些是配置及 Cook 值；实际运行还受平台能力、场景后处理与资源使用情况影响。不会为了让浏览器运行而重新套用旧版强制 TAA、SSR 或关闭上述功能的配置。

## 构建工具修复

本机 MSVC 14.50 和 14.44 编译隔离 RenderCore 时触发内部错误；14.51 成功。Renderer 的优化编译也触发内部错误，使用 `-DisableHostOptimization` 仅关闭隔离原生 Cook 模块的 C++ 优化后成功：

```powershell
& tests/web-platform/build-native-rendercore.ps1 -Module RenderCore -MaxParallelActions 2 -CompilerVersion 14.51.36231 -DisableHostOptimization
& tests/web-platform/build-native-rendercore.ps1 -Module Renderer -MaxParallelActions 2 -CompilerVersion 14.51.36231 -DisableHostOptimization
& tests/web-platform/build-web-engine.ps1 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 2
```

两项新参数为可选项，正常构建默认行为保持原样。关闭优化仅作用于本次指定的隔离主机模块，不改变浏览器运行时编译优化、渲染配置或着色器优化。

平台映射生成器改为从 WebGPUShaderFormat 的实际编译响应文件识别 MSVC，避免写死 14.44 却使用 14.51 标准库头文件而触发 STL1001。

参考仓库补充稀疏检出 Chaos、GeometryCollection 的两个必需覆盖文件及 Web 平台 Build 文件；没有改动安装目录。Web 运行时最终链接与 WASM 结构校验通过，416 个对象；WASM 摘要为 `d5ae74a31551a72ac0c6abefa40064a44a650b29d2fbf2fc20e3de3cde40d203`。

## 验证与边界

- 全新 Cook 成功，退出码 0、5159 个产物、3,576,504,451 字节；日志汇总为 0 错误、14 警告，包括音频格式尚未支持及输出目录临时文件清理等警告。没有将 Cook 描述为零警告。
- Stage 成功：5157 个文件，排除两个重复的着色器元数据归档后，资源包为 3,331,985,583 字节。
- Package 成功：`build/triplex-project-distance-fields-threads/index.html`，总产物 3,517,221,839 字节。包报告 `useProjectSettings=true`、`textureCompression=Project`；`--distance-fields` 仅验证 Cook 已由项目启用的距离场能力，不修改配置。
- `villa-project-settings-config-validation.json` 验证 1633 个原输入未变，以及最终配置包中的 DefaultEngine.ini、DefaultGame.ini、DefaultInput.ini 与原项目逐字节相同，画质覆盖列表为空。
- Edge 1280x720 启动检查通过，约 23.45 秒到达检查点；截图有 33165 种颜色、非黑像素约 91.6%，未记录页面或 GPU 错误。此时间是本次本机样本，不代表通用加载性能。
- `project-gameplay-project-settings-build-20261102.json` 通过 1 轮 20 秒真实按键移动、转向及缩放检查，由第 3 帧到第 1020 帧，最大位移约 150 cm、最大转向约 31.5 度。设置覆盖列表为空，GPU 错误为 0，Game / Render / RHI 线程身份检查通过。只说明短时回归通过，不代表随机崩溃已解决。
- 运行值：GI=0、反射方式=0、距离场生成/AO/阴影开关=1、静态光照=1、DBuffer=1、体积雾=1、纹理池=1000 MiB、默认屏幕比例 CVar=0（由自动策略决定）；实际内部和输出分辨率均为 1280x720。支持开关开启不证明场景中的每个对应效果都被使用。

抗锯齿配置仍为 4（TSR），实际视图为 2（TAA）。`Engine/Private/SceneUtils.cpp` 的 `GetDefaultAntiAliasingMethod()` 在 `SupportsTSR()` 为 false 时自动回退到 TAA；当前 Web 没有声明 Gen5 Temporal AA 能力。这是引擎平台兼容回退，没有改写原配置，也没有声称 TSR 已在 Web 实现。

本地入口：`http://127.0.0.1:8765/build/triplex-project-distance-fields-threads/index.html`。
启动截图：`tests/web-platform/results/villa-performance-project-settings-build-20261102-startup.png`。
构建、Cook、Stage、Package 和浏览器 JSON 报告均位于 `tests/web-platform/results/`；旧自定义配置包未覆盖。

Lumen 的 GI 和反射方式均未启用，因此 `r.Lumen.HardwareRayTracing` 不会单独启用 Lumen 光追。`r.RayTracing=True` 是支持开关，不能证明场景正在使用光追效果。光追阴影可独立于 Lumen 启用，默认 `r.RayTracing.Shadows=0`，灯光也可强制启用；本轮未据此认定别墅存在光追画面差异。实现见 `Renderer/Private/LightRendering.cpp` 的阴影选择逻辑。

Web 平台仍不支持硬件光追、Nanite、Lumen 等能力；这是平台限制，不能将“使用项目设置”描述为与原生画面完全一致。场景本身未启用 Lumen，不把 Lumen 缺失列为本场景已证实的差异原因。原先用户暂停的随机崩溃调查不属于本次构建验收。
