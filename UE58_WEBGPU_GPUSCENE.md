# Web SM5 GPUScene 接入与验证（2026-11-01）

状态：完整 Cook、打包、两轮浏览器操作测试及同视角 ABBA 性能测量均已通过。

对应参考引擎本地提交：`979705eea`（启用桌面 Web GPUScene 并适配实例剔除的 WebGPU 限制）。

## 路径与项目设置

原正式包的 Cook 清单和浏览器 `P3_ENGINE_READY` 都记录 GPUScene 为 false。Web 后端同时存在三处排除：`WebShaderPlatform.h::SupportsGPUScene` 返回 false、SM5 平台能力表关闭 GPUScene/顶点 SRV、`GPUScene.cpp::ConstructDefault` 在 Web 上清空默认资源。

候选修改启用桌面 SM5 的 GPUScene 和顶点 SRV，恢复 UE 原有的默认结构化缓冲区。`UseGPUScene`、LocalVertexFactory 的 primitive ID stream、GPUScene 上传、InstanceCulling 和 MeshDrawCommands 继续使用引擎实现。没有另写一套场景或实例管理器。

手动顶点读取仍按平台已有能力决定。GPUScene 的结构化 SRV 与 typed 顶点读取是不同能力，修正了 PositionVertexBuffer、StaticMeshVertexBuffer 及 RHI 默认顶点视图中将二者绑定的检查。

Cook 使用 `-UseProjectSettings`，保留原工程的距离场和所有质量设置；`rendererOverrides=[]`。ES3.1 保持独立的能力表。实验 RenderBundle 缓存继续使用原默认值 0。

## 新路径暴露的着色器兼容问题

### 无效调试实例的 NaN 坐标

`FInstanceCullingOcclusionQueryDebugVS` 用 `asfloat(0xFFFFFFFF)` 隐藏无效实例，触发当前 Tint 的 `TINT_ASSERT(std::isfinite(v.value))`。保留失败的 SPIR-V 后，仅将其中一个 NaN 常量换成有限值，Tint 即返回 0。Web HLSL 分支改为输出 `float4(2,2,2,1)`，使无效调试几何落在裁剪体外；其他平台保留原逻辑。

首次失败记录：`results/web-project-triplex-project-desktop-cook-20261101-143020.log`，着色器目录 `ShaderConversion/9F6596D34ED17E04FAF73E84C884E716`。

### 多视图遮挡查询 VS 的可写存储声明

`FInstanceCullingOcclusionQueryVS/1` 从 `RWVisibilityMask` 读取旧掩码，Tint 因顶点阶段使用 read_write storage 拒绝转换。Web VS 只传当前 view mask，旧掩码在已经写该缓冲区的 PS 阶段合并；计算阶段原有的清理与确定可见性步骤保留。其他平台的 VS/PS 路径不变。

失败记录：`results/web-project-triplex-project-desktop-cook-20261101-144136.log`，目录 `ShaderConversion/D2DAA5DA4341EA463F9DADBF8013020B`。

### Tint 将非一致地址误转换为 workgroupUniformLoad

`FBuildInstanceIdBufferAndCommandsFromPrimitiveIdsCs/0` 在前缀最大值计算中对每个线程的 `ItemIndex[ElementIndex]` 读取，触发 `workgroupUniformLoad requires argument 0 to be uniform`。

当前固定版本 Tint 的 [ReplaceWorkgroupBarrier](https://dawn.googlesource.com/dawn/+/c943ea32b614ff53e4fe410fc8f4968b6b8fe46d/src/tint/lang/wgsl/writer/raise/raise.cc) 直接把相邻 barrier/load/barrier 合并，没有检查地址是否一致。UE 此处的下标来自线程索引。

Web 分支省略读自身元素后的重复屏障：下一步 `PrefixMaxStep` 已在任何共享写入之前对所有线程同步，因此初始读取和邻居读取仍在写入之前完成。这也避免了 Tint 错误合并。64 个实际实例剔除绘制命令变体已通过转换。

失败记录：`results/web-project-triplex-project-desktop-cook-20261101-144454.log`，目录 `ShaderConversion/B777178C4CD3993B5F750DBF3DBC3CBF`。

所有 shader 改动均在参考引擎中保存，并由 `prepare-web-cook-shaders.cjs` 对照安装版逐处校验后复制到隔离 Cook 目录。

## 浏览器暴露的 RHI 兼容问题

- `FSinglePrimitiveStructured::InitRHI` 原 Web 分支假设 GPUScene 永远关闭。SM5 改为走 UE 原有初始化；ES3.1 的兼容路径保留。
- GPUScene 的 primitive/instance ID 顶点流使用 `VET_UInt`，补齐与 DX `R32_UINT` 对应的 WebGPU `uint32` 格式。
- `SetDrawBindings` 原来校验并绑定全部历史顶点流。GPUScene 将上一绘制使用的 InstanceIdOffsetBuffer 转作计算 SRV 时，未使用的旧流也被错误校验为 Vertex。现在按当前 PSO 的 `VertexStreamMask` 处理实际使用的流。
- 本机 RTX 4090 浏览器适配器实际最多支持每阶段 16 个 storage buffer，而 UE 的部分批处理实例剔除计算变体需要 17～18 个。Web 分支把 `ViewIds`、`BatchInfos`、`BatchInds` 三块 CPU 只读元数据打包为一个 ByteAddressBuffer，减少两个绑定；保留 UE 的负载均衡、GPUScene 读取、遮挡查询及保序压缩算法。延迟路径仍在异步批次合并之后准备数据。其他 RHI 使用原缓冲区。

## 验证方法

构建使用隔离的 Web 构建主机和本地 RenderCore/Renderer Cook DLL，构建报告检查安装版引擎输入未被修改。

运行验证同时检查 Cook 清单 `gpuSceneEnabled` 与浏览器 `P3_ENGINE_READY.activeGPUSceneEnabled`。新增实际 draw、间接 draw、dispatch 累计计数；描述符重算校验和 Game/Render/RHI 三线程检查沿用现有工具。

GPUScene 改变着色器约定，必须重新 Cook。A/B 工具新增显式 `--allow-gpuscene-recook`，要求提供两份 Cook 报告；验证相同项目、地图、输入文件、项目设置及运行时设置，只允许 SM5 的两个平台能力项不同。默认的严格同 content/config SHA 检查仍保留。

性能测量使用原出生相机、1863×1030 CSS、DPR 1.25、相同内部渲染尺寸，并忽略外部输入。顺序为旧/新/新/旧，预热 20 秒后各测 15 秒。另一大型游戏按用户要求继续运行，结果存在资源竞争，不能视作独占机器的绝对性能。

旧包没有发布计数所属的帧号，因此其绑定计数按实际测量帧数估算；新包用计数快照自身的帧号计算。RHI 时间与 FPS 单独测量，不将 GPU pass 时间求和当作整帧 GPU 时间。

## 已完成验证

- 隔离 Web WASM、原生 RenderCore 和 Renderer 均编译成功，安装版引擎输入的 SHA 校验通过。
- `20261101-153940` 完整 Cook 通过，`gpuSceneEnabled=true`、`shaderFailures=[]`；项目设置 JSON 的 SHA256 与旧包相同：`4d5d741f4f65ee9345f3be5804835d8134225bf4cfe9e1095b170b20d77ca16a`。
- 64 个实际 `FBuildInstanceIdBufferAndCommandsFromPrimitiveIdsCs` 变体全部转换成功，storage buffer 最大为 16。未使用视图或批次的变体会由编译器移除无用的元数据绑定。
- 浏览器 `P3_ENGINE_READY` 确认 `webGPUSceneEnabled=true`、`activeGPUSceneEnabled=true`、SM5、`nullRHI=false`。
- 两轮各 45 秒的移动、转向、跳跃、窗口缩放、诊断快照及绑定重算校验通过，最后分别到达第 567、603 帧。Game/Render/RHI 实际线程 ID 为 2/14/1。
- 新增计数记录了实际间接绘制；统计调用拆成两个 `EM_ASM`，避免当前工具链只为前 16 个参数生成 JS 形参的问题。

本地证据：`tests/web-platform/results/gpuscene-after-cook-results.json`、`gpuscene-packed-storage-bindings.json`、`project-gameplay-gpuscene-gameplay-v5.json`。候选网页为 `http://127.0.0.1:8765/build/villa-gpuscene-candidate/index.html`，原正式包保留用于对照。

## 同视角性能结果

ABBA 包含启用 GPUScene 所必需的顶点格式、流绑定和着色器兼容修复，衡量的是完整候选实现的效果，没有逐项做消融实验。所有轮次使用相同浏览器诊断脚本；性能阶段不开绑定校验、API 计数/计时或 CPU 采样。诊断钩子仍安装，故这些值是该测量工具下的结果。

| 顺序 | GPUScene | FPS | RHI 工作 ms/帧 |
| --- | --- | ---: | ---: |
| 旧包 1 | false | 11.679 | 69.658 |
| 新包 1 | true | 20.212 | 36.564 |
| 新包 2 | true | 19.578 | 37.980 |
| 旧包 2 | false | 12.424 | 66.009 |
| 旧包合并 | false | **12.052** | **67.775** |
| 新包合并 | true | **19.896** | **37.259** |

FPS 按总帧数/总测量时间合并，提升 **65.08%**；RHI 工作时间按测量帧数加权，下降 **45.02%**。每轮均通过相机、渲染尺寸及设置一致性检查，错误列表为空。同视角截图目视未见几何、材质或阴影缺失。

绑定计数快照显示旧包约 574～621 次新建 BindGroup/帧，新包约 66～72 次；旧包窗口帧数为估算，不能作精确逐帧百分比。新包 RHI 实测约 3190～3251 次绘制/帧，其中约 94～100 次是间接绘制。调用级明细另用独立插桩记录，插桩帧率不混入上表。

对照报告：`tests/web-platform/results/gpuscene-abba.json`；四轮原始报告及同视角 PNG 位于 `performance-capture-gpuscene-abba-*`。后台 `cod.exe` 保留运行，抽样时整机 GPU 利用率约 95%～99%、总显存占用接近 18～23GB，记录见 `gpuscene-performance-environment.json`、`gpuscene-gpu-samples.csv`。这是有资源竞争的单机结果，不能视作独占机器的绝对性能。

这一轮确认 GPUScene 接入带来了明显改善，但约 20 FPS 仍远低于桌面端的 147 FPS。后续判断应继续依据新的调用分布与 CPU 性能图，而不能认为开启 GPUScene 就解决了全部瓶颈。

## 调用与 CPU 性能图

另外分别录制旧包、新包的 5 秒 API/pass 插桩、18 个 Worker CPU profile、浏览器时间轴和三个 GPU 帧。这些阶段存在可测量的录制开销，不用于上面的帧率比较。

| 实际 WebGPU API 调用/帧 | 旧包 | 新包 |
| --- | ---: | ---: |
| 绘制合计（直接和间接） | 6134.2 | 3145.0 |
| drawIndexed | 6084.7 | 3008.9 |
| drawIndexedIndirect | 2.0 | 88.3 |
| setBindGroup | 7782.3 | 1403.6 |
| createBindGroup | 522.8 | 80.1 |
| setVertexBuffer | 11197.4 | 8008.5 |

GPUScene 接入后减少了约 48.7% 的绘制调用、82.0% 的 setBindGroup。收益最大的是 `WholeSceneShadowmap`，绘制从约 3929.9 降至 1439.3/帧；`SceneColor` 从 543.3 降至 294.2；`SceneDepthZ` 从 839.3 降至 597.2。`ShadowDepthAtlas` 仍约 487/帧。pass CPU 范围含 C++ 命令编码且有插桩成本，不能把其中差值直接当作未录制时的 CPU 节省。

候选 RHI 采样去除 idle 后的靠前热点仍有 `CreateGroups`、`ResolveBinding`、`ResolveUniform`、`SetDrawBindings`、`setVertexBuffer` 和 `setIndexBuffer`。当前每帧仍有约 8000 次 setVertexBuffer，绑定解析与跨 WASM/JS 调用仍值得继续调查。采样包含等待，父子调用不能累加；后台游戏占满 GPU，三个 GPU pass 合计波动很大，不能据此给出独占 GPU 总帧耗时或归因全部剩余差距。

可交互查看：[旧包火焰图](http://127.0.0.1:8765/results/performance-capture-gpuscene-baseline-profile.html)、[新包火焰图](http://127.0.0.1:8765/results/performance-capture-gpuscene-candidate-profile.html)。原始 `.cpuprofile`、浏览器 trace 和汇总 `gpuscene-profile-comparison.json` 都在本地 results 目录。

同视角 PNG 的平均逐通道绝对差为 0.886/255；旧包自身两轮为 0.725/255，新包自身两轮为 0.784/255。该数值和目视检查支持出生视角未见明显画面回退，不等于整个关卡的逐像素一致性证明。见 `gpuscene-scene-comparison.json`。

## 当前边界

本轮验证设备为 RTX 4090、Edge，适配器支持每阶段 16 个 storage buffer；新的最复杂实例剔除 shader 需要 16 个。没有验证只提供 8 个绑定的设备。ES3.1 的 GPUScene 能力仍为 false，距离场及所有项目质量项保持原值。没有把未知设备的兼容性等同于本机通过。

原始工程 `G:/UE_HTML/TriplexHouseVilla` 与安装版 `D:/UE_5.8` 未改动。Cook、覆盖源码、DLL 和输出包都在工作区隔离目录中。Cook 失败重试的恢复检查已覆盖 `web-project-*-cook` 快照，仍要求主机路径及产品 SHA 匹配。

本候选已实测减少别墅关卡的绘制和绑定调用。剩余引擎机制的接入差距、源码依据及建议顺序见 [UE 引擎机制复用审查](UE58_WEBGPU_ENGINE_REUSE_AUDIT.md)。
