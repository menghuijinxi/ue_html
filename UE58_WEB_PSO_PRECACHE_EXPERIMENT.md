# WebGPU PSO 预缓存实测（2026-11-02）

本页保留 v14 的历史实验。后续顶点布局哈希、已完成对象复用和场景颜色复制收集器的修复，见 [启动 PSO 复用修复](UE58_WEB_PSO_CACHE_REUSE.md)。

本轮接通了 UE 自身的 PSO 收集、调度与完成通知，再以 WebGPU 异步管线创建执行预编译。当前实验版本没有解决首次转向的严重长帧，不应据此默认开启预缓存。项目渲染设置和 Cook 内容保持原样。

## 实现与范围

- 复用 UE 的组件、材质与全局 PSO 收集器、PipelineStateCache 和预编译线程池。WebGPU 后端只负责设备兼容检查、提交 `createRenderPipelineAsync` / `createComputePipelineAsync`，并在浏览器回调完成后让 UE 编译任务完成。
- GPU owner 不能阻塞等待自己的 Promise；两个 UE 预编译线程等待事件，owner 在事件循环中接收异步结果。预编译提交离开可重入的系统代理调用栈，避免 emdawnwebgpu EventManager 的递归互斥锁死锁。正常创建请求不会继承重入时的预编译回调。
- UE 收集器会提出运行场景未使用、当前设备不支持的状态。此类请求返回预编译失败；保留正常绘制的验证约束。浏览器异步创建失败也不会返回可用的空 RHI 状态。
- 通过 `-WebPSOPrecacheTest` 显式启用，正常路径仍默认关闭。固定 Wasm Worker 池预留 20 个 Worker；UE PSO 线程池只创建两个请求线程，避免按硬件核心数创建大量线程耗尽池。
- 这是每次运行的提前准备，不是可导出、跨浏览器复用的 D3D12 PSO 二进制文件缓存。没有接入 UE PipelineFileCache，也没有给正式包增加“预缓存完成才进入游戏”的加载屏门槛；本轮测试脚本明确等待队列完成再测性能。

## 对照方法

使用 `villa-binding-groups-v4` 历史实测 Cook，重新链接同一份运行时生成开/关两个实验包。比较 Wasm、JS、`content.bin`、资源清单、配置清单 SHA-256，只有启动预缓存参数不同；没有修改光照、距离场、阴影、分辨率等项目设置。

有窗口 Edge，Focus Emulation，原出生点，画布 2290×1288、内部渲染 1484×835。每轮等引擎至少 30 帧、UE 活跃预编译请求为零且 WebGPU 回调全部返回，再静置 15 秒；固定视角 10 秒，0/90/180/270/0 度各 5 秒，然后重复巡回。开关顺序为关/开/开/关，每轮关闭并重新启动测试浏览器，保留浏览器和驱动缓存。因此测的是新场景实例的首次使用，不是清空驱动缓存后的启动。

Low 使用每段最慢 `ceil(N×1%)` 个提交间隔的平均值换算；另记滚动 5 秒 Low 最小值。它们是 RHI owner 提交间隔，不是显示器物理呈现时间。`pass` 表示完整执行和一致性检查通过，`performanceComparable` 还检查同组固定视角平均 FPS 漂移是否小于 15%。

早先同一浏览器进程连续测试时，后续开、关两组都出现约一半运行速度；该组保留为稳定性记录，不用来宣称增幅。重启浏览器的正式对照用于结果表。

## 结果

最终四轮对照数据记录于 `tests/web-platform/results/pso-precache-v14-20261102-fresh-abba.json`，`pass=true`、`performanceComparable=true`。同组固定视角平均 FPS 漂移分别仅约 0.3% 和 1.2%。

| 首次巡回指标 | 关闭预缓存（两轮） | 开启预缓存（两轮） |
| --- | --- | --- |
| 平均提交 FPS | 69.08 / 69.49 | 68.92 / 67.66 |
| 整段 1% Low | 17.69 / 17.68 | 14.55 / 14.63 |
| 滚动 5 秒 Low 最低 | 5.79 / 5.75 | 4.15 / 4.45 |
| 最长提交间隔 | 362.62 / 355.21 ms | 576.63 / 474.17 ms |
| 新建图形管线 | 15 / 15 | 15 / 15 |
| 新建 shader module | 10 / 10 | 1 / 1 |
| 导航开始至队列就绪 | 15.33 / 14.29 秒 | 30.99 / 31.67 秒 |

两轮均未观察到性能提升，首次巡回整段 Low 反而约下降 17.5%，启动准备约增加 16.5 秒。此结论针对当前实现和当前路线；不能据此证明补齐实际管线描述后的预缓存无效。

重复巡回无新增图形管线，关闭组约 70.37–71.20 FPS、1% Low 26.82–27.90，开启组约 69.62–70.12 FPS、1% Low 27.67–29.32。没有稳定的平均帧率增幅。固定视角均约 49.51–50.29 FPS。

预编译开启组每轮发出 943 条异步请求，全部完成，其中 910 成功、33 被浏览器拒绝；854 条不兼容的推测请求在设备调用前被拒绝。浏览器拒绝的记录包括通用顶点声明未提供 shader 需要的输入槽。失败数量不等于场景缺失同等数量材质。

## 为什么“提前编译过”仍会卡

描述捕获脚本保存布局、顶点格式、步长、偏移、渲染目标、深度和混合状态，比较预编译与实际绘制请求。修正后的复核记录 `tests/web-platform/results/pso-precache-v14-coverage-final.json` 已通过，确认首次巡回新增的 15 条图形管线中：

- 9 条有相同 shader 组合的预编译，但完整顶点布局不同，涉及 `arrayStride`、UV 的 Half2/Half4 格式、attribute 偏移等；不能算作实际管线已预编译。
- 5 条找到完全相同描述的成功异步预编译，之后仍发生普通创建；UE 默认可以释放完成的推测 PSO，之后依赖底层缓存重建。不能仅凭新的 create 调用就断言这 5 条完全重新编译。
- 1 条没有找到相同 shader 组合的预编译。

对照引擎源码 `Engine/Source/Runtime/D3D12RHI/Private/D3D12PipelineState.cpp`：D3D12 用 `HashNoStrides`，注释明确说明顶点流步长不影响其 PSO；WebGPU 的 `GPUVertexBufferLayout.arrayStride` 属于管线描述。UE 的通用 LocalVertexFactory 预编译声明包含零步长和通用 UV 布局，因此不能直接推断其适配 WebGPU 的实际网格布局。这是当前预编译覆盖不足的直接证据，尚不足以把每个长帧精确归因到某条遗漏管线。

后续有针对性的方向是让收集阶段使用组件实际顶点声明、补齐遗漏组合，并验证完整描述命中；命中后再测试保留已完成管线是否降低首次使用成本。现阶段“编译了很多条”不能作为优化成功的依据。

## 验证、风险与复现

最终 Wasm 完整构建和链接通过，报告 `tests/web-platform/results/web-engine-full-thread-build-results.json`。开/关画面截图检查到门厅、家具、玻璃、材质及光照均正常，未通过隐藏对象制造提升。最终四轮无页面错误、GPU 验证错误或崩溃，仍不等于长期移动稳定性验收。

开发中修复了线程池耗尽、owner 重入导致的死锁/空管线、推测 PSO 触发运行时断言及不支持的 storage texture 状态。早期一次关闭组还出现过地址零内存破坏，后续没有定位到确定根因；保留失败报告 `pso-precache-v12-20261102-abba.json`，不将实验包当作已通过生产稳定性验收。

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/benchmark-web-pso-precache.cjs --off=villa-pso-off-v6 --on=villa-pso-async-v14 --tag=pso-precache-check --fresh-browser
node tests/web-platform/probe-web-pso-coverage.cjs --folder=villa-pso-async-v14 --tag=pso-coverage-check
```

实验包：`http://127.0.0.1:8765/build/villa-pso-async-v14/index.html`；同二进制关闭组：`http://127.0.0.1:8765/build/villa-pso-off-v6/index.html`。预编译阶段会与首帧并行，人工测性能应等队列完成；正式默认包没有切换到此实验。

## 资料

- [UE PSO Precaching](https://dev.epicgames.com/documentation/unreal-engine/pso-precaching-for-unreal-engine)
- [WebGPU pipeline creation](https://gpuweb.github.io/gpuweb/#pipeline-creation)
- [WebGPU GPUVertexBufferLayout](https://gpuweb.github.io/gpuweb/#dictdef-gpuvertexbufferlayout)
- [GPUWeb 关于读写 storage texture 格式限制的讨论](https://github.com/gpuweb/gpuweb/discussions/4651)
