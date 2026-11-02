# WebGPU 启动 PSO 复用修复（2026-11-02）

本轮继续调查此前预缓存增加启动时间、却没有改善首次转向长帧的问题。已合入外围仓库 `origin/master` 的 `1f095f7`，引擎同步到 `origin/html` 的 `061234ef2`，保留此前本地工作。没有推送远端。

引擎修复提交：`4ffc20ee52bbe24d5643ceb5e8bba5c24f39f4de`；外围合并提交：`6f8d650`。最终运行时构建的 451 项源码指纹复核无过期项。

## 已确认的问题与修复

1. `FWebGPUVertexDeclaration` 原先没有覆盖 `GetPrecachePSOHash()`，继承值始终为 0。UE 的预缓存去重因此不能区分实际网格的不同顶点布局。现在覆盖哈希及 `GetInitializer()`，哈希包含流索引、格式、偏移、属性、步长和实例步进。D3D12 可以排除步长，WebGPU 的 `arrayStride` 属于管线描述，必须包含。
2. UE 原生预缓存通常先创建并释放推测 PSO，实际绘制再通过 RHI 创建，由驱动缓存降低成本。保留对象的内存策略还默认限定 NVIDIA / Qualcomm，Web RHI 的厂商标识不能用于此判断。现在 Web 接入 UE 现有的有容量上限的内存缓存，并在实际创建前直接取出已成功完成的 RHI 对象；在读锁内增加引用，继续沿用 UE 的清理和淘汰逻辑。图形上限 2000、计算上限 1000，未另建一套无限缓存。
3. 剩余的一条首次转向管线为 `FScreenVS / FCopySceneColorPS`，来自透明材质的场景颜色复制。为 Web 注册 UE 全局 PSO 收集器，收集该通道的真实屏幕绘制声明、状态、编码排列和目标格式。

缓存中的图形 PSO 还显式持有 shader、顶点声明及固定状态的引用，防止原材质或编译任务释放后留下悬空指针。计算 PSO 的 UE 基类已持有计算 shader 引用。

修复仅用于 Web，正常桌面条件保留。启用入口仍是 `-WebPSOPrecacheTest`。浏览器启动后调用异步 WebGPU 管线创建，Cook 负责着色器资源，不是在 Cook 机器上生成当前 GPU 的最终 PSO。每次新运行都要建立相应 GPU 对象；浏览器自己的持久缓存行为不等于应用可导出的 PSO 二进制缓存。

开启预缓存的页面会等待 UE 队列与实际异步回调全部完成后再显示场景，并重置帧率统计。准备期间显示剩余任务，暂停游戏输入。没有通过改变画质或隐藏场景对象提高统计结果。

## 旧资源的功能复核

正式性能测试前，用保留的 TAA Cook 资源排除管线复用错误。这些检查与新 Cook 并行运行，仅作为功能证据。

- `pso-reuse-v15-taa-coverage.json`：实际绑定 84 条成功的异步预编译图形管线；转向新增管线由历史版本的 15 条降到 1 条。
- `pso-reuse-v16-taa-coverage.json`：补齐场景颜色复制后，实际绑定 85 条；转向新增图形管线为 0，GPU 错误为 0。
- 页面通过观察 `GPURenderPassEncoder.setPipeline` / `GPURenderBundleEncoder.setPipeline` 确认对象确实用于绘制，同时记录 C++ 的唯一复用对象数与绑定次数。没有把“异步请求完成”直接当作“命中成功”。

这些旧资源的实际 AA 为 2，不能作为 TSR 性能结论。

## 正式构建与性能测试

刷新等待的进一步调查见 [WebGPU 刷新后的 PSO 等待调查](UE58_WEB_PSO_RELOAD_DIAGNOSTICS.md)。后续跟踪已确认 Dawn 缓存读取存在命中，不能把本页记录的整体准备时间都解释为从头编译；独立页面重建同批管线仍有约 18 秒成本。

使用合入 TSR 更新后的源码重新编译 Web 运行时、原生 Cook 所需 Renderer / RenderCore，再对 `G:/UE_HTML/TriplexHouseVilla` 完整 Cook。没有使用其他机器的打包产物。

- Web 编译、417 个对象完整链接通过；构建报告 `tests/web-platform/results/web-engine-full-thread-build-results.json`。
- Cook 输出 `tests/web-platform/build/web-project-triplex-pso-tsr-desktop-cook/20261102-140157`，退出码 0，5159 个产物、3,593,766,677 字节。日志为 0 个错误、14 个警告，保留于对应 Cook 报告引用的日志中。
- 原项目 1632 个输入文件哈希不变，打包的 `DefaultEngine.ini`、`DefaultGame.ini`、`DefaultInput.ini` 与原项目一致；`qualityOverrides=[]`。核对记录：`tests/web-platform/results/pso-reuse-v17-project-config.json`。
- 实际 AA 为 4（TSR），距离场、DFAO、距离场阴影继续启用；GI、反射方法、虚拟阴影沿用项目原值 0。没有手动切换这些设置。
- `web-tsr-pso-reuse-v17.json` 验证了 8 类 TSR 通道实际 dispatch，移动 135.27 cm、缩放画布后恢复均通过，未施加诊断画质覆盖，页面及未捕获 GPU 错误为空。

对照包共享完全相同的 JS / Wasm、Cook 内容与项目配置。开启包只增加 `-WebPSOPrecacheTest` 启动参数。

| 运行时文件 | SHA-256 |
| --- | --- |
| UEWebEngineThreads.js | `10ae6c3d2165e2029b0e3820e9380f00f315cb0bbca2f0f0e76775586107d53c` |
| UEWebEngineThreads.wasm | `55494677ceef4bec6868de1ee77fc92f1ae3651e818ddbc81ef8a155586fcc16` |

### ABBA 四轮结果

测试于同机有界面 Edge 156.0.4314.58 / NVIDIA Lovelace 上运行，每轮重开浏览器，保留浏览器及驱动缓存。运行期间大型游戏已关闭，Cook 和编译进程已结束。视角、项目设置、内部 1484×835 / 输出 2290×1288 在四轮间一致，没有限制 60 FPS。

加载及预编译结束后额外等待 15 秒，再依次采样静止 10 秒、首次转向 25 秒、重复转向 25 秒。帧间隔取渲染所属 Worker 的提交间隔；整段 1% Low 为最慢 `ceil(N×1%)` 帧的平均耗时倒数，另记录近 5 秒滚动 Low 最低值。它不能等同于显示器上每个实际呈现间隔。

首次转向结果：

| 次序 | PSO | 平均 FPS | 整段 1% Low | 近 5 秒 Low 最低值 | 最长帧 ms | 新建图形 PSO | 新建 shader module |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 关 | 68.77 | 16.26 | 5.35 | 385.28 | 15 | 10 |
| 1 | 开 | 68.45 | 25.63 | 17.86 | 69.66 | 0 | 0 |
| 2 | 开 | 68.30 | 26.65 | 18.51 | 66.75 | 0 | 0 |
| 3 | 关 | 68.90 | 16.99 | 5.55 | 370.21 | 15 | 10 |

两次开启的整段 Low 均值比两次关闭高约 **57%**，最长帧均值下降约 **82%**；首次转向平均 FPS 变化约 **-0.7%**。关闭时每次有 2 个超过 83 ms 的帧、其中 1 个超过 166 ms，开启后均为 0。

静止平均 FPS 关闭为 49.72 / 50.34，开启为 49.13 / 48.32；重复转向平均 FPS 关闭为 70.88 / 70.15，开启为 66.88 / 68.62，重复转向 Low 分别为 28.69 / 27.81 与 25.80 / 27.97。当前证据支持改善首次使用卡顿，**不支持提高稳定平均帧率**，部分热运行样本还有小幅下降。四轮功能检查均通过，同组静止 FPS 漂移约 1–2%，`performanceComparable=true`。每组仅两次样本，不能把小幅变化解释为确定的收益或回退。

完整逐帧原始记录：`tests/web-platform/results/pso-reuse-v17-tsr-abba.json`。可复现命令：

```powershell
node tests/web-platform/benchmark-web-pso-precache.cjs --off=villa-pso-reuse-v17-tsr-off --on=villa-pso-reuse-v17-tsr-on --tag=pso-reuse-v17-tsr-abba --fresh-browser --aa=4
```

### 启动成本与实际复用

开启时页面就绪为 36.48 / 37.12 秒，其中前 30 帧后继续等待预缓存约 20.27 / 20.52 秒。关闭的热资源启动为 14.75 秒。第一轮关闭需要首次下载约 3.52 GB，启动为 38.62 秒，因此不能拿这一轮与开启包比较启动成本。当前实现的 GPU 对象缓存属于单次运行，每次重开页面仍建立对象，浏览器可能自行复用内部编译缓存。

测试断言确认预编译队列活动期间加载层始终显示，所有异步回调结束后才隐藏。功能观测 `pso-reuse-v17-tsr-coverage.json` 进一步确认 **85 个成功的异步图形 PSO 对象实际绑定，其中 80 个在转向阶段使用**；C++ 唯一使用数同为 85，最终绑定 580,186 次，转向新建图形 PSO 为 0。该观测记录完整描述符，有额外开销，其截图 HUD 不作为性能数据。

本次共提交 1108 个异步预缓存请求，1100 个成功、8 个被拒绝。8 个均为计算管线：`workgroup_size(512,1,1)` 超出当前请求的设备 X 上限 256；这些排列在本次实际场景路径中未使用。另有 846 个不满足 Web 能力的推测请求在创建前排除。这些边界仍保留在诊断中，不能宣称所有 UE 排列均可缓存；实际本次使用的图形管线已经确认复用，场景验证未出现未捕获 GPU 错误或设备丢失。

### 剩余性能边界

开启后仍有 50–70 ms 的长帧，它们发生时没有创建新管线，不能继续归因于 PSO miss。首次转向期间每帧仍约创建 54 个 GPUBuffer，这是后续 CPU / API 开销排查的线索，尚未通过单独对照证明其占比。本次没有改动资源分配、线程或画质路径来混入其他优化。

### 本地测试页面

- 开启启动预编译：<http://127.0.0.1:8765/build/villa-pso-reuse-v17-tsr-on/index.html>
- 关闭预编译对照：<http://127.0.0.1:8765/build/villa-pso-reuse-v17-tsr-off/index.html>

两包位于 `tests/web-platform/build/`，使用现有带 COOP / COEP 的 `serve.cjs` 服务。不要同时运行两包做帧率对比。源码修改仅保存到工作区和参考引擎，本机安装引擎未被写入。
