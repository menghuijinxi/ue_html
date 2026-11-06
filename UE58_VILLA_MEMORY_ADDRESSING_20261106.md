# TriplexHouseVilla：内存寻址、绑定复用及尾帧复测

2026-11-06。**找到可重复的平均帧率与固定路线低帧收益：保留 wasm64 的 C++ ABI，在最终链接把线性内存和表寻址降低为 32 位。** 两轮固定移动平均约 +11.1%、1% low +8.4%；固定转向平均 +5.7%、1% low +10.3%。不过静止长帧更多，自由输入也没有证明更平滑，所以仍是可回退候选，不升级默认设置，也不宣称浏览器与桌面端已接近。

测试入口：[候选与对照](http://127.0.0.1:8765/villa-parity-test.html)。每次只运行一个版本。

## 改动及归因

新增构建选项 `-LowerMemory64`，向最终链接传 `-sMEMORY64=2`。保留同一份 417 个 C++ 对象文件及其编译响应、源码、定义文件 SHA256；没有重新使用 32 位 C++ 布局。包之间仅 JS、Wasm 和 index 版本信息不同，Cook、shader、config、host、worker、IO 文件全部一致。最终对照及候选都开启已有的计算 pass 复用，因此表格里的差额不包含这项旧优化的贡献。

Wasm 实际导入/定义节审计如下，未仅凭命令行推断：

| 属性 | 对照 | 候选 |
|---|---:|---:|
| C++ 对象 ABI | wasm64 | wasm64，同对象 |
| 线性内存地址 | 64 位 | 32 位 |
| 函数表地址 | 64 位 | 32 位 |
| shared memory | 是 | 是 |
| 初始线性内存 | 128 MiB | 128 MiB |
| 最大线性内存 | 2 GiB | 2 GiB |
| Wasm 文件大小 | 182,560,219 字节 | 171,489,686 字节 |

Emscripten 文档明确说明这种模式使用 clang/lld 的 wasm64 ABI，再通过 Binaryen 降低寻址。实际 SDK 6.0.9 的 settings 和 link.py 也包含该路径。它不是移除内存安全检查，也不是浏览器启动参数优化。上游目前正在讨论弃用 `MEMORY64=2`，所以只保留显式选项；SDK 升级时必须重新验证。本项目当前本就限制为 2 GiB，本轮不能证明超过 4 GiB 的项目兼容性。[官方设置说明](https://emscripten.org/docs/tools_reference/settings_reference.html#memory64)、[上游弃用讨论](https://github.com/emscripten-core/emscripten/issues/27952)。

这是对最终 Wasm 内存/表指令及其生成代码的组合干预，尚未隔离内存指令、间接调用和 JS 转换各自的收益。V8 当前源码也有 memory64 trap handling 路径，不能直接断言所有收益来自“去掉每次 bounds check”。[V8 内存边界检查选择](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/wasm/wasm-module.cc)。

本轮采样重新确认 RHI owner 是主要 CPU 热点：采样叶节点中 Wasm 41.47%、WebGPU API 13.75%、JS 12.22%、idle 28.77%、GC 0.42%；包含子调用的 CreateGroups 17.16%。Render 有约 52.24% futex 等待，Game 约 80.3% idle。这是计时后单独采集的短栈，不能把占比直接换算为收益，也没有定位全部 low 帧原因。场景 manual vertex fetch 实际关闭，因此未继续实施基于该假设的缓存优化。

## 同设置测量

可见 Edge 156、i9-12900K、RTX 4090。内部/输出 1280×720、DPR 1、TSR、CSM 缓存、原场景 Cook。owner rAF、priority RHI wake、gpuahead=0、t.MaxFPS=0、r.VSync=0。没有修改 owner 等待、Game/RHI 调度或 GPU 提前帧预算。两个新绑定实验、上传页、RDG 合并、JS scratch 复用均关闭。

普通计时没有 CPU profiler、trace、GPU 完成探针或逐 draw 的 API 包装；固定路线只计数 shader/pipeline 创建，以确认稳定段没有新增编译。静止每次独立启动，流送/预缓存就绪后预热 30+5 秒。1% low 为最慢 ceil(N×1%) 原始间隔均值的倒数；不删除长帧，不把不同窗口的间隙算作一帧。这里测量 RHI 提交间隔，不是物理屏幕的新画面间隔。

### 静止：独立启动 ABBA

| 顺序 | 平均 FPS | 1% low | RHI ms/帧 | 最长 ms | >33.33 ms | >50 ms |
|---|---:|---:|---:|---:|---:|---:|
| 对照 A1，45 秒 | 99.05 | 35.91 | 6.931 | 61.59 | 7 | 2 |
| 候选 B1，45 秒 | 108.21 | 37.05 | 6.320 | 60.85 | 11 | 2 |
| 候选 B2，45 秒 | 107.77 | 35.95 | 6.362 | 55.38 | 12 | 3 |
| 对照 A2，45 秒 | 99.07 | 38.98 | 6.890 | 47.86 | 7 | 0 |
| 对照合并 | 99.06 | 37.31 | — | 61.59 | 14 | 2 |
| 候选合并 | 107.99 | 36.49 | — | 60.85 | 23 | 5 |

平均 +9.02%，但 low -2.20%。两次基线平均几乎一致，支持平均收益可重复；不能据此称尾部延迟改善。draw 约 1356/帧、dispatch 约 161.5/帧，均基本一致，没有以少绘报提升。

后续自由输入启动因 C 盘空间不足而报 OPFS quota。核对仅余约 1.95 GiB；把本轮已退出的隔离浏览器 profile 迁至 G 盘保存，未删除原始测量、Cook、用户浏览器资料或结束用户应用。最初的删除缓存命令被执行策略拦截，实际采用完整迁移。恢复后补测 A→B 各 60 秒：

| 补测 | 平均 FPS | 1% low | 最长 ms | >33.33 ms | >50 ms |
|---|---:|---:|---:|---:|---:|
| 对照 | 98.68 | 36.90 | 62.17 | 8 | 2 |
| 候选 | 108.89 | 39.83 | 66.81 | 8 | 3 |
| 全部 150 秒对照 | 98.91 | 37.08 | 62.17 | 22 | 4 |
| 全部 150 秒候选 | 108.35 | 37.69 | 66.81 | 31 | 8 |

补测平均 +10.35%、low +7.94%；全部静止数据平均 +9.55%、low 仅 +1.64%。这不是纯净的同一组 ABBA，磁盘压力前后的窗口分别保留。不能将前组低帧回退丢弃，也不能把它直接归咎于配额问题。候选超过 33/50 ms 的数量仍更多。

![全部静止帧间隔](tests/web-platform/results/parity-memory-frame-times-20261106.png)

### 固定路线：B→A 后 A→B 反向复测

每次独立启动，各阶段 20 秒，预热 30 秒。相机在实际 Game tick 内按墙钟插值推进，不依靠低频 RPC 模拟连续移动。起终点、画质、分辨率逐项核对。moving/turning 在测量前走预热路线；两轮稳定段无新 shader/pipeline 创建。首次区域各有 1 个 shader、2 个 pipeline 创建，完整保留其停顿，不称为编译完全预热。

| 场景，两轮原始间隔合并 | 对照 FPS / low | 候选 FPS / low | 平均 / low 变化 | 最长 ms，对照→候选 |
|---|---:|---:|---:|---:|
| 首次区域穿行 | 98.62 / 30.71 | 109.81 / 37.52 | +11.35% / +22.19% | 55.61 → 55.14 |
| 固定往返移动 | 101.78 / 34.05 | 113.04 / 36.93 | +11.06% / +8.45% | 66.06 → 48.89 |
| 原地 360° 转向 | 94.09 / 32.67 | 99.48 / 36.05 | +5.72% / +10.33% | 70.81 → 54.88 |
| 重复区域穿行 | 109.39 / 35.15 | 116.26 / 37.92 | +6.27% / +7.88% | 58.68 → 53.48 |

各轮的低帧都比对应对照高，但不是没有长帧：固定移动 >33 ms 次数为 9→13，转向 10→10，重复穿行 8→10。候选更短的主体帧、减少的极长帧与仍存在的中等长帧需一并判断。此路线绕过 Pawn 碰撞，不能代替输入延迟和实际体感测试。

## 排除假提升及正确性

另开静止 GPU 完成诊断，保持相同探针且没有 API 计数包装。完成回调峰值均为 4，平均延迟 13.77→12.93 ms，最长 39.46→41.48 ms；两边记录全部完成。不能将未收到回调数等同于正在执行的 GPU 帧数，更不能用它证明物理呈现。

连续 DOM 键鼠通过包内 owner-forwarded 输入桥测试，两边都实际移动和转向。候选移动距离 2702 cm、对照 2515 cm，draw 1724 vs 1612/帧，所以该段不可作为公平性能 A/B。其结果仍保留：

| 自由输入诊断 | 对照 | 候选 |
|---|---:|---:|
| FPS / 1% low | 96.96 / 32.83 | 102.66 / 30.28 |
| GPU 完成回调峰值 | 4 | 5 |
| 完成回调平均 / 最长 ms | 13.71 / 50.52 | 13.44 / 57.11 |
| 页面观察进度 / 提交进度 | 99.13% | 97.96% |

这段没有证明候选更平滑，也不证明与固定路线结论矛盾：负载不同、未测物理新画面。`physicalPresentationValidated=false`、`performanceAccepted=false` 保留；不将刷新率或页面进度包装成真实呈现 FPS。

对照与候选分别完成 5,207,094 / 5,683,941 次绑定条目重算、800,952 / 870,459 次整组重算，纹理上传→复制→异步回读通过。五个同视角人工图像检查未发现亮度、阴影或缺失差异；排除 HUD 后 RGB 平均绝对差为 0.21–0.79/255，仅作描述，不作为自动像素验收。另有六次相机切换、四次窗口/DPR 变化（1 / 1.5）通过，无 GPU 校验错误、设备丢失或崩溃。

![五视角对照](tests/web-platform/results/parity-memory-visual-20261106.jpg)

## 本轮其他方案

| 方案 | 实现/校验 | 结果及决定 |
|---|---|---|
| 跨 access generation 复用绑定组 | 保留当前 texture/buffer 访问、锁定、transition/attachment 校验；仅省 descriptor 准备 | 短测 101.01 / 38.77，约 559 万条目校验；未测出明显收益，默认 0 |
| 动态 Globals 只更新 offset | 区分资源/Globals 版本；同 buffer、size 才复用，页切换回原路径 | 短测 101.14 / 39.89，约 528 万条目校验；默认 0，不计入候选收益 |
| 仅降低内存/表寻址 | 同对象、同配置，先做筛查及 ABBA | 筛查 110.58 / 41.22；初组 ABBA 有共同漂移，合并 94.48 / 34.37→100.68 / 34.84；单独转向 low 有回退，继续测试组合 |
| lowering + 最终 O2 + 完整调试信息 | 编译器尝试 | Binaryen 返回 3221226505；失败保留 |
| lowering + 最终 O2 + 常规调试信息 | 成功构建、绑定重算/回读通过 | 133.50 FPS，但 draw 约 710 vs 正常 1350、dispatch 约 106 vs 161；多个视角显著偏亮，阴影错误，明确淘汰 |
| lowering + 固定 2 GiB 内存 + 计算复用 | `-FixedHeap2GiB`；生成 JS 的 402 处 growMemViews 调用消失，约 566 万绑定条目重算通过 | 短测 109.00 / 34.87，无额外低帧收益；默认关闭；没有做充分 ABBA，不能声称确定回退 |

固定内存实验依据 pthread + memory growth 需要处理 JS view 更新的实际实现与编译警告，未预先断言它就是长帧原因。[WebAssembly 共享内存增长讨论](https://github.com/WebAssembly/design/issues/1271)。最终 O2 还执行 Binaryen/JS 优化，与 C++ 的编译 O2 不同；本轮画面错误仍未定位到具体 pass，不能称 Binaryen 已被证实存在 bug。[Emscripten 优化说明](https://emscripten.org/docs/optimizing/Optimizing-Code.html)。

## 桌面端与剩余差距

同包 D3D12 SM5、RayTracing=0、CSM=1，1280×720、TSR、MaxFPS/VSync/FinishCurrentFrame=0，两次各 9,000 帧完整保存：

| 本轮桌面窗口 | FPS / 1% low | 最长 ms | >50 ms |
|---|---:|---:|---:|
| 第一次 | 188.64 / 29.68 | 669.27 | 7 |
| 第二次独立复测 | 218.70 / 166.64 | 6.80 | 0 |

第一次的 7 个异常长帧集中于窗口后段，包含 Game/RHI 停顿，原因未确定；没有删除这些帧，不能利用受压低的桌面 low 宣称 Web 达标。第二次 RHI 1.866 ms、GPU 3.421 ms、draw 1190.34/帧；Web 候选静止 RHI 约 6.3 ms、draw 约 1355/帧，仍有明显差距。Web 与 D3D12 的 RHI 计时边界也不完全相同，不能将差额全部等同于桥接成本。

已有架构差异仍在：Web 点光阴影需要六个 2D depth face 及复制到 cubemap，WebGPU 编码/验证与浏览器 GPU 进程存在额外路径，且 owner 还承担事件与完成回调。本轮没有修改这些路径，也没有通过减少阴影/AA、关闭等待或扩大在途帧掩盖差距。

两次桌面采集均在 CSV 完成和日志关闭后返回已知 777003；`cleanExit=false`，只使用完整性能窗口，不宣称退出生命周期通过。此前同日稳定桌面为 233.51 / 183.03，也保留在前轮证据中。

## 复现及保存

构建：`build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4 -LowerMemory64`。包名：`villa-address32-compute-20261106` / `villa-address64-compute-20261106`，都从对应 runtime 加 `--csm --reuse-compute` 生成。默认构建已再次重建，JS/Wasm 与本轮原始 memory64 对照逐字节一致；所有新选项默认关闭，未修改 H:/UE_5.8。

证据生成器 `tests/web-platform/summarize-villa-memory-addressing.cjs` 校验对象/包 hash、Wasm 内存节、画质、相机、路线终点、预缓存、输入、回读和缩放报告。机器可读结果：`tests/web-platform/evidence/villa-memory-addressing-20261106.json`。完整逐帧、日志、截图位于 `tests/web-platform/results/parity-address*`。画面对比/逐帧图生成器为 `compare-villa-memory-visuals.py`，绘图库安装在工作区 `.tools/perf-plot-deps`，不改变系统 Python。

页面 18 个入口已检查 HTTP 200、同页打开、owner、gpuahead=0、priority、owner-forwarded；保留以往实验供复查。失败的 O2 画面版本没有加入页面入口。
