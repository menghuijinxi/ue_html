# WebGPU 软件 Lumen 初步兼容

更新：2026-11-03。状态：**实验接入，存储格式初筛已通过，完整场景仍待验收**。依据 `UE58_NANITE_LUMEN_WEBGPU_FEASIBILITY.md`，优先普通网格、软件距离场追踪和原有 Screen Probe Gather；没有加入硬件光追或 Nanite。

对应独立引擎提交：`3bba192188f966b4808074518c4ca732229663c4`。
后续材质采样分支修复：`7a31024c7f`。
灯光 Tile 归约控制流修复：`d0952c9207`。

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
7. Lumen 与其共享的 StochasticLighting Compute Shader 使用运行时存储格式专用管线：Cook 保留格式位置及实际访问方式，RHI 在绑定 UAV 后使用其真实格式编译管线，并按格式组合缓存。Shader 中的 RGBA32F 只是转换占位类型，不改变实际纹理分配。
8. 从原始 SPIR-V 证明只写的纹理输出增加 NonReadable 声明，避免把 R11G11B10、RG8 等只写输出错误声明成不受支持的读写纹理。不能证明只写的资源仍保留读写限制；没有删除真正的纹理读取。

原生分支保留原算法。没有为通过编译而整体关闭 Wave、探针自适应、Lumen 反射或其他项目效果。

## 验证结果

机器条件：本机 i9-14900KF 的既有 DXC 原生崩溃在常规调度下仍可复现；本轮诊断进程限制到逻辑核 16～31，掩码 `0xffff0000`。这是测试主机条件，不是渲染质量或 Web 运行时优化设置，也不表示主机稳定性问题已修复。

| 检查 | 结果与边界 |
| --- | --- |
| 实际 UE 准入探针 | 8 组通过：关闭、GI、反射、总开关关闭、屏幕空间方法、Web 覆盖开启/关闭、再次关闭；同时核验 Shader 准入与 Cook Cards/DF 声明 |
| 配置预检回归 | 9 项通过，包含缺失 DF、Forward、VSM 拒绝、其他平台隔离、跨 INI section 的 CVar 优先级 |
| 真实 UE 全局 Shader 初筛 | 157 类 Lumen 与 1 类共享 StochasticLighting 各取第一个允许排列，158 项全部通过；新增拷贝 Shader 计入总数；不代表所有排列均已覆盖 |
| 本轮修复路径的允许排列 | 场景队列、自适应 Mark/Spawn、ScreenData、头拷贝共 11 个允许排列全部通过，不代表其余 Lumen 排列全覆盖 |
| 浏览器 WGSL 检查 | 上述 158 个输出均通过 Edge WebGPU 模块编译检查；另核验 89 项动态格式位置与 4 类只写输出；不是 158 条完整渲染管线执行验收 |
| 场景队列 GPU 执行 | 257 个原语，65 次添加、64 次移除；容量 258 和容量 3 两组均验证计数、配对、去重、头部填充及溢出哨兵 |
| 探针头拷贝 GPU 执行 | 1×1、13×9、65×37、127×68 全部逐 texel 回读通过 |
| 原生 Web RHI 存储格式 GPU 执行 | R11G11B10、RGBA16F、RGBA32F、R16F、RG8、R8 与混合 R8 输出共 7 组通过；重复 R11G11B10 复用管线，共创建 6 条；浮点格式逐字节核对，UNORM 允许 1 个量化单位舍入差 |
| 原生 RenderCore、Renderer 与测试宿主构建 | 通过；安装目录输入审计未变 |
| 多线程 Wasm64 编译、链接与 Wasm 校验 | 通过；Web Renderer 编译仍为 `-O2` |

原生 Cook 模块继续使用既有的 MSVC 编译器故障规避选项，不能据此推断 Web Renderer 关闭优化。完整源码原生引擎、完整 Lumen Cook、真实场景 GI 像素和开关前后资源回收尚未验收。

首次结果位于忽略的 `tests/web-platform/build/lumen-probe/20261103-101212/`。最新格式与访问修复结果位于 `build/lumen-probe/20261103-123222/`，浏览器复核为 `results/web-lumen-storage-gpu-access.json`，原生 RHI 回读为 `build/lumen-storage-rhi/lumen-storage-rhi.json`。首次可追溯摘要保存在 `tests/web-platform/evidence/lumen-initial-20261103.json`。

复现命令，在工作区 PowerShell 运行：

```powershell
node tests/web-platform/verify-web-lumen-settings.cjs
& tests/web-platform/probe-web-lumen.ps1 -Mode All
```

第二条检查各类 Shader 的首个允许排列，并保存逐项成败；它不能代替目标项目的完整 Cook 和浏览器运行。

原生存储格式回读复现入口为隔离宿主的 `-run=WebShaderProbe -WebRHIProbe -WebLumenStorageRHIProbe -Output=<结果目录> -nullrhi -norhithread -unattended`。该探针使用实际 Web RHI 纹理、绑定、Dispatch、拷贝和回读，Shader 元数据由固定测试样例构造；真实 UE Shader 的转换与格式位置另由上述 158 项检查覆盖。

## 剩余阻塞与下一步

首次 36 个初筛失败项均报告 `StorageImageWriteWithoutFormat`，分布于软件 SDF 追踪、Screen Probe 积分/过滤、Surface Cache 光照、Radiosity、Radiance Cache 和反射等通道。这些首个允许排列已通过存储格式专用管线修复。完整 Cook 还发现了共享 StochasticLighting 的同类问题，现已将该目录的 Compute Shader 纳入同一路径。

接下来仍须验证完整排列、绑定限额、Surface Cache 捕获和场景动态更新。不能统一写死 RGBA16F 来掩盖项目默认格式差异。存在于源码中的硬件光追辅助 Shader 即使转换成功，也不代表 Web 实现了硬件光追。

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

### 完整排列中的材质采样分支

补齐存储格式后，完整 Cook 在 `FScreenProbeIntegrateCS/3` 发现 `switch fallthrough not supported by the SPIR-V reader`。实际 SPIR-V 包含 `SampleBxDF` 多个空 case 到下一标签的跳转链；首个允许排列没有覆盖该路径。

仅在 Web 分支将这组标签改为等价条件判断，9 类原有 Lit 模型继续调用 `SampleDefaultLitBxDF`、Hair 调用 `SampleHairBxDF`、其他模型返回零。安装目录与桌面分支未改。隔离 Shader 快照逐字核对该差异后，排列 3 转换及 Edge 模块编译通过，结果为 `build/lumen-probe/20261103-124518/` 和 `results/lumen-fallthrough-gpu.json`。这不代表其余 511 个允许排列均已通过。

诊断入口现在支持指定实际排列，避免为了重现单项错误反复编译全部排列：

```powershell
& tests/web-platform/probe-web-lumen.ps1 -Mode Shaders -ShaderTypes FScreenProbeIntegrateCS -Permutation 3
```

### 灯光 Tile 归约

后续完整 Cook 已越过全部积分排列，在 `FBuildLightTilesCS/30` 遇到共享归约值控制循环提前退出造成的 uniformity 错误。Web 分支使用固定 `MAX_LIGHT_SAMPLES` 轮归约，只累计非零值，并在共享临时区读取后同步；最多保留的灯光数、排序及打包布局不变，桌面分支不变。少灯光 Tile 会比原提前退出路径多做空归约，尚无场景 GPU 时间实测。

该类 12 个允许排列均通过转换、浏览器模块和计算管线创建。结果位于 `build/lumen-probe/20261103-130356/` 和 `results/lumen-light-tiles-pipelines-gpu.json`；管线创建不代表灯光筛选已经完成实际场景执行验收。

```powershell
& tests/web-platform/probe-web-lumen.ps1 -Mode Shaders -ShaderTypes FBuildLightTilesCS -AllPermutations
node tests/web-platform/probe-web-lumen-gpu.cjs --input=tests/web-platform/build/lumen-probe/20261103-130356/ShaderConversion --modules-only --pipelines
```

### Radiosity 时间累积

完整 Cook 的 `FLumenRadiosityIntegrateCS/4` 发现存储纹理实际读取被误判为只写。原因是 SPIR-V 资源来源分析在向 `TMap` 增加条目时传入了同一容器内的值引用，扩容可能使引用失效；现在先复制来源 ID，再增加条目，并更新受影响的 Shader 缓存键。

修正后原始排列可以转换，但按真实 R11G11B10/R8 格式创建浏览器管线仍失败：当前设备启用 texture-formats-tier1/tier2 后，R8 支持 read_write，R11G11B10 仍不支持。这不是通过占位 RGBA32F 管线就能验证的能力。

Web 的 Radiosity 积分现在从独立的同格式历史图集读取，向原图集只写；计数图集继续使用 R8 的实际读写能力。只在项目准入、Radiosity 和时间累积均开启并实际执行积分时创建历史副本，保留原有累积系数、精度与 CVar 开关。桌面仍使用原来的原地读写路径。RHI 不再将 R11G11B10 误报为支持 TypedUAVLoad。

8 个 Radiosity 允许排列均通过转换及真实 R11G11B10/R8 格式的浏览器管线创建；排列 0–3 不绑定历史读取，4–7 绑定独立历史 SRV，光照 UAV 均为只写。结果在 `build/lumen-probe/20261103-133429/` 和 `results/lumen-radiosity-fixed-format-gpu.json`。旧原地读写排列仍被浏览器按预期拒绝，记录为 `results/lumen-radiosity-original-format-gpu.json`。

回归检查：158 类 Shader 的首个允许排列、浏览器模块编译、6 项 Cards/探针头 GPU 执行及 7 项实际 RHI 格式回读均通过。原生 Renderer 优化构建和线程版 WASM 编译、链接及结构校验通过。上述结果仍不等于完整场景 GI、性能或显存验收。

另有独立 WebGPU 历史拷贝/时间混合测试：64² 和 4096² R11G11B10 图集各运行 12 帧，回读图集两角的颜色与 R8 帧计数，逐帧参照上帧实际量化结果核验，容差为当前通道一个量化单位。4096² 副本在当前设备 10 次暖机后采样的 GPU 时间均值约 0.35 ms；计时包含空 Pass 边界，64² 时间低于当前计时分辨率。这是精简测试程序，不是完整 UE Radiosity Shader，不能推算场景 FPS。入口：`probe-web-radiosity-history.cjs`，报告：`results/lumen-radiosity-history-gpu.json`。

### 计算工作组上限

浏览器管线检查发现 `FScreenProbeCompositeTracesWithScatterCS`、`FBuildProbeVisualizeBufferCS`、`FSortProbeTraceTilesCS` 和 `FReflectionCompactTracesCS` 需要 512 或 1024 个工作组线程，超过 WebGPU 默认设备的 256 上限。原生和浏览器 RHI 创建设备时现在共同申请最多 1024 个线程、X/Y 方向最多 1024 和 32 KiB 工作组共享内存，各项均不超过适配器实际支持值。没有修改 Shader 工作组布局或项目画质设置；低于所需上限的设备仍不保证能够运行这些排列。

诊断脚本按同一组计算上限申请设备，支持 `--job=<转换目录名>` 定向复现和 `--pipeline-batch=<数量>` 分批释放设备，遇到首个模块或管线错误立即停止。此前数百条管线共用设备时出现一次 D3D12 `E_OUTOFMEMORY`，失败的 `FVisualizeLumenSceneCS/10` 单独重测通过；这不能作为场景显存溢出的结论。

2026-11-03 重启恢复后，以每批 32 个模块、共 5 个设备完成 158 个模块和 142 条计算管线创建。7 项实际 RHI 格式回读、6 项 Cards/探针头 GPU 执行、8 个 Radiosity 真实格式管线和 9 项项目设置检查通过；原生插件及优化线程 WASM 编译、链接和结构检查通过。摘要：`tests/web-platform/evidence/lumen-compute-limits-20261103.json`。完整别墅 Cook 另行继续，上述结果不代表已经生成可运行场景。

### Radiance Cache 探针偏移

后续完整 Cook 在 `FComputeProbeWorldOffsetsCS/1` 触发 Tint 的 `vector_element_pointer.cc` 内部错误。该 GBuffer 偏移排列对 `groupshared uint4` 的四个分量执行原子加法；Web 分支改为四个 `uint` 数组槽位，保留采样条件、量化、原子累加、同步及平均公式，桌面分支不变。共享数据仍为 16 字节，没有增加全局缓冲区或纹理。

两个允许排列均通过转换、浏览器模块和计算管线创建，结果为 `build/lumen-probe/20261103-141651/` 和 `results/lumen-probe-world-offsets-pipelines-gpu.json`。这是编译兼容验证，尚未进行实际场景探针偏移结果回读或性能验收。完整别墅 Cook 随后恢复；Shader 修改通过内容哈希使相关缓存失效，没有修改项目设置或全部 Shader 的格式缓存键。

## 性能与显存边界

本轮可直接计算的增量：

- 自适应头 buffer：`ceil(宽/下采样因子) × ceil(高/下采样因子) × 4` 字节，另增加一次清零和一次拷贝 Dispatch。下采样因子为 16 时，1280×720 约 14.1 KiB，1920×1080 约 31.9 KiB。
- BRDF SH buffer 从 half16 改 float32：额外 `探针图集宽 × 探针图集高 × 9 × 2` 字节，图集包含自适应区域；会增加对应读写带宽。
- Cards 添加队列保持原始字节布局，没有因标量化再复制一份队列。
- 存储格式专用管线不增加纹理尺寸、格式字节数或拷贝 Pass；每个动态格式 Shader 保留一份 WGSL 源码，实际遇到的格式组合各保留一条管线。绑定格式未知时暂不进行该管线的推测预缓存，第一次使用会增加管线编译成本，后续同格式组合复用；CPU/驱动内存及首次卡顿仍待真实场景测量。
- Radiosity 历史副本增加 `图集宽 × 高 × 原格式字节数` 的临时资源和每次积分前的一次整图拷贝。默认 4096×4096 R11G11B10 为 64 MiB，拷贝读写合计 128 MiB；项目改用其他图集尺寸或格式时按实际值计算。资源池可能保留该内存，不能将 RDG 生命周期结束当作显存立即归还。完整场景的耗时和峰值尚待实测。

以上未计对齐、驱动和资源池开销。**尚无完整 Lumen 场景帧率、GPU 各通道耗时或峰值显存实测，不能给出与桌面端的性能结论。** 关闭项目准入后不会进入这些新增 Lumen pass；尚未实测运行中关闭效果后的资源池即时归还情况。
