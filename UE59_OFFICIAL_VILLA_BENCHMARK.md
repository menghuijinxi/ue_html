# UE 5.9 官方 Wasm 别墅构建与性能测试

日期：2026-11-09。本记录随构建和测试更新，尚未取得浏览器性能结果。

## 输入与隔离

- 官方来源：`EpicGames/UnrealEngine` 的 `5.9` 分支。
- 固定提交：`589a52b5abcf7b0ee0e2fd9de58b4d2872672f21`。
- 独立源码：`E:/UE59WebBenchmark/engine-5.9`，不修改官方受 Git 跟踪的引擎文件。
- 原工程：`H:/TriplexHouseVilla/TriplexHouseVilla.uproject`。
- 测试副本：`E:/UE59WebBenchmark/TriplexHouseVilla/TriplexHouseVilla.uproject`。
- 地图：`/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla`。
- 工具链：独立 Emscripten 6.0.10；Windows 宿主改用 MSVC 14.44.35227、Windows SDK 10.0.26100.0。
- 机器：Intel Core i9-14900KF、64 GB 内存、NVIDIA GeForce RTX 3070。

`prepare-ue59-villa.ps1` 为原工程的 1,633 个文件记录 SHA-256，
复制后逐个核对资产和原配置。清单保存在副本的 `ue59-benchmark-inputs.json`。
原工程、现有 5.8 Web 包和 `H:/UE_5.8` 安装目录不由此次构建修改。

5.9 的 Wasm 不接受纯蓝图项目，因此只在副本中增加最小游戏模块和 Game/Editor Target。
副本 `.uproject` 清空 EngineAssociation，明确使用上述源码引擎；
OnlineSubsystemUtils、OnlineSubsystemNull 只对 Wasm 禁用。
额外的 `Config/Wasm/WasmEngine.ini` 开启实验性 SM5，同时保留默认的两个移动档。
原资产、DefaultEngine.ini、DefaultGame.ini、DefaultInput.ini 不改写。
官方 web-deploy 文档要求 Wasm Cook 排除 AIAssistant、AllToolsets、ToolsetRegistry；
准备脚本及现有测试副本均已应用这一规则。

## 构建

准备步骤已完成，两个 PowerShell 脚本通过语法检查，源资产和配置复制校验通过。
官方依赖同步成功：103,904 个文件、22,152.8 MiB 下载，耗时 2,245.516 秒；
编辑器宿主正在构建，ShaderCompileWorker 和 Wasm 游戏尚待构建。

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
引擎 `Engine/Intermediate` 是指向
`H:/ue_html/.tools/ue59-official-intermediate` 的目录联接，编译中间文件使用 NVMe。

官方 GitDependencies 的帮助仍列出 `--include`，但该提交的解析器已不接收此参数，
且错误时返回 0。外围构建脚本已去掉此参数，并将该错误文本认定为失败；
最初那次仅打印帮助的运行不计作依赖同步成功。

首轮宿主编译在 MSVC 14.50.35732 下遇到多个 `C1001` 内部编译器错误。
MSQS、MeshPaint、TraceTools 三个单元使用原 response file 和相同编译器单独重试均成功；
4 并发增量构建仍有 7 个编译单元失败，WorldBrowser 单独重试也发生 C1001 和访问异常。
因此停止使用 14.50.35732，切换到本机的 14.44.35227；两者都位于该提交
`Engine/Config/Windows/Windows_SDK.json` 的推荐范围内。
后续构建设置 `VSLANG=1033`，但 UBT 的部分子进程仍输出中文乱码。
没有为此修改引擎代码或渲染配置，编译器故障根因尚未确定。

14.44 的默认调度重建也出现多个 C1001/访问异常，不能归因于单一 MSVC 版本。
系统日志记录 2026-11-09 12:24:41（UTC+8）的 WHEA-Logger 19：
处理器核心 `Corrected Machine Check / Internal parity error`，APIC ID 40。
本项目既有文档也记录了类似编译器异常和进程亲和性对照。
12:53:51 起，本次构建进程树调整为 `0x00ff0000`（逻辑处理器 16–23），
未修改 BIOS、系统电源设置或引擎代码。实际进程检查保存为 `editor-affinity-change.json`。
后续可显式传 `-HostProcessorAffinity 16711680`；默认仍为不改变调度。
此项是宿主构建诊断条件，不证明硬件根因或普通调度稳定性已经修复。

## 测量边界

计划在同机、同浏览器、固定 1920×1080 输出下分别记录 forward、deferred 和 desktop
实际运行档位、冷/热启动、预热后帧耗时、内存、画面和 WebGPU 错误。
官方原有构建、RHI 和渲染默认值作为本次基线，不合入本项目 5.8 的性能修改。
本次为 Development 包：官方默认 C++ `-O2`、Wasm 链接 `-O1`，不能称为 Shipping 性能。

`benchmark-ue59-villa.cjs` 使用本机 Chrome 157 和工作区现有的 Node Playwright，
每档新建浏览器配置，再复用该配置做第二次启动。系统文件缓存与 GPU 驱动缓存不清除。
预热 30 秒后采集 30 秒，帧耗时来自官方 `PresentOffscreen` 中 Canvas texture 获取后
紧接的 `queue.submit`；每 120 帧与引擎自己的 present 日志交叉核对，计数不符则判失败。
这测量的是最终 Canvas 复制的 CPU 提交间隔，不等于显示器实际显示帧数或 GPU 完成延迟。
不使用逐 draw instrumentation，不修改官方引擎；截图在计时结束后采集。
`harness=1` 跳过网页 GPU 自动分档，采用工程和渲染器默认画质，不代表网页自动选择的
Medium 档；结果同时保存实际启动参数和官方加载阶段时间。

浏览器预检通过：Chrome 157.0.8103.39，NVIDIA Ampere，cross-origin isolation 和
SharedArrayBuffer 可用，支持 subgroups、clip-distances、texture-formats-tier2 与 BC 压缩。
预检不代表别墅已经运行，尚无游戏 FPS 结果。

当前原别墅配置的 GI=1、反射=1、虚拟阴影=1、硬件光追关闭。
现有 5.8 历史包及历史 FPS 的场景配置和采样条件不一定相同，不能直接计算优化倍率。
5.9 的移动 deferred 仍属于 ES3.1 移动路径；它的性能不能代表桌面画质达标。
官方 SM5 为实验性路径，默认 TAA、Lumen 反射关闭，Nanite/VSM/硬件光追不支持；
需连同截图、实际配置和已知渲染问题一起解读帧率。
