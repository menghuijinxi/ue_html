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

& tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -MaxParallelActions 8 -SkipHostPreparation
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
```

完整交付审计和正式发布另见 `UE58_DEFAULT_TEMPLATE_PROGRESS.md`；单浏览器本地运行不替代其中要求的双浏览器发布检查。

## 已完成的资源验证

2026-10-30 的默认关卡 Cook 与 Stage 均通过，地图为 `/Engine/Maps/Templates/Template_Default`，桌面 SM5，wasm64，共 425 个文件、225,003,973 字节。Edge 对本次 Cook 的 3,202 个 WGSL 模块检查通过，零模块编译错误。场景完整运行与同视角像素对照以最终运行报告为准。
