# Edge 原生崩溃诊断

## 2026-11-06：当前 VT/VSM 包的高概率启动失败

用户报告普通页面约 80% 无法显示画面，其他电脑似乎正常。本轮在同一台机器、
同一 `triplex-virtual-distance-fields-threads` 包复现；未把少量测试换算成 80% 的统计结论。
直接故障确认是 Edge 内的 DXC 原生崩溃，普通调度仍未修复。

### 原始诊断与精确转储对应

- 用户文件 `ue-startup-diagnostics-2026-11-06T06-48-22-397Z.json` 记录 5163/5163 个资源完成挂载，
  6163 个 Shader 已注册，桌面 SM5 路径已运行到第 1 帧，画布为 2405×1353。
- 设备丢失时间是 2026-11-06 **14:48:19.228（UTC+8）**；Edge Crashpad 的
  `56ac6f16-aab9-408f-9c32-9d6d7a92ff87.dmp` 头部时间为同秒。
  异常码 `0xc000001d`，指令地址落在 Edge 156.0.4314.58 的
  `dxcompiler.dll+0xf4162d`。本机对应 DLL 字节为 `0f 0b`（UD2）。
- 14:47:14 的 Windows Application Error 1000 还记录了一次 DXC `0xc0000409`；
  它早于用户这次启动，不将其误配为 14:48:19 这次故障。
- 此次 `A valid external Instance reference no longer exists` 是页面观测到的设备丢失，
  不能仅据其文字推断 UE 释放 Instance 出错，也不能据 `0xc000001d` 认定 CPU 缺少指令集。

### 同包 A/B/A 对照

全部使用可见 Edge 156.0.4314.58、独立配置目录、CSS 1614×902、DPR 1.5。
各组依次执行，包文件哈希相同，未改 Shader、UE 设置、特效或浏览器编译开关。

| 条件 | 结果 |
| --- | --- |
| 默认调度 A | 第一次启动、第 1 帧失败；15:01:49 转储为 `dxcompiler.dll+0xc7ebf8`、`0xc0000005` |
| 仅测试浏览器限制逻辑核心 16–31，`0xffff0000` | 三轮启动/刷新及三次缩放全部通过；启动帧 180/181/180，缩放后 270/273/270 |
| 恢复默认调度 B，另一个新配置 | 第一次启动、第 1 帧失败；15:07:57 转储为 `dxcompiler.dll+0xf4162d`、`0xc000001d` |

受限组首轮与第三轮启动为 2405×1353，第二轮因沿用前次缩放为 1920×1080。
启动前实际设置浏览器及其子进程掩码，随后六个采样点只读复核，GPU 进程始终保持同一 PID
及 `0xffff0000`；不能只凭 Node 父进程掩码认定 GPU 已受限。
通过组无页面/GPU 错误，最终截图人工确认有实际带光照场景；这不是普通调度的性能验收。

本轮假设依次为主机/核心调度条件、DXC 软件缺陷、当前场景资源压力。
结果支持前两者及其交互；改变亲和性同时改变核心、并发和时序，尚未做等核心数/等负载对照，
不能区分硬件问题与编译器缺陷。历史独立 DXC 回放见下文，本轮没有重跑已清理的 HLSL 语料。

### 主机检查与下一步

本机读取到 i9-14900KF、RTX 3070、ROG STRIX Z790-A GAMING WIFI S，
BIOS 1801（SMBIOS 日期 2024-11-30）。重新查询系统日志仍可见
2026-11-04 11:03:21 的 WHEA-Logger 19：处理器核心 `Internal parity error`、APIC ID 8。
这使主机稳定性成为高优先级检查项，不能仅由这一条历史纠正错误宣布 CPU 已损坏。

2026-11-06 访问该型号的[华硕官方支持页](https://rog.asus.com.cn/motherboards/rog-strix/rog-strix-z790-a-gaming-wifi-s/helpdesk_download/)，
“BIOS & 固件”列出 2301、发布日期 2026-11-06，说明涉及系统性能、安全与兼容性，
并会更新 Intel ME 至 16.1.40.2765。本轮只核对页面，没有下载/刷写 BIOS，
也没有确认现有超频、降压或 XMP 状态。后续应由用户在确认主板型号及厂商操作要求后，
核对 BIOS 更新与 Intel 默认设置，再在默认 CPU 调度下重跑同包；必要时进一步检查 CPU/内存稳定性。
固件更新本身不能保证修复这次故障。

需要临时查看当前原画质包时，本机可运行：

```powershell
& H:/ue_html/tests/web-platform/start-web-preview.ps1 -Folder triplex-virtual-distance-fields-threads -AffinityMask 4294901760
```

它只限制新建独立浏览器，可能降低 CPU 性能；不适用于其他机器，也不构成普通启动修复。
普通网页无法用 JavaScript 设置浏览器原生 GPU 进程的 Windows CPU 亲和性。
本轮另用该脚本打开实际交互窗口，在 1866×1050 下验证到 184 帧、无启动失败，
并在加载后核对浏览器/GPU 子进程仍为 `0xffff0000`；窗口保留给用户。
截图与诊断为 `results/virtual-startup-host-preview-20261106.{png,json}`。

### 可复核证据与工具

摘要与原始文件哈希：`tests/web-platform/evidence/virtual-startup-host-20261106.json`。
三份生命周期原始报告标签为 `virtual-startup-{default-a,ecores,default-b}-20261106`。
原始转储留在本机，未上传或提交其内存内容。

`probe-web-browser-lifecycle.cjs` 新增显式 `--affinity-mask`；默认不改变调度。
它在空白页阶段设置实际浏览器/GPU 进程，启动及缩放后只读校验；成功时保存场景截图。
新增 `diagnostics/inspect-minidump.cjs` 读取时间、异常码和包含异常地址的模块；
拒绝截断数据，只报告直接异常位置，不猜测调用栈或硬件健康状态。
真实三份转储的异常位置、非法/截断输入、JavaScript 语法及上述 A/B/A 路径均已检查。

```powershell
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node H:/ue_html/tests/web-platform/probe-web-browser-lifecycle.cjs --folder=triplex-virtual-distance-fields-threads --headful --width=1614 --height=902 --dpr=1.5 --runs=3 --affinity-mask=4294901760 --tag=host-recheck
node H:/ue_html/tests/web-platform/diagnostics/inspect-minidump.cjs "C:/Users/wap80/AppData/Local/Microsoft/Edge/User Data/Crashpad/reports/56ac6f16-aab9-408f-9c32-9d6d7a92ff87.dmp"
```

默认调度对照去掉 `--affinity-mask`，使用不同 `--tag`。普通浏览器修复、长期稳定性、
跨机器及硬件根因均仍待验收。本轮没有修改引擎或发布包。

## 2026-11-04：继续尝试兼容

普通 WebGPU 应用能运行，与别墅触发 DXC 崩溃并不矛盾。本轮抓到 302 个实际 WGSL 模块、333 个不同描述符和 420 次管线创建请求；脱离 UE 后逐条异步编译全部完成。报告点名的 `main_00002028_1fc9f5c5` 约 12 KB，对应两条阴影管线也能单独创建，不能把它当成必然失败的 Shader。同步创建回放虽无设备丢失，但没有绘制，也没有等待每条管线实际完成编译，不据此计作同等编译验收。

完整场景的默认模式对照在首次 3488×1962 启动通过后，1920×1080 重载时复现设备丢失。一次 DOM 元数据模式也通过；它和抓取模式均改变时序，不能证明新原生元数据读取有错。早期两次失败测试意外重叠，不纳入独立 A/B 统计。

尝试传入 `--disable-dawn-features=d3d12_use_hlsl_2021` 后，两批共七轮启动/刷新/缩放，以及两个独立配置各 60 秒移动/转向/跳跃/缩放通过，末帧分别 2369、2346。恢复默认编译模式后两轮也通过。GPU 配置页的 Dawn 明细没有抓取完整，亦未取得实际 HLSL 转储，不能宣称编译模式已核实或该选项已修复故障。它仅作为显式实验参数保留。

实际普通 Edge 的沙箱 GPU 子进程曾把继承亲和性重置为全部核心。新增 `tests/web-platform/start-web-preview.ps1` 会先打开空白页，等待、设置并核对浏览器及 GPU 子进程后再导航；同时启动或复用本地服务。受限核心仅用于这个独立配置，不修改既有浏览器、系统或项目设置。默认不限制核心，使用下列本机临时命令时才限制：

```powershell
& H:/ue_html/tests/web-platform/start-web-preview.ps1 -AffinityMask 4294901760
```

本轮未改变 UE、Shader、包体或画质配置。GI/反射仍为 1、AA 仍为 TSR 4、距离场 AO/阴影仍开启。受限核心会影响 CPU 性能，GPU 进程重启后也可能需要重新启动该独立预览；它不构成普通浏览器根因修复。证据及通过范围见 `tests/web-platform/evidence/villa-startup-compat-20261104.json`，长期稳定性和其他机器对照仍未完成。

## 当前结论

2026-11-02 的 TLV 别墅启动失败已在可见 Edge 窗口复现。GPU 进程转储指向 `dxcompiler.dll`，旧版无 TLV 包也会失败；当前 Edge 的 DXC 脱离 UE、浏览器和 GPU 绘制后也能发生访问违规。限制到本机逻辑核心 16–31 时，独立编译、完整场景启动和交互通过。目前只提供隔离浏览器的临时预览方法，普通浏览器启动仍未修复，不能认定 CPU 损坏或编译器并发已被证明是根因。详见下节。

2026-10-30 用户报告别墅页面反复出现 `STATUS_ACCESS_VIOLATION`。当天 12:17:06（UTC+8）的本机转储确认：Edge 156.0.4314.50 的 renderer 进程在 WebGPU `createBindGroup()` 的 Blink 参数转换阶段发生原生非法内存读取。

这次故障已定位到浏览器内部函数，但尚未复现并修复根因。不能将它说成已确认的显存不足、Wasm 堆越界、UE 断言失败或服务器中断，也不能仅凭崩溃位于浏览器就排除更早发生的内存破坏。

此前画质、距离场及短时运行回归通过，不代表间歇性的浏览器进程崩溃已经解决。

## 2026-11-02：TLV 别墅启动失败

用户报告 `ue-startup-diagnostics-2026-11-02T10-16-26-313Z.json`：5157 个资源挂载完成，3878 个着色器已注册，但呈现帧数为 0；启动约 12.8 秒后报告 `WebGPU device lost: A valid external Instance reference no longer exists.`。没有先行 GPU 参数校验错误，不能凭这句话判断 UE 提前释放 Instance。

### 原入口复现及对照

- 最新 TLV 包在 1639×922 的可见窗口启动失败；回归报告 `project-gameplay-tlv-startup-repro-20261102.json`。
- 1280×720 可见窗口同样失败，GPU 进程退出码 `0xc000001d`。自有测试配置的转储 `40bc599d-3fb4-4814-9e37-3402e18af87e.dmp` 落在 Edge `156.0.4314.50` 的 `dxcompiler.dll+0xf4162d`，反汇编为断言路径末端的 `ud2`，与 10 月 30 日的一次 GPU 故障偏移相同。日志为 `web-startup-tlv-visible-720-before-browser.log`。
- 旧版 `triplex-project-tsr-distance-fields-threads` 的可见窗口也失败；转储 `2bfed3f1-2368-4174-b6b1-2b10a5cfd84f.dmp` 为 `0xc0000005`，位于 `dxcompiler.dll+0xf3f081` 的内存复制写入指令。
- 最新包新建配置的无界面运行通过至少 180 帧；但可见窗口再次检查发生 renderer 原生崩溃，偏移 `msedge.dll+0x2ad2e9`。这些异常不能仅凭发生于同一机器就合并成同一个根因。
- 捕获实际 WGSL、布局及管线后，265 条管线的异步逐条回放及同步批量回放均有通过；记录全部描述时完整场景也有启动成功。插桩会改变时序，单次回放成功不能排除故障，也不能证明管线并发是原因。

这些对照不支持把新 TLV 注入、资源校验或分辨率直接定为根因。上次 TLV 交付的运行验证使用无界面浏览器，未覆盖本次可见窗口的失败条件。

### 独立 DXC 对照

使用已有的 53 份 Dawn 实际 HLSL、原始 SM 6.8 编译参数，通过 `IDxcCompiler3` 连续编译。直接加载当前 Edge 自带的 `dxcompiler.dll` 1.9.2609.0，不替换 DLL，不加载 UE、资源包或 GPU 绘制。三组依次执行，避免同时进行场景和编译压力测试：

| 执行条件 | 结果 |
| --- | --- |
| 默认调度 | 12.56 秒后访问违规退出 `0xc0000005`；最后记录第 12 轮 `19-cs_6_8.hlsl`，逻辑核心 10 |
| 本机逻辑核心 0–15，掩码 `0xffff` | 8.49 秒后访问违规退出；最后记录第 7 轮 `33-ps_6_8.hlsl` |
| 本机逻辑核心 16–31，掩码 `0xffff0000` | 30 轮、1590 次编译全部通过，37.61 秒 |

报告分别为 `web-default-dxc-host-villa-edge156-{default,pcores,ecores}-20261102-results.json`，记录 DLL、输入、诊断程序哈希及 CPU 拓扑。本机 i9-14900KF 的前一组为性能核心、后一组为效率核心。这证明执行条件影响复现，仍需其他主机或硬件稳定性对照来区分主机条件、DXC 缺陷及其交互，不能据此宣布硬件已损坏。

### 临时预览及验证

新增 `tests/web-platform/diagnostics/start-web-browser.ps1`，只在启动时限制新建独立配置的浏览器及其子进程，随即恢复启动器自身的亲和性。既有浏览器、系统配置和项目画质不变。掩码必须显式指定；下列值只对应本机已核对的 CPU 拓扑：

```powershell
& H:/ue_html/tests/web-platform/diagnostics/start-web-browser.ps1 -AffinityMask 4294901760
```

保持本地 8765 服务运行。关闭该独立窗口即可结束这次临时预览；该方法不会改变普通浏览器以后启动的执行条件。诊断可额外指定本机调试端口 `-DebugPort 9337`，默认不开放调试端口。

同一个 TLV 发布包、项目原设置、无 WebGPU 方法包装：

- 可见 Edge 1639×922 / DPR 1，连续三轮加载及刷新，各至少 180 帧，并各缩放后运行至少 90 帧。页面错误、GPU 错误及设备丢失均为零。报告 `web-browser-lifecycle-msedge-tlv-ecores-visible-20261102-results.json`。
- 可见窗口连续 60 秒移动、跳跃、转向及缩放通过，第 2 帧推进至第 1779 帧，移动约 155.7 cm、转向约 37.7°，渲染及 RHI 线程持续工作。截图已人工检查，报告 `project-gameplay-tlv-ecores-visible-20261102.json`。
- 实际启动脚本新开普通 Edge 窗口后，核对浏览器、renderer、GPU 子进程亲和性均为 `0xffff0000`，再通过 CDP 确认至少 180 帧及 AA=4。证据 `tlv-diagnostic-preview-20261102.json` 和 `tlv-diagnostic-preview-affinity-20261102.json`。该窗口保留供用户查看。

生命周期及交互报告新增 `hostCondition`，清楚区分默认调度与诊断条件；生命周期探针支持实际尺寸和显式打包报告路径，验证报告确实指向被测目录，并使用按标签隔离的浏览器配置。启动脚本通过 PowerShell 解析、无效掩码拒绝及实际窗口启动验证。

本轮没有修改引擎、着色器、项目设置或发布包，因此没有重新编译。受限核心的帧率不能替代正常调度的性能基准；上述通过也不构成普通浏览器启动修复或长期稳定性证明。

## 崩溃证据

本机文件保留在 Edge 自有 Crashpad reports 目录，没有上传转储：

`C:/Users/wap80/AppData/Local/Microsoft/Edge/User Data/Crashpad/reports`

| 时间（UTC+8） | 文件 | 记录 |
| --- | --- | --- |
| 2026-10-30 12:17:06 | `11a05ad2-5ff9-41f6-b34f-f3a1a169f95c.dmp` | `ptype=renderer`，`0xc0000005`，读取异常；故障指令 `msedge.dll+0x87710d`，异常记录地址 `0xffffffffffffffff` |
| 2026-10-30 09:11:40 | `0be1c100-ca16-42b1-afd4-865b07364589.dmp` | `0xc0000005`，空地址写入，`msedge.dll+0xb4669a0`；匹配符号为 `base::win::ForceCrashOnSigAbort`，不能把强制中止入口当成原始根因 |
| 2026-10-30 09:09:03 | `349ae642-bcaf-465a-aeed-31c0ca7565d8.dmp` | `ptype=gpu-process`，`0xc000001d`，`dxcompiler.dll+0xf4162d`；尚未进一步符号化，不等同于中午的 renderer 崩溃 |

表中使用 minidump 头部时间，文件系统写入时间可能稍晚。其他转储不一定对应同一页面，不能合并成同一个故障统计。

### 12:17 转储的本机符号定位

读取已安装版本的 `msedge.dll`，从微软公共符号服务器下载匹配 PDB，仅下载符号，没有修改浏览器或安装引擎：

- PDB：`msedge.dll.pdb`
- GUID / age 键：`F44CB0836ADF26834C4C44205044422E1`
- PDB 字节数：685797376
- PDB SHA-256：`62126a0700839383400700817b26d3291e8e4db741dd4e1b9678dc484240b124`

按 PE AMD64 unwind 信息和转储捕获的栈内存展开，得到以下连续原生帧；不是简单扫描栈上所有看似代码的地址：

| 模块偏移 | 匹配符号 |
| --- | --- |
| `0x87710d` | `blink::V8PerIsolateData::FindOrCreateEternalNameCache` |
| `0x10d99bff` | `blink::GPUObjectDescriptorBase::FillMembersFromV8Object` |
| `0x10925595` | `blink::GPUBindGroupDescriptor::FillMembersFromV8Object` |
| `0x10925510` | `blink::GPUBindGroupDescriptor::Create` |
| `0x102ed9e7` | `blink::v8_gpu_device::CreateBindGroupOperationCallback` |
| `0xfb439a` | `Builtins_CallApiCallbackOptimizedNoProfiling` |

之后超出本次展开工具覆盖的 PE 原生代码范围，不继续推测 Wasm/JS 调用栈。反汇编中的故障指令为 `movq (%rax,%r10,8), %r11`，位于内部名称缓存查找。此时尚在浏览器绑定层，不能直接认定该次故障来自 GPU 执行着色器。

诊断脚本保留在忽略目录 `tests/web-platform/results/inspect-edge-minidump.cjs` 和 `unwind-edge-minidump.cjs`；它们是本机临时分析工具，不是通用转储分析器。完整输出 `edge-user-crash-20261030-1217.json` 中的 `stackCandidates` 仅是原始扫描候选，不能替代上表的 unwind 帧。

## 重复启动验证

新增 `tests/web-platform/probe-web-browser-lifecycle.cjs`，用于检验启动、刷新和缩放过程中是否发生页面崩溃、启动失败或 GPU 错误。测试使用独立持久化配置，正常引擎时钟，不注入 WebGPU 方法包装、冻结时间或着色器替换。先校验打包报告内各产物哈希，再运行页面，记录浏览器实际版本、源码哈希、Wasm 堆及纹理流送状态。

2026-10-30 的最终可见窗口测试：

- Edge `156.0.4314.50`，V8 `15.6.12.7`。
- 四轮加载，每轮至少 180 帧，再缩放并至少运行 90 帧；三次刷新。
- 四轮共八次采样，页面无 crash、pageerror、记录范围内 GPU 验证错误或设备丢失。
- 实际渲染尺寸在 1800×1012 和 1600×900 间变化；不是 4K 测试。
- Wasm 堆为 577437696～678297600 字节，没有逐轮增长；这不是浏览器原生内存或 GPU 显存的总账本。
- 报告：`tests/web-platform/results/web-browser-lifecycle-msedge-edge156-headful-results.json`。
- 最终测试源码 SHA-256：`7f81b5410c9d74d561a2bd28aeb9af6b3d19752a2fc1fe0ba7664cbead0c1539`。

此前六轮无界面运行也通过，报告标签为 `edge156-startup` 和 `edge156-final`；它们对应补充版本记录之前的测试脚本，不能伪称为最终源码的运行结果。

复测命令：

```powershell
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-browser-lifecycle.cjs --headful --runs=4 --tag=edge156-headful
```

`--chrome` 可改用 Chrome。`--browser-args=<JSON数组>` 仅供隔离诊断，报告保留参数；带诊断开关的通过不能替代默认配置验收。

## 未完成边界

- 用户的原生 renderer 崩溃没有在上述循环中重现，因此没有可证明有效的修复，也没有将循环测试称为已锁定根因的回归用例。
- 排查时系统尚有约 42 GiB 可用物理内存，但这不是崩溃瞬间采样，不能排除当时的资源压力。
- 当前证据优先指向 WebGPU 绑定调用期间的浏览器内部状态异常；浏览器缺陷、更早的内存破坏及环境因素仍需区分。
- 单凭启动和刷新未复现，不能排除相机移动、长时间运行、其他标签页并行工作或用户配置相关触发条件。
- 下一步应提高原入口、同窗口及真实交互下的复现率，并比较新转储是否仍落在同一原生调用链。GPU 进程中的 DXC 故障应单独最小化。
- 本轮没有修改 UE 渲染代码、降低画质、改动用户浏览器配置或修改 `H:/UE_5.8`。
