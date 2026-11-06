# UE 5.8 Nanite 的 WebGPU 实现方案复核

日期：2026-11-06，Asia/Hong_Kong。范围：普通浏览器本地执行、桌面渲染路径。
源码基线：根仓库 `9eec4fb862931664d6b0e224d88714363cb6665b`；
参考引擎 `6aa753526ccca70deeaecaf910d1a6686a72f846`。

## 结论

**Nanite 可以进入真实 UE 资产的移植原型阶段。推荐复用 UE 的 Nanite 构建数据、层级、流送和材质体系，以新打包原子实现可见性缓冲；普通硬件光栅作为初期接通路径和兼容候选。**

2026-10-30 报告中“本机尚未暴露打包 64 位原子”的前提已经变化：
Chrome 157 实际执行新原子的数值检查通过；Edge 156 仍未暴露。
因此将原报告 N1 从等待项提升为主线候选，N2 两遍算法保留为兼容方案。
这不表示当前 UE 包已支持 Nanite。

Nanite 的几何管线不要求先接通硬件光追。其必要工作是实际 cluster 数据、LOD、
剔除、可见性、材质与页流送；显示 fallback mesh 不能作为完成证明。[S3][S4][L2]

## 本机新验证

探针：`tests/web-platform/probe-nanite-visibility.cjs`。
使用 Playwright 启动独立无界面浏览器，本地可信 origin，没有额外实验参数；
适配器报告为 NVIDIA / Ampere、非 fallback。这里不据浏览器架构字符串推断具体显卡型号。

| 检查 | Chrome 157.0.8103.39 | Edge 156.0.4314.58 |
| --- | --- | --- |
| `atomic-vec2u-min-max` | 暴露，显式申请设备特性成功 | 未暴露 |
| `enable atomic_vec2u_min_max` 与 `atomicStoreMax/Min` | 编译、执行、GPU 回读通过 | 跳过特性专属测试 |
| 每组 32768 个候选竞争 256 个像素，3 个种子 | 深度及 ID 与 CPU BigInt 结果一致 | 两遍 u32 方案一致 |
| 同深度 ID 决胜、ID 高位、零与有限深度边界 | 通过 | 两遍方案通过 |
| 完成写入后，下一计算 pass 按只读 `vec2u` 访问同一缓冲 | 通过 | 未测试此新原子路径 |
| 片元着色器向打包原子缓冲写入 | 16×16 像素回读通过 | 未测试此新原子路径 |
| 片元 pass 后计算 pass 继续竞争同一可见性缓冲 | 回读通过 | 未测试此新原子路径 |
| `atomicLoad(atomic<vec2u>)` | 按预期被拒绝 | 未测试 |
| 正向数值检查 | 17 项通过 | 6 项通过 |
| 未捕获 GPU 校验错误 | 0 | 0 |

测试采用有限、非负的浮点深度位模式，按 UE 的反向 Z 最大值逻辑选择结果。
这是合成归约和简单片元写入测试，没有执行 UE cluster 解码、三角形覆盖计算、
近裁剪、masked/WPO、真实材质、遮挡剔除或页流送，也没有测性能。
片元与计算写入在不同 pass 中有序执行，没有验证跨队列并发。

原始报告与脚本、着色器 SHA-256 保存于
`tests/web-platform/evidence/nanite-visibility-20261106.json`。
可重建输出位于 `tests/web-platform/results/nanite-visibility-20261106.json`。
总 `pass` 表示浏览器数值验证通过；工具链是否能读回 Int64 SPIR-V 由独立字段
`compiler.spirvRoundtripSupported` 表示，本次为 false。

### API 语义

规范定义的是两个 u32 组成的无符号 64 位原子 min/max，低位在 x，高位在 y。
不是分别对 x/y 做原子最大值，也不是完整的 u64 运算、CAS 或 R64 图像原子。[S1][S2]

```wgsl
enable atomic_vec2u_min_max;
@group(0) @binding(0)
var<storage, read_write> visibility: array<atomic<vec2u>>;

// In a shader function: low word = triangle ID, high word = depth bits.
// atomicStoreMax(&visibility[pixel], vec2u(triangleId, depthBits));
```

设备创建必须申请 `requiredFeatures: ['atomic-vec2u-min-max']`。
本机 WGSL language features 列表没有这一名称，但 enable 扩展实际可用；
不能只查该列表，也不能只使用旧探针的 `requires atomic_vec2u_min_max` 判定支持。
应检查适配器特性、申请设备、编译并执行实际 shader。

## 新定位的编译阻塞

项目固定工具为 `.tools/dawn-v20261009.190412/bin/tint.exe`。
同一份 `shaders/nanite-packed-visibility-probe.wgsl` 的结果：

| 转换 | 结果 |
| --- | --- |
| WGSL → WGSL | 通过，保留新原子 |
| WGSL → HLSL SM6.6 | 通过，生成 `RWByteAddressBuffer.InterlockedMax64` |
| WGSL → SPIR-V | 通过 |
| 上述 SPIR-V → WGSL | 失败：`SPIR-V capability 'Int64' is not supported` |

因此不能推断“浏览器认识 WGSL，所以现有 UE → DXC → SPIR-V → Tint → WGSL 已通”。
本轮没有运行真实 UE Nanite shader 的完整 Cook；已证明的是固定 Tint 的 Int64 读取入口仍有阻塞。

建议先做一个 Web 专用、范围受限的可见性原语转换：

1. 明确资源类型为打包可见性 storage buffer，记录低 ID、高深度的布局与用途。
2. 在 shader 编译层为该原语做结构化转换，最终生成 `atomicStoreMax`；
   Web 中间表示用 `uint2`/`vec2u`，不能让不支持的通用 Int64 直接进入现有 SPIR-V reader。
3. 选择受控的 IR/SPIR-V 转换或 Tint reader 扩展，并验证资源反射和绑定一致；
   不用全局正则替换任意 u64，也不把两个独立 u32 原子当作等价实现。
4. 用实际 UE `NaniteWritePixel`、数据解码和材质 shader 验证，再开放 Cook 排列。

单纯更新 Tint 不作为已证实的解决办法；需要先验证候选版本的 SPIR-V 输入路径。
也不应将 `bSupportsUInt64ImageAtomics` 或 `GRHISupportsAtomicUInt64` 全局置 true
来冒充通用能力，应以已实现的 Web Nanite 路径局部调整准入。

## 实现路线

| 路线 | 做法 | 适用位置 | 主要代价 |
| --- | --- | --- | --- |
| A：打包原子 + 混合光栅 | 大三角形走 VS/PS，小三角形走 Compute；共同写入 `atomic<vec2u>` 可见性缓冲 | 推荐主线；本机 Chrome 具备底层前提 | 编译转换、R64 资源改造、Wave、所有可见性消费者 |
| B：全部硬件光栅 | GPU 选择真实 Nanite cluster；VS 解码顶点；深度附件 + 整数颜色附件保存可见性 | 初期接通与无新原子浏览器的兼容候选 | 微三角形效率可能下降；原 PS/UAV 路径仍须改造 |
| C：两遍 32 位软件/混合光栅 | 第一遍 atomicMax 深度，pass 结束；第二遍重放，仅深度相等者 atomicMax ID | 保留原子结果语义的兼容候选 | 重放覆盖计算、额外带宽与 dispatch；真实性能待测 |
| D：独立 Nanite-like 系统 | 自建 cluster、LOD、格式和材质，用 meshoptimizer 等工具辅助 | 新 Web 引擎或教学 | 与现有 UE Cook、资产、材质、流送割裂，不推荐作本项目主线 |

上述排序是工程建议，不是完整 UE 实测排名。

### A：最接近当前引擎的主线

保留 UE 导入/Cook、cluster 页格式和层级，主要改 Web 的执行与资源表达：

```text
UE Nanite Cook 数据
    -> 根页/层级常驻 + 流送页池
    -> GPUScene 实例剔除
    -> 分层 NodeCull + ClusterCull + GPU 间接参数
    -> 现有 VS/PS 硬件路径 / Compute 微三角形路径
    -> storage buffer: [ID低32位, 深度高32位]
    -> 只读可见性访问或导出 RG32_UINT
    -> 深度/HZB、材质分桶、GBuffer、速度
    -> 现有桌面光照、软件 Lumen、TSR
```

`NaniteWritePixel.ush:20` 的打包原子操作与本次验证的数据次序一致。
`EarlyDepthTest()` 会读取仍在写入的可见性目标，而新原子没有通用 atomicLoad。
首期建议局部移除这种早期淘汰优化，保证最终原子写入的正确性；
之后再测冻结深度快照或独立阶段预深度。不能同时对同一存储用非原子读取规避限制。

后续 pass 只读访问同一 GPUBuffer 已通过小探针。
可选择全链路改为 buffer，或阶段结束后导出 `rg32uint` 纹理供消费者读取；
后者可能减少上层改动，却增加转换、资源同步和带宽，需以 pass 账本选择。
现有 R32 纹理原子镜像可借鉴资源生命周期，但不能自动覆盖 64 位成对原子。

### B：普通硬件光栅不是“打开开关即可”

`NaniteShared.cpp:157` 的默认硬件路径就是 `VertexShader`，
`NaniteCullRaster.cpp:3667` 有 `DrawPrimitiveIndirect`。
缺少 Mesh Shader 不妨碍评估这条路线，不需要重新发明 Nanite 的层级构建。

但现有 Nanite PS 仍依赖原子可见性写入。若要彻底摆脱 64 位原子，
必须改为固定功能深度测试与整数颜色输出，再对接消费者。
深度完全相同时的 ID 决胜规则也可能不同于 packed max，需制定并验证规则。
这条路线能保留真实 cluster LOD 和流送，但不能承诺原微三角形性能。

### C：两遍方案的正确性条件

第一遍求深度，第二遍在同深度候选中求 ID，不能把两个通道无条件同时 atomicMax。
本机探针证明了有限候选集合的归约正确性；真正光栅化还须保证两遍使用同一
变换、裁剪、采样覆盖、WPO/时间输入和可见 cluster 列表。
主剔除/后剔除、软件/硬件来源也必须遵守同一合并规则。

不采用每像素自旋锁或假设跨工作组全局屏障。
必要的全局阶段边界应通过 pass/dispatch 顺序表达。[S2]
两份 u32 仍为每像素 8 字节，不能宣称可见性存储减半。

## 当前工程可复用与仍缺失的部分

| 子系统 | 当前证据 | 下一步 |
| --- | --- | --- |
| GPUScene | 桌面能力已启用并有既有场景验证 | 复用实例体系，验证 Nanite 实例与 primitive 映射 |
| 顶点访问 | LocalVF 手动读取已有实验实现，默认关闭且旧 AB 回退 | Nanite 单独验证 cluster 解码，不全局启用 LocalVF 实验 |
| Wave/Subgroups | 浏览器暴露 subgroups；DDPI 仍为 Unsupported | 逐个验证 ballot、shuffle、prefix、lane 宽度和一致控制流 |
| 持久线程剔除 | UE 已有非 persistent 分层间接 dispatch 分支 | 优先 `r.Nanite.PersistentThreadsCulling=0`；审计仍存在的统一断言 |
| 间接绘制 | Web RHI 已实现 `RHIDrawPrimitiveIndirect` | 验证 Nanite 参数布局、绑定数与材质分桶；不逐 cluster CPU 发 draw |
| 可见性消费者 | Composition、Shading、DepthExport、ExportGBuffer、HZB 均读旧布局 | 建立统一 buffer/纹理接口，连同清理、可视化和速度一起迁移 |
| 资源能力 | `bSupportsNanite=false`、UInt64 image atomics=false | 分离 Cook 能力、设备协商和 Web 局部实现，禁止伪报 |
| 资产保留 | Nanite 资源序列化及 fallback 受目标平台能力影响 | 独立 Cook，核对真实根页、流送页、层级、DDC 与 fallback |
| 流送 | 已有 BulkData/OPFS；UE Nanite 自带请求、页依赖、安装与回读管理 | 复用页协议，接异步浏览器 IO、GPU 回读、淘汰、缺页恢复 |
| 材质 | 现有桌面材质链可复用，Nanite 分桶/着色尚未接通 | 首期静态不透明材质，使用非 bindless/非 Work Graph 路径 |
| VT/VSM、Lumen、TSR | 已有相关适配与测试记录 | 非 Nanite VSM 成功不代表 Nanite 阴影页路径已通；联动单独验收 |

非 persistent 分层剔除代码见 `NaniteCullRaster.cpp:4575`，
无需一开始移植跨工作组持久任务队列。其附近仍有
`GRHIPersistentThreadGroupCount > 0` 检查，不能只设 CVar 就认定 Web 已可运行。

首期内容范围建议为静态、不透明、普通三角形网格和受控材质集合。
蒙皮、植被/体素、曲线、细分/位移、复杂 WPO、透明及完整多视图后续逐项验证。
不要求先开放全部 SM6 能力，也不把已有 SM5 名称作为排除算法的唯一依据。

## 外部实现可参考什么

| 项目 | 已公开的做法 | 不能据此声称 |
| --- | --- | --- |
| `Scthe/nanite-webgpu` | WebGPU cluster LOD、实例/meshlet 剔除、硬件/软件光栅 | 作者明确未实现流送、淘汰、压缩、完整 visibility buffer；软件分支无纹理材质，不是 UE 5.8 完整移植 |
| `apollo-2006/colossus` | 自建虚拟几何；其 Web 说明采用普通图形管线、两遍计算光栅和 HTTP Range 页流送 | 自定义格式/构建器和材质，不能直接读取本项目 UE Cook；作者性能数字不是本项目验证 |

两项目 README 中“WebGPU 无 64 位原子”的概括都需要结合新可选特性修正。
本轮只查阅源码仓库与作者说明，没有运行其 demo，也不采用其 FPS/毫秒数作为预算。[S5][S6]

## 推荐推进顺序与验收

1. **编译闭环**：用真实 UE 最小可见性 shader 打通 Web 原语转换、反射和 RHI 绑定；
   同深度决胜、片元/计算合并与只读消费都正确。当前仅独立 WGSL 探针通过。
2. **真实资产闭环**：保留并解码一个 UE Nanite 高密度资产，
   接通 GPU 层级 LOD 与剔除，先走 VS/PS 路径、固定不透明材质。
   可临时全页驻留排查，但必须标为中间检查点。
3. **微三角形与材质**：加入 Compute 光栅，与硬件路径统一可见性，
   接通原有材质/GBuffer、深度/HZB、速度；与原生相同机位比较。
4. **流送闭环**：受限页池、真实缺页、淘汰/重新进入、依赖/fixup、冷/热缓存、
   相机瞬移、请求取消、设备恢复。必须证明原生页协议在浏览器工作。
5. **场景与兼容性**：默认带灯光天空的关卡回归，再测高密度资产和别墅；
   Chrome 新原子与无扩展兼容构建分别列出质量、CPU/GPU 帧耗时和峰值内存。

若最小 UE 编译转换不能闭环，应先解决该阻塞或用 B 路线推进消费者，
不批量开启所有 Nanite permutations。
若 C 的重放成本过高，保留普通网格/LOD 交付，不能静默降低深度或 ID 精度。

收益重点是高密度几何、实例剔除与细粒度 LOD/流送。
目前没有证据证明当前别墅必然更快，也不承诺修复硬件 Lumen 镜面差距。
需要记录可见 cluster/三角形数、材质桶数、绑定与 dispatch 数、页池峰值、
页面请求延迟、完整帧耗时；源资产总三角形数不能代替性能证据。

## 复现与边界

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node --check tests/web-platform/probe-nanite-visibility.cjs
node tests/web-platform/probe-nanite-visibility.cjs
```

脚本同时记录固定 Tint 的四步转换结果；SPIR-V 读回失败保留为独立已知阻塞。
本轮新增调研、探针、WGSL 样本和结果，不修改引擎能力、Cook 配置、发布包、
原项目资产或 `H:/UE_5.8`。没有构建完整 UE Nanite，也没有跨 GPU/系统测试。

## 一手资料

在线资料于 2026-11-06 核对；规范页面版本为 2026-10-30。

- [S1] WebGPU 编辑草案，§25.25：
  `https://gpuweb.github.io/gpuweb/#dom-gpufeaturename-atomic-vec2u-min-max`
- [S2] WGSL 编辑草案，enable 扩展、原子类型、atomicStoreMax 与内存模型：
  `https://gpuweb.github.io/gpuweb/wgsl/`
- [S3] Epic Nanite Virtualized Geometry：
  `https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-in-unreal-engine`
- [S4] Epic Nanite Technical Details，fallback、精度、流送池及 cluster 容量：
  `https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-technical-details`
- [S5] 作者仓库与 README：
  `https://github.com/Scthe/nanite-webgpu`
- [S6] 作者仓库 README 的 “in the browser”：
  `https://github.com/apollo-2006/colossus`
- [S7] Epic 作者的 Nanite 深入讲座索引：
  `https://advances.realtimerendering.com/s2021/`

## 本地源码与既有记录

- [L1] `reference-engine/Engine/Platforms/Web/Config/DataDrivenPlatformInfo.ini:25`；
  `reference-engine/Engine/Source/Runtime/RenderCore/Public/WebShaderPlatform.h:116`；
  `reference-engine/Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp:1292`。
- [L2] `reference-engine/Engine/Shaders/Private/Nanite/NaniteWritePixel.ush:20`；
  `reference-engine/Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShared.cpp:157`；
  同目录 `NaniteCullRaster.cpp:4575`、`:6604`。
- [L3] `reference-engine/Engine/Shaders/Private/Nanite/NaniteDepthExport.usf:36`；
  同目录 `NaniteExportGBuffer.usf:23`、`NaniteDataDecode.ush:902`；
  `reference-engine/Engine/Source/Runtime/Renderer/Private/Nanite/NaniteComposition.cpp:54`、
  `NaniteShading.cpp:1551`。
- [L4] `reference-engine/Engine/Source/Runtime/Engine/Private/Rendering/NaniteStreamingManager.cpp:2281`；
  `reference-engine/Engine/Source/Runtime/Engine/Private/StaticMesh.cpp:209`、`:2585`；
  `tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat/Private/WebGPUShaderFormat.cpp:1129`。
- [L5] `UE58_WEBGPU_GPUSCENE.md`、`UE58_WEBGPU_MANUAL_VERTEX_FETCH.md`、
  `UE58_WEB_VIRTUAL_RESOURCES.md`、`UE58_WEBGPU_LUMEN.md`。
- [L6] 本轮探针、WGSL 样本及 evidence JSON，报告的时间、二进制与源码 SHA-256 可核验。
