# 按原始项目设置构建别墅

本轮于 2026-11-14 开始，跨日继续。原项目为 `G:/UE_HTML/TriplexHouseVilla/TriplexHouseVilla.uproject`，地图为 `/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla`。外围源码基于 `f991662`，引擎基于 `94189abfe`。

按用户要求直接使用原项目配置。Lumen GI、Lumen 反射、虚拟阴影、距离场保持项目中的开启状态；没有套用旧测试副本的关闭配置。独立项目副本位于 `tests/web-platform/build/projects/villa-project-settings-20261114`。Web 使用平台实际支持的能力；例如硬件光追不受 WebGPU 支持时，Lumen 使用引擎的软件回退，不能据此声称与原生硬件光追画质相同。

## 打包脚本修复

此前 `package-web-project.cjs` 即使读取 `useProjectSettings=true` 的 Cook，也会追加 `web-accepted-defaults.cjs` 中的帧率、画质和输入配置。本轮让项目设置模式保留 Stage 的完整配置包，并在收尾后校验其 SHA-256 不变。普通桌面多线程包仍经过统一发布收尾流程，校验当前 worker 并采集实际管线预热记录。

首次浏览器启动在严格全局着色器检查中发现 `FClearStreamingRequestCount_CS` 缺失。安装版 Engine DLL 的 Nanite 流送清零、散布更新编译条件比 Web 运行时旧，Cook 清单中对应排列为 0。本轮在隔离 RenderCore 的 Web 原生 Cook 条件中精确补齐这两个普通计算着色器，限定名称、源码路径与桌面平台，并重新构建、Cook；保留运行时的缺失着色器检查。

## 构建命令

在仓库根目录执行，Node 依赖通过本机 `NODE_PATH` 提供：

```powershell
$env:UE_ENGINE_ROOT = 'D:/UE_5.8/Engine'
$env:UEEngineRoot = $env:UE_ENGINE_ROOT
$env:P1_ENGINE = 'D:/UE_5.8'
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
& tests/web-platform/build-native-rendercore.ps1 -Engine D:/UE_5.8 -Module RenderCore -MaxParallelActions 4
& tests/web-platform/build-native-rendercore.ps1 -Engine D:/UE_5.8 -Module Renderer -MaxParallelActions 4
& tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -MaxParallelActions 4
& tests/web-platform/build-tint-nanite.ps1
node tests/web-platform/prepare-web-project.cjs --project=G:/UE_HTML/TriplexHouseVilla/TriplexHouseVilla.uproject --id=villa-project-settings-20261114 --project-settings
& tests/web-platform/cook-web-engine.ps1 -Engine D:/UE_5.8 -Mode WebGPU-SM5 -Scene Project -Project G:/UE_HTML/ue_html/tests/web-platform/build/projects/villa-project-settings-20261114/TriplexHouseVilla.uproject -Map /Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla -UseProjectSettings -ReportId villa-project-settings-20261114 -StopOnShaderError -OutputRoot G:/UE_HTML/ue_html/.cache/villa-project-settings-20261114
node tests/web-platform/stage-web-engine.cjs --project=villa-project-settings-20261114 --desktop
node tests/web-platform/package-web-project.cjs --project=villa-project-settings-20261114 --desktop --threads --distance-fields --output-folder=villa-project-settings-20261115
```

`--distance-fields` 用于核对 Cook 已由项目启用的距离场状态，不改变项目配置。运行时使用多线程、mimalloc 和 lowered memory64；没有额外设置固定分辨率或诊断预热参数。

首次完整 Cook 在虚拟阴影投影转换处失败：本机 11 月 7 日构建的 `tint_nanite.exe` 不认识合并后的 `--vsm-adaptive`，返回码 2 且没有错误文本。重建转换工具后，同一个真实 SPIR-V 转换通过，384 个 GPU 通道的自适应策略测试通过；第二次 Cook 使用相同项目设置和 `-SkipBuild` 继续。

## 已完成验证

- 隔离原生 RenderCore / Renderer 构建通过，分别 8 / 40 个动作，安装目录输入摘要未变。
- 浏览器运行时构建、链接及 WASM 校验通过，447 个对象。修复后的最终 WASM SHA-256 为 `ae93fa98b075ecb31d1d48c5e205c8c1b3b5c9df9cdcb8dcab880262016fbb5a`。
- 六项 Lumen 着色器预检通过；天空光捕获通过。首轮完整 Cook 退出码 0，5165 个产物、3,924,229,812 字节；日志汇总 0 错误、16 警告（含音频格式未支持、临时目录清理及跨平台 CVar 提示）。后续因浏览器发现的清单缺项重新 Cook。
- 最终完整 Cook 成功：5165 个产物、3,924,243,548 字节；Stage 成功：5163 个文件、资源包 3,505,778,452 字节。两个补齐的着色器在 Cook 清单中均有 1 个排列。
- 最终包成功：13 个文件、3,689,261,018 字节，输出 `tests/web-platform/build/villa-project-settings-20261115`。普通发布的实际管线采集通过，包含 116 条图形和 204 条计算预热管线；无诊断替换或推测预热参数。
- 配置验收通过：1632 个原始输入摘要未变，最终 DefaultEngine.ini、DefaultGame.ini、DefaultInput.ini 与原项目逐字节一致，配置包与 Stage SHA-256 相同，`rendererOverrides=[]`。
- Edge 在 1280×720、DPR 1 的实际管线采集启动约 42.43 秒；正式包启动检查约 28.01 秒。时间仅代表本次机器上的样本。
- 正式包 12 秒真实按键移动及转向通过，帧数 34→503，末位移约 191.7 cm；页面及 GPU 错误为 0。实际 GI=1、反射=1、虚拟阴影=1、距离场=1，虚拟纹理和虚拟阴影路径均活跃，实际抗锯齿为 TSR（4）。预热已采用，命中 347 次。

## 测试入口与证据

- 本机服务入口：[打开别墅](http://127.0.0.1:8765/build/villa-project-settings-20261115/index.html)。该页面需要提供 COOP/COEP 的 HTTP 服务，不使用文件协议打开。
- 简要证据：`tests/web-platform/evidence/villa-project-settings-20261115.json`。
- 配置验收：`tests/web-platform/results/villa-project-settings-20261115-validation.json`。
- 浏览器启动及移动：`tests/web-platform/results/villa-startup-project-settings-20261115/result.json`；截图 `0-spawn.png`、`0-ours.png`。
- 实际预热采集：`tests/web-platform/results/villa-startup-auto-prewarm-a439b75b-eb1c-4c5c-b957-cea4611c968b/result.json`。

本轮验收涵盖构建、配置保持、首屏和短时移动；未完成长期稳定性或原生硬件光追效果对照。Cook 仍有音频格式未支持等警告，不将此包描述为音频和全部视觉效果已经验收。修改仅提交本地，没有推送远程。
