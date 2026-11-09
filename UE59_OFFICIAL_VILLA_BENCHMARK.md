# UE 5.9 官方 Wasm 别墅构建与性能测试

日期：2026-11-09。本记录随构建和测试更新，尚未取得浏览器性能结果。

## 输入与隔离

- 官方来源：`EpicGames/UnrealEngine` 的 `5.9` 分支。
- 固定提交：`589a52b5abcf7b0ee0e2fd9de58b4d2872672f21`。
- 独立源码：`E:/UE59WebBenchmark/engine-5.9`，不修改官方受 Git 跟踪的引擎文件。
- 原工程：`H:/TriplexHouseVilla/TriplexHouseVilla.uproject`。
- 测试副本：`E:/UE59WebBenchmark/TriplexHouseVilla/TriplexHouseVilla.uproject`。
- 地图：`/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla`。
- 工具链：独立 Emscripten 6.0.10；本机 MSVC 实际版本 14.50.35732、Windows SDK 10.0.26100.0。
- 机器：Intel Core i9-14900KF、64 GB 内存、NVIDIA GeForce RTX 3070。

`prepare-ue59-villa.ps1` 为原工程的 1,633 个文件记录 SHA-256，
复制后逐个核对资产和原配置。清单保存在副本的 `ue59-benchmark-inputs.json`。
原工程、现有 5.8 Web 包和 `H:/UE_5.8` 安装目录不由此次构建修改。

5.9 的 Wasm 不接受纯蓝图项目，因此只在副本中增加最小游戏模块和 Game/Editor Target。
副本 `.uproject` 清空 EngineAssociation，明确使用上述源码引擎；
OnlineSubsystemUtils、OnlineSubsystemNull 只对 Wasm 禁用。
额外的 `Config/Wasm/WasmEngine.ini` 开启实验性 SM5，同时保留默认的两个移动档。
原资产、DefaultEngine.ini、DefaultGame.ini、DefaultInput.ini 不改写。

## 构建

准备步骤已完成，两个 PowerShell 脚本通过语法检查，源资产和配置复制校验通过。
官方依赖正在同步；编辑器、ShaderCompileWorker 和 Wasm 游戏尚待构建。

```powershell
& H:/ue_html/tests/web-platform/prepare-ue59-villa.ps1
& H:/ue_html/tests/web-platform/build-ue59-villa.ps1 -Phase Dependencies
& H:/ue_html/tests/web-platform/build-ue59-villa.ps1 -Phase Editor
& H:/ue_html/tests/web-platform/build-ue59-villa.ps1 -Phase Shaders
& H:/ue_html/tests/web-platform/build-ue59-villa.ps1 -Phase Package
```

准备脚本要求目标目录不存在，防止覆盖既有工程；准备成功后直接运行后续阶段即可。
每次构建保存调用参数、引擎提交、完整日志、退出码及耗时，目录：
`H:/ue_html/tests/web-platform/results/ue59-official-villa`。
预定归档目录为 `E:/UE59WebBenchmark/package/Wasm`。

官方 GitDependencies 的帮助仍列出 `--include`，但该提交的解析器已不接收此参数，
且错误时返回 0。外围构建脚本已去掉此参数，并将该错误文本认定为失败；
最初那次仅打印帮助的运行不计作依赖同步成功。

## 测量边界

计划在同机、同浏览器、固定 1920×1080 输出下分别记录 forward、deferred 和 desktop
实际运行档位、冷/热启动、预热后帧耗时、内存、画面和 WebGPU 错误。
官方原有构建、RHI 和渲染默认值作为本次基线，不合入本项目 5.8 的性能修改。

当前原别墅配置的 GI=1、反射=1、虚拟阴影=1、硬件光追关闭。
现有 5.8 历史包及历史 FPS 的场景配置和采样条件不一定相同，不能直接计算优化倍率。
5.9 的移动 deferred 仍属于 ES3.1 移动路径；它的性能不能代表桌面画质达标。
官方 SM5 为实验性路径，默认 TAA、Lumen 反射关闭，Nanite/VSM/硬件光追不支持；
需连同截图、实际配置和已知渲染问题一起解读帧率。
