# Web PSO 自动收集与提前缓存

预热内容由引擎组件、全局和场景收集器自动决定。
普通发布通过 `web-release-defaults.cjs` 自动准备完整收集缓存，
浏览器立即并行编译，并保留引擎内自动补漏；诊断开关继续保留。

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
  及镜头畸变维度。方法先执行运行期的 `RemapPermutation`，避免把主放大器的
  method-set 组合误排除。
- TAA 按当前 alpha 和主通道画质选择；DOF、SSR、光轴的独立画质组合继续保留。
- 雾按当前过滤质量选择，同时保留反射捕获固定使用的质量零；
  不收集 Web 不支持的局部雾组合。
- 实例剔除按立体渲染和遮挡剔除开关筛选；单实例分支不收集实例剔除的
  不可达组合，继续保留合批、顺序保持及 WPO 的合法状态。
- HZB 依据分批缩减的输入约束，排除后续 closest-only 批次不会读取的
  visibility 和 froxel 组合；保留有效输入格式与各批次 mip 数。
- Tonemap 在平台没有硬件及软件 VRS 能力时不收集 VRS 亮度输出组合；
  保留曝光、颗粒、色差、锐化及输出格式状态。
- 次表面散射按当前半分辨率、separable 和 profile cache 配置筛选；
  保留由视图上采样器和场景颜色格式决定的质量及棋盘格状态。
- 大气 LUT 排除实时反射捕获不会使用的阴影与独立散射输出组合；
  保留第二大气灯、云遮蔽和云阴影状态。
- Lumen 探针体素追踪按 radiance cache、额外 AO 和 SDF coverage 配置筛选；
  阴影按实际线程组、SDF coverage 和 mesh SDF 索引结构筛选。
  随机光照采样按开关及采样数筛选，保留场景灯光种类和 IES 状态。
- Lumen 反射 mesh SDF 追踪按实际线程组及索引结构筛选；throughput resolve
  仅保留运行期使用的前层、两轴相同缩减比例组合。距离场阴影按当前立体渲染
  及深度子采样设置筛选，继续保留输出历史有效与失效状态。
- Web 灯光网格不收集运行期已排除的链表和双层父网格组合；
  HZB 有效与失效、矩形灯存在与否、indirection 状态继续保留。

以上筛选不改变实际绘制路径、TSR 分块大小或画质配置。

延迟光照遍历整个 `Scene.Lights`，依据灯光形状、纹理、IES、透射、光函数及
VSM 能力派生合法组合，收集相机位于灯体内外、正常和反向剔除的状态。
特殊光照通道依据整个场景的 primitive 属性决定；各向异性依据平台和配置，
大气及云透射依据场景大气灯和组件决定，不能仅看初始视锥。
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
缓存保留 shader 引用防止 module 地址复用。
空片元模块设备内只创建一次，随 RHI 释放，因此采用它的管线也能安全缓存。
关闭 RHI 时先释放管线缓存，再释放共享空片元模块和布局句柄。
UE wrapper 仍保存各自 initializer。缓存键 C++ 检查覆盖 20 项相等及差异条件。

Lumen 表面缓存清理和重采样图形管线通过标准的全局 PSO 收集器提交，
使用实际 card capture 的目标格式、矩形顶点着色器及深度模板状态。
重采样不一定在初始镜头执行，不能靠延长启动等待碰巧覆盖它。

## 启动调度

Web 在 UObject 默认配置和渲染线程就绪后，立即启动全局计算 PSO 收集，
与后续引擎初始化重叠。启动末尾的完整收集仍保留，包含稍后注册的 shader type
和图形收集器；重复请求由原有 UE PSO 缓存合并，不省略晚注册的功能。
`WebPSOPrecache.h` 只增加 Web 的早期入口，不改变其他平台的启动顺序。

Web 全局计算收集在每个模块就绪后立即调用标准的 `RequestPrecachePSOs`，
让浏览器编译与后续模块创建重叠，不再等待全部模块生成后才提交整批请求。
渲染命令仍等待所有模块生产任务结束；加载门槛继续检查 UE 活动请求和 RHI
异步完成计数，不能仅凭提交完成就开放操作。

RHI 自动并发为浏览器逻辑处理器数量的一半，范围 2 到 16；显式诊断参数
`-WebPSOPrecacheConcurrency=1..32` 可覆盖。线程目标的 pthread pool 同步读取
相同参数和硬件默认值，在原有至少 28 个槽位的基础上保证额外 20 个引擎/
启动服务槽位。不能只放开 RHI 并发上限，否则严格线程池会在启动时耗尽。

`prepare-web-pso-host.cjs` 在增量构建时也同步空间放大、TAA、雾、实例剔除、
HZB、Tonemap、次表面散射、大气、距离场阴影、Lumen 探针、反射与直接光照、
表面缓存及相关声明；
只修改参考源码、没有更新隔离宿主，不等于改动已经进入 WASM。

## 自动收集的提前缓存

5.9 的初始镜头采集与重放保留作备用。主要优化路径继续使用 UE 的组件、
全局及场景灯光收集器；不以初始镜头记录代替完整自动收集。

仅调整引擎内的调用顺序，仍需要先初始化 WASM 才能取得 PSO 描述。
`diagnostics/package-villa-pso-startup.cjs --automatic-corpus=auto` 自动启动
一次无记录的自动收集包，等待 UE 活动请求和浏览器编译回调全部完成，
在移动相机前导出完整收集结果，再生成提前缓存对照包。
收集失败即停止，不读取失败结果或旧构建作为替代；不按手写 shader 名称、
管线数量上限或相机路线裁剪描述。

缓存严格绑定 WASM、Cook、配置、启动参数和物理分辨率。`--source` 指定
本次打包的场景包，运行时取本次构建的 JS/WASM；重新构建后可以自动重新生成，
无需人工补走镜头。已有合格收集报告也可通过 `--automatic-corpus=<报告路径>`
显式复用，哈希或参数不匹配时拒绝打包。

提前缓存使用我们的描述符重放器，在加载 WASM 和资源之前开始准备设备及编译。
GPU adapter 请求与缓存文件读取并行，首条管线的依赖就绪后立即提交，
不等待所有 WGSL 模块生成。完整描述符仍决定命中，异步补漏与重放共享有界队列，
相同在途请求共享 Promise；同步未命中仍创建真实管线。
默认并发为硬件逻辑处理器的一半、范围 2 到 16，显式诊断值范围 1 到 32。
这里的并行编译由同一设备上的 WebGPU 异步接口提交，使用浏览器编译线程；
不把不同 Worker 的 GPUDevice 或管线对象混用。

设备默认提前交接给引擎，加载层仍同时等待提前缓存和完整 UE 自动队列，
并要求 RHI 异步失败数为零。
普通发布由 `web-release-defaults.cjs` 自动加入正式参数 `-WebPSOPrecache`，
不使用诊断参数 `-WebPSOPrecacheTest`。旧诊断参数仍兼容。
没有匹配的缓存时，发布入口自动运行完整组件、全局和场景收集器，
在移动相机前导出描述；已有缓存必须同时匹配二进制、Cook、配置、启动参数
及物理分辨率，并证明自动队列与浏览器编译全部完成。
初始镜头记录、带路线记录、未完成或失败的自动收集不能替代正式缓存。
这些检查失败即停止发布，不能静默降回较小的初始镜头记录。
浏览器编译立即开始、提前交接设备和硬件自适应并发均通过统一发布收尾生效。
UE 会将后端明确拒绝的推测性组合也输出为管线失败日志。采集单独保留这些
日志并与 RHI 的 unsupported 计数核对，不能把它们当作已经预热的管线；
真实 WebGPU 编译拒绝、验证错误、设备丢失、RHI 异步失败以及无法解释的
管线失败仍阻止正式缓存生成。
提前缓存对照包始终保留 UE 自动组件和全局收集，缓存未收录的新请求仍走原路径，
不能将缓存条数或一条路线零新增解释为所有动态地图、配置和未来 pass 的保证。

```powershell
node tests/web-platform/diagnostics/package-villa-pso-startup.cjs --tag=<新包标签> --source=<本次场景包目录> --capture-free --automatic-corpus=auto --only=automatic,eager
node tests/web-platform/diagnostics/package-villa-pso-startup.cjs --tag=<正式默认对照标签> --source=<本次场景包目录> --capture-free --release-defaults
node tests/web-platform/diagnostics/probe-villa-pso-startup.cjs --suite=<新包标签> --tag=<新结果标签> --modes=automatic,eager,eager,automatic --expect-zero --max-pipelines=1500
node tests/web-platform/diagnostics/probe-villa-pso-startup.cjs --suite=<新包标签> --tag=<新路线标签> --modes=eager --expect-zero --route=<导出的路线文件> --route-step=1
```

`--max-pipelines` 是本场景诊断预算，不参与选择或删除预热内容。
收集过程与加载计时分开，捕获插桩所得加载耗时不作为提速成绩。
启动报告的 `schedule` 使用页面时间原点，分别给出首条管线、末条完成及实际
峰值并发；`loadingHiddenMs` 与运行六十帧后的检查时间继续分列。

## 对照和验证

`diagnostics/package-villa-pso-startup.cjs --capture-free` 产生三个模式：
历史记录参考、旧引擎自动收集、新引擎自动收集。
两种自动模式都不包含 `pipeline-prewarm.json`，也不采用记录预热的 device。
新引擎使用同一个原 Cook、配置与分辨率，仅替换 JS/WASM 和当前宿主。
`--concurrency=auto`（默认）检查硬件默认调度；`--concurrency=1..32` 调节明确
的诊断请求并发。`--only=overlap,automatic` 可跳过不需要的历史模式。
`--baseline-suite=<上版包标签> --only=previous,automatic` 可直接比较两次自动收集构建；
打包前校验上版文件哈希，以及 Cook、配置和渲染参数与当前场景一致。
两版使用同一份当前网页宿主和缓存 worker，上版保留原 JS/WASM。

启动诊断保留资源及驱动缓存，计时到加载门槛且至少 60 帧，包含引擎启动和
帧进展，不能当作纯编译耗时或人工 low 帧对比。请求数会随首次使用和异步
预缓存重叠略有波动；已完成 native 状态可复用，未完成请求仍可能并行重复。
比较数量时分别报告 RHI 图形与计算管线创建次数、异步预缓存请求数，以及
后端提前拒绝的推测性请求数；异步请求数不代表全部 PSO 或唯一 PSO 数。
`probe-villa-pso-startup.cjs --max-pipelines=<上限>` 对启动时实际图形与计算
管线创建次数之和设置回归检查；数量检查与路线零新增检查同时执行，
不能通过把预缓存工作推迟到操作阶段来满足数量上限。

路线默认每 15 个导出上下文采样一次，`--route-step=1` 检查全部上下文。
计时前不预巡游；路线只作覆盖验证输入，不生成新的预热记录。
失败时保存有限时长的状态快照和浏览器日志，不能因 worker 已失去响应而
无限等待诊断取数。构建、路线和页面报告留在 `tests/web-platform/results/`，
不把一次性采集输出提交到 Git。
持久化浏览器 profile 可能恢复上次的测试页；诊断启动后关闭所有恢复页，
只创建一个被测页面，并检查上下文内只有该页面，避免旧场景争用 GPU。

真实页面检查原生键鼠、录制导出、切版保留玩家位置，以及 DPR 1.5 下固定
1400×788 渲染、1920×1080 输出，检查 1600×1000 和 900×700 两种布局的非空画布。
没有通过自动相机定位宣称人工连续移动的 low 帧表现。

## 未关闭边界

候选曾出现外部 WebGPU Instance 丢失及浏览器 target crash。
单次路线或受控 GC 检查通过不等于已经证明该问题彻底修复，
自动收集和提前缓存现在通过普通发布收尾启用，仍不能将历史故障视为已经彻底修复。
同一浏览器交替导航的启动失败必须单独保留；重新启动浏览器后的成功
不能覆盖该失败，也不能以自动重试将整轮对照标记为通过。

全局收集仍有过量组合；运行期 UAV 格式、动态设置、新地图和新引擎 pass
尚未获得穷尽覆盖。新增 pass 应通过标准的收集器描述 PSO；注册后的全局 shader
会自动参与遍历，但不能保证任意新 pass 的图形状态无需实现收集。
这与要求用户人工跑遍所有镜头采集不同，后续应继续扩展引擎侧状态合同。

## 复现命令

```powershell
node tests/web-platform/diagnostics/package-villa-pso-startup.cjs --tag=<新包标签> --capture-free --concurrency=auto --only=overlap,automatic
node tests/web-platform/diagnostics/package-villa-pso-startup.cjs --tag=<新对照包标签> --capture-free --baseline-suite=<上版包标签> --only=previous,automatic
node tests/web-platform/diagnostics/probe-villa-pso-startup.cjs --suite=<包标签> --tag=<新结果标签> --modes=automatic --expect-zero --max-pipelines=1500 --route=<导出的路线文件> --route-step=1
node tests/web-platform/diagnostics/verify-villa-pso-live.cjs <包标签> <新页面结果标签> automatic --worker-gc
node tests/web-platform/diagnostics/verify-depth-atlas-bilinear.cjs <新数值结果标签>
```

最后一条命令默认要求最新源码构建成功且 WASM 哈希匹配。
只整理历史候选证据时显式加 `--candidate-only`，报告会标记包与最新源码不匹配，
不得将这类证据用于宣称新源码运行验证通过。

上述入口初始化项目内临时目录，结果在 `tests/web-platform/results/`，
拒绝覆盖既有包、报告及证据。浏览器检查要求 Playwright 和 sharp 可用。
