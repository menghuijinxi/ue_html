# UE 5.9 官方 Wasm 别墅构建与性能测试

日期：2026-11-09。官方 5.9 的别墅 Wasm 包已构建成功，并在本机浏览器中运行。
Desktop 原生 1080p、工程默认 Epic 的两轮均值为 **50.5 FPS**；
自动分辨率时为 **72.9 FPS**，普通网页 Medium 单轮为 **119.6 FPS**。

## 浏览器结果

机器为 RTX 3070、i9-14900KF、64 GB，Chrome 157.0.8103.39，DPR=1。
固定别墅入口视角，每轮预热 30 秒、采样 30 秒。除普通页面补测外各做冷/热浏览器配置两轮，
下表给出各轮 FPS、1% Low 和 p95 的算术平均；不是遍历整栋别墅的平均值。

| 条件 | Canvas 输出 | 场景渲染尺寸/比例 | FPS | 1% Low | p95 |
| --- | --- | --- | ---: | ---: | ---: |
| Forward，保留工程默认 | 1920×1080 | 移动渲染路径 | 120.0 | 103.6 | 8.67 ms |
| Deferred，保留工程默认 | 1920×1080 | 移动渲染路径 | 120.0 | 104.8 | 8.60 ms |
| Desktop，保留工程默认 Epic | 1920×1080 | SceneColor/Depth 1400×792 | 72.9 | 37.9 | 19.36 ms |
| Desktop，Epic，显式 100% 屏幕比例 | 1920×1080 | 原生 1920×1080 | 50.5 | 30.1 | 28.25 ms |
| Desktop，普通页面自动 Medium，仅一轮 | 1920×1080 | ScreenPercentage=71 | 119.6 | 72.3 | 9.16 ms |

100% 屏幕比例两轮分别为 50.29/50.69 FPS、1% Low 30.38/29.72 FPS；
最慢提交间隔 36.20 ms，共 14 个间隔超过 33.33 ms，没有超过 100 ms 的间隔。
该组只增加 `r.ScreenPercentage=100`，实测 CVar 为 100、动态分辨率为 0，
其余 Epic、Lumen GI、TAA 和官方 pacing 保持不变。
浏览器进程 working set 合计约 4.09–4.44 GiB。

默认 Desktop 两轮分别为 72.63/73.14 FPS、1% Low 37.37/38.33 FPS；
最慢提交间隔 30.37 ms，两轮均无超过 33.33 ms 的间隔。
默认 Desktop 的 Wasm 线性内存约 737 MiB，浏览器进程 working set 合计约 4.00–4.29 GiB；
后者可能重复计入共享页，不等于独占物理内存或显存。
共九轮正式性能测试没有浏览器崩溃、WebGPU validation 或 device-lost 错误。

默认 Desktop 的 READY 为冷浏览器配置 7.98 秒、复用配置 4.61 秒；
首个 Canvas 提交分别 7.93/4.58 秒。这里使用本机 NVMe 与不限制带宽的 localhost 服务，
并且资源仍可后台下载，不能当作公网首次访问下载完整 1.35 GB 的耗时。

实际引擎日志确认默认 Desktop 的 GI/反射/阴影 scalability 均为 3（Epic），TAA=2，
Lumen GI 允许，Lumen 反射被官方设备配置强制关闭。普通页面指定 `?tier=desktop`
后自动选择 Medium，三组 scalability 均为 1，ScreenPercentage=71；
它仍出现 Lumen 渲染日志，但画面光照与 Epic 明显不同，不能只比较 FPS。
`r.Shadow.Virtual.Enable=1` 是项目配置值，不证明当前平台实际运行了 VSM。

默认 `r.ScreenPercentage=0` 的含义是采用引擎自动分辨率，不能解释为 100%。
独立诊断通过浏览器实际创建的纹理确认 SceneColor、SceneDepthZ、GBuffer 为 1400×792；
这次增加纹理记录的运行明确排除在性能统计之外。
普通网页 Medium 成绩也不代表原生 1080p 渲染。

原配置缺失的全局 GameMode 没有使当前地图退回空白默认角色：
三档日志都确认地图自己的 `FirstPersonGameMode_C` 和
`/Game/BigTriplexHouseVilla/Blueprint/FPS_Character/FirstPersonCharacter` 实例。
独立 Desktop 诊断用官方 `LogLoc`/`FlushLog` 取得角色坐标，S/D 输入后移动 143.04 cm，
鼠标输入后偏航改变 18.50°。离屏自动化窗口没有获得 pointer lock，
本次验证的是键盘移动和可见的鼠标转向，不是浏览器全屏/锁鼠流程。

原始结果、完整日志、逐帧时间戳及 PNG 位于：
`tests/web-platform/results/ue59-official-villa/official-defaults-20261109`；
普通页面位于 `normal-page-desktop-20261109`，独立诊断位于 `desktop-diagnostics-v2-20261109`。
原生 1080p 组位于 `desktop-native1080-20261109`。
第一版坐标读取 helper 在返回值转换时报错，保留为失败诊断，修复后的 v2 已通过；
没有将失败诊断或带纹理记录的 FPS 混入正式成绩。

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/benchmark-ue59-villa.cjs --tag=new-defaults-run --tiers=forward,deferred,desktop --runs=2 --seconds=30 --warmup=30 --interaction
node tests/web-platform/benchmark-ue59-villa.cjs --tag=new-native1080-run --tiers=desktop --runs=2 --seconds=30 --warmup=30 --screen-percentage=100 --interaction
node tests/web-platform/benchmark-ue59-villa.cjs --tag=new-normal-page-run --tiers=desktop --runs=1 --seconds=30 --warmup=30 --normal-page --interaction
node tests/web-platform/inspect-ue59-logs.cjs --tag=new-defaults-run
```

每次使用尚不存在的新 tag；最后一条在相应测试结束后运行，从该浏览器配置的 OPFS
提取引擎完整日志，不再启动游戏。页面控制台默认只打印部分日志，单看命令回显不能证明 CVar 值。

## 本地运行

已运行的服务是 `http://127.0.0.1:8900/index.html?tier=desktop`，使用 Chrome 打开。
这个普通入口自动设置 Medium；基线测量的高画质入口为：

```text
http://127.0.0.1:8900/index.html?tier=desktop&harness=1&args=-dpcvars=t.MaxFPS=0,r.VSync=0,r.ScreenPercentage=100
```

输出尺寸随浏览器窗口变化；上表由自动化明确固定到 1920×1080，手动改变窗口不能直接比较。
首次高画质测试应使用新的浏览器配置，已有普通页面的保存设置可能改变后续画质。
本地服务关闭后可在终端重启：

```powershell
& E:/UE59WebBenchmark/emsdk-6.0.10/python/3.13.3_64bit/python.exe E:/UE59WebBenchmark/engine-5.9/Engine/Platforms/Wasm/Build/Tools/web/serve.py --root H:/ue_html/tests/web-platform/build/ue59-official-villa-20261109 --bind 127.0.0.1 --port 8900 --net none
```

可审查的汇总证据已写入 `tests/web-platform/evidence/ue59-official-villa-20261109.json`，
包含所有轮次、原始数据 SHA-256、档位与 CVar 日志、独立纹理/坐标诊断和边界。
`summarize-ue59-villa.cjs` 再次检查原工程 1,633 个文件 SHA-256、归档副本 70 个文件 SHA-1，
以及两个 manifest 的存在、尺寸、SHA-1/Brotli 尺寸，并核对逐帧样本计算的 FPS。
上述检查已通过，官方引擎受 Git 跟踪文件仍无修改。

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
编辑器宿主已于 13:34:52（UTC+8）成功构建，最终增量补编 60 个步骤、137.033 秒、退出码 0；
ShaderCompileWorker 已成功构建（297 个步骤、252.201 秒、退出码 0）；
Wasm 游戏、Cook、Stage、Package、Archive 于 14:21:41（UTC+8）完成：
最后一轮 UAT 共 2,146.760 秒，退出码 0，`BUILD SUCCESSFUL`。
游戏编译 1,055 个步骤；Cook 1,980 个包，0 错误、3 条警告。

```powershell
& H:/ue_html/tests/web-platform/prepare-ue59-villa.ps1
& H:/ue_html/tests/web-platform/build-ue59-villa.ps1 -Phase Dependencies
& H:/ue_html/tests/web-platform/build-ue59-villa.ps1 -Phase ToolDependencies
& H:/ue_html/tests/web-platform/build-ue59-villa.ps1 -Phase Editor
& H:/ue_html/tests/web-platform/build-ue59-villa.ps1 -Phase Shaders
& H:/ue_html/tests/web-platform/build-ue59-villa.ps1 -Phase Package
```

本机存在以下稳定性问题，后续实际构建使用 `-MaxParallelActions 8 -HostProcessorAffinity 16711680`；
这两个参数只约束当前构建及其子进程，脚本结束时恢复调用进程亲和性。
UAT 的 `UbtArgs` 只传给游戏目标，工具目标 UnrealPak 仍自动选择 MSVC 14.50.35732；
编辑器/ShaderCompileWorker 为 14.44.35227，Wasm 游戏为 Emscripten 6.0.10/Clang 24。
每个目标的实际工具链以完整日志为准，阶段 JSON 的字段明确记为 `requestedCompilerVersion`。

准备脚本要求目标目录不存在，防止覆盖既有工程；准备成功后直接运行后续阶段即可。
每次构建保存调用参数、引擎提交、完整日志、退出码及耗时，目录：
`H:/ue_html/tests/web-platform/results/ue59-official-villa`。
归档目录为 `E:/UE59WebBenchmark/package/Wasm`。
NVMe 测试副本为 `H:/ue_html/tests/web-platform/build/ue59-official-villa-20261109`；
两份包的 70 个文件逐个 SHA-1 相同，官方 webrun stamp/verify 检查通过。
本地服务使用官方 `serve.py`，只监听 `127.0.0.1:8900`，COOP/COEP 响应头已检查。
引擎 `Engine/Intermediate` 是指向
`H:/ue_html/.tools/ue59-official-intermediate` 的目录联接，编译中间文件使用 NVMe。

官方 GitDependencies 的帮助仍列出 `--include`，但该提交的解析器已不接收此参数，
且错误时返回 0。外围构建脚本已去掉此参数，并将该错误文本认定为失败；
最初那次仅打印帮助的运行不计作依赖同步成功。
首次 UAT 初始化还发现：自动化项目即使在 Windows 构建，也无条件复制
`EpicGames.Perforce.Native` 的 Linux/macOS Release 库，而前述平台筛选排除了这两个文件。
此外，IOS 自动化模块的 GreenCheck/GreyCheck 图标也被平台筛选排除，导致资源编译失败。
`ToolDependencies` 从原始 `Commit.gitdeps.xml` 提取上述两个库、两个图标及 IOS 导出模板的 Blob/Pack 记录，
在独立临时目录调用官方 GitDependencies 下载，再核对下载与复制结果的 SHA-1。
首次两个库下载约 5.3 MiB，后续图标及模板约 1.1 MiB，文件哈希与官方清单一致；
没有改动官方依赖清单或项目源码。

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
调整亲和性后，本轮剩余宿主构建没有新增内部编译器错误；
ImageWriteQueue 使用相同 response file 的受限重试成功，随后完整 60 步增量构建成功。
不将前面三轮失败构建计作成功，所有阶段日志和退出码仍保留。

## 测量边界

在同机、同浏览器、固定 1920×1080 输出下分别记录 forward、deferred 和 desktop
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

浏览器条件：Chrome 157.0.8103.39，NVIDIA Ampere，驱动 610.88，cross-origin isolation 和
SharedArrayBuffer 可用，支持 subgroups、clip-distances、texture-formats-tier2 与 BC 压缩。
浏览器使用系统默认进程调度，没有应用宿主编译阶段的 CPU 亲和性限制。
测量期间没有引擎编译或官方发布扫描进程。

启动时间分别记录首个真实 Canvas 提交与 `UE_RUN READY`：
`ue-first-frame` 是地图载入后第一次游戏 Tick，可能早于实际出画面，不能作为可交互时间。
早期 `desktop-smoke-default-20261109` 的 `readySeconds` 使用了这个过早事件，
且当时发布扫描仍在运行，所以该短测不计入正式结果。
正式脚本已修正，保留独立的 `firstEngineTickSeconds`。

`WebGPUDevice.cpp` 的官方 `WebGPUFrameGate` 默认为 2，最终提交后等待浏览器动画帧再继续；
保留这一默认行为。因此移动档约 120 FPS 是本环境的帧节奏限制，不是无上限吞吐量。
没有使用 `WebGPUFrameGate=0` 或关闭 GPU pacing 来提高报告中的帧数。

当前原别墅配置的 GI=1、反射=1、虚拟阴影=1、硬件光追关闭。
现有 5.8 历史包及历史 FPS 的场景配置和采样条件不一定相同，不能直接计算优化倍率。
5.9 的移动 deferred 仍属于 ES3.1 移动路径；它的性能不能代表桌面画质达标。
官方 SM5 为实验性路径，默认 TAA、Lumen 反射关闭，Nanite/VSM/硬件光追不支持；
需连同截图、实际配置和已知渲染问题一起解读帧率。

## 包与验证记录

- Wasm：193,406,255 字节；Brotli 后 39,076,337 字节。
- 资源缓存清单：23 项，未按 HTTP Brotli 计的大小合计 1,521,703,916 字节；
  各文件优先采用 Brotli 时合计 1,351,908,965 字节。IoStore 容器本身已有压缩。
- 归档 70 个文件合计 1,600,888,468 字节，包含原文件及 `.br`，不是单次网络下载量。
- Wasm SHA-1：`4d303c65fa19b9bba13d3ff5dc7be6ea0df3f6c3`。
- 官方 stage SHA-1：`de719cdb2dc524fde78244077fc71e203fa0b8a9`。
- stamp 记录官方引擎受跟踪文件 `dirty=false`。
- 原工程 1,633 个输入文件再次 SHA-256 检查通过，见 `original-project-check.json`。

官方 `check_stage.py` 的完整公开发布扫描运行 10 分钟仍未结束，已停止，
以避免干扰正式计时；不能把它记成完整通过。这里的成功检查是单独完成的
归档副本逐文件校验及官方 stamp/verify。本包只用于 localhost Development 测试，
没有公开部署，也没有宣称通过发布隐私检查。

## 已知边界

Cook 的 3 条警告是：原配置的 `/Game/FirstPersonBP/Blueprints/FirstPersonGameMode`
不存在；`M_GlassBlur` 在 Forward `SF_WEBGPU_ES3_1` 因 SceneColor 需要延迟渲染而
编译失败、使用默认材质；同一材质随后出现无效 ShaderMap 警告。
运行时也有 legacy HTTP、NULL 在线子系统、ToolsetRegistry 清单缺失和
无效材质资源日志。性能测试的“通过”只表示正确档位/分辨率、帧计数对应、
有效画面及没有浏览器崩溃、WebGPU validation/device-lost 错误，不表示引擎日志无告警。

Desktop 入口画面显示 2,083 个对象光照待重建；三档都有纹理池超预算提示。
没有重建项目光照、增大纹理池或删除材质来美化基线。
移动档光照和细节与 Desktop 明显不同，不能以移动档 FPS 代表桌面效果达标。
尚未完成同场景同视角的 5.9 Windows 原生包画质对照，也不以本次别墅测试代替
工作区 `/Engine/Maps/Templates/Template_Default` 的完整验收。

首次 UAT 启动还由官方引擎自动更新了用户级 Zen 缓存服务；
它属于引擎运行产生的缓存状态，不是对 `H:/UE_5.8` 安装文件的修改。
