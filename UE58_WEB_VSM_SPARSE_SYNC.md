# 2026-11-11 Web 虚拟阴影按页同步

## 改动范围

上一版 `5c95466` 将物理阴影页池每帧整池复制从四次降到两次，但仍复制
1 GiB/帧。本轮在非 Nanite VSM 光栅前后增加两个 Web 计算通道，
只同步已分配、被引用且可能需要光栅化的物理页。页面分配、清除、静态页合并
和阴影采样仍以纹理为准，片元原子操作仍写入缓冲镜像。

- 依据 `PhysicalPageMetaData.Flags` 选择 `ANY_UNCACHED` 或 `FORCE_CACHED`
  的页面，跳过未分配、未引用及完全缓存的页面。对选中的页保守地同步全部层。
- Web RHI 检查同一个 UAV 同时绑定为 `WebShadowPoolTexture` 与
  `WebShadowPoolAtomicBuffer` 后，交由显式计算通道同步，停止这张纹理的自动整池复制。
  其他原子纹理仍走原有同步路径。
- `r.WebGPU.VSMSparseSync=1` 默认开启，仅允许启动时配置，避免运行中切换造成
  镜像状态不一致。改为 0 可在启动时恢复旧同步路径，但该配置的发布包必须重新
  采集匹配的实际管线。
- 原有 4096 页容量、阴影质量、TSR、Lumen GI/反射和虚拟纹理开关保持不变。
  固定物理输出 1920×1080，实际渲染 1400×788；DPR 不重复应用。
- 源码仅改工作区和独立 `reference-engine`，未写入 `H:/UE_5.8`。

主要文件：

| 仓库 | 文件 |
| --- | --- |
| 引擎 | `Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapArray.cpp` |
| 引擎 | `Engine/Shaders/Private/VirtualShadowMaps/WebVirtualShadowPoolSync.usf`、`.ush` |
| 根仓库 | `tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp`、`.h` |
| 根仓库 | `tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat/Private/WebGPUTextureAtomics.h` |
| 根仓库 | `tests/web-platform/prepare-web-cook-shaders.cjs` |

## 验证方式

以下路径均相对 `tests/web-platform/`。

- `verify-web-virtual-shadow-sync.cjs` 使用实际共享 HLSL helper，经 DXC/Tint 转换后
  在浏览器 GPU 回读。6 种尺寸/层数组合、每种 3 轮不同页标记，检查 6,195,456 个值，
  无不匹配。包括完全缓存、未引用、强制缓存、静态/动态失效页，以及不应被覆盖的内容。
- 原生 C++ RHI GPU 回读共 79 项通过；新增两项显式同步测试在三轮纹理改写、
  图形/计算状态转换中验证只同步选定列，其他像素不被整池复制覆盖。
  记录 `build/vsm-sparse-native-20261111/lumen-storage-rhi.json`。
- 线程 Wasm 编译、链接、校验通过，日志
  `results/web-engine-full-thread-20261111-153625.log`。
- WebGPURHI 23 个编译单元及 ShaderFormat 编译链接通过。Renderer 原生宿主完成
  全模块编译，并重编修正的 35 号与中断的 18 号单元后链接；
  `results/native-renderer-build-results.json` 保留各次日志和对象检查，未跳过失败后补编。
- 完整别墅项目重新 Cook、Stage，通过同一发布收尾流程采集新管线并打包。
  `results/villa-shadow-on-20261111-sparse-release.json` 为 `releaseReady=true`，
  保留实际管线预热、当前宿主/worker 和多页共享读取锁。
- 发布默认值、Lumen 和虚拟资源设置回归均通过。

## 浏览器实测

旧包为 `villa-shadow-on-20261111-mirror`，新包为
`villa-shadow-on-20261111-sparse`。两包使用相同项目设置、分辨率、浏览器和缓存目录。
六段路线依次为静止、首次转向、转向后静止、再次转向、首次移动、再次移动。

带 GPU 插桩的六段诊断通过，无 GPU 错误、无新增管线遗漏。物理页池整池复制
由 1 GiB/帧降到零；按页复制仍有开销，不能把零整池复制理解为零数据传输。
18 个采样帧的 GPU 时间线平均跨度由 28.67 ms 降到 24.33 ms，
通道之间的间隔合计由 7.14 ms 降到 2.99 ms。旧数据来自上一轮同配置诊断。
新包带插桩平均帧率为 41.0～41.8 FPS，上版为 33.5～35.8 FPS。

不带 GPU/CPU 性能插桩的交叉测试采用旧、新、新、旧顺序，每包两轮，
每轮预热 15 秒后测量六段各 10 秒路线。仍有轻量的提交帧和复制命令计数；
这是 RHI 提交间隔统计，不是显示器呈现时间。

| 阶段 | 上版 FPS | 本版 FPS | 上版 1% Low | 本版 1% Low |
| --- | ---: | ---: | ---: | ---: |
| 静止 | 36.97 | 44.86 | 32.78 | 35.88 |
| 首次转向 | 36.35 | 43.95 | 32.40 | 34.76 |
| 转向后静止 | 36.52 | 44.01 | 32.45 | 36.31 |
| 再次转向 | 36.00 | 43.28 | 28.96 | 34.19 |
| 首次移动 | 35.18 | 43.10 | 23.95 | 29.33 |
| 再次移动 | 35.82 | 43.54 | 30.89 | 35.92 |

FPS 按两轮总帧数/总时长计算；1% Low 合并两轮所有提交间隔后，
取最慢 1% 的平均间隔倒数。平均吞吐提高 20.2%～22.5%。
24 个阶段全部无 GPU 错误、无新增管线创建或预热遗漏。
上版首次移动有 1 个超过 50 ms 的间隔，本版测量窗口内为零。
原始报告为 `results/vsm-motion-sparse-{a1,b1,b2,a2}-20261111/result.json`，
汇总及哈希为 `results/vsm-sparse-comparison-20261111.json`。

相同静止视角人工检查未见明显阴影、材质或玻璃回退。
排除性能面板和黑边后，RGB 平均绝对差为 0.743/255，
最大通道差超过 10 的像素占 0.403%。这不替代整个场景逐视角检查。

普通发布页另做 10 秒真实键鼠测试：最大位移 190.4 厘米，转角 100.8 度，
无 GPU 错误，实际管线预热已采用。自由漫游出现 1 条未采集管线；
固定路线零遗漏不能扩大为所有视角零遗漏。本次单次启动就绪为 16.58 秒，
没有进行控制缓存条件的加载速度基准，不能据此判断加载速度变化。
记录为 `results/villa-startup-vsm-sparse-plain-20261111/result.json`。

正式页面：
`http://127.0.0.1:8765/build/villa-shadow-on-20261111-sparse/index.html`。
旧包和旧对比页面保留。源码、编译、Cook、发布、GPU 回读及浏览器结果的
审计记录为 `tests/web-platform/evidence/vsm-sparse-sync-20261111.json`。

后续已用相同运行时补做 VSM 开/关四轮对照：开启后平均 FPS 低 13.6%～15.1%，
转向 1% Low 低 25.2%，移动 Low 低 14.1%。这组测试有独立的关闭组发布包和预热记录，
详见 [UE58_WEB_VSM_LOW_COMPARISON.md](UE58_WEB_VSM_LOW_COMPARISON.md) 顶部最新结果；
不覆盖本节先前的“新旧运行时”测量。

## 失败记录与边界

- 首次 Cook 的输出路径过长，超过 Windows/UE 的 260 字符检查；
  改为 `C:/ue-web-cook-sparse` 后完整 Cook 成功。失败日志保留在
  `results/web-project-triplex-virtual-desktop-cook-20261111-155421.log`。
- 初次 Renderer 编译的向量构造和原生探针字符串拼接错误均已修正，并重新编译验证。
- 曾单独比较整池复制命令与多种整池计算复制工作组，结果没有稳定收益，因此没有
  采用整池计算替代。记录 `results/atomic-copy-20261111-first.json`；
  这是带宽实验，不是内容正确性测试。
- 此次没有修改之前偶发的 GPU 设备丢失问题；成功测试不代表该问题已解决。
- 虚拟纹理开关及运行路径开启，但本场景遥测的实际 VT 资源数量为零；
  不能将本场景验收等同于大量 VT 资产的压力测试。
- 本轮未重新做 VSM 开/关对照，也未跑多标签页长时压力测试。
  新旧包对照只衡量本次按页同步的效果。
- 约六千次每帧间接绘制及其他 VSM 通道仍有开销；本轮没有减少绘制数量，
  也没有降低页池容量、分辨率或光照质量。
