# Web PSO 无记录自动收集候选

2026-11-16。此候选落实自动选择 PSO 的路径，保留显式诊断开关。
普通发布仍执行 `web-release-defaults.cjs`，未改变正式包的记录预热门槛。
独立引擎仓库提交为 `330fc26ffa`。

本轮最后一次构建的 419 个编译单元全部通过，链接因 H 盘空间不足失败，已停止重试。
当前可运行的是此前成功打包的 `villa-pso-automatic-20261116-c`，不是最新源码完整产物。
下面的 23.427 秒及零新增管线结果只对应这个包。
最后追加的 Lumen 时间重投影、空间放大组合筛减、灯光枚举顺序调整、native cache
计数及临时空片元缓存排除尚未完成新包运行验证，不应从旧包结果推导它们已通过。

## 收集来源

组件继续使用 UE 材质、网格及顶点工厂的 PSO 收集器。全局计算着色器继续遍历
引擎注册的 shader type，依次检查 `ShouldCompilePermutation` 和
`ShouldPrecachePermutation`；未知着色器保留引擎默认收集行为，不使用名称白名单。
Web 对已经关闭的 Lumen、VT、VSM 功能族作开关判断。

增加 Web 的配置筛选，保留实际会切换的状态：

- TSR 按当前 alpha、16 位计算、history update quality 选择；输出格式维度继续保留。
- VSM 投影按实际射线数、斜率外推选择，保留单灯、分块、第一人称等合法维度；
  排除无法在 Web 使用的 hair uber shader 和可视化状态。
- Lumen 按当前 radiosity 线程组、空间过滤、时间累积、AO 配置筛选；
  时间重投影同时保留历史有效和失效，以及材质背面、短程 GI 等状态。
- 空间放大按当前方法、alpha、锐化质量选择，同时保留 secondary SmoothStep
  及镜头畸变维度。没有修改实际绘制路径、TSR 分块大小或画质配置。

延迟光照遍历整个 `Scene.Lights`，依据灯光形状、纹理、IES、透射、光函数及
VSM 能力派生合法组合，收集相机位于灯体内外、正常和反向剔除的状态。
这是场景属性收集，视锥外灯光也参与，不用先操作相机访问每盏灯。
新增灯光属性组合在后续帧继续加入队列；本轮没有保证动态加载过程完全无等待。

筛选只返回 `NotPrecached`，不删除运行期可用着色器。运行中修改画质设置，
仍可能触发新 PSO，不能把本轮启动覆盖等同于任意动态设置的完整预缓存。

## 修正的兼容和命中问题

Lumen 深度 atlas 的 PF_G16 在浏览器是不可过滤的 R16Unorm。
对使用共享双线性钳位 sampler 的 depth-atlas 采样，改为四次 textureLoad
加双线性插值，保留边缘钳位；没有换成点采样或关闭该功能。
数值测试执行 RHI 中实际 WGSL，中心、边界及 texel 中心五点读回正确，GPU 错误为零。

运行期才能确定 UAV 格式的 compute shader 不再创建无法使用的占位模块；
仍在实际绑定格式已知时创建真实模块和管线，不把它们记成已经预缓存完成。

深度管线曾在启动时已经存在同一个 WebGPU 描述符，转向时却因 UE 层状态差异
再次创建。新增设备范围内的 native raster cache，键包含布局、shader module、
entry point、常量、顶点输入、剔除、深度模板、多重采样、混合和输出格式；
哈希只选择桶，完整键相等才复用，最多保留 2048 条。
缓存保留 shader 引用防止 module 地址复用，临时空片元模块不进入此缓存；
关闭 RHI 时释放句柄。
UE wrapper 仍保存各自 initializer。缓存键 C++ 检查覆盖 20 项相等及差异条件。

## 对照和验证

`diagnostics/package-villa-pso-startup.cjs --capture-free` 产生三个模式：
历史记录参考、旧引擎自动收集、新引擎自动收集。
两种自动模式都不包含 `pipeline-prewarm.json`，也不采用记录预热的 device。
新引擎使用同一个原 Cook、配置与分辨率，仅替换 JS/WASM 和当前宿主。
`--concurrency=1..8` 调节明确的诊断请求并发。

在完成缓存及灯光状态修复、尚未作最后组合筛减的同一 WASM 上：

| 请求并发 | 到加载门槛且至少 60 帧 | 请求失败 | 用户路线采样新增 |
| --- | ---: | ---: | ---: |
| 2 | 52.910 秒 | 0 | 0 |
| 8 | 23.427 秒 | 0 | 0 |

这是保留资源及驱动缓存的单轮诊断，计时包含引擎启动和帧进展，不能当作
纯编译耗时、统计提速结论或人工帧率对比。不同并发下实际请求数略有波动，
原因包括首次使用与异步预缓存重叠；已完成 native 状态可复用，未完成请求仍可能并行重复。

用户 `2026-11-13T09-17-23` 导出路线每 15 个上下文取一个位置，共 11 个。
计入检查前没有预巡游；路线仅作覆盖验证输入，未生成新的预热记录。
已打包候选的实际结果、资源哈希、队列统计、页面验证，以及最新构建失败状态见
`tests/web-platform/evidence/pso-automatic-20261116.json`。
报告明确标记 `testedPackageMatchesLatestSource: false`。

真实页面检查原生键鼠、录制导出、切版保留玩家位置，以及 DPR 1.5 下固定
1400×788 渲染、1920×1080 输出，检查 1600×1000 和 900×700 两种布局的非空画布。
没有通过自动相机定位宣称人工连续移动的 low 帧表现。

## 未关闭边界

此前和本轮早期候选出现过外部 WebGPU Instance 丢失；另有一次新候选的
浏览器 target crash。后续路线及受控主线程、GPU worker GC 检查通过，仍未证明原因和修复，
因此本轮不将候选替换为普通发布默认值。

全局收集仍有过量组合；运行期 UAV 格式、动态设置、新地图和新引擎 pass
尚未获得穷尽覆盖。新增 pass 应通过标准的收集器描述 PSO；注册后的全局 shader
会自动参与遍历，但不能保证任意新 pass 的图形状态无需实现收集。
这与要求用户人工跑遍所有镜头采集不同，后续应继续扩展引擎侧状态合同。

## 复现命令

```powershell
node tests/web-platform/diagnostics/package-villa-pso-startup.cjs --tag=<新包标签> --capture-free --concurrency=8
node tests/web-platform/diagnostics/probe-villa-pso-startup.cjs --suite=<包标签> --tag=<新结果标签> --modes=automatic --expect-zero --route=tests/web-platform/results/villa-turn-manual/villa-turn-2026-11-13T09-17-23-425Z-10ddd198.json
node tests/web-platform/diagnostics/verify-villa-pso-live.cjs <包标签> <新页面结果标签> automatic --worker-gc
node tests/web-platform/diagnostics/verify-depth-atlas-bilinear.cjs <新数值结果标签>
node tests/web-platform/diagnostics/analyze-villa-pso-automatic.cjs <包标签> <路线结果标签> <页面结果标签> <新证据标签>
```

最后一条命令默认要求最新源码构建成功且 WASM 哈希匹配。
只整理历史候选证据时显式加 `--candidate-only`，报告会标记包与最新源码不匹配，
不得将这类证据用于宣称新源码运行验证通过。

上述入口初始化项目内临时目录，结果在 `tests/web-platform/results/`，
拒绝覆盖既有包、报告及证据。浏览器检查要求 Playwright 和 sharp 可用。
