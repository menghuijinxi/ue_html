# 本机默认关卡构建记录

## 工作区与版本

- 外围项目：`G:/UE_HTML/ue_html`，初始提交 `e19d401570383fed71df5f301e3d8e1a10c57b66`。
- 引擎参考源码：`G:/UE_HTML/UnrealEngine-1`，`html` 分支，提交 `1d8eba0ad95a09621cdcb70801a2364f3e3ee70b`。
- `ue_html/reference-engine` 是指向该引擎仓库的目录联接。
- 本机安装版引擎：`D:/UE_5.8`，5.8.1；Web 目标参考分支为 5.8.3。
- 本机构建使用 MSVC 14.44.35207、Windows SDK 10.0.22621.0，以及安装版引擎附带的 .NET 10。
- 工作区工具：Emscripten 6.0.9、Dawn/Tint `v20261009.190412`、DXC `v1.9.2609`。
- 可用测试浏览器：Edge 156.0.4314.50。

工具、隔离构建宿主、Cook 资源、构建日志及测试报告均留在被 Git 忽略的目录中。安装版引擎的原生模块不直接覆盖；本轮没有推送远程。

## 本次修复

- 原生 UBT 从当前安装版源码生成局部覆盖，避免旧版 `UEBuildTarget.cs` 与 5.8.1 的 API 不兼容。仅重建 RenderCore/Renderer，并为原生模块明确设置 `PLATFORM_WEB=0`。
- 构建宿主支持安装引擎和工作区分属不同盘符：硬链接遇到 `EXDEV` 时复制依赖文件。
- 原生模块构建可指定并行数，并显式传递安装引擎位置。
- 默认关卡 Stage 直接生成基础配置，不再依赖先运行一次 NullRHI 浏览器验证；与基础验证共享配置读取代码。
- Edge 可以生成桌面同视角对照输入；画面对照可用 `--edge` 单独检查本机浏览器。
- Cook 报告读取实际安装版版本号。
- Web 构建的蒙皮实现沿用安装版源码，只从目标分支提取默认参数处理，避免与安装版私有头文件及共享 Shader 结构混用；体积雾的深度缓冲实现同步复制配套声明，并记录这些输入的来源哈希。
- 引擎仓库提交 `ffd7a662b` 修复 Emdawn 端口脚本的目录联接路径解析，使工具依赖从外围项目的 `.tools` 目录加载。

## 后续增量构建

以下命令在 `G:/UE_HTML/ue_html` 的 PowerShell 中执行，依赖本次已准备好的工作区工具与隔离宿主。

```powershell
$env:UE_ENGINE_ROOT = 'D:/UE_5.8/Engine'
$env:UEEngineRoot = $env:UE_ENGINE_ROOT
$env:P1_ENGINE = 'D:/UE_5.8'
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'

# 原生渲染覆盖发生变化时才重建相应模块；两条命令顺序执行。
& tests/web-platform/build-native-rendercore.ps1 -Engine D:/UE_5.8 -Module RenderCore -MaxParallelActions 4
& tests/web-platform/build-native-rendercore.ps1 -Engine D:/UE_5.8 -Module Renderer -MaxParallelActions 4

& tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -MaxParallelActions 12 -SkipHostPreparation
& tests/web-platform/cook-web-engine.ps1 -Engine D:/UE_5.8 -Mode WebGPU-SM5 -Scene DefaultTemplate -StopOnShaderError -ValidateShaderJobCache -SkipBuild
node tests/web-platform/stage-web-engine.cjs --default-template --desktop
node tests/web-platform/package-web-default-template.cjs --desktop
```

在独立终端启动并保留服务：

```powershell
node tests/web-platform/serve.cjs
```

本地候选包地址为 `http://127.0.0.1:8765/build/ue-default-template-desktop/index.html`。运行验证：

```powershell
node tests/web-platform/probe-web-default-desktop.cjs --edge
& tests/web-platform/capture-web-default-native.ps1 -Engine D:/UE_5.8 -Mode desktop
node tests/web-platform/verify-web-default-desktop-comparison.cjs --edge
node tests/web-platform/probe-web-default-startup.cjs --desktop --candidate --browser=Edge --runs=1 --scale=1.5 --report=local-edge
```

完整交付审计和正式发布另见 `UE58_DEFAULT_TEMPLATE_PROGRESS.md`；单浏览器本地运行不替代其中要求的双浏览器发布检查。

## 本次运行结果

2026-10-30 已完成完整 UBT 编译链接、默认关卡 Cook、Stage 和打包。地图为 `/Engine/Maps/Templates/Template_Default`，桌面 SM5，wasm64；Cook 共 425 个文件、225,003,973 字节，最终网页包为 9 个文件、406,549,840 字节。

- Edge 对本次 Cook 的 3,202 个 WGSL 模块检查通过，零模块编译错误。
- Edge 156.0.4314.50 完整场景探针通过，`completeUEScene=true`，结束时运行到 3,685 帧；一分钟连续运行约 60.339 秒，预热后线性内存增长为零，页面/GPU 错误均为零。
- 实际前进、鼠标转向、失焦释放按键、横竖屏切换、恢复尺寸和重载均通过；失焦后的相机漂移为零。
- 普通页面在 DPR 1.5 下直接启动、横竖屏切换及移动检查通过，没有修改 GPU API，也没有冻结测试时钟。
- 同地图、配置、材质及相机的安装版 UE D3D12 SM5 截图对照通过，平均通道误差（满量程 255）：全图 1.370，材质 1.339，地面 0.962，天空 1.807。

主要报告位于 `tests/web-platform/results/`：

| 报告 | 结果 |
| --- | --- |
| `web-engine-full-build-results.json` | 完整普通 UBT 构建及链接通过 |
| `web-engine-webgpu-sm5-default-cook-results.json` | 默认关卡 Cook 通过 |
| `web-engine-webgpu-sm5-default-stage-results.json` | 资源和配置 Stage 通过 |
| `web-default-template-desktop-package-results.json` | 桌面候选包通过 |
| `web-desktop-shader-modules-edge-results.json` | 全部转换模块通过 |
| `web-default-desktop-edge-results.json` | 完整场景、实际通道、交互及一分钟运行通过 |
| `web-default-startup-local-edge-results.json` | 普通页面启动及三个窗口状态通过 |
| `web-default-desktop-comparison-results.json` | 与原生 SM5 同视角画面对照通过 |

网页截图：`tests/web-platform/results/default-desktop-edge-samples.png`。本次交付为本机 Edge 运行验证，未执行双浏览器正式发布流程，也不将一分钟检查扩展为长期稳定性结论。
