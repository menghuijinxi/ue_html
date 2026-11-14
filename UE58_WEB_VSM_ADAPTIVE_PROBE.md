# VSM 自适应采样试验

日期：2026-11-11。项目：`H:/TriplexHouseVilla`。

本轮恢复 UE 的 SMRT 自适应提前结束规则，验证当前浏览器是否兼容，
以及是否降低实际场景投影耗时和整帧耗时。没有降低射线预算、修改分辨率或关闭光照功能。
当前是显式诊断试验，未修改正式包或普通 Cook 默认行为。

## 实现范围

- 参考引擎和工作区 Cook 覆盖增加 `WEB_VSM_ADAPTIVE_PROBE` 条件：
  只有显式开启时，Web 的局部光、方向光和头发投影恢复原来的提前结束分支。
- ShaderFormat 同时检查 `VirtualResourceShaderProbe`、`WebVSMAdaptiveProbe` 和精确的投影源码路径。
  普通 Cook 不会开启该宏，也不会换用诊断转换策略。
- 显式试验启用 wave 编译，使用本地 Tint 库转换器的活跃线程 subgroup 策略，
  保留工作组屏障一致性校验。没有更改点光跨立方体面的现有标量处理。
- 本次实际场景只编译并执行 `FVirtualShadowMapProjectionCS` 的 17、18 两个 permutation。
  头发路径及其他 permutation 尚未完成场景验收。

`r.Shadow.Virtual.SMRT.AdaptiveRayCount=1` 原来已是默认值，
但 Web 着色器提前结束分支被编译排除，单改 CVar 无效。
实验保持基线和候选都为 1，只有候选真正含有 `subgroupAll` 和提前结束分支。

## 兼容性与资源验证

- 转换器及工作区 ShaderFormat/commandlet 编译成功。
- 已有 Nanite 转换策略的 5 项回归通过。
- 关闭试验开关重新编译 17、18 两个 permutation，WGSL 与现有正式包的原始着色器完全一致，
  均没有 `enable subgroups`。发布默认流程回归通过实际管线自动复用/失效、
  固定物理分辨率、旧 worker 拒绝、硬链接保护和采集失败阻止发布等检查。
- 新语义夹具在实际 WebGPU 上回读 384 个线程，覆盖完全明亮、完全遮蔽、
  明暗混合、光源分支、部分视口和关闭自适应的完整采样对照。
  故意放入的非一致工作组屏障仍被拒绝。
- 两个场景 permutation 的资源绑定、整个 uniform 大小及已有成员的偏移、大小、步幅一致。
  新使用的 `SMRTAdaptiveRayCount` 位于已有 uniform 的偏移 164；
  反射所报相邻成员尾部 padding 缩小，不代表布局位移。
- 诊断工具只匹配明确的原始 WGSL 和运行时存储格式专用版本。
  仅在浏览器内替换模块，保留运行时输出纹理的真实格式。
  未识别的源码版本会失败，不进行宽泛字符串替换。

## 性能与画面测量

最终四轮正常渲染对照：

| 阶段 | 原版 FPS | 自适应 FPS | 平均提升 | 原版 1% Low | 自适应 1% Low |
| --- | ---: | ---: | ---: | ---: | ---: |
| 静止 | 44.69 | 47.74 | 6.82% | 37.28 | 37.40 |
| 转动 | 45.14 | 48.51 | 7.46% | 36.36 | 37.28 |
| 移动 | 44.89 | 47.89 | 6.68% | 37.40 | 38.53 |

转动 Low 提升约 2.52%，移动 Low 提升约 3.02%，静止 Low 基本不变。
12 个计时窗口均为零新管线、零预热 miss、零超过 50 ms 的间隔、零页面/GPU 错误。
这些是 RHI 提交间隔，不是 Windows 合成器的物理显示帧率。
本轮没有重新测无 VSM，因此不将旧环境的无 VSM 数据混入当前收益。

独立 GPU 诊断各采静止、转动 6 帧，局部光和方向光投影合计：

| 阶段 | 原版投影 | 自适应投影 | 节省 |
| --- | ---: | ---: | ---: |
| 静止 | 2.763 ms | 1.027 ms | 1.737 ms / 62.85% |
| 转动 | 2.272 ms | 1.059 ms | 1.212 ms / 53.37% |

投影耗时降低明确，平均 FPS 的实际收益约 7%，Low 改善有限。
因此该方向值得继续，但不能据此说移动低帧问题已解决。

GPU 计时为拆分 compute pass 的归属诊断，不能直接当作正式帧率。
正常帧率测试保留 compute-pass 复用，使用原版、自适应、自适应、原版顺序，
各阶段 30 秒，先预热转动和移动路线各 15 秒。
每次仅运行一个测试页面，并检查每个计时窗口零新管线、零预热 miss。
最终工具每轮启动独立浏览器进程，复用同一资源缓存；离开场景后导航到空白页再关闭。

输出 1920×1080，实际渲染 1400×788，TSR；Lumen GI、反射、VT、VSM 均开启。
本场景实际 VT 资产数量仍为 0，不构成虚拟纹理流送负载验证。
GPU 为 RTX 3070，浏览器为 Edge 157.0.4341.42。

画面检查使用餐厅玻璃、客厅灯光/栏杆和厨房近景三个固定视角，
同时保留两轮原版、两轮自适应截图，用重复截图差异区分时序噪声。
截图和语义夹具不能替代运动中的半影噪声、动态遮挡及其他设备的完整验收。
三处截图人工检查未见大片缺影或玻璃明显偏色，但厨房金属反射及部分边缘有稳定差异：
原版与自适应的 RGB 通道均方根差约 2.21～2.23（0～255），
原版两次截图约 0.89；最大通道差超过 16 的像素约 0.34%～0.36%，
原版重复截图约 0.020%。不能把这些差异全部当成时序噪声。
当前未接受“完全等画质”，证据明确标记 `qualityAccepted=false`、`releaseReady=false`。

汇总及每轮数据、截图哈希：
`tests/web-platform/evidence/vsm-adaptive-20261111.json`。
完整最终计时：
`tests/web-platform/results/vsm-adaptive-timing-isolated-20261111/result.json`。
GPU 归属：
`tests/web-platform/results/vsm-adaptive-gpu-20261111-v3/result.json`。
厨房两轮平均差分放大 8 倍：
`tests/web-platform/results/vsm-adaptive-timing-isolated-20261111/kitchen-mean-difference-x8.png`。

## 保留的失败记录

- 第一次 GPU 诊断只识别预热记录里的存储格式专用版本，
  在原版运行时创建原始模块时被精确匹配检查拒绝。
  已补齐两种已知源码，均校验绑定和格式。
- 第二次 GPU 诊断完成原版后，关闭最后一个标签使持久浏览器退出，
  因而不能创建下一页。该记录不用于汇总。
- 一组四轮帧率测试在第四轮原版的启动阶段终止，前面的有效窗口也不混入最终汇总。
- 后续原版和自适应的启动均曾遇到
  `GPUPipelineError: A valid external Instance reference no longer exists.`，
  发生在引擎开始渲染之前。新工具仅对这一具体启动错误做最多三次重试，
  将每次失败及日志单独保存在 `startupFailures`，不重试差的性能结果，
  不更改原定测量顺序。独立进程本身未消除该问题。

这些启动失败不能证明自适应逻辑有问题，也不能被解释为启动问题已修复。
本轮只接受完成预热后正常渲染的性能窗口，不能作为发布启动可靠性的验收。
最终四轮中的第一轮和第四轮原版各记录一次该启动失败，重试后完成全部阶段。
其他未完成组均保留原始结果并列入证据的 `excluded`，没有混合其测量窗口。

## 截图对照页

2026-11-12 新增 `tests/web-platform/vsm-adaptive-comparison.html`，
本地服务地址为 `http://127.0.0.1:8765/vsm-adaptive-comparison.html`。
这是实际测试截图的交互对照，非实时引擎场景。
默认定位厨房金属反射，可切换水壶边缘、窗边阴影、餐厅玻璃和客厅栏杆，
支持拖动分界、画面平移、缩放、单独 A/B 和 RGB 绝对差分。

对照可选原版/自适应，也可选两次原版或两次自适应，辅助判断重复采样噪声。
页面读取本节对应的 evidence，按 SHA-256 校验原始截图及相机一致性，
缺图或哈希不匹配时显示错误，不使用替代图。
依赖 `results/vsm-adaptive-timing-isolated-20261111` 的原始 PNG；
复制页面时须同时带上这些截图和证据 JSON。

已验证桌面拖动/缩放、全部视角和对照组合、差分增益、390px 手机布局、
缺图错误后的重试以及篡改截图拒绝。没有改动正式包或发布入口。

## 实际漫游诊断页

2026-11-12 新增 `tests/web-platform/vsm-adaptive-live.html`，
地址为 `http://127.0.0.1:8765/vsm-adaptive-live.html`。
这是实际引擎场景，默认自适应采样；原版和候选均以最新按页同步包为基础，
均保留 VSM、Lumen、虚拟纹理、TSR 和 1400 × 788 → 1920 × 1080 的尺寸。
切换时只运行一个实例，重新加载后恢复完整玩家位置和控制朝向。
使用 `WebPlayerViewControl` 恢复玩家控制，不使用不能漫游的测试相机。
厨房、餐厅和客厅快捷视角也通过玩家接口定位。

页面校验两个投影模块均精确匹配，候选均已替换，原版均未替换；
候选设备必须具备 subgroups，同时校验实际引擎配置、预热采用状态和 GPU 错误。
控制台状态通过现有 worker 状态镜像传递，正式宿主、worker 和缓存锁逻辑不变。
导出记录包含每种模式最后的玩家视角、实际配置、FPS、近五秒 Low、替换计数和预热状态。
切换会重建时间历史，实时数字不作为受控性能基准。

生成独立诊断目录：

```powershell
node tests/web-platform/diagnostics/package-vsm-adaptive-live.cjs
```

生成工具拒绝覆盖已有目录，先校验基础包与当前宿主、缓存 worker 和全部文件哈希，
校验原版预热记录的源码与实验替换表匹配。
不可变的大资源使用硬链接，修改的入口及 worker 单独写入；两个目录明确标记
`diagnosticOnly: true, releaseReady: false`，不进入正常发布收尾流程。
必须保留 `results/vsm-adaptive-variants-20261111-v2.json` 才能重新生成；
已生成目录可直接通过现有 8765 服务运行。

验证命令为 `node tests/web-platform/verify-vsm-adaptive-live.cjs <新结果目录名>`。
已在 Edge、DPR 1.5 下验证：自适应 → 原版 → 自适应的实际着色器匹配、
玩家与相机完整保持、五次键盘移动和鼠标转向、三个快捷视角、恢复入口、
1600px / 390px 布局、非空渲染、记录导出及篡改采样状态后的拒绝与重试入口。
结果保存在 `results/vsm-adaptive-live-20261112/result.json`，本轮无 GPU 错误或启动重试；
这不代表此前偶发的设备启动错误已经修复。
证据摘要为 `tests/web-platform/evidence/vsm-adaptive-live-20261112.json`。

## 诊断与发布边界

实验在预热和引擎创建着色器时应用同一替换，因此二者使用同一候选 GPU 管线。
预热缓存的键仍是原版描述符，只适用于本次显式内存替换试验；
不能将原版 corpus 当作候选着色器的正式发布记录。

诊断试验完成时，正式启用还需完成：

1. 将候选纳入正式 Cook 和设备能力选择，保留不支持 subgroups 的完整采样回退。
2. 覆盖其他投影 permutation、点光跨面、动态遮挡、运动中的噪声和闪烁。
3. 经 `web-release-defaults.cjs` 重新采集并校验与新 Cook 哈希、启动参数匹配的实际管线，
   连同当前宿主和缓存 worker 发布。

上述诊断阶段未修改正式包、DPI 计算、多页缓存锁及默认发布流程。
2026-11-12 用户确认可接受视觉差异后，正式 Cook 和默认启用已经接入，
新包、验证结果及兼容边界见 [正式启用说明](UE58_WEB_VSM_ADAPTIVE_RELEASE.md)。
本文保留诊断阶段的测量与复现记录。

## 复现

工具需要现有的 sparse 正式包、剩余开销证据元数据及本地着色器工具链。
浏览器测量需要 8765 服务。不要同时运行两组性能测试。

```powershell
& tests/web-platform/build-tint-nanite.ps1
& tests/web-platform/build-web-material-host.ps1
node tests/web-platform/prepare-web-cook-shaders.cjs

& tests/web-platform/probe-web-virtual-resources.ps1 `
  -ShaderTypes FVirtualShadowMapProjectionCS -Permutation 17 -VSMAdaptiveProbe
& tests/web-platform/probe-web-virtual-resources.ps1 `
  -ShaderTypes FVirtualShadowMapProjectionCS -Permutation 18 -VSMAdaptiveProbe

node tests/web-platform/verify-vsm-adaptive-policy.cjs
node tests/web-platform/diagnostics/prepare-vsm-adaptive-probe.cjs `
  <variants.json> <probe17/ShaderConversion> <probe18/ShaderConversion>
node tests/web-platform/diagnostics/benchmark-vsm-adaptive.cjs `
  --variants=<variants.json> --tag=<new-gpu-tag> --kind=gpu
node tests/web-platform/diagnostics/benchmark-vsm-adaptive.cjs `
  --variants=<variants.json> --tag=<new-timing-tag> --kind=timing
node tests/web-platform/diagnostics/summarize-vsm-adaptive.cjs `
  --gpu=<gpu/result.json> --timing=<timing/result.json> `
  --default-probe=<probe17-without-switch> --default-probe=<probe18-without-switch> `
  --out=<evidence.json>
```
