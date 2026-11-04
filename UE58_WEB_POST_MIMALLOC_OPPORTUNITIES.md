# mimalloc 之后的 WebGPU 优化空间

2026-11-04。检查当前外围提交 `1832832`、引擎提交 `f8843511d3`，并对已验收的最新完整包 `villa-lumen-off-current-mimalloc-v59` 重新采集逐帧、浏览器 GPU 服务时间线和所有 Worker CPU 栈。

当前证据最支持继续减少 **RHI 的绑定准备、资源对象创建和逐灯计算调度**。首次转向的数百毫秒卡顿仍与浏览器后续管线准备吻合，需要用实际使用的管线集合单独处理。固定视角和重复转向的 40–60 ms 慢帧仍未完成归因，下一步应补任务排队到执行的时间关联。

用户观察的 GPU 约 60% 占用没有在本轮重新量测，不能由此推导剩余帧率空间。线程等待、CPU 端喂入不足、浏览器服务工作和 GPU 执行需要分别测量；当前没有与桌面端同条件的完整 GPU 帧时间对照。

## 最新包复测

可见 Edge 156.0.4314.58、NVIDIA Lovelace，2289×1287 CSS、DPR 1，内部 1484×835、输出 2289×1288、TSR=4。Game/Render/RHI 独立，UE 核心预算 4、3 个任务 Worker。沿用原项目 Cook、材质、光照、距离场、线程和默认的 PSO 使用约定。

先运行低频对象创建观察器，预热 20 秒，静止 30 秒，再以出生方向为起点按 0/90/180/270/0 度各停留 5 秒，两次走相同转向序列。转向阶段另开 Chromium trace；观察器没有包装每条 draw，也没有增加 GPU fence 或 GPU 时间戳查询。

| 阶段 | 平均提交 FPS | 1% Low | 最长间隔 | 新图形 PSO | 新 ShaderModule |
|---|---:|---:|---:|---:|---:|
| 固定视角 30 秒 | 76.94 | 32.46 | 55.70 ms | 0 | 0 |
| 首次转向 25 秒，有 trace | 99.53 | 23.32 | **331.05 ms** | 15 | 10 |
| 重复转向 25 秒，有 trace | 105.84 | 31.60 | 54.53 ms | 0 | 0 |

转向时视野和可见物改变，因此不能把它的平均 FPS 与固定出生点直接比较。1% Low 为最慢 `ceil(N×1%)` 个完整 RHI 提交间隔的平均值取倒数；首次转向近五秒滚动 Low 最低为 8.54 FPS，重复转向为 21.36 FPS。两者均为引擎完成提交的间隔，不是显示器扫描输出。

固定视角没有新增 PSO、ShaderModule 或磁盘读取，仍有两帧超过 50 ms；重复转向也没有新增 PSO、ShaderModule 或磁盘读取，仍有一帧超过 50 ms。它们不能继续全部归因于 PSO 或资源磁盘流送。

首次 331.05 ms 间隔对应帧 4356。`CrGpuMain` 的两个完整 `RunTask` 分别为 150.77、116.94 ms，另有前一任务的约 30.83 ms 落在该间隔内，三段重叠时间合计约 298.53 ms。内部包含 `WebGPU → CommandBuffer::Flush → WebGPUDecoderImpl`；这些是 **GPU 服务进程的 CPU 工作**，不是 GPU 着色器执行时间。15 条管线在此前数帧创建，API 调用点没有覆盖后续准备成本。本轮 trace 有 34 次 Dawn cache hit，最长 GC 为 5.61 ms。结合首次出现、重复后消失的现象，支持首次管线准备方向，但尚未细分到 Tint、DXC、原生驱动各阶段。

trace 还记录到约 204 ms 的 DevTools Worker 数据导出任务，发生在采样阶段切换处；不能将全 trace 中最长的任意任务当成游戏慢帧。汇总只对明确的游戏长帧标记做时间关联，不重复累加嵌套的 WebGPU/Flush 任务。

## 独立固定视角与 CPU 采样

结束上述浏览器后，另起一次原有线程基准：15 秒预热、10 秒无 profiler 计时，然后才开启 Worker CPU profiler。普通页面保留异步 PSO cache consolidation；原有 `full` 基准会关闭这项功能，因此两次只能互相印证量级，不能当成逐变量 A/B。

固定视角为 **76.56 FPS、1% Low 32.48、RHI pump 墙钟约 9.37 ms/帧**，每帧约 3110 次 direct draw、81 次 indirect draw、159 次 dispatch。Wasm 线性内存容量在这段正常计时前后均为 1,521,025,024 字节，不等同于活跃堆或进程 RSS。

| 所在线程及包含子调用的路径 | 占各自线程采样窗口 |
|---|---:|
| RHI `SetDrawBindings` | **28.51%** |
| RHI `CreateGroups` | **19.13%** |
| RHI JS 命令回放 | 10.15% |
| RHI 资源访问校验 | 3.86% |
| RHI `CommitShaderResources` | 3.43% |
| RHI 名称可识别的分配/释放路径 | 2.83% |
| RHI 创建 GPUBuffer 路径 | 2.10% |
| Render TLV 注入相关准备路径 | 3.08% |
| Render RDG 校验路径 | 2.45% |

这些路径存在包含关系，不能相加，也不能按百分比直接推算可提升的 FPS。Render 的 futex 叶子约 64.00%、Game idle 约 82.73%、RHI idle 约 23.67%，显示各线程等待/空闲情况，尚不能将等待全部解释为分配器锁或 GPU 等待。RHI 的 `growMemViews` 自身约 1.67%，但它检查共享内存视图是否过期，不能因函数名就判定持续扩堆。

RHI 有一个 99.51 ms 的长采样间隔，落在 `CreateGroups → CommitShaderResources` 内；它可能包含调度或 profiler 停顿。汇总保留所有原始时间，并额外计算排除超过 20 ms 样本的敏感性结果：`SetDrawBindings` 27.49%、`CreateGroups` 17.98%、`CommitShaderResources` 2.05%。绑定准备仍然突出，但不能把上述 99.51 ms 全当成函数实际计算。Render/Game 各有一个约 65/70 ms 的长样本，也在证据中逐项保留。

正常计时窗口的现有计数器进一步给出：

| 每帧计数 | 数值 |
|---|---:|
| 整组准备快路径命中 | 3228.54 |
| 因访问代次失效 | 735.12 |
| 因资源/Uniform 版本失效 | 748.22 |
| 因跨帧失效 | 222.12 |
| 重新准备绑定项 / 复用绑定项 | **5471.50 / 4771.04** |
| 创建 BindGroup / 已有 BindGroup 命中 | 59.79 / 4874.21 |
| 资源表提交 / 涉及的 UniformBuffer | 567.47 / 622.38 |
| 常量快照 / 合并上传调用 | 690.22 / 2.00 |

整组准备检查约 **65.43%** 命中；已有 BindGroup 查找约 **98.79%** 命中。后者明显更高，说明大量工作仍发生在查到同一个浏览器绑定组之前。不能仅用 `createBindGroup` 已经很少来判断绑定准备优化结束。

## 值得实施的方向

### 1. 绑定缓存未命中路径：优先级最高

代码入口为 `tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp` 的 `CommitShaderResources`、`CreateGroups`、`SetDrawBindings`。当前正常计时下每帧仍重建约 5472 个绑定项；采样中 `CreateGroups` 本体的多个节点合计约 8.30%，资源提交另有可见工作。

可实施的第一步是把每条管线的分组槽位、动态 offset 顺序、直接资源/资源表位置预先整理成紧凑计划，减少未命中时的 TMap 查询、字符串判断、逐项去重、排序和描述符 hash。再按实际失效原因细化跨 Pass 的描述符复用：不可变视图描述与当前资源访问检查分开缓存，保留真实 transition、附件冲突、Uniform 内容、TextureReference/streaming 的失效规则。

这与 v48 的“命中后跳过反射循环”实验不同。v48 已实测无明确收益；本次目标是 **发生版本/访问失效后的重建成本**。计数也表明首次路由解析已接近零，不能再次把“移除正常 draw 的 JSON/初次反射解析”当成新收益来源。

通过条件：对相同画面和提交量，减少未命中项的准备 CPU 时间；完整描述符重建校验一致，覆盖移动、纹理流送、窗口变化、同帧 Uniform 更新和资源释放，再进行 ABBA 帧率对照。

### 2. TLV 逐灯调度：优先检查最近新增的工作

`reference-engine/Engine/Source/Runtime/Renderer/Private/TranslucentLighting.cpp:2059` 遍历未合批灯，`:2145` 为 Web 每灯、每有效级联发出 `WebInjectTranslucencyLightingVolume` compute pass。UE 已有对兼容灯光的批量路径，需先记录真实灯光为什么进入 Unbatched：投影阴影、静态阴影、LightFunction、矩形灯近似、灯光网格准入等条件都可能影响，不能假定所有灯都能直接合并。

[上一轮完整新包](UE58_WEB_LUMEN_OFF_ALLOCATOR_AB.md) 的 dispatch 约从 66 增至 159，反向复测平均 FPS 约回退 6.4%；本轮当前包仍约 159 dispatch/帧，Render 栈也确认注入准备实际发生。这是当前明确的增量工作，值得优先收回后端适配成本。

先补每个 TLV pass 的灯光、级联、覆盖体素数和不能合批原因。对资源布局与 shader 排列兼容的灯复用准备结果，检查是否能使用已有批量机制，或在一次 compute 内完成多个灯的累加。阴影采样资源不同、WebGPU 绑定数量限制和累加精度都要纳入设计；保持半透明材质光照正确。

通过条件：在同等半透明光照下减少 pass/dispatch 和 CPU 准备开销，同时核对 GPU 时间。当前只有同包运行证据和此前完整包比较，尚无单独 TLV 优化 A/B，不能承诺收回全部回退。

### 3. GPUBuffer 生命周期和缓存淘汰

本轮静止和两次转向均约 **55.8–55.9 个新 GPUBuffer/帧**；固定视角 30 秒内创建 128,988 个。mimalloc 改善 C/C++ 分配竞争，没有消除浏览器 GPU 资源对象创建、上传与释放。当前 C++ 创建缓冲路径约占 RHI 栈 2.10%，帧末清理约 1.27%，没有证据证明它们占全部慢帧。

优先给创建事件补用途、size、usage、持有方和释放帧，区分持久 Uniform、更新临时源、readback 和其他资源。已有帧常量 1 MiB 页和 UE RDG 资源池正在复用，正常计数每帧只有 2 次合并常量上传，后续池化应针对仍在创建的对象。

另一个具体入口是 `WebGPUDynamicRHI.cpp:1076`：帧末扫描整个 BindGroup/Bundle cache，删除当帧未使用的条目。可测带容量和存活代次上限的多帧淘汰，减少视角交替时重新创建；必须持有资源引用，正确处理句柄复用、纹理流送和页内范围。延长缓存也会增加内存，不能仅延长 TTL 后报命中率提升。

通过条件：资源账本证明同用途对象被安全复用，创建数量与 CPU 时间下降；同队列读写顺序、读回状态、资源上界和移动时的画面通过。没有重新引入每帧 GPU 排空。

### 4. 首次使用 PSO：针对极端 Low 的独立工作

本轮再次得到 15 条图形管线缺失和 331 ms 长帧，而固定视角没有新管线。应捕获这 15 条实际描述，优先研究小集合、分阶段的异步准备和已完成对象保留，分别测准备耗时、首次转向和重复转向。

[历史实际对象复用实验](UE58_WEB_PSO_CACHE_REUSE.md) 已证明补齐描述和复用对象能改善首次转向，但完整批量预缓存存在明显启动成本；[当前使用约定](UE58_WEB_PSO_CACHE_CAPACITY.md) 因此保留普通页面默认关闭。本轮没有更改这一默认，也没有添加访问者浏览器启动参数。后续候选应控制实际工作集和启动成本，再决定是否值得采用。

标准允许同步创建的实际管线准备延后至首次使用、finish 或 submit；异步创建适合在真正使用前完成准备。参见 [WebGPU pipeline creation](https://gpuweb.github.io/gpuweb/#pipeline-creation)。不能只按 JS create API 的耗时判断编译卡顿，也不能将当前 40–60 ms 的全部慢帧一起归因于 PSO。

### 5. RHI 唤醒和帧间排队：针对重复慢帧

`reference-engine/Engine/Platforms/Web/Source/Runtime/Core/Private/Web/WebPlatformProcess.cpp:22` 的唤醒先走一次异步代理，再通过 `emscripten_set_immediate` 调用 RHI pump。该让出事件循环的步骤维持呈现、map 回调和设备错误处理，是生命周期要求的一部分；目前没有证明它就是剩余 40–60 ms 慢帧的原因。

下一步记录“Render 入队 → 代理接收 → immediate 开始 → RHI pump 结束 → viewport 提交”的共同序号和时间戳，再与浏览器 Worker/GPU 服务任务关联。只有确认存在多余空唤醒、连续短批之间的排队或长任务阻塞，才设计有工作量预算的合并和唤醒去重。

现有 `rhiWorkMilliseconds` 在 pump 返回后才累加，而提交标记发生在 `RHIEndFrame` 内；一个 pump 也可能处理多个提交。因此采集文件里的逐帧 `rhiDelta` 并不是同一帧的精确 RHI 工作，不能用 `55 ms - 9 ms` 算出约 46 ms 等待，更不能据此删除调度边界。

## 清理项和验证边界

本次日志有 **22,637 条** `FGenericPlatformMemory::GetStats not implemented` 警告。Web 平台只实现 `GetConstants`，`GetStats` 仍继承 Generic 实现。应补符合浏览器语义的统计入口或明确的不可用字段，避免热路径反复警告；Wasm 容量不能冒充物理 RAM/RSS。当前 Game 日志相关栈仅约 0.34%，未显示它是主瓶颈。

当前构建保留开发断言、RDG 校验；本轮 Render RDG 校验约 2.45%，可以后续做发布配置的独立对照。已有最终链接 `-O2` 候选出现过画面错误、SIMD/增加任务数也没有获得稳定收益，相关历史结果分别见 [构建优化审计](UE58_WEB_BUILD_OPTIMIZATION_AUDIT.md)、[SIMD/RHI 隔离](UE58_SIMD_RHI_ISOLATION.md)、[并行录制](UE58_WEBGPU_PARALLEL_RECORDING.md)。这些变量需要单独重新验收，不能作为本轮已获得的收益。

本轮只有一次逐帧诊断和一次另行固定视角计时/CPU 采样。没有实现或宣称新的渲染加速，没有重打包、改变项目质量或关闭后台用户程序。所有阶段无捕获到的 GPU 校验错误或崩溃；这不是新的长期稳定性验收。后续吞吐优化先做绑定未命中路径和 TLV 的单变量实验；Low 验证同时保留首次与重复转向，单独记录 PSO 事件、排队延迟和慢帧。

## 证据与复现

可携带汇总：[post-mimalloc-20261104.json](tests/web-platform/evidence/post-mimalloc-20261104.json)，包含运行时/清单和采集文件 SHA-256、原始路径、逐阶段指标、缓存计数、线程栈分类和长帧/GPU 服务关联。源码、资源摘要逐一复核；现有构建哈希与默认 mimalloc 的验收证据相同。完整 764 MB trace 和逐帧原始数据保留在本机 `tests/web-platform/results/`。

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/capture-web-stutters.cjs --folder=villa-lumen-off-current-mimalloc-v59 --tag=post-mimalloc-v59-stutters-new --width=2289 --height=1287 --dpr=1 --trace=tour
node tests/web-platform/analyze-web-stutters.cjs tests/web-platform/results/post-mimalloc-v59-stutters-new.json tests/web-platform/results/post-mimalloc-v59-stutters-new-chrome-trace.json
node tests/web-platform/benchmark-villa-threading.cjs --folder=villa-lumen-off-current-mimalloc-v59 --modes=full --seconds=10 --warmup=15 --profile-workers --tag=post-mimalloc-v59-profile-new
node tests/web-platform/analyze-web-frame-costs.cjs tests/web-platform/results/post-mimalloc-v59-profile-new-1-workers tests/web-platform/results/post-mimalloc-v59-frame-costs-new.json
node tests/web-platform/summarize-post-mimalloc.cjs --capture=tests/web-platform/results/post-mimalloc-v59-stutters-new.json --profile=tests/web-platform/results/post-mimalloc-v59-profile-new.json --costs=tests/web-platform/results/post-mimalloc-v59-frame-costs-new.json --output=tests/web-platform/evidence/post-mimalloc-new.json
```

按以上顺序串行执行，避免 trace 分析或其他浏览器运行与正常计时重叠。采集和汇总要求使用新标签；已有证据不覆盖。
