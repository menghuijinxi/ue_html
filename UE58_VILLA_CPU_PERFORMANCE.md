# 别墅 CPU 提交瓶颈调查与修复

本文是 `4b8cb6d` 任务线程版本的历史结果。后续已实现独立 Game / Render / RHI 线程并进一步复用常量页，当前实现和测试见 [独立渲染线程报告](UE58_VILLA_RENDER_THREADS.md)。

本机：i9-12900K、RTX 4090、Edge 156。场景与资源为 `TriplexHouseVilla` 原项目设置包，未降低渲染质量、距离场、贴图、阴影、LOD 或绘制距离。

## 多线程实际状态

运行时确认共享 WASM 内存、Engine Worker、任务工作线程均已启用：`sharedMemory=true`，游戏线程 ID 为 1，探针任务在线程 ID 2 执行。PThread 池实测 12 个活动线程、4 个预建空闲线程；这包括引擎辅助线程，并不代表 12 核持续进行渲染。平台目前最多向 UE 报告 4 个逻辑核心。

`FWebPlatformMisc::UseRenderThread()` 明确返回 false，启动参数为 `-norhithread`。因此游戏、渲染和 WebGPU 提交共用 Engine Worker 所在的线程。任务系统可以并行，但主要绘制提交没有独立的渲染/RHI 线程。当前 WebGPU 句柄和 JS 对象属于 Engine Worker，直接修改线程开关会违反所有权；本轮未以这种方式强行启用线程。

## CPU 时间花在哪里

`profile-web-cpu.cjs` 使用 Chromium 的 Worker CPU 采样器，取得实际运行 WASM 的调用栈，并同时记录帧数、UE Tick 时间、API 调用数量、线程状态及进程显存。原运行时归档在 `build/villa-cpu-baseline`，与正式包共用字节相同的 Cook 资源；运行时和加载脚本分别归档，避免用不同配置解释性能差异。

修复前客厅 CPU 栈采样估算：

| 路径 | 时间 / 帧 |
| --- | ---: |
| `CreateGroups`，含其子调用 | 24.81 ms |
| 其中创建 WebGPU 绑定组 | 9.91 ms |
| 其中采样纹理绑定校验 | 4.76 ms |
| 帧末绑定组清理 | 2.46 ms |
| GPU 调试标记的完整路径生成与提交 | 2.15 ms |
| Worker 状态快照 | 1.97 ms |

这些行有父子包含关系，不能相加。日志中的 `GetStats not implemented` 确实每帧输出，但 CPU 栈中该函数只有约 0.02 ms/帧，不是本次主要瓶颈。没有用屏蔽日志代替定位。

资源绑定热路径中有反复的 JSON 查找、字符串构造和重复的纹理解析/访问校验；每帧约 2633 个绑定组创建还伴随布局获取、WASM↔JS 转换、引用管理和内存分配。Worker 每 100 ms 又对全部流式资源执行 MEMFS 路径查找。大量时间耗在单个提交线程上，GPU 利用率因此较低。

## 已修复

- 着色器加载时缓存纹理反射契约，绘制时保留类型、维度、范围及访问状态校验；一次纹理解析同时返回已验证的纹理视图，避免重复处理。
- 按管线缓存绑定组布局。相同绑定组可跨帧复用，每帧结束删除本帧未用项，仍保留 8192 项上限。旧流式纹理或常量页的缓存引用最多多保留一帧；没有恢复无限持有旧资源的行为。
- 使用 WebGPU 动态 uniform 偏移，将每次绘制的常量偏移从不可变绑定组键中分离。偏移按 binding 编号排序，并保留 256 字节对齐、实际设备动态 uniform 数量上限、完整绑定内容比较和 GPU 引用持有。超过设备数量限制的 uniform 继续用静态偏移。
- Worker 挂载时保存 bulk 文件节点，统计直接读取节点，不再定时遍历并解析全部路径。
- 正常运行不逐 pass 生成 GPU 调试标记，CPU breadcrumb 栈及配对校验保留；调试模式仍发送 GPU 标记。

## 对照与验证

对照入口为 `profile-web-villa.cjs --project-settings`，只调整测试相机，禁止该模式下的遮挡/阴影预算等诊断覆盖。内部和输出均为 1280×720、DPR 1、正常游戏时钟。每视角预热后采样 10 秒，GPU 时间来自三个单帧 pass 时间戳，包含采样开销；不是整卡 GPU 利用率。

修复前：`villa-performance-cpu-baseline-gpu.json`；最终：`villa-performance-cpu-final-gpu.json`。

| 视角 | 修复前 FPS | 修复后 FPS | 修复前 CPU 回调 | 修复后 CPU 回调 |
| --- | ---: | ---: | ---: | ---: |
| 客厅 | 19.22 | 26.69 | 47.11 ms | 35.41 ms |
| 看墙 | 26.62 | 33.96 | 34.00 ms | 28.29 ms |
| 返回客厅 | — | 26.81 | — | 35.28 ms |

客厅与看墙分别约提高 39%、28%。客厅索引绘制约 2262→2264 次/帧，绑定组创建约 2633→1863 次/帧；没有通过减少绘制来提速。看墙主体数量会受到异步遮挡结果到达时间影响，最终绘制约 1543 次/帧，高于基线的 1256，不能把两次墙面样本视为命令完全相同的对照。客厅 GPU pass 总和约为基线 9.0～11.7 ms、最终 7.9～9.1 ms，明显短于 CPU 回调，仍受 CPU 提交限制；返回客厅 GPU 样本约 5.6～6.0 ms。各段不是同时测量，也不包含全部复制/排队间隙。

独立显存回归 `project-memory-cpu-final.json` 完整通过：90 秒、2728 帧、三个视角，GPU 错误为 0。室内、厨房、返回室内的专用显存分别约 1716、1762、1755 MiB；活跃缓冲约 48.2、48.9、48.1 MiB。返回后缓冲回到原水平，未重现旧版持续增长。缓存最多多保留一帧的常量页，因此与旧版约 46～47 MiB 的缓冲相比有少量有界增量。

前后同视角截图平均 RGB 绝对差为客厅 0.81/255、看墙 0.49/255，包含 TAA 与游戏时间差；截图人工检查正常。原项目 1632 个输入哈希均未改变。最终线程构建 `web-engine-full-thread-20261031-132300.log`、WASM 校验及打包审计通过。

移动回归 `project-gameplay-cpu-final.json` 两轮均通过：可见浏览器、1899×1068 CSS 视口、DPR 1.21，每轮从第 2 帧开始按键移动、转向和调整窗口，持续 45 秒，分别运行至第 603、599 帧；相机最大位移约 154 cm、转向约 31.5°，均无 GPU 验证错误、设备丢失或引擎崩溃。这是短时移动回归，不代表已覆盖整张地图长时间游玩。

CPU 栈的中间版本对照为 `cpu-baseline-counted.json`、`cpu-dynamic-fixed.json` 及对应 `.cpuprofile`。中间优化将 `CreateGroups` 由约 24.81 降至 15.05 ms/帧，快照由约 1.97 降至 0.09 ms/帧。采样器会影响绝对帧率，最终 FPS 采用不启用 CPU 栈采样器的独立对照。

本轮定位并修复已测到的串行开销。主线程仍承担游戏和绘制提交，尚未实现 WebGPU 所有权跨独立渲染线程的桥接，不能将任务线程已启用描述为完整的 UE 并行渲染支持。

复测（工作区根目录，沿用已配置的 Playwright `NODE_PATH`）：

```powershell
node tests/web-platform/profile-web-cpu.cjs --tag=cpu-repeat --seconds=15 --visible
node tests/web-platform/profile-web-villa.cjs --tag=cpu-gpu-repeat --folder=triplex-project-distance-fields-threads --warmup=120 --seconds=10 --project-settings --phases=room-on,wall-on,room-restored
```
