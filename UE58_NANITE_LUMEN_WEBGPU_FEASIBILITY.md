# UE 5.8 Nanite / Lumen 移植 WebGPU 可行性报告

评估日期：2026-10-30，UTC+8。对象为 `H:/ue_html` 的本地浏览器执行方案，采用 Wasm64、桌面延迟渲染和 WebGPU；不使用像素流、收费 SDK 或移动 ES3.1 路径替代桌面验收。

源码基线：根仓库 `42e75165fc0b8a2bfdeed1c8a6b40cde4787a6d3`；独立参考引擎 `9e1a16e57eca867b37aaf683a3e022ca4739a560`，`Build.version` 为 5.8.3。本报告依据这些源码、本机浏览器探针和下方一手资料；不是已经完成移植的交付说明。

## 1. 决策结论

**建议有条件投入软件 Lumen；Nanite 先做限定范围的技术验证；不承诺原样移植完整桌面 Nanite + 硬件 Lumen。两者应分开立项、分开验收。**

| 目标 | 可行性判断 | 决策 |
| --- | --- | --- |
| 保留 UE 软件 Lumen 核心算法，支持普通静态网格的动态漫反射 GI | 中高，有明确工程路径；尚未完成 UE 着色器 Cook 和运行闭环 | 推荐优先验证 |
| 软件 Lumen 反射、复杂材质和完整别墅场景 | 中等，依赖 GI 基础，性能和覆盖存在较大不确定性 | GI 通过后独立扩展 |
| Nanite 静态、不透明、有限材质、无细分的兼容实现 | 中等，需更改可见性写入及部分调度；不能原样照搬 | 推荐限定预算的原型 |
| 保持当前 UE Nanite 全部功能及原有性能特征 | 低；目前不能给出可执行的完整交付承诺 | 不作为首期验收 |
| 将 UE 硬件 Lumen 的 DXR / Inline Ray Tracing 直接映射到浏览器 WebGPU | 当前标准 API 没有对应接口 | 当前不立项 |
| 在 WebGPU Compute 中另建 BVH 和三角形追踪 | 原理上可研究，但属于另一条软件追踪工程路线 | 不混入本次工作量 |

这里的可行性等级是工程判断，不是统计成功概率。软件 Lumen 并不要求先移植 Nanite；但本地 UE 5.8 的 Lumen 场景管理实际使用 GPUScene，也不能因为已有 DFAO 就直接打开 Lumen 总开关。

最值得先投入的目标是：**普通静态网格 + 原有材质 + 软件距离场追踪 + Surface Cache + Screen Probe Gather，先完成可对照的真实动态间接光反弹。** 默认关卡用于基础回归，不能单独证明 GI 或 Nanite 的价值。

## 2. 现有工程基础

以下是既有交付及当前源码核查，不是本轮重新执行整套场景验收。[L1][L2][L3]

| 层次 | 已有基础 | 不能据此推导的结论 |
| --- | --- | --- |
| 运行与渲染 | Wasm64、多线程资源基础、桌面 SM5 延迟渲染、真实 Lit 材质、TAA、SSR、天空和普通阴影 | 不代表 SM6 全能力、独立渲染/RHI 线程或硬件光追 |
| 距离场 | 网格 DF Cook、稀疏砖块图集、全局距离场、DFAO、BulkData / OPFS 流送 | DFAO 是遮蔽，不是 Lumen 动态 GI |
| GPU 调度 | Compute、DispatchIndirect、部分 DrawIndirect / DrawIndexedIndirect、异步回读及 fence | 不等于完整 Nanite 调度、计数间接绘制或 Work Graphs |
| Shader 工具链 | UE 原有编译路径及 SPIR-V → 固定版本 Tint → WGSL，带绑定反射 | 新 Wave、原子及复杂控制流仍需逐个排列核验 |
| 平台能力 | `bSupportsDistanceFields=true` | GPUScene、Nanite、LumenGI、WaveOperations、UInt64ImageAtomics 等仍被明确禁用 |

当前 RHI 已尝试请求浏览器 `subgroups`、Tier 1 / Tier 2 等可选特性，但平台声明尚未接通 UE Wave 路径。硬件能力、设备创建、编译排列和 UE 运行分支是四个不同的检查点。[L4]

另有两个影响本次投资决策的现状：

- 原别墅配置的动态 GI 方法本来就是 0，不能把当前所有桌面/Web 差异归因于“没有 Lumen”。应先在同一原生场景显式开启软件 Lumen，确认收益与可支持的资产范围，再评估 Web 接入价值。[L2]
- 既有报告仍记录未闭环的浏览器原生崩溃及高显存压力。历史整适配器约 6.8～7.7 GiB 的采样包含其他应用，不是本包显存；但它足以说明不能把 8 GiB 硬件当成还有大量余量。本轮小探针通过没有解决这些场景问题。[L1][L3]

## 3. 标准与本机能力实测

### 3.1 必须更新的认知

截至评估日，查阅的 WebGPU 编辑草案定义了可选特性 `atomic-vec2u-min-max`；WGSL 文档定义 `atomic_vec2u_min_max`、`atomic<vec2<u32>>` 与 `atomicStoreMin` / `atomicStoreMax`。它以低 32 位在 x、高 32 位在 y 的方式表示无符号 64 位值。[S1][S2]

**因此，“WebGPU 永远没有 64 位原子，所以 Nanite 绝对不可能”不是合适的结论。** 但该能力有明确边界：

1. 是可选特性，不是所有浏览器和显卡的保证。
2. 是特定的打包 64 位 min/max，不等于通用 `u64`、64 位 CAS、加法或任意原子操作。
3. 对象位于 storage buffer，不能原样替换 UE 的 `RWTexture2D<UlongType>` / R64_UINT 图像原子。
4. 规范、浏览器及本项目固定 Tint 的语法和能力版本必须一致；不能仅看浏览器内置解析器认识名称。
5. 本机两个正式通道浏览器均未暴露该设备特性和语言能力，不能以它作为当前交付前提。

WebGPU 当前标准 API 同样没有 DXR 加速结构、光追管线、ray query、Mesh Shader 或 Work Graph 的直接接口。[S1] 其中后两者对部分 Nanite 路径属于优化选项，不能全部误写成 Nanite 的必要条件。

### 3.2 本轮实测方法

新增 `tests/web-platform/probe-nanite-lumen-capabilities.cjs`，用 Playwright 启动独立无界面 Chrome / Edge；不附加浏览器命令行实验参数，不加载 UE 大包。页面通过本地可信 origin 访问 WebGPU，记录适配器、语言能力、设备限额和实际 GPU 回读。

本机结果：

| 项目 | Chrome | Edge |
| --- | --- | --- |
| 实际版本 | 156.0.8078.73 | 156.0.4314.50 |
| 适配器报告 | NVIDIA / Ampere，非回退适配器 | 相同 |
| Subgroups / subgroup-size-control | 暴露 | 暴露 |
| 实际 Subgroup 宽度 | 32 | 32 |
| Tier 1 / Tier 2 纹理格式 | 暴露 | 暴露 |
| `atomic-vec2u-min-max` / 对应语言能力 | 未暴露 | 未暴露 |
| `atomic<u64>` | 编译拒绝：无此类型 | 相同 |
| 草案 `requires atomic_vec2u_min_max` 与 `atomicStoreMax` | 编译拒绝：不支持该语言扩展 | 相同 |
| R64_UINT / `r64uint` 纹理 | Web API 枚举拒绝 | 相同 |
| 普通 R32_UINT 存储纹理调用 `textureAtomicAdd` | 编译拒绝：无此内建函数 | 相同 |
| Subgroup 归约、前缀和、首 lane 广播 | 64 个调用回读通过 | 相同 |
| R16_UINT 存储纹理写入、屏障、读取 | 输出 65535，通过 | 相同 |
| 分两遍选择深度与 ID | 3 个种子，每组 8192 个候选 / 128 个像素，与 CPU BigInt 64 位最大值一致 | 相同 |

最后一项刻意制造同像素竞争和相同深度，采用完整的两个 Compute Pass；它证明这一有限输入模型下可以保持深度/ID 配对及相同深度时的 ID 决胜规则。它**没有执行三角形光栅化、UE Nanite Shader、材质评估或流送，也没有测性能**。

每浏览器 6 项正向/回读检查通过；预期的编译/API 拒绝被错误作用域捕获，未出现额外 GPU 验证错误。原始 JSON 位于 Git 忽略的 `tests/web-platform/results/nanite-lumen-webgpu-capabilities.json`；本文保存结论，脚本可重建证据。

### 3.3 不能把默认设备限额当成硬件上限

本轮两个浏览器数值相同：

| 限额 | 默认新设备 | 适配器可申请上限 | 对项目的含义 |
| --- | ---: | ---: | --- |
| 单 buffer 大小 | 256 MiB | 2 GiB | 大页池需显式申请，仍需分块策略 |
| 单 storage buffer 绑定范围 | 128 MiB | 2 GiB - 4 字节 | 默认 128 MiB 不是全部硬件的固定天花板 |
| 每阶段 storage buffer | 8 | 16 | 必须核对完整 shader 的绑定合计 |
| 每阶段 storage texture | 4 | 8 | 不能仅按纹理格式可创建就判定完整通道可用 |
| 每阶段 sampled texture | 16 | 48 | UE 当前 RHI 申请值上限为 32 |
| 每阶段 sampler | 16 | 16 | 仍需共享 sampler、图集或分批 |
| 单工作组线程数 | 256 | 1024 | 项目 DDPI 当前仍声明 256 |
| 工作组共享内存 | 16 KiB | 32 KiB | 部分原生算法需要改排列或申请更高上限 |
| 二维纹理边长 | 8192 | 16384 | 图集不能直接按适配器上限创建 |

探针的显式设备只提升了五项通道/Compute 限额；没有申请更大 buffer 或纹理。因此表中的 buffer/纹理高值是适配器报告，不是大分配或压力测试结果。实际 UE RHI 的 `RenderingLimits()` 当前只显式提升部分限额，不能假设其设备已经取得上表所有高值。[L4]

## 4. Nanite：可行路径与阻塞

### 4.1 真正阻塞的是一致的可见性写入

本地 `NaniteWritePixel.ush` 将像素的深度和可见三角形编码打包，用 `ImageInterlockedMaxUInt64` 对可见性纹理写入。`NaniteCullRaster.cpp` 的多个排列检查 UInt64ImageAtomics；`RenderUtils.cpp` 还检查 GPUScene 和运行时 AtomicUInt64。[L5]

不能直接写成两个独立的 32 位原子更新。并发时可能拿到最近三角形的深度，却保留另一个三角形的 ID；后续材质、速度、法线及深度合成都会错误。逐像素自旋锁也不宜作为正式方案：跨工作组前进与调度缺少可依赖的保证，热点竞争还会放大执行时间。

| 路线 | 实现方式 | 优点 | 代价与当前判断 |
| --- | --- | --- | --- |
| N1：可选打包 64 位原子 | 把可见性目标改为 storage buffer，使用草案规定的 min/max；随后转换给消费者 | 最接近原有深度/ID 选择语义 | 本机未暴露；仍要重做 R64 读者、绑定、反射及提前深度读取，暂不作为首期依赖 |
| N2：两阶段 32 位原子 | 先选每像素深度，结束 pass；重放候选，仅让匹配深度的候选竞争 ID | 现有基础 API 能表达，本轮简化模型回读通过 | 需要重放光栅/候选生成；所有硬件及软件来源必须统一；有额外带宽和调度成本，推荐优先验证 |
| N3：全部走硬件光栅 | 复用 cluster 层级与流送，将解码几何通过普通 VS/PS 输出深度和整数可见性 | 避开软件微三角形写入路径 | 需改几何展开和调度，可能失去 Nanite 对微三角形的主要性能优势；作为备选 |

N2 如果要保持与原始 packed max 相同的决胜结果，第二遍必须处理相同深度时的 ID 比较；不能只“命中深度就普通写 ID”。候选生成、裁剪、像素坐标和深度位模式两遍必须相同；masked、WPO、时间相关材质及混合软硬光栅都会扩大验证范围。

N1 即使未来可用，也不自动解决 `EarlyDepthTest()` 对当前可见性目标的读取。受限 min/max 不是完整的原生 UAV 读改写接口，需要单独设计预深度、只读视图或移除相应提前淘汰优化，并验证消费者一致性。

### 4.2 其余必要改造

| 子系统 | 当前差距 | 首期策略 |
| --- | --- | --- |
| GPUScene / Instance 数据 | DDPI 和 `WebShaderPlatform.h` 双重排除，Nanite 平台门槛明确要求 | 接通静态 primitive / instance 上传、删除、重分配和映射；不能只改布尔值 |
| Wave 运算 | Shader 大量使用 shuffle、ballot、prefix、lane 通信 | 先针对本机 32 lane 接通实际编译与回读；其他宽度独立验证 |
| GPU 队列和剔除 | 原生持久线程/队列、原子及屏障语义不一定能直接进入 WGSL | 审计全局进度依赖，必要时拆为有界多 dispatch；不能靠跨组忙等 |
| 几何解码、手动取顶点 | 当前 ManualVertexFetch、VertexShaderSRV 等未开放 | 用实际 Nanite cluster 页验证解码、步长、对齐、索引及 VS 访问 |
| 页流送和转码 | 已有 OPFS/BulkData，但尚非 Nanite 页协议闭环 | 保留原页、依赖和 fixup 语义，补 GPU 请求延迟、合并、淘汰与重传 |
| 材质分桶和着色 | 绑定数、间接参数及材质计算排列尚未适配 | 先复用非 bindless、非 Work Graph 路径，限制材质集合 |
| 深度、HZB、GBuffer、速度 | 多处消费 R64 可见性，不能只改 writer | 建立 Web 可见性数据布局及完整消费者清单，核验与普通网格交叠 |
| Cook / 资产 | 需确认完整 Nanite 页与 fallback 的保留策略 | 使用独立候选构建，记录页和 cluster 清单；fallback 显示成功不算 Nanite 成功 |

Mesh Shader 不是第一阻塞：`NaniteShared.cpp` 存在 VertexShader 硬件光栅路径。Bindless、Work Graphs 和 VSM 也不能一概当成首期硬前提；本地源码有相关可选路径。[L5]

**首期 Nanite 范围**：静态、不透明、普通三角网格；限制材质数量；暂不含蒙皮、细分/位移、曲线、体素、透明、复杂 WPO、VSM 和完整 Nanite/Lumen 联动。范围之外保留现有普通网格路径，并在构建清单明确记录。

真正的 Nanite PoC 必须读取实际 Nanite 资产，执行层级 LOD 选择、cluster 剔除、页请求/缺页恢复和可见性着色。仅把离线三角形批量画出来，或者渲染 fallback mesh，不能证明 Nanite 已移植。

## 5. Lumen：优先软件追踪，不能停在 DFAO

### 5.1 推荐移植链路

```text
普通静态网格 + GPUScene
    -> Cook 生成并保留 Mesh Cards、网格距离场
    -> 非 Nanite 材质捕获 -> Surface Cache
    -> Lumen Scene 直接光、Radiosity 与缓存更新
    -> Screen Traces + Mesh SDF / Global SDF 软件追踪
    -> Screen Probe Gather + Radiance Cache
    -> 时域积累、降噪、上采样 -> 间接漫反射合成
    -> 软件 Lumen 反射另行接入
```

Epic 文档说明 Lumen 支持距离场软件追踪，Nanite 主要加速 Surface Cache 捕获；本地 `LumenSceneCardCapture.cpp` 确有普通网格的材质 VS/PS 捕获通道。[S3][L6] 因而先移植软件 Lumen 无需等待 Nanite。

不过，官方也对植被和实例化网格的捕获支持列出 Nanite 相关限制。首期不能由“普通静态网格可用”外推到 ISM/HISM、植被、地形和所有资产；每类需单独审计 Cook、捕获与更新。[S3]

### 5.2 本地源码的具体阻塞

| 阻塞 | 核查证据 | 必须完成的工作 |
| --- | --- | --- |
| Lumen 平台准入 | `DoesPlatformSupportLumenGI()` 除 DDPI 外，还明确检查 SM6 或特定 Vulkan/Metal SM5 枚举，以及非 Forward | 增加经过测试的 Web 能力路径；`Language=Vulkan` 和命名 SM5 都不能自动放行 |
| Cards 被 Cook 剥离 | `StaticMesh.cpp:2438` 要求目标平台同时支持 DeferredRendering 与 LumenGI；当前真实 Cook settings 未声明后者 | 新增独立 Lumen Cook 配置并重新生成/保留 Cards，不能复用已剥离的 DF 包 |
| GPUScene | `LumenMeshCards.cpp:471` 等使用实例 ID 上界和实例到 Cards 映射 | 恢复实际静态实例管理及消费者，验证更新/移除；普通网格捕获也不等于无需 GPUScene |
| R16_UINT typed UAV | `DoesRuntimePlatformSupportLumen()` 明确要求 PF_R16_UINT TypedUAVLoad | 本轮 API 回读已通过；还需 RHI 能力声明、视图、Cook 格式反射及实际 UE Shader 验证 |
| 存储纹理原子 | 自适应 Screen Probe 等使用纹理 InterlockedAdd；当前 WGSL 不能直接表达这些原调用 | 映射至线性 `atomic<u32>` buffer，或分阶段归约；审计返回旧值、清零、索引和后续读取 |
| Lumen 专属全局场数据 | DF 中 PageObjectGrid 由 Lumen 条件启用；coverage atlas 另受能力控制 | 已有 DFAO 图集不等于这些数据齐备；接通对象网格，逐项验证 coverage 回退对追踪质量的影响 |
| 光照存储格式 | 默认 R11G11B10 的采样、RenderTarget、Storage 不是同一能力 | 首个参考实现可用原生已有 RGBA16F 配置，明确增加的内存/带宽；之后再优化 |
| Wave / 控制流 / 导数 | 有些 Lumen 通道存在非 Wave 排列，但不能保证所有通道都有 | 优先已有正确回退，逐排列核验；不能统一关 Wave 后宣称全支持 |
| 场景动态更新 | 材质捕获、光照更新、缓存请求和时域历史为独立子系统 | 覆盖灯光变化、物体移动/移除、视角变化、瞬移及历史失效 |

GPUScene、存储纹理原子和 Cards 数据是容易被“距离场已经有了”掩盖的主要增量。本次 R16_UINT 和 Subgroups 实测缩小了底层不确定性，但没有替代上述接入工作。

### 5.3 画质和性能边界

软件 Lumen 会受距离场几何精度、薄墙、封闭结构、Surface Cache 覆盖、材质及屏幕外追踪影响；对镜面、多层透明和动态蒙皮的支持不能按硬件 Lumen 承诺。[S3] 需要先选择与目标模式相符的原生软件 Lumen 作为对照。

本报告优先 Screen Probe Gather，不以屏幕空间 AO、SSGI、预烘焙探针或统一提亮冒充 Lumen。源码另有较低质量的 Irradiance Field Gather，可作为独立候选模式，必须披露模式和质量差异，不能替代主线验收。[L6]

Async Compute 不是正确性前提，可先在同一 WebGPU 队列串行执行。这样可能失去原生重叠收益，但不会因此直接判定算法不可移植。

Epic 文档中的主机约 8 ms 是特定主机与画质档位、1080p 内部渲染、GI 和反射组合的预算，并非浏览器性能保证；依赖 TSR 输出接近 4K 也不等于原生内部 4K。[S3] 本工程尚未完成 TSR，不能把它计入现成性能收益。

## 6. 显存、帧率与内容包

**目前没有证据可承诺完整别墅 1080p 60 FPS，或内部 4K 实时 Nanite + Lumen。** 本轮探针只验证能力与局部正确性，没有 GPU 场景耗时。

可用于预算检查的直接计算：

| 单份资源 | 1920×1080 | 3840×2160 |
| --- | ---: | ---: |
| 深度 + ID，8 字节/像素 | 15.82 MiB | 63.28 MiB |
| RGBA16F 全分辨率纹理 | 15.82 MiB | 63.28 MiB |
| 4096×4096 RGBA16F 图集 | 128 MiB | 与输出分辨率无直接对应关系 |

这些是像素数据大小，未计对齐、mip、多个历史、双缓冲、临时资源或驱动开销。N2 两个 u32 通道与原 R64 同为 8 字节/像素；主要额外成本来自重放、读写、可能的转换/暂存，不能直接宣称显存减半。

建议预算先覆盖：现有 GBuffer/阴影/纹理池、Nanite 页池及解码工作区、可见性/HZB、网格/全局距离场、Cards 与 Surface Cache、Radiance Cache、探针及反射历史、读回与上传暂存。需要按资源寿命记录当前值、峰值和延迟释放，不能用整适配器显存减法推导增量。

内容包须重新计量 Cards、Nanite 根页/流送页、DF 和新增 Shader permutations。流送复用 OPFS 与批量 BulkData，验证冷/热缓存、页面淘汰及取消请求；不能把全部页永久复制进 Wasm 堆，也不能增加逐 cluster HTTP 请求。

建议先定义 **1080p、30 FPS、代表性相机路线** 的候选目标，再以实测决定 60 FPS 和更高分辨率。这个目标是建议的验收预算，不是当前已达到的结果。移动端、Safari、Firefox 及其他 GPU 属于独立能力矩阵，本轮未测试。

## 7. 实施阶段和止损条件

| 阶段 | 可审查交付 | 继续投入条件 |
| --- | --- | --- |
| P0：原生收益基线 | 显式软件 Lumen 的室内 GI 夹具及别墅对照；Nanite 高密度资产和 fallback 对照；固定相机、曝光和配置清单 | 明确画面收益、资产覆盖和目标预算；排除只是修复当前光照缺项即可解决的需求 |
| P1：共用底座 | 静态 GPUScene、实际 UE Shader 的 Wave/格式/原子 buffer 转换、能力与构建清单 | WGSL 转换、实际 GPU 数值回读、实例增删及设备限额检查通过 |
| L1：最小软件 Lumen | 真实 Cards Cook、普通网格捕获、Surface Cache、Scene Lighting、SDF 追踪和 Gather 合成 | 实际出现随光源变化的间接光与颜色反弹；屏幕外几何也参与 |
| L2：场景与运动 | 默认关卡回归、别墅室内、相机移动/瞬移、物体增删、缓存失效、资源账本 | 目标相机路线达到质量/性能预算；没有把黑块、漏光或历史错误用后处理掩盖 |
| L3：软件反射 | 反射追踪、滤波、历史和合成独立回归 | 与原生相同软件模式对照，明确镜面与透明边界 |
| N0：真实 cluster 原型 | 用 N2 或 N3 处理实际 Nanite cluster，接深度/ID、LOD、缺页和最小着色 | 高竞争可见性正确；与 fallback 区别可证；成本值得继续 |
| N1：Nanite 场景 | 完整流送、材质分桶、深度/HZB/速度、与普通网格交叠 | 高密度场景有实测收益或满足明确的几何质量目标 |
| I：联合运行 | Nanite + 软件 Lumen、原有 UI、启动/刷新/缩放/后台恢复 | 两功能联合峰值预算、长时与设备丢失恢复达到要求 |

止损条件应在阶段开始前固定：

- N0 的真实光栅重放代价导致目标场景明显不如可接受的普通 LOD 路径时，暂停 Nanite 扩展，保留研究结果。
- 只有 fallback 显示成功，没有真实页流送或 cluster LOD，不能进入 N1。
- L1 只有屏幕空间效果，视角一转间接光就消失，或者 Cards 缺失时靠环境光补亮，不能称为软件 Lumen 通过。
- 当前场景崩溃、资源释放或峰值内存不能闭环时，不以增加总内存或降低未披露的画质继续扩大支持面。
- 新原子扩展未在实际部署浏览器暴露时，不将等待浏览器更新作为唯一交付计划。

### 粗略投入区间

以下是本报告的规划估算，单位为有效工程人周；不是实测工期或交付排期。假设工程师熟悉 UE Renderer/RHI、Shader 编译和 WebGPU，且已有本地构建与测试环境可复用：

| 工作包 | 规划区间 |
| --- | ---: |
| P0 与共用底座 P1 | 4～8 人周 |
| L1 普通静态网格软件 GI 闭环 | 6～12 人周 |
| L2 别墅/运动/预算验证 | 4～8 人周 |
| L3 软件反射，作为附加项 | 3～6 人周 |
| N0 有实际资产和流送的 Nanite 原型 | 4～8 人周 |
| N1 范围内场景化与优化，N0 通过后 | 10～20 人周 |
| I 联合运行与发布级验证 | 4～8 人周 |

软件 GI 候选从现有基线累计约 14～28 人周，不含软件反射；Nanite 分支在共用底座之后另需约 14～28 人周。范围部分可并行，但不能把人周直接除以人数当作日历工期；完整桌面功能、所有浏览器/GPU及未知驱动缺陷没有被这些数字覆盖。

建议首先批准 **1～2 人周的 P0 和关键阻塞验证额度**，交付实际 UE Shader 转换清单、原生收益对照与下一阶段修订估算，再决定后续预算。该额度是 P0/P1 的前段，不是承诺在两周内完成软件 Lumen 或 Nanite。

## 8. 验收方法

| 对象 | 必测内容 | 不能作为替代的证据 |
| --- | --- | --- |
| Nanite 正确性 | 实际 cluster 解码对原生；相同深度 ID 决胜；大量重叠微三角形；近裁剪、背面、普通网格交叠、速度/HZB；缺页、淘汰及恢复 | 只看帧数、单网格截图或 CPU 固定 LOD |
| 软件 GI | 带红/绿墙的室内反弹；间接受光区域；光源和 emissive 改变后的收敛；遮挡物移动；屏幕外追踪 | DFAO 开关变暗、SSGI 或调曝光 |
| 缓存与动态 | Cards 缺口、Surface Cache 更新、相机瞬移、移除/重新加入物体、预曝光及历史重建 | 静止镜头预热后的一张图 |
| 桌面对照 | 同一 UE 版本、资产、视角、分辨率、软件追踪模式、曝光、画质参数；保存差异和未支持项 | 原生硬件 Lumen 对 Web 软件模式但不披露差别 |
| 性能与资源 | 完整帧 CPU/GPU、P50/P95、冷/热缓存、峰值资源账本、内容包和 Shader 大小 | 只相加 GPU pass 时间或套用主机官方 ms |
| 稳定性 | Chrome / Edge 正常时钟，真实移动路线、重复加载/刷新、缩放、后台恢复、至少 30 分钟候选压力测试 | 冻结渲染时间、短时 API 探针通过 |

默认 `/Engine/Maps/Templates/Template_Default` 仍需完成原灯光、天空、材质、交互及缩放回归；它既没有足够的间接光反弹结构，也没有高密度几何负载，因此另加专用夹具和别墅场景。全部高级功能只在 Web 局部适配，保留 Slate/UMG，不修改 `H:/UE_5.8`。

## 9. 本轮交付与复现

本轮新增本文和独立能力探针。**没有开启运行时 Nanite / Lumen，没有修改参考引擎、现有打包配置、资产或安装引擎，也没有重新 Cook / 构建完整 UE。**

```powershell
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node --check tests/web-platform/probe-nanite-lumen-capabilities.cjs
node tests/web-platform/probe-nanite-lumen-capabilities.cjs
```

实测边界：仅本机 NVIDIA Ampere 和上述两个浏览器版本；Subgroups、R16_UINT 和两遍归约的 Compute 小规模回读。预期不支持项单独记录，不将有意触发的编译错误计为额外场景错误。未测试真实 Nanite 页解码、Lumen permutations、完整光栅重放、设备内存压力、其他 GPU 或发布级稳定性。

## 10. 证据索引

在线资料于 2026-10-30 查阅。规范是可变文档，部署前应重查特性暴露与浏览器版本；Epic 在线文档用于算法/平台背景，本地实现细节以本报告固定引擎提交为准。

### 一手在线资料

- [S1] W3C GPU for the Web 编辑草案：<https://gpuweb.github.io/gpuweb/>。核对 `GPUFeatureName`、`atomic-vec2u-min-max`、设备功能与限额、纹理格式及标准接口集合。
- [S2] W3C WGSL：<https://www.w3.org/TR/WGSL/>。核对 `atomic_vec2u_min_max`、原子类型、`atomicStoreMin` / `atomicStoreMax`、Subgroups 和原子内存作用域。
- [S3] Epic Games，Lumen Technical Details：<https://dev.epicgames.com/documentation/en-us/unreal-engine/lumen-technical-details-in-unreal-engine>。核对软件距离场追踪、Cards / Surface Cache、Nanite 捕获作用、质量限制及主机预算背景。
- [S4] Epic Games，Nanite Virtualized Geometry：<https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine>。核对当前官方支持平台、几何/材质限制和虚拟几何架构背景；不据此声称官方支持 WebGPU。

### 本地证据

- [L1] `UE58_DISTANCE_FIELD_WEB.md`：距离场、间接调度、场景验证与资源/性能边界。
- [L2] `UE58_VILLA_RENDERING_OVERRIDES.md` 与 `tests/web-platform/cook-profiles/TriplexHouseVillaFullresDesktopEngine.ini`：实际配置、原有 GI 方法和 Web 特性排除。
- [L3] `UE58_BROWSER_CRASH_DIAGNOSIS.md`：尚未闭环的原生浏览器崩溃；本轮不对其根因作新判断。
- [L4] `reference-engine/Engine/Platforms/Web/Config/DataDrivenPlatformInfo.ini`；`reference-engine/Engine/Source/Runtime/RenderCore/Public/WebShaderPlatform.h`；`tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp:44`、`:515`、`:586`；同插件 `WebGPUShaderFormat/Private/WebGPUShaderFormat.cpp:766`：能力声明、设备申请与 Tint 转换。
- [L5] `reference-engine/Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp:1280`、`:1304`；`reference-engine/Engine/Shaders/Private/Nanite/NaniteWritePixel.ush:19`；`reference-engine/Engine/Source/Runtime/Renderer/Private/Nanite/NaniteCullRaster.cpp:1554`、`NaniteShared.cpp:121`、`NaniteShading.cpp:256`、`NaniteComposition.cpp:50`：Nanite 准入、原子、可选调度与可见性消费者。
- [L6] `reference-engine/Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp:2630`；`reference-engine/Engine/Source/Runtime/Renderer/Private/Lumen/Lumen.cpp:54`、`:63`、`:82`；同目录 `LumenMeshCards.cpp:471`、`LumenSceneCardCapture.cpp:411`、`LumenScreenProbeGather.cpp:2325`；`reference-engine/Engine/Shaders/Private/Lumen/LumenScreenProbeGather.usf:1936`：Lumen 准入、GI 模式、GPUScene、普通网格捕获与纹理原子。
- [L7] `reference-engine/Engine/Source/Runtime/Engine/Private/StaticMesh.cpp:2438`；`tests/ue-shader-host/Plugins/WebGPUShader/Source/WebCookTargetPlatformSettings/Private/WebCookTargetPlatformSettings.cpp:17`；`reference-engine/Engine/Source/Runtime/Renderer/Private/GlobalDistanceField.cpp:908`、`:950`：Cards Cook 剥离、真实 Cook 目标能力及 Lumen 专属全局场数据。
- [L8] `tests/web-platform/probe-nanite-lumen-capabilities.cjs` 与可重建的 `tests/web-platform/results/nanite-lumen-webgpu-capabilities.json`：本轮实际浏览器能力、预期拒绝、限额及 GPU 回读。原始报告记录 UTC 时间和探针源码 SHA-256。
