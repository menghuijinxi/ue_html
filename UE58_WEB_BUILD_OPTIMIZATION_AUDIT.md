# Web 构建优化与性能归因审计

2026-11-03。不能根据前两轮桥接优化只有小幅 FPS 收益，认定 WebGPU 交互已无性能问题，也不能将剩余差距都归为 UE 公共 C++。本轮核对真实编译响应文件、对象哈希和最终链接参数，并独立测试此前遗漏的最终 Wasm/JS 优化。

## 实际优化状态

审计对象是通过完整 UBT 构建并用于 v38 的 417 个 C++ 对象文件，不根据 Development 名称推断优化级别。

| 项目 | v38 实际参数 | 本轮 v39 |
|---|---|---|
| LLVM C++ 编译 | 416 个 `-O2`，1 个 `-O1` | 完全相同的 417 个对象及响应文件哈希 |
| WebGPURHI / Renderer / Core / Engine | 已开启编译优化 | 不改变 |
| 最终 Emscripten 链接 | 没有 `-O` 参数 | 增加 `-O2` |
| 显式 Wasm SIMD | 0 个单元带 `-msimd128` | 不改变 |
| LLVM LTO | 编译和链接均无 `-flto` | 不改变 |
| Emscripten 断言 / 调试名 | `-sASSERTIONS=1`、`-g2` | 保留 |
| 项目配置 / Cook | v28 已验证的别墅内容 | 同一内容、配置哈希 |

唯一 `-O1` 是包含三角网格查询实例化的 Chaos 单元，工具链针对 LLVM 24 wasm64 指令选择崩溃做了局部回退。不是整个 Chaos 或引擎关闭优化。插件里条件式 `OptimizeCode=Never` 只适用于 Win64 原生探针且要求显式环境变量，未作用于本次 Web 构建。

C++ 编译阶段的 `-O2` 执行 LLVM 优化；最终链接的 `-O2` 还会执行 Binaryen Wasm 优化及生成的 JS 优化。本轮构建日志实际出现 `wasm-opt --post-emscripten -O2`，不只是记录了参数。它不等于开启 LLVM LTO，也没有重编所有 C++ 为 `-O3`。[Emscripten 优化说明](https://emscripten.org/docs/optimizing/Optimizing-Code.html)、[编译与链接优化参数](https://emscripten.org/docs/compiling/Building-Projects.html#building-projects-with-optimizations)。

`UEWebEngine.Target.cs` 增加显式 `-WebLinkOptimization=0/1/2`；构建脚本对应 `-LinkOptimization 0/1/2`。默认 0 保留原先无 `-O` 的最终链接状态，避免将出现画面异常的候选变为默认。审计脚本 `audit-web-build-optimization.cjs` 验证响应文件及对象哈希，报告每单元实际级别、SIMD、LTO、链接优化和断言，不从参数推算 FPS。

## 为什么相同 UE C++ 仍可能有差距

| 层次 | 当前证据与边界 |
|---|---|
| UE 公共渲染、游戏及任务代码 | 大量复用；平台宏、算法路径、编译器、并行任务数及实际工作量仍可能不同 |
| 自定义 WebGPU RHI | `CreateGroups`、`SetDrawBindings` 属于本项目适配层；不能当作 D3D12 后端原样执行 |
| Wasm64 → JS 绑定 | 已减少导入、BigInt 参数和描述符解析；收益有限不能证明其余调用成本为零 |
| 浏览器 WebGPU / Dawn / GPU 进程 / 驱动 | owner Worker 的 CPU 栈没有完整覆盖后台校验、IPC、资源处理和 GPU 调度，仍需独立调查 |
| 平台 CPU 基础设施 | 向量化、分配器及线程实现存在差异；本轮没有证明它们各自造成多少差距 |

v38 owner 采样中 `CreateGroups` 包含子调用占 23.92%，自身仅约 5.59%；包含时间会计入 JS、分配和等待。`SetDrawBindings` 等占比又与它重叠。不能将这些数字加总或称为纯 C++ 计算，更不能证明 GPU 进程没有瓶颈。

此前同机线程实验：原生 full / single 为 205.90 / 71.99 FPS，Web 为 52.43 / 40.12 FPS。原生与 Web 的 full 差约 3.93 倍，single 差约 1.79 倍。这说明并行路径值得调查，但不能将差额全部归给线程：Web full 每帧约 3159～3162 次 draw，原生约 2524 次；任务线程数、异步遮挡、API、Cook 及呈现条件亦有差别。详见 [线程对照](UE58_VILLA_THREADING_AB.md)。

独立 3200 draw 测试中，JS WebGPU 的 CPU 前端约 0.545 ms，直接 DX12 约 0.355 ms；包含队列完成的摊销墙钟分别约 3.462 / 0.559 ms。前端接近不代表完整后端开销接近。不同 Dawn 版本及执行模型使差值不能精确归为 IPC 或校验，且不能直接当成别墅帧时间。详见 [独立 API 对照](UE58_DRAW_API_BENCHMARK.md)。

当前没有 `-msimd128` 或 LTO 是可验证的配置事实，尚不是根因结论。应分别建立实验，不与最终链接优化同时改变，也不承诺启用后自动获得数倍收益。

## 最终链接优化对照

v38 → v39 → v39 → v38：相同的 417 个对象，只在最终链接增加 `-O2`。每轮至少 90 帧，额外预热 15 秒，采样 20 秒；可见 Edge，CSS 2289×1287、DPR 1，内部 1484×835、输出 2289×1288、AA=4。所有断言、线程、TSR、距离场和 Cook 一致。

自动运行检查完成，合并 FPS 为 54.725 → 77.180；**该提升无效**。新版默认视角的明暗与阴影明显错误，每帧 draw 从约 3140～3165 降为约 1274～1276，间接 draw 约 88～91 降为约 5。截图人工复核不通过，不能将少绘工作当作优化收益。`report.pass=true` 仅代表自动运行检查通过，不代表图像等价。

v40 另测最终 `-O1`，它不运行主要 Binaryen 优化流程，依然使用相同的 417 个对象。六机位切换及返回出生点持续渲染通过，没有 GPU 校验错误、设备丢失或崩溃，截图明暗与 v38 一致。单独采样与正常 FPS 测量分开。

第二组 v38 → v40 → v40 → v38，依次 56.980 / 51.819 / 38.176 / 42.501 FPS。合并旧版 / `-O1` 为 49.741 / 45.001 FPS，1% low 为 21.289 / 20.317。**未测出可用收益，也不能从这组认定 `-O1` 固定回退约 9.5%**：同一旧版前后自身从 56.98 降为 42.50，环境存在明显漂移。原始值完整保留，不选择其中一轮报收益。

测量区间进程监控没有记录游戏、UE 或编译器同时运行，但存在 TGitCache、Sunlogin、Oopz、音乐和系统活动。TGitCache 在第二组后半段持续占用约一个 CPU 核；没有隔离证明它就是漂移的全部原因。遵循用户先前要求保留后台进程，没有关闭用户程序。这是带干扰的同机短时对照，非独占资源实验。帧率来自 RHI 完成帧间隔，1% low 为最慢 1% 间隔的均值取倒数，不代表显示器实际扫描输出。

这个对照仅将问题缩小到最终 `-O2` 增加的流程；仍可能涉及 Wasm 优化、生成 JS 优化、绑定依赖分析或被优化暴露的实现错误。**尚未证明 Binaryen 本身有 bug**，也未定位具体优化 pass。两级候选均保留为独立包，默认继续使用已验证的原先链接路径。

最后用默认参数重新完成完整 UBT 链接及 Wasm 结构检查；生成 JS/Wasm 的 SHA256 与 v38 均完全一致，417 个对象及响应文件也仍相同。因此没有将异常候选留在默认构建产物中。

## 复现与证据

```powershell
./tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4 -RendererRevision d175ae4ae -LinkOptimization 1
node tests/web-platform/audit-web-build-optimization.cjs tests/web-platform/results/web-engine-full-thread-build-results.json tests/web-platform/results/new-optimization-audit.json
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/benchmark-villa-threading.cjs --folders=villa-bridge-extras-v38,villa-final-link-o2-v39,villa-final-link-o2-v39,villa-bridge-extras-v38 --tag=new-final-link-abba
node tests/web-platform/verify-villa-command-stream.cjs --folder=villa-final-link-o2-v39 --tag=new-final-link-views
```

原始构建日志、编译审计、基准区间和截图保留于本地 `tests/web-platform/results/`。所有性能结论与正确性、插桩采样分开。

汇总及哈希：`tests/web-platform/evidence/web-build-optimization-20261103.json`，由 `summarize-web-build-optimization.cjs` 生成。审计通过不表示候选优化获准采用；证据明确标注 v39 图像不等价、两组均未接受性能收益。当前默认网页仍为 [v38](http://127.0.0.1:8765/build/villa-bridge-extras-v38/index.html)。
