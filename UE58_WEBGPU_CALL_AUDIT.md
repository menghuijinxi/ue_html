# WASM64 调用审计与第二轮传输优化

2026-11-03。在动态绘制命令流之后，继续检查逐调用 BigInt 转换、共享内存视图检查和跨 JS 的频率。没有发现又一处能单独解释数倍帧率差距的错误；找到两处可减少的传输开销，并实现、构建和对照测试。它们是合法通用绑定的成本，不能据此称 WebGPU 方法本身调用错误。

## 审计范围与发现

新增 `tests/web-platform/audit-webgpu-bridge.cjs`，在实际 UE WASM 导入表安装计数器，统计调用次数、BigInt 参数数量、`growMemViews` 检查和 `WebGPU.getJsObject` 查询。只统计 WebGPU 所在 owner Worker；Game、Draw 和任务线程不在该表内。插桩影响执行速度，**这些捕获的 FPS 不作为性能结果**。

v36 默认出生视角，413 个完成的 RHI 帧：

| 路径 | 每帧次数 | 观察 |
|---|---:|---|
| 动态命令流回放 | 890.59 | 状态和查询边界仍会将命令流切碎 |
| begin / end 遮挡查询 | 各 373.41 | 每次都跨 WASM/JS，并携带一个 BigInt 句柄 |
| viewport / stencil / scissor | 254.81 / 252.81 / 86.59 | 原先都先 flush 再立即调用 |
| 创建 bind group | 80.47 | 合计每帧约 9367 次内存视图检查，平均每次创建约 116 次 |
| beginRenderPass | 275.81 | 每帧约 5830 次内存视图检查 |
| compute pipeline / group 绑定 | 各 66.51 | 频率远低于绘制绑定，暂未增加新的 compute 传输层 |
| owner 的 get_now / asm_const | 17.02 / 11.20 | 没有发现逐 draw 的大量计时或任意 JS 调用 |

`growMemViews` 通常只是检查 `wasmMemory.buffer` 是否改变；次数不等于实际扩容或复制次数，也不能将次数直接换算为耗时。生成的绑定需要读 C 结构中的指针、64 位长度、扩展链和不同资源类型；共享内存构建在多个堆读取处重复插入检查。

v37 同包再次插桩，原路径 / 两项开启分别捕获 399 / 427 帧：每帧 owner 导入调用约 **4003 → 2025**，导入中的 BigInt 参数约 **4611 → 3100**，内存视图检查约 **18060 → 8274**；命令流回放约 **895 → 267**。原生遮挡查询方法仍执行，移除的是它们的逐次导入，不是查询工作。创建的绑定组主要含 20、22、30 等数量的条目，紧凑描述符有实际覆盖；两次异步可见性结果略有不同，不要求计数逐帧完全一致。

同时查看了 [wasm_webgpu 的实际绑定](https://github.com/juj/wasm_webgpu/blob/main/lib/lib_webgpu.js) 和 [Dawn 的 Emdawn 绑定实现](https://dawn.googlesource.com/dawn/+/706e9804921a81903f977f76ef8971eb293a453d/third_party/emdawnwebgpu/library_webgpu.js)。前者对轻量描述符使用更直接的参数接口；本地实际测试使用固定的 `v20261009.190412` Emdawn 包，未将其他实现的性能说明当作本项目测量结果。

## 修改

1. 将 viewport、scissor、stencil、begin/end occlusion query 加入已有动态命令流，增加 opcode 11～15。原生 WebGPU 调用、参数和先后顺序全部保留；查询仍正常执行，未关闭遮挡剔除。pass end、finish、submit、debug 和 bundle 等边界继续先同步回放。
2. 增加紧凑 bind-group 描述符传输。C++ 将常见 buffer、texture view、sampler 条目写成 f64 字，JS 一次取得堆视图后解析，调用相同的 `GPUDevice.createBindGroup`，并使用原 Emdawn C 句柄分配和对象表。不是缓存或省略创建结果。

有标签、扩展链、异常资源组合、超过 128 个条目、不能精确表示的 offset/size 等情况走原 C API；`WGPU_WHOLE_SIZE` 保持 undefined 语义。在 UE 中，非 GPU owner 线程的创建继续走原有同步代理，避免在错误 Worker 的对象表中查句柄。

两个启动 A/B 参数分别为 `-WebGPUScalarPassCalls`、`-WebGPULegacyDescriptors`。参数经过入口程序明确传给 UE，启动日志输出实际状态，测试按日志验证。旧 `-WebGPUImmediateCalls` 仍可关闭整个绘制命令流。

相关实现为插件的 `WebGPUCommandStream.h`、`WebGPUPackedDescriptors.h` 和引擎 Web 平台的两个同名 JS 库。桌面渲染器、Cook 内容、相机、TSR、距离场及项目配置保持原有设置。

## UE 对照

v37 同一个 WASM，基线 → 两项 → 状态 → 描述符 → 描述符 → 状态 → 两项 → 基线。每轮完成至少 90 帧，再预热 15 秒，采样 20 秒；可见 Edge，CSS 2289×1287、DPR 1，内部 1484×835、输出 2289×1288、AA=4。

| 传输组合 | 两轮合并 FPS | 1% low |
|---|---:|---:|
| 原路径 | 54.672 | 30.000 |
| 仅状态/查询合并 | 55.269 | 29.526 |
| 仅紧凑描述符 | 54.776 | 30.390 |
| 两项同时启用 | 55.743 | 30.206 |

合计 FPS 增加约 **1.96%**，1% low 基本持平；仅描述符的场景差异太小，不能声称独立带来稳定的 FPS 收益。两项合计仍是小幅改善，不能补齐与桌面端的帧率差距。每轮 workload 记录在证据中，可见性及异步遮挡结果存在小幅变化，没有假定每帧 draw 数完全一致。

最终 v38 增加非 owner 线程的原 C API 回退后，另做基线 → 两项 → 两项 → 基线四轮确认：**55.045 → 56.984 FPS（+3.52%）**，每帧 RHI 工作时间两轮均值 **13.948 → 13.417 ms**。这一组的 1% low 为 **31.753 → 29.977**，超过 33.33 ms 的间隔为 8/2201 → 13/2278；因此没有测出卡顿改善，尾部间隔反而略差。两组短样本的尾部结果不同，尚不能判断稳定的回退幅度；本轮结论仅为平均 CPU/RHI 耗时的小幅减少，不宣称 low 帧已优化。

最终普通测试页：[villa-bridge-extras-v38](http://127.0.0.1:8765/build/villa-bridge-extras-v38/index.html)。两个回退参数和 v36 的历史包均保留，便于继续比较。

最终包六次机位/朝向切换及返回出生点持续渲染通过，未记录 GPU 校验错误、设备丢失或崩溃。截图检查未见异常；这是短时验证，不代表长期稳定性和全项目画质验收。单独检查时页面 visible、focused，HUD 的页面新画面和 RHI 提交均约 56 FPS；该检查未混入 A/B 计时。

以上是 RHI 完成帧间隔，**不是显示器扫描输出或页面实际显示的新画面数量**。沿用已有 `-WebThreadingTest=full` 基准入口，两组均关闭异步 PSO 缓存合并；普通网页入口没有添加此基准参数。1% low 为采样区间最慢 1% 间隔的平均值取倒数。

首轮六次测试的基线只有约 27 FPS，新旧包随后分别恢复到 52.64 / 54.01 FPS。首轮后台有 Visual Studio 下载进程，后续该进程退出；没有隔离证明它就是全部原因。首轮全部保留，未混入上述收益计算。正式八轮没有 UE、游戏或编译器同时运行，仍有 TGitCache、Oopz、音乐等用户后台活动，属于带干扰的同机测试。

## 独立验证与剩余热点

独立测试使用 **共享内存 WASM64 + JSPI**，避免此前非共享内存测试不能体现 `growMemViews` 的差别。绑定组测试每批创建 80 个 group，分别有 0/1/8/16/32 条目；计时不含释放及队列等待，不将其直接换算为游戏 FPS。

三轮中位数再取中位数，单位 ms / 80 groups：

| 每组条目数 | 原 Emdawn 描述符 | 紧凑传输 |
|---|---:|---:|
| 0 | 0.0701 | 0.0502 |
| 1 | 0.1203 | 0.0804 |
| 8 | 0.3651 | 0.2350 |
| 16 | 0.6095 | 0.3999 |
| 32 | 1.1551 | 0.7101 |

32 条目时创建批次减少约 38.5%。测试组的布局 visibility 为 None，专门隔离描述符创建成本；不能外推为所有材质布局的固定收益。已有命令流的 3200 次绑定切换绘制，完整 CPU 前端约 0.615 / 0.620 ms，基本不变，符合该负载在计时前已创建绑定组的事实。

GPU 预检查增加 buffer + texture + sampler 的真实绘制、whole-size、标签回退，以及一个有可见样本、一个零样本的遮挡查询。保留提前释放资源、临时 dynamic offsets 覆写、资源表/命令区分批、两种融合序列和普通/间接绘制的像素读回检查。另一次插桩校验比较原生方法顺序、参数及标准化 bind-group 描述符；插桩计时不用于收益结论。

独立正常测试为 2 路径 × 3 轮 × 12 组合，共 72 个组合输出检查通过。另一次四种组合的校验，每种包含 984 个性能负载 pass、2 个 GPU 预检查 pass，以及 18868 个 bind-group 描述符，逻辑参数和方法顺序一致。首版校验将 dynamic offsets 的暂存内存起点当作参数差异，已改为比较传给浏览器的偏移值切片；失败报告保留为 `bridge-extras-equivalence.json`，通过报告为 `bridge-extras-equivalence-v2.json`。

v37 关闭两项实验后的独立 RHI 栈采样中，CreateGroups 仍占约 23.12%，SetDrawBindings 约 28.27%，分配路径约 10.96%，互斥等待约 7.79%，命令回放约 8.99%。这些是包含子调用的墙钟采样，存在重叠，不能相加。重点仍应放在 C++ 资源解析、绑定准备和分配器竞争；继续给低频 API 添加专用接口，预期收益有限。

最终 v38 默认页面的另一次采样也相近：CreateGroups 23.92%、SetDrawBindings 28.39%、分配路径 12.46%、互斥等待 6.76%、命令回放 9.03%。包含调用的占比不是各函数可独立消除的成本；优化变快后相对占比也可能不降。

源码中已有 entry、whole-group、bind-group 缓存及动态偏移复用，并非每个 draw 都创建新绑定组。仍可继续测量的是缓存失效后重复遍历、逐条唯一性检查、组键比较/哈希，以及临时结果数组的分配。需按命中/未命中分别采样，不能仅从 `CreateGroups` 函数名断定缓存未启用。

## 证据与复现

汇总与原始文件哈希见 `tests/web-platform/evidence/webgpu-bridge-audit-20261103.json`，由 `summarize-webgpu-bridge-audit.cjs` 校验和生成。原始大文件保留在本地 `tests/web-platform/results/`。

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/benchmark-villa-threading.cjs --folder=villa-bridge-extras-v37 --tag=bridge-new-ablation --transport=baseline,all,states,groups,groups,states,all,baseline
node tests/web-platform/audit-webgpu-bridge.cjs --folder=villa-bridge-extras-v37 --tag=bridge-new-audit --transport=all
./tests/web-platform/build-draw-api-benchmark.ps1 -CommandStream -PackedGroups -SharedMemory
node tests/web-platform/benchmark-draw-bridge.cjs --tag=bridge-new-micro --rounds=3 --variants=legacy-both,original
node tests/web-platform/benchmark-draw-bridge.cjs --tag=bridge-new-equivalence --rounds=1 --variants=legacy-both,legacy-states,legacy-groups,original --validate-calls
```

普通 FPS 测试、构建和其他性能测试顺序执行；带插桩的调用计数可以在构建期间运行，结果仅用于计数。
