# 大型 WebGPU 实现源码对照（2026-11-01）

后续实现与实测见 [Web SM5 GPUScene 接入与验证](UE58_WEBGPU_GPUSCENE.md)：GPUScene 已在候选包启用，保留原项目设置，四轮 ABBA 从 12.05 提升至 19.90 FPS。下文对 GPUScene 关闭的描述对应研究时的旧正式包。

本轮已拉取并阅读四套引擎的实际源码及相关已合并 PR。结论是：优先补齐 UE 既有的持久对象数据和实例提交路径，并把绑定更新移到状态发生变化的位置。现有逐 draw 解析之后再查缓存的方案仍会付出大量 CPU 成本，继续扩大缓存或录制更多 Bundle 的依据不足。

这是一轮源码与既有捕获的交叉调查，没有产生新的帧率 A/B，也没有修改项目质量设置或启用尚未实现的能力。上一轮测试中用户要求保留另一大型游戏运行，该干扰说明仍适用。

## 已拉取的参考实现

源码保存在 `tests/web-platform/build/research/`，采用浅克隆和稀疏检出，不并入本项目源码。下列链接固定提交，便于复查。

本轮核对结果保存在 `tests/web-platform/results/webgpu-implementation-comparison.json`，包括四个提交号、旧捕获的每帧 API 次数、pass draw 数及正式包能力/桥接代码核对结果。

| 引擎 | 固定提交 | 阅读重点 | 对当前 UE 后端的参考价值 |
| --- | --- | --- | --- |
| [DiligentCore](https://github.com/DiligentGraphics/DiligentCore/tree/f1a3a110e43337d46d691b3a55e911eb695499f9/Graphics/GraphicsEngineWebGPU) | `f1a3a110e43337d46d691b3a55e911eb695499f9` | C++ WebGPU 资源组、提交脏标记、动态内存 | 与当前 C++ RHI 到 WebGPU C API 的结构最接近，适合对照绑定更新生命周期 |
| [PlayCanvas](https://github.com/playcanvas/engine/tree/4b496a2a1c5892b6f8198a2ec7aef0009b4447cc/src/platform/graphics/webgpu) | `4b496a2a1c5892b6f8198a2ec7aef0009b4447cc` | 持久对象 storage、按材质/视图分组、近期 CPU 优化 PR | 能解释如何从上层减少每 draw 数据绑定，而非仅优化单次 API |
| [Babylon.js](https://github.com/BabylonJS/Babylon.js/tree/1b26881f8120797f5726b4aa23eaa16e62c479fe/packages/dev/core/src/Engines/WebGPU) | `1b26881f8120797f5726b4aa23eaa16e62c479fe` | draw/material dirty、稳定 UBO 身份、Bundle 快速路径 | 可对照当前 Bundle 为何命中后仍有很大整理成本，以及资源身份变化与内存增长 |
| [Three.js](https://github.com/mrdoob/three.js/tree/fa01dd6ad164c48554f1bb9456f6500db052ec4f/src/renderers/webgpu) | `fa01dd6ad164c48554f1bb9456f6500db052ec4f` | render object 绑定版本、encoder 当前状态、资源回收 | 适合核查状态缓存边界、绑定重建与 buffer 内容更新是否被混在一起 |

## 1. Diligent：已有绑定对象带脏标记，draw 只提交变化的部分

[ShaderResourceCacheWebGPU.cpp:519](https://github.com/DiligentGraphics/DiligentCore/blob/f1a3a110e43337d46d691b3a55e911eb695499f9/Graphics/GraphicsEngineWebGPU/src/ShaderResourceCacheWebGPU.cpp#L519) 的 `UpdateBindGroup()` 仅在 handle 不存在或 `m_IsDirty` 时创建绑定组。描述数组已经保存在资源缓存内。buffer 内容更新与 handle/范围变化分开处理。

[DeviceContextWebGPUImpl.cpp:226](https://github.com/DiligentGraphics/DiligentCore/blob/f1a3a110e43337d46d691b3a55e911eb695499f9/Graphics/GraphicsEngineWebGPU/src/DeviceContextWebGPUImpl.cpp#L226) 的 `CommitBindGroups()` 按 SRB mask 选择需要处理的资源签名，并区分资源组失效与动态偏移变化；两者都未变就不绑定。`PrepareForDraw()`（2087 行）先检查 PSO、顶点缓冲等 encoder 状态，再按 commit mask 调用它。

我们已有 encoder 状态去重和单项 prepared descriptor 缓存，但 `CreateGroups()` 每次仍遍历 shader 绑定：解析资源来源、检查版本、组装 entries、整理动态偏移，再比较上次的组或计算哈希。即使最终没有创建新的 GPU 绑定组，这些 C++ 工作也已经发生。Diligent 的可借鉴处是把稳定资源组保存为可直接提交的状态，在资源修改入口标记失效，draw 只更新必要的动态部分。

实现约束：不能仅用“上次 RHISetShaderParameters 没调用”判定资源不变。UE 的纹理引用可由 streaming 更换，uniform 内容可更新，pass/附件访问约束会改变，SingleFrame 页也会在下一帧重用。需要覆盖这些失效来源，并保留当前重算验证路径。

其 [DynamicMemoryManagerWebGPU.cpp:99](https://github.com/DiligentGraphics/DiligentCore/blob/f1a3a110e43337d46d691b3a55e911eb695499f9/Graphics/GraphicsEngineWebGPU/src/DynamicMemoryManagerWebGPU.cpp#L99) 也使用 CPU 数据页和合并 `wgpuQueueWriteBuffer`。这与上一轮合并常量上传方向一致，说明该方向有实际引擎参照；它不是剩余整帧瓶颈已经解决的证据。

## 2. PlayCanvas：对象数据持久化，材质和视图按各自频率绑定

已合并 [PR #9614](https://github.com/playcanvas/engine/pull/9614) 将对象矩阵保存在持久 storage buffer 的稳定槽位，只上传脏范围，由 instance index 读取。相关实现为 [renderer.js:1250](https://github.com/playcanvas/engine/blob/4b496a2a1c5892b6f8198a2ec7aef0009b4447cc/src/scene/renderer/renderer.js#L1250)。同一对象跨 pass 不必重新构造一份对象矩阵绑定。

[forward-renderer.js:330](https://github.com/playcanvas/engine/blob/4b496a2a1c5892b6f8198a2ec7aef0009b4447cc/src/scene/renderer/forward-renderer.js#L330) 在材质切换时设置材质绑定组，view 与 mesh 数据另有各自更新路径。这比“所有资源按 shader 阶段混合，每个 draw 再组装一次”更利于复用。2.23.0 的 [实际发布记录](https://github.com/playcanvas/engine/releases/tag/v2.23.0) 包含相应 PR。

PR 作者在其 Chrome/Apple silicon 箱体基准中报告：10K 静态对象的 CPU 帧时间 14.37→8.31 ms，全移动时 19.87→15.18 ms。这是上游特定基准，未在本机复现，不能换算成 TriplexHouseVilla 的预期收益。

这使本项目一个更大的路径差异变得明确：**当前 Web 平台禁用了 UE GPUScene**。

- `reference-engine/Engine/Source/Runtime/RenderCore/Public/WebShaderPlatform.h:112` 的 `SupportsGPUScene()` 对 Web 返回 false。
- `RenderCore/Private/RenderUtils.cpp:1798` 的 `UseGPUScene()` 在此处提前返回 false。
- `tests/web-platform/platform-extension/Config/DataDrivenPlatformInfo.ini:76` 的 SM5 平台能力也为 false；正式包实际 `config-files.json` 中相同。
- 实际 Cook 报告 `tests/web-platform/results/web-project-triplex-project-desktop-cook-results.json` 中 `gpuSceneEnabled=false`，与源码和正式包一致。
- `Renderer/Private/MeshDrawCommands.cpp:1750` 在 GPUScene 可用时走 `InstanceCullingContext.SubmitDrawCommands()`；当前走后面的 `SubmitMeshDrawCommandsRange()` 路径。

UE 已有 GPUScene、PrimitiveId、InstanceCulling 和 MeshDrawCommand 等结构，应先审计并补齐 Web 后端对它们的支持。PlayCanvas 的方案帮助确认“持久对象数据和稳定索引”值得研究，UE 的实现应复用自身系统。

这属于后端能力实现，不是要求用户调整画质。不能只把 `bSupportsGPUScene` 改 true：还需验证 shader storage/SRV、PrimitiveId、顶点工厂、GPU 上传与散写、间接参数/实例 ID、原生剔除和多 pass 资源版本。它会改变 shader 编译结果，需要重新 Cook 和画面/移动回归。本轮保留原能力声明。

### 已排除一个看似适用、实际已经具备的优化

[PlayCanvas PR #9487](https://github.com/playcanvas/engine/pull/9487) 使用 `Uint32Array` 加明确起止范围调用 `setBindGroup()`，避免 JS sequence 转换；无动态偏移时只传两个参数。

已检查我们实际发布的 `UEWebEngineThreads.js`，`_wgpuRenderPassEncoderSetBindGroup()`（7782 行）和 compute 对应函数已经如此：无偏移传两个参数，有偏移使用 `HEAPU32`、起始下标和数量的五参数重载。这个已合并优化在当前 emdawnwebgpu 桥接层已具备，不能重复修改并声称获得同样收益。

## 3. Babylon：Bundle 快速路径依赖稳定的 draw 身份和资源

[webgpuCacheBindGroups.ts:98](https://github.com/BabylonJS/Babylon.js/blob/1b26881f8120797f5726b4aa23eaa16e62c479fe/packages/dev/core/src/Engines/WebGPU/webgpuCacheBindGroups.ts#L98) 在 draw/material context 都未变时直接返回已保存的绑定组数组，连全局缓存查找也跳过。

[webgpuEngine.pure.ts:3976](https://github.com/BabylonJS/Babylon.js/blob/1b26881f8120797f5726b4aa23eaa16e62c479fe/packages/dev/core/src/Engines/webgpuEngine.pure.ts#L3976) 的 fastBundle 分支可以在获取绑定组之前直接重放已有 Bundle；draw 参数变化可通过 indirect buffer 处理。我们的实验先运行 `CreateGroups()`、组合资源和动态偏移的完整键，再知道能否命中 Bundle，因此保留了已知的一块主要 CPU 成本。两种实现不能只按“都用了 Bundle”判断是否等价。

已合并 [PR #18880](https://github.com/BabylonJS/Babylon.js/pull/18880) 修复了按绘制顺序分配 UBO 导致资源身份不断变化、绑定组组合增长的问题。现在按 draw context/UBO 关联持有槽位，使用 generation 跳过无变化上传，并处理同帧不同内容的额外槽位。实现见 [uniformBuffer.ts:740](https://github.com/BabylonJS/Babylon.js/blob/1b26881f8120797f5726b4aa23eaa16e62c479fe/packages/dev/core/src/Materials/uniformBuffer.ts#L740)。

这与本项目“相机改变、绘制顺序改变后，页偏移及资源组合变化”的问题相似，但不是已证明同一个内存泄漏：我们有 8192 项上限和帧末淘汰。应量化的是存活集合、创建/淘汰速率以及常量槽位稳定性。稳定槽位也可能提高固定显存占用，不能为增加命中率改成每对象无限保留 buffer；同一对象同帧多次改变内容时仍须保存不同快照。

## 4. Three.js：资源版本与 encoder 状态分别缓存

[WebGPUBackend.js:2042](https://github.com/mrdoob/three.js/blob/fa01dd6ad164c48554f1bb9456f6500db052ec4f/src/renderers/webgpu/WebGPUBackend.js#L2042) 的 `_draw()` 比较当前 pipeline、native bind group、index 和 vertex buffer，只在变化时发出 set 调用。绑定资源更新由 [Bindings.js](https://github.com/mrdoob/three.js/blob/fa01dd6ad164c48554f1bb9456f6500db052ec4f/src/renderers/common/Bindings.js#L451) 处理，buffer 内容更新、资源 generation 改变与绑定组重建分开。

我们已经有 encoder 内的相似去重，因此“再加一层同样的状态缓存”不是新的突破口。可以借鉴的是：持久 binding 对象及其版本先准备好，draw 消费结果，避免把全部解析塞回 draw。Three.js 上层仍会检查 bindings，不能将其描述成所有资源检查都完全消失。

## 与当前捕获的交叉核对

使用上一轮保存的 `performance-capture-webgpu-worker-snapshot-final.json` 重新统计，窗口含 55 个呈现帧。以下是 API 插桩期间的调用数量，不是新的性能 A/B；首尾帧可能有部分边界误差。

| 项目 | 平均每呈现帧 |
| --- | ---: |
| `drawIndexed` | 6089.5 |
| `setBindGroup` | 7790.7 |
| `setVertexBuffer` | 11230.7 |
| `createBindGroup` | 557.4 |
| `WholeSceneShadowmap` 中的直接 draw | 3929.9 |

该窗口 render pass 中直接 draw 合计 337538 次，其中 `WholeSceneShadowmap` 为 216146 次，约 64.0%。多 pass、阴影 caster 和对象提交路径因此是高价值调查点。标签统计不能证明某个阴影 pass 多余，也不能直接拿它与旧截图桌面 `Draws=1601` 相减归因；原生端尚缺同分辨率、同视角、同资源状态的逐 pass 捕获。

## 后续实现顺序与验收点

1. **先审计 UE GPUScene 的 Web 阻断点**。记录当前 Primitive uniform/对象数据更新、direct/indirect draw、可合并 mesh command 数量，以及各 shadow pass 的更新原因；补齐后端能力后接回 UE 原生路径。以同画面、相同输入序列的 direct draw 与绑定次数下降作为第一层证据，再看 RHI 时间和帧率。不能把减少功能当成该路径优化。
2. **按 Diligent/Babylon 的方式整理绑定生命周期**。在 shader/pipeline 准备时建立绑定计划；资源修改时更新版本，稳定组直接提交；纹理引用、uniform、pass 访问和页重用都进入失效机制。继续用重算模式核对描述，观察 `CreateGroups` scope 的绝对耗时、解析项数及资源组重建数量。
3. **稳定资源身份后再评估 Bundle**。让持久 mesh command/draw 对象能决定是否直接复用，避免先完成每 draw 解析才命中；动态内容保留原 UE 快照语义。用移动、遮挡、shadow pass、材质变化、streaming、资源销毁/重建和显存稳态共同验收。当前实验继续默认关闭。

这三项是根据源码差异及现有采样提出的实施优先级，并非已经测得的收益。可先落地的 encoder 去重、布局共享、合并上传已有实现；尚未恢复的 UE 提交能力和每 draw 解析工作，才是本轮调查确认的主要差距。
