# 别墅线程模式对照（2026-11-03）

本轮分别比较 Web 和 D3D12 的现有多线程、合并渲染流程、引擎单线程。默认出生视角，沿用项目画质、距离场、光照、TSR、分辨率策略和资产；不启用 Web 显式 PSO 预缓存，不使用扩大浏览器 GPU 缓存容量的测试参数。

引擎诊断与两项单线程修复已提交本地参考引擎 `e94c92291`，未推送远端。

## 结果与判断

| 路径 | 引擎单线程 | 合并 Game / Draw / RHI、保留任务线程 | 现有多线程 | 多线程相对单线程 |
| --- | ---: | ---: | ---: | ---: |
| Web / WebGPU | 40.12 FPS | 41.52 FPS | 52.43 FPS | +30.66%，1.31 倍 |
| Win64 / D3D12 | 71.99 FPS | 启动失败，不计入 | 205.90 FPS | +186.02%，2.86 倍 |

多线程在当前 Web 中有效，关闭它会更慢。保留任务线程但合并渲染流程，相对完全单线程只增加约 3.48%；恢复独立 Game、Draw、RHI 流水线则增加约 26.27%。这些是不同基线的比值，不能相加。本轮是固定出生视角的对照，不能推广为所有视角的收益。

Web 的 full 使用现有独立线程，但启动状态仍为 `parallelCommandRecording=false`、`parallelRHITranslation=false`；它不表示 WebGPU 编码已经可以在多个线程同时完成。历史上 D3D12 并行翻译约 8% 的对照只关了部分并行环节，不能代替这里的完整单线程测试。

本机为 i9-12900K，16 物理核心 / 24 逻辑处理器、RTX 4090。当前 `FWebPlatformMisc::NumberOfCores()` 将核心数限制为 2～4，实际 full / render-serial 均只启动 3 个任务工作线程；Emscripten 预建 16 个 pthread 槽位不等于有 16 个 UE 任务工作线程。这个限制来自移植代码，不能解释为 WebGPU 或浏览器只允许 4 核。本轮测量现有默认值，没有改线程数量；后续应把 4 / 6 / 8 核上限作为独立实验，按实际池容量和竞争情况验证，而非直接解除上限。桌面与 Web 的 full 并不是相同任务线程数量。

逐次 FPS：Web full 为 52.51 / 52.34，render-serial 为 41.66 / 41.38，single 为 40.28 / 39.96；D3D12 full 为 212.94 / 199.31，single 为 71.66 / 72.31。合并样本后的 1% low 分别为 Web full 27.50、render-serial 26.47、single 25.68 FPS，D3D12 full 162.08、single 58.86 FPS。桌面两次 full 约有 6.4% 波动，不能把小比例差异当作确定收益。

本轮桌面约 206 FPS 来自独立的 Development 打包版，不是此前用户约 170 FPS 的编辑器运行环境。Web 内部场景为 1484×835，实际输出 2289×1288、TSR；原生输出 2289×1287、同项目 TSR。截图核对确认出生视角和效果一致，原生内部尺寸沿用此前 GPU Profile 的 1484×835 记录。本轮各自的线程 A/B 固定相机和设置，但两端 API、Shader Model、Cook 和呈现方式不同；绝对差值不是纯粹的 WebGPU API 速度差。

Web full 每帧约 3159 / 3162 次 draw，render-serial 约 3119 / 3229，single 约 2859 / 2869；原生各模式约 2524。线程安排会影响异步遮挡结果及其消费时机，本轮测的是实际运行模式的综合收益，没有强行固定 draw 数。即使 Web 单线程绘制更少，帧率仍低于现有多线程。

原生两次 full 均在测量、截图、CSV 写完并记录正常退出请求和日志关闭后，返回退出码 777003；此前相同包也有该退出问题。保留原始退出码并标记 `lateExitFailure=true`，只接受完整有效的测量区间；不能据此声称进程退出稳定性通过。两次 single 正常退出。

## 线程竞争与 CPU 热点

另开 full 运行采集各 Worker 的 DevTools CPU profile。正常帧率先测得 52.97 FPS，随后才开启采样；采样期间数据不进入上面的帧率对照。各 Worker 依次启停采样，窗口约 6～7 秒，不是严格同时的全进程时间线。

| 执行线程 | 采样观察 | 含义 |
| --- | --- | --- |
| RHI | 互斥锁 futex 等待约 6.62%；`SetDrawBindings` 调用栈约 33.40%；顶点缓冲绑定桥接约 9.70% | 竞争确实存在；绑定准备及 WASM/JS 编码调用仍有较大开销 |
| Draw / Render | 互斥锁 futex 等待约 6.73%；`EndFlushResourcesRHI` 下等待约 15.30%；其他条件等待含任务空闲 | 有下游依赖和资源同步，不能把所有等待都归因于锁竞争 |
| Game | 约 82.15% 采样处于 idle；互斥锁等待约 0.90% | 当前固定视角未显示 Game 逻辑计算饱和 |

这些比例按各线程采样时长计算，包含等待；调用栈类别互相重叠，不能相加或直接换算成可提升的 FPS。RHI 的分配路径约 8.88%、Draw 约 15.40%，也与互斥锁类别重叠。锁等待栈包括资源释放、数组扩容及部分运行期反射对象查询，支持进一步测试分配器竞争，但尚未做 mimalloc A/B。

普通 full 对照中 RHI 工作累计约 14.79 ms/帧，相对约 19.1 ms 的整帧已经很大。`WebGPUOnOwner` 统计的资源代理调用约 1 次/帧，合并模式为 0；此计数不涵盖所有 `MAIN_THREAD_EM_ASM`，不能断言所有跨线程调用均已消除。原生 CSV 的 RHIT 也不包含全部并行翻译工作，不能拿两端 RHIT 数字直接当相同工作量比较。

当前证据指向的下一轮顺序：先减少 `SetDrawBindings` 中的重复准备和分配、顶点绑定的 WASM/JS 调用，再追踪 `EndFlushResourcesRHI` 为何必须同步等待；分配器或锁粒度修改应独立 A/B。现有测量不支持仅通过关闭线程解决差距，也尚未证明全局锁是主要原因。本轮补齐测量和诊断模式，未宣称普通多线程帧率已有新提升。

## 测量定义

| 模式 | Game / Draw / RHI | UE 任务工作线程 | 启动控制 |
| --- | --- | --- | --- |
| full | 三个执行线程 | 保留 | 默认 |
| render-serial | 合并到同一个执行线程 | 保留 | `-norenderthread -norhithread` |
| single | 合并到同一个执行线程 | 关闭 | `-onethread -nothreading -norhithread` |

Web 三种模式使用同一个 pthread WASM 和同一份 Cook。合并模式直接在 GPU 所有者 Worker 上运行引擎，避免制造“每个 draw 都跨线程同步代理”的不合理对照。启动见证检查真实 Game/Draw/RHI 线程 ID 和任务线程数量；正常模式仍要求三者互不相同。输入和诊断 RPC 在合并模式下也通过原有游戏命令入口处理。

单线程指 UE 执行模式。浏览器、GPU 驱动及宿主 IO 自身仍可能有线程；同一个 pthread WASM 的共享内存、原子指令、TLS 和分配器不会因启动参数而从二进制消失。此测量可分离 UE 工作线程及流水线调度收益，未测独立非 pthread 构建的额外差异。

Web 使用可见 Edge，viewport 2289×1287、DPR 1，正常浏览器缓存，不按 draw 包装计时。预热至少 90 帧再等待 15 秒，每段测量约 20 秒，顺序 full / render-serial / single / single / render-serial / full。FPS 为实际完成的 RHI viewport presents / 测量墙钟时长；1% low 为最慢 1% 帧时间均值的倒数。保存全部样本，不删除慢帧。

桌面使用 `D:/UE_5.8` 为同一项目生成的现有 Win64 Development 包 `villa-native-pso-v1`，D3D12、RenderOffscreen、2289×1287，固定出生视角。每次重新启动，预热 2400 帧，测量 2400 帧，顺序 full / single / single / full。复用引擎 CSV Profiler；按所有测量帧的总时间合并 FPS，检查相机不变。不是编辑器视口，也不是 Shipping 包。

原生中间模式 render-serial 在启动时触发 `TextureReferenceRHI.IsValid()` ensure 与 `CommandSlots.Find(SceneInfo) == nullptr` 断言，涉及关闭 RT 后的异步资源/注册顺序。失败运行保留日志，没有当成低 FPS 样本，也没有为跑通它关闭纹理流送等项目功能。本轮原生只比较能完成场景启动的 full 和 single。

Web 与桌面所有测试模式统一设置 `r.pso.EnableAsyncCacheConsolidation=0`。Web 平台源码已写该默认值，但本次沿用的旧 Cook 配置没有携带它，因此通过线程测试启动入口显式统一。这只改变 PSO 缓存维护的调度，普通启动不追加该覆盖。UE 5.8 在 `-nothreading` 下保留该异步操作会在启动期触发 `Consolidate was hit while Get/SetPSO was running`；两端预检查均已复现，失败运行不作为性能结果。项目 Config 文件前后逐文件哈希验证。

## 构建与源码边界

Web 平台原先固定返回支持多线程/启用渲染线程，未遵从 UE 的通用诊断开关。现复用 `FGenericPlatformProcess::SupportsMultithreading()` 和 `FGenericPlatformMisc::UseRenderThread()`；标准启动参数得以生效。普通启动仍保留独立 Game、Render、RHI。

无任务工作线程时还复现了 `FShaderCodeArchive::PreloadShaderMap → FPreloadShaderTask → OnShaderPreloadFinished` 的写锁重入。原代码在持有 `ShaderPreloadLock` 时 `Task->Unlock()`，无工作线程时任务会立即在当前线程执行并再申请同一把锁。Web 的单线程路径现先保存完成事件，退出写锁范围后才释放任务；没有删去锁或跳过 shader 预加载。正常多线程调度路径保留。

还复现了 bulk IO 回调内联触发纹理流送 continuation、释放最后一个批请求引用，而析构又等待当前回调发布 `DoneEvent` 的自等待。Web 无工作线程路径在派发前保留一次引用，等 `CompleteBatch` 发布完成状态后释放，保留原有完成事件顺序。上述两项修复后，三种 Web 模式均完成场景启动及重复测量。

已拉取的 `23e0a4781` 包含新的半透明光照体功能，现有二进制反射基线 Cook 对应之前的渲染源码。线程对照通过 `build-web-engine.ps1 -RendererRevision d175ae4ae`，仅在隔离构建目录固定 `WebShaderPlatform.h`、`TranslucentLighting.cpp`、`SystemTextures.cpp` 到匹配基线的版本；不回退或覆盖参考引擎仓库的远端更新，不混入新功能，也不重新 Cook。构建报告记录实际 revision、隔离源码和目标文件哈希。

## 历史对照不能替代本轮

- 2026-10-28 的任务线程对照：多数视角下降约 9%～10%，4K 输出室内提升约 47%；尚未独立 Render/RHI，画质/分辨率策略也不同。
- 2026-10-31 的独立线程改造与绑定缓存联合优化：客厅约 25.17→41.67 FPS。不是单独线程开关的收益。
- 2026-11-02 原生 RHI 并行翻译：154.94 / 143.67 FPS，开启收益约 7.84%。联合关闭绘制录制、Mesh 准备和翻译后仍约 144.94 FPS，但保留独立 Game/Render/RHI，不是引擎单线程。

## 调研依据

[UE 并行渲染说明](https://dev.epicgames.com/documentation/en-us/unreal-engine/parallel-rendering-overview-for-unreal-engine) 区分前端命令录制、后端翻译和独立 RHI 流水线，并说明跨阶段依赖及部分资源操作需要等待。等待时间不能全部算成可删除的锁开销。

[Emscripten pthread 文档](https://emscripten.org/docs/porting/pthreads.html) 说明同步 proxy 会阻塞调用线程；其默认 dlmalloc 使用全局锁，出现分配竞争时可评估 mimalloc。当前 Web 为 FMallocAnsi + 默认 dlmalloc，这是一条需要通过采样和 A/B 验证的线索，不能仅凭分配器名称判定瓶颈。

[Godot 的 Web 导出实现记录](https://godotengine.org/article/progress-report-web-export-in-4-3/) 同时保留单线程和多线程路径，并将音频与宿主约束分别处理。其渲染后端和场景与本项目不同，不把它的表现当作本项目收益数据。

## 复现

```powershell
./tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4 -RendererRevision d175ae4ae
node tests/web-platform/package-web-runtime-experiment.cjs --baseline=villa-reflection-binary-base-v28 --output=villa-threading-new --evidence=tests/web-platform/results/web-project-triplex-binary-distance-fields-threads-package-results.json
node tests/web-platform/benchmark-villa-threading.cjs --folder=villa-threading-new --tag=threading-web-new
./tests/web-platform/capture-villa-threading-native.ps1 -Packaged -Tag threading-native-new
python tests/web-platform/analyze-villa-threading-native.py tests/web-platform/results/threading-native-new
```

报告标签、实验包目录需要使用新名字，避免覆盖原始证据。Playwright 使用工作区现有 NODE_PATH。

本次实际包为 `build/villa-threading-v33`。正常启动不附加 `-WebThreadingTest`；复现单一模式可以给打包器增加 `--threading-test=single` 或 `--threading-test=render-serial`，使用新的输出目录。CPU 采样使用基准脚本的 `--modes=full --profile-workers`，再执行 `node tests/web-platform/analyze-villa-threading-cpu.cjs tests/web-platform/results/<tag>-1-workers`。

## 证据

纳入 Git 的汇总及原始文件哈希见 [threading-ab-20261103.json](tests/web-platform/evidence/threading-ab-20261103.json)。完整本机数据保存在 `tests/web-platform/results/`：

- `threading-web-20261103-abba.json`：6 次正常运行、原始帧间隔、线程见证、相机、渲染设置及包哈希。
- `threading-native-20261103-abba-analysis.json`、同名前缀的 4 份 CSV / log / 截图：原生对照与退出状态。
- `threading-web-20261103-cpu-1-workers-analysis.json` 与同前缀 `.cpuprofile`：热点及完整调用栈。
- `threading-web-20261103-controls2.json`：三种模式的相机 RPC、键鼠事件与继续出帧检查。
- `villa-threading-v33-build.json`、`villa-threading-v33-package.json`：构建、匹配旧 Cook 的渲染 revision、产品哈希。
- `threading-20261103-environment.jsonl`：运行环境抽样。Web 测量区间未检测到大型游戏或编译进程；仍有普通后台应用，本轮不是系统独占实验。
