# TriplexHouseVilla：提交、输出复制与上传写入实验

2026-11-06，接续 pass 合并实验。**本轮四项新方案均未取得稳定低帧收益，浏览器和桌面端仍未接近。** 保持 owner rAF、priority RHI wake、gpuahead=0、t.MaxFPS=0、VSync=0，内部和输出均为 1280×720，TSR、阴影、CSM 缓存及原 Cook。计算复用、RDG 合并、JS 数组复用关闭，避免叠加前轮变量。所有新开关默认 0。

## 新方案

| 开关 | 修改 | 顺序与生命周期约束 |
|---|---|---|
| `r.WebGPU.BatchSubmissions` | 一个 RHISubmitCommandLists 内的多个 command buffer 通过一次 queue.submit 提交 | 遇到 readback/fence 保留通知边界；不跨调用、任务或帧暂存；handle 保留到实际提交 |
| `r.WebGPU.ReusePresentEncoder` | 当前 encoder 尚未关闭时，在其末尾附加 canvas 复制 | 保留稳定 backbuffer；同一 owner 任务中获取当前纹理、复制、提交，不跨任务持有 canvas 纹理 |
| `r.WebGPU.FrameUniformSnapshots` | 不超过 64 KiB 的 MultiFrame 常量也使用既有帧常量页 | 快照在下帧失效并重新上传；保留每次更新的不可变偏移和帧末复用规则 |
| `r.WebGPU.BatchStagingWrites` | 在已有 staging 页基础上合并小 writeBuffer | 复制各用独立 256 字节对齐切片；页切换及每次提交前刷新；保留最多四个 1 MiB GPU 页及一个 1 MiB CPU 镜像，大块上传仍单独处理 |

没有修改 owner 等待、扩大在途帧数或降低阴影、分辨率、AA。后三项都可能只减少 API 次数而没有可用 FPS 收益，需要以实测为准。

## 测量方法

正常计时每版本两个 45 秒窗口，无 API wrapper、CPU profiler、trace、PresentMon 或 GPU 完成探针。按原始 RHI 帧间隔合并，1% low 为最慢 ceil(N×1%) 间隔均值的倒数，保留全部长帧。两个窗口共用已预热进程，属于短时筛查，不等于两次独立启动或统计稳定性证明。

第一组顺序为对照→批量提交→输出 encoder→小常量页，各两个窗口：

| 版本 | 平均 FPS | 1% low | 最长帧 ms | >33.33 ms 次数 |
|---|---:|---:|---:|---:|
| 同运行时对照 | 100.66 | 38.67 | 46.06 | 9 |
| 批量提交 | 101.14 | 38.94 | 48.12 | 8 |
| 输出 encoder 复用 | 100.80 | 38.39 | 45.00 | 9 |
| 小常量页 | 102.41 | 38.90 | 48.44 | 10 |

前三项没有稳定低帧改善，最长帧也没有一致变好，均不接受为默认优化。上述顺序没有首尾交错基线，小幅平均差不能排除运行间漂移。

第二组使用另一份包含上传批处理实现的完整构建；两个包的 Wasm、JS 和 Cook 相同。顺序为仅上传页 45 秒→合并写入 45+45 秒→仅上传页 45 秒，以控制窗口前后漂移。对照也开启既有上传页，因此不会把旧的 buffer 复用贡献算成新写入合并的收益：

| 版本 | 平均 FPS | 1% low | 最长帧 ms | >33.33 ms 次数 |
|---|---:|---:|---:|---:|
| 仅上传页，首尾合并 | 100.98 | 41.63 | 44.28 | 5 |
| 上传页 + 合并写入，两窗合并 | 101.11 | 41.32 | 42.82 | 5 |

平均仅增加约 0.13%，1% low 反而约低 0.74%，不接受默认启用。对照两次 low 为 41.10、42.35，合并写入为 41.45、41.38；自然波动大于表面平均收益。两组运行时不同，不拿第一组对照的 38.67 low 当作第二组方案的独占收益。

API 计数、GPU 完成及正确性另开诊断会话，不混入正常计时。初始计数约 11.11 encoder/提交、56 buffer 创建、53 writeBuffer/帧；稳定窗纹理和纹理视图创建为零。常量页试验只把 buffer 创建降到约 54/帧，支持继续检查 staging 来源，不能把全部 buffer 分配归给 uniform。

| API / 帧，仅诊断窗 | 对照 | 批量提交 | 输出 encoder 复用 | 小常量页 | 上传页 + 合并写入 |
|---|---:|---:|---:|---:|---:|
| queue.submit | 11.11 | 11.14 | 10.10 | 11.07 | 11.13 |
| command buffer | 11.11 | 11.14 | 10.10 | 11.07 | 11.13 |
| createBuffer | 55.98 | 56.00 | 55.99 | 54.00 | 11.00 |
| writeBuffer | 52.98 | 53.00 | 52.99 | 51.00 | 9.13 |
| createBindGroup | 34.68 | 34.57 | 34.75 | 27.92 | 34.72 |

批量提交窗中 command buffer 数与 submit 数仍相等，说明当前场景几乎没有可在单次 RHI 提交内合并的列表；不能把微小 FPS 差归为批量优化收益。输出 encoder 确实每帧省去约一次创建和提交，但没有改善低帧。小常量页虽然 bind group 创建减少约 20%，尾部帧耗时没有相应改善。

按 GPUBuffer usage 分类，约 45 / 56 次创建来自 COPY_SRC | COPY_DST 上传暂存；其余约 4 次 MAP_READ | COPY_DST、5 次 COPY_DST | UNIFORM、各 1 次其他用途。合并上传窗只创建 11 个 buffer/帧，保留 GPU 页共 4 MiB；实际 GPU 回读比对 1,024 个切片、4,292,208 字节，其中 1,002 个切片为非零偏移，无错误。减少 API 调用是真实的，但不直接等于提高帧率。

增加按 size/usage 分类的 buffer 计数及首次代表栈，仅诊断开关启用。新增小常量方案已完成约 559 万次绑定条目重算校验与纹理上传→复制→异步回读。上传验证器支持在编码后才发出的合并写入：在提交时寻找覆盖整个切片的最新写入，实际 GPU 复制后回读目标并逐字节比较。其验证用例覆盖独立写入、延迟合并写入、缺失写入与数据损坏检出。

对照及批量提交诊断最初按每个 size/usage 保存首个调用栈，后续缩减为每种 usage 一份、最多八份。因此这些带包装的 GPU 完成回调数据仅留档，不用来横向证明队列或延迟改善。普通计时没有启用这些包装。

## 桌面复测及差距

同一桌面包重新采集两个各 9,000 帧的窗口，不与浏览器测试、编译重叠。日志核对 t.MaxFPS=0、VSync=0、FinishCurrentFrame=0、CSM 缓存开启：

| 桌面路径 | FPS / 1% low | 最长帧 ms | RHI ms/帧 | draw/帧 |
|---|---:|---:|---:|---:|
| SM5，RayTracing=0，与既有 Web 对照一致 | 233.51 / 183.03 | 6.34 | 1.890 | 1190.33 |
| 默认 SM6，保留项目 RayTracing=1 | 221.42 / 165.75 | 6.99 | 1.858 | 1190.35 |

SM6 是额外记录，不混入 SM5 基线，也不能将两个顺序窗口的差归结为 SM6 单独成本。浏览器上传合并约 101.11 / 41.32，仍远低于原生；Web RHI 约 6.80 ms、draw 约 1350，原生 SM5 RHI 约 1.89 ms、draw 约 1190。不同路径仍有阴影六面绘制、WebGPU 命令处理、稳定 backbuffer 输出复制、owner 调度和浏览器呈现等差异。删除一次输出提交和大量上传 API 后低帧没有稳定改善，排除了“只要减少这些调用就能追平”的假设，但尚不能将剩余约 4.9 ms 的 RHI 差全归给其中一项。

两次桌面 CSV/日志完整关闭后均为既有退出码 777003，记录 cleanExit=false。它们可用于该窗口数据分析，不称作完整生命周期测试通过。

## 画面、最终构建与复现

四项实验与共同对照的右、后、左、室内、返回五个机位均完成截图及相机一致性核对。人工检查未见明显新增材质、光照或阴影缺失；排除顶部 90 像素 HUD 后，各通道平均绝对差为 0.34–1.25 / 255，包含时域差异，不是逐像素等价证明。合并上传使用第二份构建，画面检查也不能代替同二进制的性能比较。对照图为 `tests/web-platform/results/parity-submit-tour-comparison-20261106.jpg`。

复查发现同时启用旧上传页和新批处理时，运行中关闭再开启批处理可能让脏区跨过中间直接写入的切片。最终代码增加关闭时先刷新；重新完整构建后，两个上传开关同时启用，再次通过 1,024 个真实 GPU 切片回读（4,290,936 字节、1,002 个非零偏移）、纹理回读及五机位检查，无运行期 GPU 错误。回读比较的是提交前 writeBuffer 输入与实际复制目标，不单独证明 CPU 镜像构造的全部正确性。上述性能表保留原测量包，固定启动开关，不重新标为最终修正构建的性能结果；热切换本身只有代码边界审查，未完成自动化现场切换测试。

手工回退入口：[性能回退检查](http://127.0.0.1:8765/villa-parity-test.html)。主按钮保留第二组实测包，另外提供前三项及前轮 pass 实验的对照链接。每次仅启动一个版本。四项新方案均不默认启用；新的上传方案未完成固定移动路线、真实键鼠延迟及物理呈现验收，不宣称体感更顺滑。

测试页已检查 14 个链接均返回 200、同标签打开、保留 owner/priority/gpuahead=0 与真实输入桥参数，并完成页面截图复核。

## 资料与代码依据

[WebGPU queue.submit](https://gpuweb.github.io/gpuweb/#dom-gpuqueue-submit) 接受 command buffer 序列；[异步与 Promise 顺序约束](https://gpuweb.github.io/gpuweb/#promise-ordering)说明完成通知及 mapAsync 有明确但有限的排序保证。实现保留原通知边界，没有把不同帧积累到一起再提交。GPU 完成通知包含 owner 回调延迟，不是精确的硬件执行时间或物理呈现帧率。

[WebGPU writeBuffer](https://gpuweb.github.io/gpuweb/#dom-gpuqueue-writebuffer) 在调用时取得输入字节副本，实际队列写入必须先于消费它的提交。本轮只合并尚未提交且偏移不重叠的切片，并在提交及换页前刷新。[微软 D3D12 命令队列说明](https://learn.microsoft.com/en-us/windows/win32/direct3d12/executing-and-synchronizing-command-lists)描述原生队列支持多线程提交及显式同步；它不意味着 Web 的 owner、canvas 生命周期和浏览器事件循环可以直接照搬原生。这里采用的是局部批处理实验，没有改变 owner 等待。

既有上传页只复用 GPUBuffer，仍逐笔 writeBuffer，见 `UE58_WEBGPU_BUFFER_LIFECYCLE.md`。本轮批量写入进一步合并 CPU 镜像的脏区；独立大块、回读、页切换都保留刷新边界。源码位于 `WebGPUDynamicRHI.cpp/.h` 与 `WebGPUViewport.cpp`，不修改参考引擎或安装目录。

完整原始采集在 `tests/web-platform/results/`。汇总由 `summarize-villa-submit-experiments.cjs` 重算并验证包内 Wasm、JS、Cook 哈希；`performanceAccepted` 与物理呈现验证单独记录，运行成功不等于性能验收。

构建使用 `D:/UE_5.8` 工具与本地覆盖，参考引擎及 `H:/UE_5.8` 均未修改。证据为 `tests/web-platform/evidence/villa-submit-experiments-20261106.json`；验证器用例为 `node tests/web-platform/verify-web-upload-staging-validator.cjs`。保存全部窗口、两种原生路径、诊断来源、截图、构建和包哈希，未删除长帧。主仓库本地中文提交，不推送远程。
