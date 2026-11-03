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

### Surface Cache 反馈压缩

完整 Cook 在共享的 `FCompactFeedbackHashTableCS/0` 再次遇到向量分量原子地址错误。Web 将输出 `RWStructuredBuffer<uint2>` 改为两个标量字段的结构体，首个 uint 仍为计数，后续每两个 uint 仍是一条反馈。定向检查整条反馈链路后，还发现哈希插入函数的多个提前返回触发 Tint 循环结果作用域错误；Web 分支改为单一出口，保留最多 32 次线性探测、CAS、去重和计数行为。桌面分支和缓冲区分配尺寸不变，没有新增纹理或全局缓冲区。

诊断入口已纳入 `GPUFeedbackCompaction.usf`；三类 Shader 的 6 个排列均通过转换及浏览器计算管线创建。另用实际 UE Shader 执行间接参数生成、哈希插入和压缩，在步长 1/2、0/1/65/257 条输入、重复元素及输出容量不足场景下共回读 10 项，核验条目唯一性、出现次数、载荷、uint2 布局及越界保护区。结果：`build/lumen-probe/20261103-142611/`、`results/lumen-feedback-compaction-gpu.json`；摘要：`tests/web-platform/evidence/lumen-feedback-20261103.json`。这还不能证明真实 Surface Cache 页面请求和更新效果正确。

```powershell
& tests/web-platform/probe-web-lumen.ps1 -Mode Shaders -ShaderTypes 'FBuildFeedbackHashTableIndirectArgsCS,FBuildFeedbackHashTableCS,FCompactFeedbackHashTableCS' -AllPermutations
node tests/web-platform/probe-web-feedback-compaction.cjs <ShaderConversion目录>
```

### 结构化缓冲区步长

运行时绑定核对发现，之前 Cards 添加队列和压缩反馈使用 `uint` 数组虽然维持了字节内容，反射步长却从 8 变成 4，与原 UE 的 uint2 UAV 不符，严格 RHI 校验会拒绝。最终改为包含两个独立 uint 字段的结构体；原子操作作用于标量字段，反射步长保持 8，未放宽 RHI 校验，也未修改原缓冲区大小或读回布局。

更新后的 161 个首个允许排列和 145 条计算管线、6 项 Cards/探针头 GPU 执行及 10 项反馈 GPU 回读通过。GPU 检查显式断言两个输出绑定的反射步长为 8。结果位于 `build/lumen-probe/20261103-145316/`、`build/lumen-probe/20261103-145359/` 和 `results/lumen-structured-all-gpu.json`；完整场景中的绑定仍须通过浏览器验证。

此前一次完整别墅 Cook 已正常退出，生成 5159 项产物；该次使用的是旧步长 Shader，只用于保留已完成的材质缓存。结构体修正后的 `20261103-145542` Cook 已正常退出，Stage 输出 5157 个文件、3412437085 字节；后续 Package 和浏览器验收使用该次新产物。

### 浏览器首帧资源与日志

该 Cook 已完成线程版 Package，实际浏览器启动仍未完成。首帧首先暴露 Surface Cache 深度图集的 `PF_G16` 未映射；Web RHI 补充对应的 `r16unorm` 采样、渲染及存储格式，按设备的 texture-formats-tier1 能力准入，保持每 texel 两字节。新增原生 GPU 回读已通过，连同原有格式共 8 项、7 条实际格式管线，没有 GPU 校验错误。结果为 `build/lumen-storage-rhi-r16/lumen-storage-rhi.json`。

再次启动越过该格式后，发现还需 `PF_R8_UINT` 的 4×4×4 三维默认纹理。RHI 增加 `r8uint` 的整数类型、格式、三维创建及 SRV 映射；不通过改成 R32_UINT 扩大纹理，也不关闭使用它的效果。新增实际 RHI 测试验证全部 64 个 texel 的上传及 GPU 拷贝回读，同时核验直接绑定和 SRV 的 uint 类型兼容、拒绝 float 类型。连同上述 8 个格式用例全部通过，没有 GPU 校验错误，结果为 `build/lumen-storage-rhi-formats/lumen-storage-rhi.json`。该路径的完整浏览器验收继续进行。

另外核对开关回退路径发现，关闭 `r.Lumen.ScreenProbeGather` 会清零 R11G11B10 输出；原 Web Compute 清零只列出了部分格式，无法处理它。清零现在复用统一的存储格式名称映射，补全已有纹理格式的清零能力，不增加场景纹理或修改清零值。上述 8 项测试均增加写入非零值后的实际 GPU 清零与回读，全部通过；8 位整数体积纹理另行回读。可追溯摘要：`tests/web-platform/evidence/lumen-rhi-formats-20261103.json`。

首帧还存在独立的日志死锁：UE 的 Generic `LocalPrint` 使用 libc 标准输出；pthread 在持有标准输出锁时同步转发写入主 Worker，主 Worker 处理 RHI 回调并再次写日志，会等待同一把锁。暂时降低 RHI 日志量能暴露后续格式断言，但不构成正式修复。Web 的 `LocalPrint` 现改为在调用线程直接使用 Emscripten 日志回调，保留原有日志接收和内容，桌面分支不变。

最小浏览器复现 `probe-web-log-proxy.cjs` 验证后台线程持锁期间执行主 Worker 日志：旧 stdio 路径停在日志入口，直接日志路径正常返回。该测试使用独立小型 WASM，不等同于完整场景验收。测试使用的 SDK 根路径与主构建统一，防止斜杠写法不同触发共享缓存失效。正式场景观察脚本没有 RDG、日志等级或画质覆盖。

越过日志死锁后，正常启动又暴露 StochasticLighting 的 `PF_A2B10G10R10` 历史法线图和 `PF_R16G16_UINT` 历史坐标图缺少 UAV 映射。现在分别使用 `rgb10a2unorm` 和 `rg16uint`，保持每 texel 4 字节，按真实 Tier 1 能力准入。整数 Shader 输出增加 Web 专用的 `r8ui` / `rg16ui` 声明，与原有纹理分配一致。原生 RHI 的 10 项存储格式写入、GPU 清零及回读、9 条专用管线与三维整数纹理回读均已通过：`build/lumen-storage-rhi-rg16-fixed/lumen-storage-rhi.json`。

### 光照预处理绑定上限

实际 Cook 的 `FStochasticLightingTileClassificationMarkCS/79` 和 `/335` 同时绑定 9 张存储纹理，超过当前设备每个计算阶段的 8 张上限。请求更高限制无法解决该设备的限制。

Web 在同时启用 2×1、2×2 降采样时，主 Pass 继续计算两种共享缓存、分类和重投影，只将 2×1 的全局深度、法线输出移到已有的独立 2×1 排列。附加 Pass 使用相同帧索引、材质来源、采样抖动和输出纹理；不增加场景纹理。只启用一种降采样、桌面平台或不要求降采样输出时不增加这个 Pass。

不能只使用恒为假的分支禁用输出：转换结果仍会保留对应纹理声明，计入设备上限。最终将纹理写出与共享缓存填充拆开，在 Web 同时降采样排列中预处理排除 2×1 写出调用。44 个允许排列的转换和浏览器计算管线全部通过，最多 7 个存储纹理；原先 `/79`、`/335` 均为 7 个，独立 `/2` 仅绑定原有的两个 2×1 输出。摘要与重复检查入口为 `tests/web-platform/evidence/lumen-stochastic-split-20261103.json`、`summarize-web-stochastic-split.cjs`。此处验证绑定与管线，不代表已完成场景像素和性能验收。

`20261103-174544` 完整别墅 Cook、Stage 与线程版 Package 已通过，Stage 为 5157 文件、3412426624 字节。该 Cook 实际转换的 38 个计算管线通过浏览器创建检查：`results/lumen-storage-split-cooked-gpu.json`。隔离原生 RenderCore、Renderer 均重新以优化模式编译，线程 WASM 保持 `-O2`；原安装目录输入哈希检查通过。完整浏览器场景继续单独验收。

### 探针 Tile 队列视图

上述 Package 在真实场景创建 Radiance Cache 探针队列时，发现 `PF_R32G32_UINT` 类型缓冲视图尚未实现。Web RHI 补充 `uint2` 的 SRV、UAV 和存储对齐准入，继续严格匹配反射类型、8 字节元素、绑定范围和访问状态。Lumen/shared stochastic-lighting Shader 元数据补充该格式标记，并递增对应编译缓存键；其他 StructuredBuffer 保留原有结构体步长校验。原队列大小不变，无额外场景缓冲区或纹理。

真实 RHI 回读核验 768 个值，覆盖带保留区的子范围向量读写、非零清除和清零，并验证类型不匹配、未对齐视图仍被拒绝。10 项纹理写入/清零、三维整数纹理和此项缓冲测试全部通过，结果为 `build/lumen-storage-rhi-uint2-v2/lumen-storage-rhi.json`。新转换的 161 个模块、145 条浏览器计算管线和 6 项 Cards/探针头执行通过，实际队列 Shader 的元数据均为格式 68、步长 8：`results/lumen-uint2-all-gpu.json`。真实别墅场景继续验收，不能由此推断 GI 画面或帧率已达标。

### 软件追踪的存储缓冲绑定限额

`20261103-175848` Cook 生成的 `FScreenProbeTraceMeshSDFsCS/10` 在浏览器定向创建计算管线时失败：17 个存储缓冲超过设备的 16 个上限。该 Cook 随后主动中止，报告为失败，没有将其打包成功。更高的毛发、地形或其他距离场偏移组合也存在超限，不能用首个允许排列的通过替代这些检查。

针对普通网格追踪，Web 的 `LumenScreenProbeTracing.usf` 编译将 `View_DistantSkyLightLutBufferSRV` 的单个 float4 改为常量缓冲绑定。转换先核验只读、float4 步长和 SPIR-V 中的常量零索引，再克隆固定长度 1 的数组及 Block 类型；其他共用原运行时数组类型的缓冲保持原类型。RHI 继续从原 SRV 路由读取原 GPU 分配，16 字节 ShaderResource 缓冲增加 Uniform usage，没有新增拷贝或分配，不修改天空光内容或项目效果。

64 个允许排列均通过转换和浏览器模块检查；无毛发、无地形、偏移结构 0 的 `/8`、`/9`、`/10`、`/11` 均为 16 个存储缓冲，四条实际浏览器计算管线通过。其余 36 个排列仍超过 16 个限制，未宣称管线兼容，也未通过改项目配置绕过。真实 RHI 使用相同资源进行初值读取和 GPU 写入后常量绑定再读取，共 8 个 float 精确回读通过；其余格式测试保持通过，共 11 条管线。首次误用安装宿主的探针因缺少独立 WebGPUHost.dll 退出，改用已有隔离宿主后通过，没有向安装目录添加文件。

结果：`build/lumen-probe/20261103-182216/`、`results/lumen-sky-uniform-all-modules-gpu.json`、`results/lumen-sky-uniform-perm8-gpu.json` 至 `perm11`、`build/lumen-storage-rhi-sky-uniform-v2/lumen-storage-rhi.json`。可重复摘要入口为 `summarize-web-lumen-sky-uniform.cjs`，摘要保存于 `tests/web-platform/evidence/lumen-sky-uniform-20261103.json`。线程版 WASM 仍使用 `-O2`，编译、链接和结构校验通过。新完整别墅 Cook 继续使用 `-UseProjectSettings`，浏览器首帧及性能仍待检查。

随后在 `20261103-182401` Cook 的 `FReflectionTraceMeshSDFsCS/4` 核验到相同的 17 个存储缓冲问题，因此主动中止该轮 Cook，将同一转换扩展到 `LumenReflectionTracing.usf`。反射追踪 32 个允许排列的转换与浏览器模块均通过，普通网格 `/4`、`/5` 两条计算管线降到 16 个并通过；没有增加 RHI 资源或关闭反射。结果位于 `build/lumen-probe/20261103-182955/` 和 `results/lumen-reflection-sky-uniform-*-gpu.json`，同一摘要纳入这些结果。毛发、地形及其他偏移结构的超限边界仍保留。

`20261103-183124` 重跑在原生天空光采集时出现 `0x80000003`，未进入 Web Cook，原因尚未确定。启动脚本原先只对预检和 Cook 子进程反复设置亲和性，天空光采集仍为直接调用；现将该步骤也通过同一等待器启动和核验，记录退出码及指定亲和性，不改变项目或天空光设置。`20261103-183410` 重跑已完成天空光采集并进入正式 Cook。这不能证明原生异常的根因已修复。

### 无附件光栅与 Radiosity 像素写入

`20261103-183410` 已完成 Cook、Stage 和 Package，但浏览器首帧暴露两处独立断言。`FLumenTranslucencyRadianceCacheMarkVS/PS` 使用不绑定颜色、深度附件的光栅 Pass，UE 此时给出的采样数为 0；`FCopyCardCaptureLightingToAtlasPS/1` 则将实际 R8 的 Radiosity 帧数 UAV 编译成了 R32 float。均未通过关闭对应效果绕过。

Web RHI 对无附件、无深度/模板测试且仅写 UAV 的光栅管线接受 UE 的零采样标记，实际仍创建单采样 WebGPU 管线。Pass 根据原 `ResolveRect` 提供一个 R8 范围附件，禁止颜色写入并丢弃内容；同一附件按最大所需尺寸复用，计入 RHI 纹理统计，关闭 RHI 时释放。该路径同时服务半透明辐射缓存标记与网格 SDF 的 UAV 光栅剔除。保留原 Shader、视口、间接绘制、原子写入与开关。

`LumenSceneLighting.usf` 的 Web 分支为 `RWRadiosityNumFramesAccumulatedAtlas` 明确声明 R8、只写，桌面分支不变。4 个 `FCopyCardCaptureLightingToAtlasPS` 允许排列均通过转换和浏览器模块检查，排列 1、3 的 UAV 为 R8 write，0、2 不绑定该 UAV。真实 RHI 用索引间接绘制测试 9×7、13×11、5×3 三种尺寸，回读像素原子计数、未写区域及 R8 值，均通过；逻辑附件字节数依次为 63、143、143，验证扩大后复用。原有 10 项存储格式写入/清零、64 texel 三维整数、768 个 uint2 值及 8 个天空光 float 回读保持通过，无 GPU 校验错误。

结果：`build/lumen-probe/20261103-185155/`、`results/lumen-radiosity-copy-modules-gpu.json`、`build/lumen-storage-rhi-uav-raster-v2/lumen-storage-rhi.json`；可重复摘要入口为 `summarize-web-uav-raster.cjs`，证据为 `tests/web-platform/evidence/lumen-uav-raster-20261103.json`。优化原生插件及 `-O2` 线程 WASM 构建通过，`20261103-185732` 别墅按项目设置 Cook 通过。完整浏览器首帧及性能验收继续单独进行。

## 性能与显存边界

本轮可直接计算的增量：

- 自适应头 buffer：`ceil(宽/下采样因子) × ceil(高/下采样因子) × 4` 字节，另增加一次清零和一次拷贝 Dispatch。下采样因子为 16 时，1280×720 约 14.1 KiB，1920×1080 约 31.9 KiB。
- BRDF SH buffer 从 half16 改 float32：额外 `探针图集宽 × 探针图集高 × 9 × 2` 字节，图集包含自适应区域；会增加对应读写带宽。
- Cards 添加队列保持原始字节布局，没有因标量化再复制一份队列。
- 无附件 UAV 光栅路径增加一个可复用 R8 附件，逻辑大小为最大所需宽 × 高字节；没有图像拷贝、没有颜色写出，Pass 内容丢弃。驱动对齐、清除/Pass 边界耗时与完整场景峰值须实测，不能由小尺寸回读测试推算。
- 同时使用两种降采样时，StochasticLighting 额外执行一次 2×1 计算 Dispatch 和对应材质读取，复用原有输出纹理；实际耗时仍待完整场景测量。
- 存储格式专用管线不增加纹理尺寸、格式字节数或拷贝 Pass；每个动态格式 Shader 保留一份 WGSL 源码，实际遇到的格式组合各保留一条管线。绑定格式未知时暂不进行该管线的推测预缓存，第一次使用会增加管线编译成本，后续同格式组合复用；CPU/驱动内存及首次卡顿仍待真实场景测量。
- Radiosity 历史副本增加 `图集宽 × 高 × 原格式字节数` 的临时资源和每次积分前的一次整图拷贝。默认 4096×4096 R11G11B10 为 64 MiB，拷贝读写合计 128 MiB；项目改用其他图集尺寸或格式时按实际值计算。资源池可能保留该内存，不能将 RDG 生命周期结束当作显存立即归还。完整场景的耗时和峰值尚待实测。
- Surface Cache 的默认压缩模式 1 需要 UAV 格式别名或 framebuffer 压缩能力；Web RHI 尚未提供这两项能力，UE 自动选择未压缩图集。这不改变项目 CVar，也没有手动关掉 Lumen 效果，但会增加显存。在相同 4096² 图集下，Albedo/Normal/Emissive 使用 RGBA8/RG8/R11G11B10，共 160 MiB；支持该压缩路径的桌面端使用 BC7/BC5/BC6H，共 48 MiB，三者差额为 112 MiB。Depth 在两端均为 R16 UNORM、32 MiB。此处是按源码格式计算的资源差额，不能替代进程显存实测。

以上未计对齐、驱动和资源池开销。**尚无完整 Lumen 场景帧率、GPU 各通道耗时或峰值显存实测，不能给出与桌面端的性能结论。** 关闭项目准入后不会进入这些新增 Lumen pass；尚未实测运行中关闭效果后的资源池即时归还情况。
