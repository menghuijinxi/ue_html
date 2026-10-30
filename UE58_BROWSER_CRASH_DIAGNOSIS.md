# Edge 原生崩溃诊断

## 当前结论

2026-10-30 用户报告别墅页面反复出现 `STATUS_ACCESS_VIOLATION`。当天 12:17:06（UTC+8）的本机转储确认：Edge 156.0.4314.50 的 renderer 进程在 WebGPU `createBindGroup()` 的 Blink 参数转换阶段发生原生非法内存读取。

这次故障已定位到浏览器内部函数，但尚未复现并修复根因。不能将它说成已确认的显存不足、Wasm 堆越界、UE 断言失败或服务器中断，也不能仅凭崩溃位于浏览器就排除更早发生的内存破坏。

此前画质、距离场及短时运行回归通过，不代表间歇性的浏览器进程崩溃已经解决。

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
