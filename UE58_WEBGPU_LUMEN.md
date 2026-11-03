# WebGPU 软件 Lumen 初步兼容

更新：2026-11-03。状态：**实验接入，尚未完成完整 Lumen 场景**。依据 `UE58_NANITE_LUMEN_WEBGPU_FEASIBILITY.md`，优先普通网格、软件距离场追踪和原有 Screen Probe Gather；没有加入硬件光追或 Nanite。

对应独立引擎提交：`3bba192188f966b4808074518c4ca732229663c4`。

## 项目设置与退出边界

Web SM5 平台现在允许编译 Lumen，但实际准入仍取决于目标项目：

| 项目设置 | Web 行为 |
| --- | --- |
| 动态全局光照选择 Lumen：`r.DynamicGlobalIlluminationMethod=1` | 准入实验 Lumen，保留对应 Shader 与 Mesh Cards |
| 反射选择 Lumen：`r.ReflectionMethod=1` | 同样准入；不代表本轮已经完成反射通道 |
| GI 与反射均选择非 Lumen 方法 | 不准入 Lumen Shader 或 Cards 保留路径 |
| `r.Lumen.Supported=0` | 即使方法选择 Lumen，也关闭项目准入 |
| Web 平台配置覆盖上述值 | 按目标 Web 配置判断，而不是照搬 Cook 主机的 Windows 值 |
| Forward 或没有 Generate Mesh Distance Fields，同时请求 Lumen | 构建预检明确报错，不擅自改设置 |

该边界同时接入 RenderCore 准入和 Cook 目标平台功能声明；诊断用的 `bSkipProjectCheck` 也不能绕过 Web 项目关闭状态。ES3.1 继续不支持 Lumen。

关闭状态构建会剥离未使用资源，因此**改变项目级 GI/反射方法后必须重新 Cook、打包并重启**。已按 Lumen 构建的包可以继续使用原有运行时质量和效果开关；不能通过控制台把不含 Lumen 资源的旧包临时变成 Lumen 包。Web 运行时锁定首次读取的项目准入状态，避免运行中改变方法误入已剥离路径。

没有添加强制启用 Lumen、强制 RGBA16F、降低探针质量等构建覆盖，配置检查报告保持 `rendererOverrides: []`。初步接入时，原别墅项目 GI/反射均为 0；下方另记用户开启 Lumen 后的实际打包尝试。没有替换已发布的别墅包。

Web RHI 不提供硬件光追，使用 UE 原有的无硬件能力时软件追踪回退。`r.Lumen.HardwareRayTracing` 的存在不代表浏览器获得了硬件光追能力。运行时 Lumen 所需的 R16_UINT TypedUAVLoad 只在设备确实提供纹理格式 Tier 2 时声明，不能伪造设备能力。

## 本轮实现

1. 接通 Web SM5 的项目准入、Cook 功能声明及 Mesh Cards 保留条件；网格距离场开关读取目标 Web 配置。
2. 将自适应探针的纹理原子计数改成线性 buffer 原子，随后用一个小 Compute Pass 写回原有头纹理，后续读取布局不变。
3. 将场景 Cards 添加队列的向量分量原子改成标量 buffer 原子，保持原有 uint2 队列与 CPU 回读布局，保留索引、距离配对与容量限制。
4. 为部分探针输出补全与原有纹理匹配的存储格式；调整共享原子计数的发布与屏障，使 WGSL 能证明组内归约循环一致。
5. Web 探针 BRDF SH 临时 buffer 使用 float32，匹配现有 WGSL buffer 转换；原生平台仍用 half16。
6. 将上述源码纳入独立 Cook Shader 快照、原生模块覆盖和 Wasm 构建，加入可重复的配置、真实 UE Shader 编译及浏览器 GPU 回读探针。

原生分支保留原算法。没有为通过编译而整体关闭 Wave、探针自适应、Lumen 反射或其他项目效果。

## 验证结果

机器条件：本机 i9-14900KF 的既有 DXC 原生崩溃在常规调度下仍可复现；本轮诊断进程限制到逻辑核 16～31，掩码 `0xffff0000`。这是测试主机条件，不是渲染质量或 Web 运行时优化设置，也不表示主机稳定性问题已修复。

| 检查 | 结果与边界 |
| --- | --- |
| 实际 UE 准入探针 | 8 组通过：关闭、GI、反射、总开关关闭、屏幕空间方法、Web 覆盖开启/关闭、再次关闭；同时核验 Shader 准入与 Cook Cards/DF 声明 |
| 配置预检回归 | 9 项通过，包含缺失 DF、Forward、VSM 拒绝、其他平台隔离、跨 INI section 的 CVar 优先级 |
| 真实 UE Lumen 全局 Shader 初筛 | 157 类各取第一个允许排列：121 通过，36 失败；新增拷贝 Shader 计入总数 |
| 本轮修复路径的允许排列 | 场景队列、自适应 Mark/Spawn、ScreenData、头拷贝共 11 个允许排列全部通过，不代表其余 Lumen 排列全覆盖 |
| 浏览器 WGSL 检查 | 上述 121 个成功输出均通过 Edge WebGPU 模块编译检查；不是 121 条完整渲染管线执行验收 |
| 场景队列 GPU 执行 | 257 个原语，65 次添加、64 次移除；容量 258 和容量 3 两组均验证计数、配对、去重、头部填充及溢出哨兵 |
| 探针头拷贝 GPU 执行 | 1×1、13×9、65×37、127×68 全部逐 texel 回读通过 |
| 原生 RenderCore、Renderer 与测试宿主构建 | 通过；安装目录输入审计未变 |
| 多线程 Wasm64 编译、链接与 Wasm 校验 | 通过；Web Renderer 编译仍为 `-O2` |

原生 Cook 模块继续使用既有的 MSVC 编译器故障规避选项，不能据此推断 Web Renderer 关闭优化。完整源码原生引擎、完整 Lumen Cook、真实场景 GI 像素和开关前后资源回收尚未验收。

原始结果位于忽略的 `tests/web-platform/build/lumen-probe/20261103-101212/` 及 `tests/web-platform/results/`。可追溯摘要保存在 `tests/web-platform/evidence/lumen-initial-20261103.json`。

复现命令，在工作区 PowerShell 运行：

```powershell
node tests/web-platform/verify-web-lumen-settings.cjs
& tests/web-platform/probe-web-lumen.ps1 -Mode All
```

第二条目前应报告失败并保存逐 Shader 错误；这是如实记录未完成通道，不能把它改成忽略错误的成功。

## 剩余阻塞与下一步

36 个初筛失败项均报告 `StorageImageWriteWithoutFormat`，分布于软件 SDF 追踪、Screen Probe 积分/过滤、Surface Cache 光照、Radiosity、Radiance Cache 和反射等通道。不能因为场景更新和数据拷贝成功就宣称完整 Lumen 可运行。

下一阶段需要按每项实际 RDG 像素格式及原有格式排列补齐存储纹理声明，再验证完整排列、绑定限额、Surface Cache 捕获和场景动态更新。不能统一写死 RGBA16F 来掩盖项目默认格式差异。存在于源码中的硬件光追辅助 Shader 即使转换成功，也不代表 Web 实现了硬件光追。

完整验收仍应使用独立测试项目：普通网格、显式 Lumen 项目设置、屏幕外彩色反弹、移动物体和灯光变化，与同设置原生软件 Lumen 对照；之后再测默认关卡及别墅。

## 目标别墅打包尝试

2026-11-03，用户已将 `H:/TriplexHouseVilla` 的 GI 和反射方法设为 1，Generate Mesh Distance Fields 开启、VSM 关闭，项目还启用了 RayTracing、硬件 Lumen LightingMode=2 和半透明前层反射。这些设置原样保留，没有为 Web 改成关闭或降低质量；Web 没有硬件光追能力，仍只能尝试软件距离场路径，不能承诺与原生硬件 Hit Lighting 等价。

创建独立的 `triplex-project-lumen` 测试项目，源输入 1633 项最终哈希复核全部不变；DefaultEngine.ini、DefaultGame.ini、DefaultInput.ini 三份配置与原项目逐字节一致。

- 首次使用 `-UseProjectSettings` 正式 Cook，原生天空光采集成功。全局 Shader 编译阶段进程异常退出，退出码 `0xc0000409`，未写出 Shader 转换错误；这次退出本身不能证明是 Lumen Shader 格式导致。
- 同设置的同步编译诊断复跑继续生成 Shader，随后直接使用该目标项目做定向编译，复现下表 4 个明确错误。确认无法完成打包后，停止了仍在编译其他全局排列的诊断 Cook，没有将其记为自然失败或成功。
- 打包入口现在先检查该项目的 5 类真实 Lumen Shader。重新运行相同打包命令，约十秒内在 `lumen-shader-preflight` 阶段按预期失败，保存 4 项格式错误，在天空光采集及完整 Cook 前退出；未进入 Stage / Package，也没有生成可运行的 Lumen 页面。

| Shader | 目标项目检查 |
| --- | --- |
| FScreenProbeTraceMeshSDFsCS | `StorageImageWriteWithoutFormat` |
| FScreenProbeIntegrateCS | 同上 |
| FLumenCardCombineLightingCS | 同上 |
| FReflectionTraceMeshSDFsCS | 同上 |
| FLumenSceneUpdateCS | 通过，作为已接通路径的对照 |

预检只在项目实际选择 Lumen 时执行，不覆盖项目的关闭边界。通过这几个首个允许排列也不代表完整 Cook 或浏览器验收成功。

首次报告备份：`tests/web-platform/results/lumen-first-cook-attempt-20261103.json`。正式入口复跑报告：`tests/web-platform/results/web-project-triplex-project-lumen-desktop-cook-results.json`；对应 `build/web-project-triplex-project-lumen-desktop-cook/20261103-104452/LumenPreflight/lumen-shader-results.json`。可追溯摘要：`tests/web-platform/evidence/lumen-villa-package-attempt-20261103.json`。

本轮同时发现：只设置 PowerShell 父进程亲和性不足以证明 UE 子进程受限。调试器复跑中的 UE 进程曾实际显示全核掩码，随后才直接限制并核对其为 `0xffff0000`。新的预检启动器直接设置 UE 子进程；此前仅记录父进程掩码的报告不能解释为全程核验了子进程调度条件。这不改变已保存的 Shader 成败及 GPU 回读结果，也没有解决首轮异常退出的根因。

## 性能与显存边界

本轮可直接计算的增量：

- 自适应头 buffer：`ceil(宽/下采样因子) × ceil(高/下采样因子) × 4` 字节，另增加一次清零和一次拷贝 Dispatch。下采样因子为 16 时，1280×720 约 14.1 KiB，1920×1080 约 31.9 KiB。
- BRDF SH buffer 从 half16 改 float32：额外 `探针图集宽 × 探针图集高 × 9 × 2` 字节，图集包含自适应区域；会增加对应读写带宽。
- Cards 添加队列保持原始字节布局，没有因标量化再复制一份队列。

以上未计对齐、驱动和资源池开销。**尚无完整 Lumen 场景帧率、GPU 各通道耗时或峰值显存实测，不能给出与桌面端的性能结论。** 关闭项目准入后不会进入这些新增 Lumen pass；尚未实测运行中关闭效果后的资源池即时归还情况。
