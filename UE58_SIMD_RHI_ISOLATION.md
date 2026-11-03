# SIMD、绑定准备与线程竞争独立对照

2026-11-03。沿用此前脱离 UE 的 DX12 / 原生 Dawn / 浏览器 WASM64 WebGPU 程序，新增准备数据、缓存命中、分配、共享锁、流水线及多线程录制的拆分测试；同时为正式 UE 场景建立独立 SIMD Target。项目画质、Cook 和普通页面默认设置不变。

## 测试边界

`rhi-isolation-common.h` 是不依赖 UE 的算法模型，参考当前 `CreateGroups` 的版本检查、逐字段 key 比较、哈希及资源路由，输出相同 draw packet。**不是将 UE 原函数完整搬出引擎**：未包含 UE 的 JSON、TArray/TMap、资源引用计数、转换屏障和真实资源表。因此能比较这类操作在 native / WASM 的成本，不能直接声称测到了 UE 某函数耗时，或已证明 UE 实际持有某把锁。

所有后端编译同一准备代码，每批 3200 个 draw、每组 24 个条目、64 套稳定资源。每个 CPU 输出逐项检查资源、PSO 选择、key 及 checksum，跨后端一致；结果会被消费和检查，避免只测空循环。

| 拆分 | 方法 |
|---|---|
| 已解析绑定 | 直接取得资源及 key，给出准备开销的参考下界 |
| 版本命中 | 版本检查后复用 key；不重新遍历 24 个条目 |
| 失效重建 | 重做路由、字段一致性检查和哈希，复用栈暂存 |
| 临时分配 | 相同重建工作，每 draw 创建/释放结果 vector |
| 共享锁 | 相同资源查找，每条目持有一把共享 mutex；有意构造竞争压力 |
| 不可变映射 | 同一映射并行只读，无共享 mutex |
| 调度空载 | 持久线程池只唤醒并会合，记录其自身开销 |

CPU 采用 1/2/4 个持久工作线程，各自处理固定、不重叠的 draw 区间；10 批预热、60 批记录，逐批验证。共享锁压力测试不代表 UE 当前确实每条绑定都使用该锁；分配测试则会实际经过各平台的 C++/系统分配器。

GPU 测试使用原先相同的两个 PSO、64 个 uniform group / DX12 descriptor table、VB/IB、64×64 RGBA8、1×1 scissor、3200 个三角形 indexed draw。GPU 调用是真实 API，准备模型不是 GPU 模拟器。资源及管线预建，CPU 部分 12 帧预热、60 帧测量，至多三帧后排空队列；分别保存准备、编码、finish/submit、队列等待及整段墙钟。没有 canvas/present/vsync，也不把这些数值换算为别墅 FPS。

四种 GPU 路径：已解析、版本命中、串行重建、一个 producer 提前准备下一帧而 owner 编码当前帧。WebGPU device、group 和 encoder 始终由同一个 owner 使用，未跨 Worker 共享。另有固定状态的两项对照：逐 draw 重复四次绑定，或检查状态后仅在变更时绑定；输出像素相同。这是 `SetDrawBindings` 类状态跟踪的操作模型，未包含真实 UE 的动态偏移及引用计数。

DX12 另测相同的四条 command list 分别用 1/2/4 个线程录制。每条 list 独占 allocator，每帧 GPU 完成后才复用；按原 draw 顺序提交，直接读回并检查实际并行录制的结果。这里每帧排空队列，故墙钟不能与上面三帧批次的墙钟直接比较；可比较该三项内部的录制成本。WebGPU 没有为同一个 device 提供等价的跨 Worker 对象共享接口，没有伪造一个“WebGPU 并行编码”数字。[微软多线程示例](https://learn.microsoft.com/en-us/samples/microsoft/directx-graphics-samples/d3d12-multithreading-sample-win32/)、[WebGPU 对象及时间线](https://gpuweb.github.io/gpuweb/)。

绑定组构建另测每批 80 个 group、1/8/24 个条目，10 批预热、36 批记录。WebGPU 实际创建并释放 group；DX12 把 CPU 描述符复制到预分配的 shader-visible heap，符合 API 不同的资源绑定机制，不能称为相同对象生命周期。WebGPU 此项布局 visibility=None，用于隔离描述符成本，不是具有 24 个真实片元 uniform 的材质负载。

## SIMD 实验

新增 `UEWebEngineThreadsSIMD.Target.cs`，C++ 编译及最终链接均传 `-msimd128`，并使用独立对象目录。保留普通线程 Target 的所有项目配置、断言、`-g2`、最终无 `-O` 的状态；不混入上一轮最终链接 `-O2` 变量。

这是 LLVM 自动向量化实验。UE 显式 VectorRegister 仍走现有 `UnrealMathFPU` 路径，没有同时切换 SSE/NEON；`-msimd128` 并不意味着所有 UE 数学操作已经获得 SIMD 加速。[Emscripten SIMD 说明](https://emscripten.org/docs/porting/simd)。

实际 417 个单元均包含 SIMD flag，优化级别仍为 416 个 `-O2`、一个 Chaos `-O1`；未启用 LTO。`wasm-opt --metrics` 在最终产物中记录到 SIMDLoad、SIMDShuffle、SIMDExtract 等指令，普通 v38 产物没有这些类别。六次机位切换和返回出生点检查通过，未记录 GPU 校验错误、设备丢失或崩溃，截图明暗/阴影保持正确。这是短时验证，不是全场景或长期稳定性验收。

实景按 v38 → SIMD v41 → SIMD v41 → v38 执行，均预热 15 秒、记录 20 秒；相同出生点，CSS 2289×1287、DPR 1，内部 1484×835、输出 2289×1288、AA=4、4 核配置。没有修改 Cook、距离场、光照或其他项目设置。

| 顺序 | FPS | 1% low | RHI work ms | draw / 帧 |
|---|---:|---:|---:|---:|
| v38 | 56.810 | 26.309 | 13.265 | 3151.84 |
| SIMD v41 | 53.709 | 24.424 | 14.181 | 3180.60 |
| SIMD v41 | 37.069 | 4.503 | 19.255 | 3217.98 |
| v38 | 44.667 | 19.229 | 17.322 | 3228.24 |

合并普通 / SIMD 为 **50.738 / 45.389 FPS**，1% low 为 **20.974 / 7.908 FPS**。没有测出可用收益；也不能认定 SIMD 固定回退约 10.5%：普通版本前后自身下降 21.4%，后半段 Sunlogin、ChatGPT、微信等活动增加，尚未证明其与漂移的因果关系。后台程序按用户要求保留，采样区间没有游戏、UE 或编译器进程；这不等于独占 CPU/GPU。每帧 draw 也有约 2.4% 的随时间变化。1% low 为最慢 1% 的 RHI 完成帧间隔均值的倒数，未用屏幕扫描输出代替。完整四轮和全部慢帧保留，不删除第三轮后报收益。SIMD 保留独立候选，默认不启用。

## 三轮独立基准结果

同机 i9-12900K、RTX 4090、Edge 156.0.4314.58。三轮各跑 DX12、原生 Dawn、浏览器 scalar / SIMD、纯 JS 五个后端，顺序正向 / 反向 / 正向，共 15 次；各后端串行测量，没有与构建或实景测试重叠。以下为三轮各自中位数的中位数，单位 ms。原始时间与所有逐批数据均保留。

| 每批 3200 draw 的 CPU 准备模型 | DX12 原生 C++ | Wasm scalar | Wasm SIMD |
|---|---:|---:|---:|
| 重建、复用栈暂存，1 线程 | 0.5285 | 0.5601 | 0.5553 |
| 重建、复用栈暂存，2 线程 | 0.2694 | 0.2900 | 0.2900 |
| 重建、复用栈暂存，4 线程 | 0.1429 | 0.1603 | 0.1649 |
| 重建、逐 draw 分配释放，1 线程 | 0.6407 | 0.6700 | 0.6500 |
| 重建、逐 draw 分配释放，2 线程 | 0.3287 | 0.6252 | 0.6500 |
| 重建、逐 draw 分配释放，4 线程 | 0.1730 | **1.4845** | **1.4899** |
| 每个条目争用同一资源锁，4 线程 | 2.9727 | **9.6502** | 8.6451 |
| 同一映射并行只读，4 线程 | 0.2085 | 0.2051 | 0.2002 |
| 版本命中，1 线程 | 0.0135 | 0.0200 | 0.0200 |

没有分配/共享锁时，这类 C++ 遍历并未出现四倍差距。逐 draw 分配加入后，Wasm 4 线程比其单线程慢 2.22 倍、比原生同为 4 线程慢 **8.58 倍**；SIMD 没有解决它。原生 Dawn 的 CPU 准备模型结果接近 DX12 原生，见证据。后续应优先在真实 UE 的分配器及 RHI 临时对象上插桩，查实际分配次数、分配器等待和可复用暂存；共享锁压力项只证明这种竞争模式代价大，不证明 UE 当前存在同一粒度的锁。

本地 Emscripten 配置默认 `MALLOC=dlmalloc`，共享内存的 dlmalloc 开启锁保护。官方也明确推荐在 malloc/free 多线程争用时比较 `-sMALLOC=mimalloc`；本轮尚未测试替换，不能承诺引擎会获得上述 8.58 倍收益。[Emscripten 分配器说明](https://emscripten.org/docs/optimizing/Optimizing-Code.html#allocation)。

| 真实 GPU API 路径，3200 个变化状态的 draw | DX12 | 原生 Dawn | 浏览器 Wasm | 浏览器 JS |
|---|---:|---:|---:|---:|
| owner 编码，资源已解析 | 0.3272 | 0.6588 | 0.5652 | 0.5200 |
| 包含队列排空的摊销墙钟 | 0.5569 | 1.6143 | 3.5326 | 3.4953 |
| 串行重建后编码，整段墙钟 | 1.0101 | 2.1236 | 3.7632 | — |
| producer 准备下一帧，整段墙钟 | 0.6312 | 1.6119 | 3.4986 | — |

Wasm 前端编码已接近 JS，但完整队列墙钟仍与 DX12 差很多；不能声称 WebGPU 交互和浏览器后端成本已经消除，也不能把墙钟差额全归为 JS 跨界或 IPC。producer 流水线在 DX12 模型约改善 37.5%，Web 约 7.0%；Web 中剩余 API/后端成本占比更高，单把准备移到另一线程收益有限。

DX12 相同 4 条 command list，用 1 / 2 / 4 个工作线程录制的时间为 **0.3686 / 0.2054 / 0.1207 ms**，4 线程约加速 3.05 倍。这证明原生并行录制有优势，但此负载只节约约 0.248 ms，不能外推成别墅全部帧率差额。真实 UE 每条命令的工作量和依赖不同。

固定状态下，检查后跳过重复绑定：DX12 编码 **0.1473 → 0.0220 ms**，Wasm **0.5399 → 0.0200 ms**；输出像素一致。这个上限场景绑定状态整帧不变，不能当作真实材质频繁切换时的收益，也不意味着 UE 当前完全没有状态缓存。

| 每批 80 组描述符 | DX12 复制到预分配 heap | 原生 Dawn 创建组 | Wasm 创建组 | JS 创建组 |
|---|---:|---:|---:|---:|
| 1 条目 | 0.0004 | 0.0127 | 0.0950 | 0.0600 |
| 8 条目 | 0.0017 | 0.0479 | 0.2550 | 0.1850 |
| 24 条目 | 0.0055 | 0.1279 | 0.5701 | 0.4650 |

绑定组创建仍有差距，尤其高条目数下，尽量复用 group / 版本键有实测依据；但 DX12 这列包含的对象生命周期不同，不能用商值直接宣称 WebGPU API 慢相同倍数。真实 `CreateGroups` 的自耗时、包含时间和 JS 调用仍需分开分析。

所有后端输出 packet checksum 一致、读回像素检查通过，DX12 debug layer 检查通过，无校验错误。构建、预检阶段失败及并行构建期间采样不进入正式三轮结果。环境日志保留，仍可能有后台干扰。

## 最终链接优化的阴影诊断

保留该路线继续定位。v38 / 最终 `-O2` v39 的插桩捕获中，距离场网格均为 591 个，CPU 常驻及 bulk 字节一致；默认时记录到相同 WGSL hash 的 9 类距离场相关 compute pipeline、相同每帧调度数。临时关闭 DFAO 后，两端都只保留其中两类流送 compute，画面也有明显变化。这说明距离场路径仍在执行，不支持仅凭截图断言“距离场完全失效”；是否所有输入数据及最终输出正确，仍需进一步检查。

普通阴影深度绘制有明显差异：默认每帧约 **2007.5 → 200.4** 次，全部 draw 约 **3087.6 → 1248.2**。这些按 WGSL 中 `ShadowDepthPass` 标记识别，不是把所有采样 shadow texture 的光照 pass 都算作阴影深度。关闭 DFAO 后差异仍在，约 **2006.8 → 200.9**。

追加临时阴影缓存对照后，v39 的 shadow depth draw 从 **200.7 恢复到 2151.2**，总 draw 从 **1228.7 恢复到 3150.1**，**画面仍偏亮**。所以此前把 draw 减少直接称为“少绘”过早：其中一部分与缓存复用相关，数量本身不能证明漏画；缓存关闭也没有修复画面。不能接受 v39 的表面帧率收益，最终优化路线继续保留。

新增最终 `-O2 -g3` v42，保留 JS/导出名和 Wasm 名称，只移除 `.debug_*` 自定义 DWARF 节，保持代码、数据、导入导出字节不变。完整 Wasm 原约 1.74 GB，其中约 1.58 GB 为 DWARF，超过 V8 单模块 1 GiB 限制，移除后约 164 MB，结构及浏览器启动检查通过；这项处理不重新运行优化。重复处理无 DWARF 的文件时保留全部字节，哈希一致。v42 六机位没有崩溃或 GPU 错误，但人工图像仍明显偏亮，因此自动 `pass` 不代表画面验收。该结果排除了“仅仅名称压缩造成”的解释，尚未定位具体 Wasm 优化 pass，也未证明 Binaryen 有 bug；被优化暴露的数据/未定义行为等实现错误仍可能存在。

诊断只在临时浏览器会话调用已有光照 RPC，没有修改项目或包内设置。插桩及编译并行期间得到的时间不进入性能对照。原始捕获 `final-link-render-diagnosis-v3.json`、`final-link-shadow-cache-v1.json`。开发阶段 v1 启动等待引用了尚未存在的全局量；v2 在临时关闭普通阴影的测试期间 Worker 关闭，未纳入正常数据。v3 仅保留默认/DFAO 的诊断并记录日志。

实验结束用默认参数重建，JS/Wasm SHA256 与 v38 完全相同，417 个对象及编译响应文件也一致。SIMD 和异常 `-O2` 候选均独立保存。默认网页仍为 [v38](http://127.0.0.1:8765/build/villa-bridge-extras-v38/index.html)。

## 复现

```powershell
./tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -Simd -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 6 -RendererRevision d175ae4ae
./tests/web-platform/build-rhi-isolation.ps1
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/benchmark-rhi-isolation.cjs --tag=rhi-isolation-rerun --rounds=3
node tests/web-platform/benchmark-villa-threading.cjs --folders=villa-bridge-extras-v38,villa-simd-v41,villa-simd-v41,villa-bridge-extras-v38 --tag=villa-simd-rerun
node tests/web-platform/diagnose-final-link-rendering.cjs --tag=final-link-render-rerun
```

正式性能测量、构建和其他 GPU 测试按顺序执行。用户后台程序保留，监控记录环境干扰；不通过终止用户程序取得收益。源文件、二进制哈希、像素检查和完整三轮原始值在结果中保留。

汇总及哈希：`tests/web-platform/evidence/rhi-simd-isolation-20261103.json`，由 `summarize-rhi-simd.cjs` 验证生成；完整原始值留于 `tests/web-platform/results/`。本轮交付是隔离构建选项、可复现基准及诊断证据，没有把模型收益冒充正式 UE 优化。
