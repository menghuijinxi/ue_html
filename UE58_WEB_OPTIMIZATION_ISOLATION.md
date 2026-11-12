# 关闭优化后的流畅度排查

日期：2026-11-12。项目：`H:/TriplexHouseVilla`。

用户反馈 TSR 恢复 16x16 后仍卡顿，要求关闭优化以定位原因。
此前只有单项关闭试验，缺少三项同时关闭的对照。本轮补上组合，
也关闭更早的 17 个 Web 性能 CVar；保留用户认可的自适应采样。
没有把诊断开关写回普通发布默认值。

## 可操作页面

`http://127.0.0.1:8765/villa-smoothness-live.html#off`

页面默认选择“新增优化关闭”：

- `r.WebGPU.IndirectDrawReuse=0`
- `r.WebGPU.VSMPageOptimization=0`
- `r.WebGPU.TSRLargeTiles=0`

“早期优化也关闭”额外关闭统一发布配置中的 `r.Web.*` 和 `r.WebGPU.*`
性能开关，共 17 项，具体值随诊断包报告保存。它不撤销 DPR 修复、
多页缓存共享读取锁、实际管线预热或原生输入桥，也不关闭自适应 SMRT。
页面帧时钟及 GPU 完成预算仍保持原配置，因此不是回退全部历史代码。

两个模式均保持 Lumen GI/反射、VT、VSM 和 TSR 开启，
内部渲染 1400x788，输出 1920x1080。当前场景实际 VT 资产数仍为零。
允许真实 WASD/右键转向，切换时恢复 Pawn 位置及控制器朝向，
仍只保留一个场景 worker，提供预设视角、重置、滚动统计和导出。

`prepare-villa-optimization-isolation.cjs` 生成独立诊断包，以硬链接共享
不可变运行时和 Cook；只修改私有 worker 与入口版本信息。
INI 覆盖发生在引擎初始化前的内存文件系统中，页标记开关必须在此时设置。
旧包字节不变，没有新 Cook 或重新编译。

这两个包明确标记 `diagnosticOnly`，不是正式发布包。
原包实采预热仍被采用，但启动覆盖会产生原记录没有的排列：
功能检查记录约 5～6 次、13 次启动 miss。性能窗口经过相同路线预热，
要求 miss 不再增加且没有新增管线或模块创建。
不能把它们描述成已重新采集并匹配覆盖配置的正式预热。

## 已完成的测量

每次使用独立 Edge 进程，复用项目内已有 profile；转动及真实鼠标拖动各测 15 秒，
预先走相同转动、移动路线。Low 为最慢 1% 提交间隔的平均值换算 FPS。
下表保留早期已完成窗口，不剔除慢帧。这两组四轮计划没有完整完成，
失败轮次不能当作通过；释放空间后的完整交叉复测单列在后面。

| 试验与轮次 | 转动 FPS / Low | 原生拖动 FPS / Low |
| --- | ---: | ---: |
| 老自适应页，第 1 组第 1 轮 | 46.32 / 23.10 | 43.36 / 18.56 |
| 新增三项全关，第 1 组第 2 轮 | 44.27 / 21.78 | 42.55 / 19.27 |
| 新增三项全关，第 1 组第 3 轮 | 43.59 / 19.24 | 42.36 / 17.99 |
| 新增三项全关，第 2 组第 1 轮 | 43.97 / 22.73 | 42.11 / 20.93 |
| 17 个 Web CVar 全关，第 2 组第 2 轮 | 44.98 / 24.07 | 41.01 / 19.19 |
| 17 个 Web CVar 全关，第 2 组第 3 轮 | 42.70 / 19.62 | 39.74 / 18.57 |
| 新增三项全关，独立复测 | 45.16 / 22.28 | 41.24 / 20.57 |

第一组第 4 轮老版因浏览器存储配额错误未进入测量；
中间另保留一次重试后成功的 `external Instance reference` 启动错误。
第二组第 4 轮在路线预热等待时超时，没有性能窗口，不纳入比较。
这些失败与有效窗口一并保存在原始报告中。

### 释放空间后的完整交叉复测

用户释放空间后，H 盘可用约 16.4GiB。新增 `--retain-cooks` 仅在测试进程中
将浏览器存储配额及缓存保留上限改为 12GiB，同时保留两个不可变 Cook；
没有修改生产缓存 worker 或旧包。依次运行“老版、三项全关、三项全关、老版”，
每个转向和原生拖动窗口延长为 30 秒，四轮全部通过，无启动重试、GPU 校验错误、
测量期新管线创建或新增预热 miss。

| 轮次 | 版本 | 转向 FPS / Low | 原生拖动 FPS / Low | 转向 / 拖动 >33.34ms 帧 |
| --- | --- | ---: | ---: | ---: |
| 1 | 老自适应页 | 47.46 / 36.55 | 45.33 / 25.68 | 0 / 8 |
| 2 | 新增三项全关 | 45.43 / 19.20 | 42.66 / 21.65 | 55 / 61 |
| 3 | 新增三项全关 | 45.23 / 20.70 | 42.14 / 19.13 | 54 / 84 |
| 4 | 老自适应页 | 45.17 / 19.03 | 42.80 / 19.43 | 53 / 69 |

旧版最后一轮也出现相近卡顿，转向最长提交间隔 143.52ms，
因此第一轮旧版较快不能直接证明新版存在固定幅度的性能回退。
这次完整复测排除了磁盘不足导致测试无法完成的障碍，没有证明释放空间修复卡顿。
原始结果：`results/villa-alloff-abba-space-20261112/result.json`。

额外核对两套 Cook 的 5163 个文件，仅全局 shader 缓存和全局 shader 库不同，
场景资产一致。旧诊断页替换后的两段 VSM 自适应投影 WGSL 与新版预热记录中的
对应模块在去除入口名称和首尾空白后完全一致。这是指定模块的源码比较，
不等于证明整个运行时、全部 shader 排列或驱动生成代码相同。

### 帧预算单变量对照

在新增三项全关的同一个包上，仅用 URL 参数将 GPU 完成预算从 3 改为 4，
再按 3/4/4/3 运行，仍为各 30 秒，四轮全部通过：

| 预算与轮次 | 转向 FPS / Low | 原生拖动 FPS / Low | 转向 / 拖动 >50ms 帧 |
| --- | ---: | ---: | ---: |
| 3，第 1 轮 | 44.58 / 21.99 | 42.99 / 21.24 | 2 / 2 |
| 4，第 2 轮 | 45.65 / 15.10 | 42.88 / 15.39 | 26 / 30 |
| 4，第 3 轮 | 45.77 / 16.13 | 43.51 / 15.75 | 20 / 29 |
| 3，第 4 轮 | 44.12 / 19.96 | 43.08 / 19.49 | 5 / 7 |

两次预算 4 的 Low 均低于两次预算 3，并增加长帧，拒绝扩大预算作为修复。
这证明该调整在此条件下会恶化节奏，尚未证明现有预算 3 是原始卡顿的唯一原因。
未写回生产宿主，也未改变页面默认调度。
原始结果：`results/villa-alloff-framebudget-abba-20261112/result.json`。

## 已缩小的范围

关闭三项和更早的性能 CVar 后仍有长帧，不能用全部撤销来证明修复。
更早 CVar 全关时 RHI 平均工作约 11.7～11.9ms/帧，
保留早期优化、仅关闭三项时约 10.2～10.4ms/帧。
CPU 端平均工作增加，真实拖动 Low 没有稳定恢复。

逐帧记录中，57.19ms 提交间隔对应 RHI 工作约 10.11ms、
最近一次 Game Tick 约 2.04ms，纹理流送 pending 为 0。
这一时刻已完成/已提交/已保留帧为 2675/2676/2678，完成预算上限为 3。
因此长间隔不能简单等同于一次 RHI 或 Game 工作执行了 57ms。
所有有效测量窗口没有新模块/管线创建，没有新增预热 miss。
这排除了这些窗口内的启动管线编译和待处理纹理流送解释，
不意味着其他所有 I/O 或 CPU 排队因素均已排除。

单独 10 秒浏览器跟踪中，WebGPU 服务线程处理跨度合计约 5.13 秒，
单次最长约 18.95ms；另一次跟踪出现 23.91ms。
独立复测中 Minor/Major GC 最长分别约 2.09/3.84ms。
跟踪发生在性能窗口后，不混入 FPS；WebGPU 服务 CPU 时间不能当成
GPU 着色器硬件执行时间，也没有证明这些峰值与每一条长帧一一对应。

当前将排查范围缩小到 GPU 完成、浏览器 GPU 服务处理及帧调度之间。
尚未隔离具体 shader、驱动调用或单个代码根因，不宣称已经修复卡顿，
也不把 TSR、间接复用或页同步单独定性为罪魁。

### GPU 硬件计时的限制

三项全关的诊断包另做拆分计算通道的 timestamp-query 采集，
先每阶段 6 帧，再每阶段 120 帧。密集采样的通道时间均值：

| 阶段 | 通道耗时合计 | 首通道开始至末通道结束均值 | 采样帧最长提交间隔 |
| --- | ---: | ---: | ---: |
| 静止 | 19.56ms | 20.87ms | 29.52ms |
| 转向 | 19.23ms | 20.56ms | 31.41ms |

转向中 Lumen 探针体素追踪约 1.30ms、radiosity 追踪约 1.16ms、
TSR RejectShading 约 1.16ms、TSR 历史更新约 0.90ms、VSM 投影约 1.05ms
（稀疏采样；不能把这几项相加当作整帧成本）。
它们说明负载分布，没有指出一个突然耗时 50～60ms 的单通道。

密集采样的 240 个选中帧没有复现原先大于 40ms 的提交间隔。
但查询、回读节奏及关闭计算通道复用均改变了诊断条件，
选中帧的间隔也不能描述未采样的其他帧，因此没有据此排除 GPU 或认定修复。
这触发了额外的无 timestamp-query、仅关闭计算通道复用的单变量对照。
原始结果：`results/villa-alloff-gpu-20261112/`、
`results/villa-alloff-gpu-dense-20261112/`。

### 计算通道复用单变量对照

首次计划在第 2 轮路线预热时出现多条 `external Instance reference` 错误并超时，
未进入该轮性能窗口。失败报告保留；脚本补充有限的预热期实例失效重试，
不重试已经开始的测量，也不将失败窗口计为通过。
随后按开启/关闭/关闭/开启重跑，每阶段 15 秒，四轮均通过且未触发重试：

| 计算通道复用与轮次 | 转向 FPS / Low | 原生拖动 FPS / Low |
| --- | ---: | ---: |
| 开启，第 1 轮 | 47.12 / 37.94 | 45.60 / 24.59 |
| 关闭，第 2 轮 | 46.71 / 33.77 | 45.28 / 23.27 |
| 关闭，第 3 轮 | 46.92 / 35.32 | 45.38 / 26.13 |
| 开启，第 4 轮 | 46.99 / 33.23 | 45.59 / 25.62 |

开启状态本轮也恢复较平稳的转向节奏，关闭状态没有稳定的整体优势，
所以不能将 GPU 采样时未出现长尾归因于关闭计算通道复用。
本轮短窗口没有完整复现先前严重长尾，不能据此宣称其已修复或排除该项。
实例失效错误本身也尚未定位；不能把它归为磁盘错误或确定由性能开关触发。
原始结果：`results/villa-alloff-computepass-abba-20261112/`、
`results/villa-alloff-computepass-abba-retry-20261112/`。

## 显存与存储边界

新增诊断按创建/销毁及可回收对象估算 GPU 资源请求字节数。
它覆盖压缩块、mip、数组层、3D 深度和 MSAA，不把请求量当作驱动驻留量。
独立复测中，VSM 物理页纹理约 512MiB，原子镜像约 512MiB；
UAV 光栅占位附件约 256MiB，两个 Lumen radiosity atlas 各约 256MiB。
这些是已存在的分配，不是本轮证明的新泄漏或显存换页根因。

开场时外部 Edge 曾占约 4.7GB 专用显存，适配器总用量约 7GB；
正式测量前已降至约 2.3～2.5GB，场景运行时总用量约 7.3GB。
因此外部显存负载是必须控制的变量，不能将一次不同负载的体感差异
直接解释为版本的固定性能差。后台页面的占用未由本轮强制关闭。

早期测试末 H 盘仅可用约 2.8GiB，曾停止补跑，未在项目外写缓存。
用户随后释放空间，已用项目内原 profile 完成上述四轮交叉复测。

## 验证与复现

`verify-villa-smoothness-live.cjs ... --modes=off,plain,off` 通过：
实际只有 256 线程的 TSR 卷积排列被派发，两个 RHI 开关均为 0，
plain 模式计算通道复用也为 false。每次键盘移动约 53cm，右键转向约 38.15 度。
位置保持、单 worker、桌面及 390px 布局、非空画面、导出和重置均通过，
没有 GPU 校验错误。该结果是功能验证，不代表性能已改善。

```powershell
node tests/web-platform/diagnostics/verify-villa-gpu-memory-observer.cjs
node tests/web-platform/diagnostics/benchmark-villa-release-regression.cjs `
  --tag=<新的结果名> --order=previous,unoptimized --phases=turning,input --seconds=15
node tests/web-platform/diagnostics/benchmark-villa-release-regression.cjs `
  --tag=<新的交叉结果名> --order=old,previous,previous,old `
  --phases=turning,input --seconds=30 --retain-cooks
node tests/web-platform/verify-villa-smoothness-live.cjs `
  <新的结果名> --modes=off,plain,off
node tests/web-platform/diagnostics/probe-vsm-remaining-costs.cjs `
  --folder=villa-added-optimizations-off-20261112 --tag=<新的GPU结果名> `
  --kind=gpu --page-mode=0 --profile=villa-regression-20261112 `
  --gpu-samples=120 --gpu-interval-ms=7
node tests/web-platform/diagnostics/summarize-villa-optimization-isolation.cjs
```

原始报告在 `tests/web-platform/results/villa-alloff-pressure-20261112/`、
`villa-all-webopts-off-20261112/`、`villa-alloff-dawn-20261112/` 和
`villa-alloff-abba-space-20261112/`、`villa-alloff-framebudget-abba-20261112/`、
`villa-isolation-live-20261112/`。验证摘要：
`tests/web-platform/evidence/villa-optimization-isolation-20261112.json`。
