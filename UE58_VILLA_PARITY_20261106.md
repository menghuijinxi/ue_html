# TriplexHouseVilla 不限帧性能对照（2026-11-06）

**尚未达到用户要求，不作为用户测试版本交付。** 已完成桌面和浏览器实际运行采集、画质成本拆分、CPU/GPU 采样、阴影缓存候选及多种失败方案的验证。保留画质功能的候选仍有很大的平均帧率与 1% low 差距，物理呈现平滑度也未获得可靠验证。

## 采集口径

- 本机 i9-12900K、RTX 4090，可见 Edge 156.0.4314.58，实际输出与内部渲染均为 1280×720、DPR 1、默认出生视角。桌面使用现有 Development 打包程序，分别核对 SM6、SM5；主对照为 D3D12 SM5。
- `t.MaxFPS=0`、`r.VSync=0`。原生另关平滑帧率。TSR=4、动态模糊=4、纹理池 1000 MiB，保持当前项目实际的 GI=0、ReflectionMethod=0。这里没有套用历史 Lumen 开启包的结论，也没有通过限制桌面帧率追平结果。
- 主对照浏览器使用 **owner** 时钟、有效遮挡历史、priority RHI 唤醒。未启用用户否决的 Game 本地时钟。候选启动器默认 owner；旧 v74 基线显式传入 `clock=owner`。额外的两帧 GPU 完成预算调度实验另行记录，不混入主对照。
- 原生读取 UE CSV 的 FrameTime；浏览器记录 RHI 提交帧间隔。平均 FPS 为总帧数除以间隔总时长；1% low 为最慢 `ceil(N×1%)` 个正间隔的均值取倒数，保留所有长帧。两者均不是显示器扫描输出 FPS。
- 先等待启动、PSO 预缓存和流送完成，再预热。CPU profiler、逐 draw 包装与 GPU timestamp 采样分开运行，不把带采样的数据当作正常性能。

## 实际结果

第一组静止视角对照（含轻量 GPU 完成探针和 PresentMon 尝试）：

| 路径 | 平均 FPS | 1% low | RHI 工作 ms/帧 |
| --- | ---: | ---: | ---: |
| 桌面 D3D12 SM5 | 185.61 | 150.75 | 约 1.75 |
| Web v74 owner 基线 | 81.67 | 38.06 | 8.45 |
| Web 开启 UE CSM 缓存 | 100.39 | 41.77 | 6.84 |
| Web CSM 缓存 + 内存统计修复 | 100.64 | 40.57 | 6.86 |

这一组观察到平均吞吐约增加 23%，1% low 的改善很有限。它不是交错多轮发布验收，不能把小幅差异解释成稳定收益。新候选依旧比桌面平均帧率低约 46%、1% low 低约 73%。

另去掉无效的 PresentMon 采集后，桌面复测 **195.76 / 157.15 FPS**；Web CSM 候选保留 GPU 完成探针时为 **97.15 / 36.19 FPS**。这排除了“仅仅是 PresentMon 导致 Web 低帧”的解释，同时显示跨次运行存在波动。

无 PresentMon、无额外 GPU 完成探针的普通采样：Web v74 基线 **80.69 / 37.04 FPS**，CSM + 内存统计修复 **100.71 / 38.69 FPS**。平均提高约 **24.8%**，1% low 仅约 **4.5%**。与这一轮桌面相比，平均差约 48.6%，低帧差约 75.4%，远未接近。

运动诊断使用持续 DOM 鼠标、键盘事件，经原有 owner 输入转发：旧基线 **89.58 / 30.66**，CSM 候选 **103.86 / 35.43**。轨迹随时序存在差异，且没有同路线原生记录，因此只证明移动时低帧问题仍在，不能用作跨平台运动验收。

最终重编译的 CSM + 内存统计候选又完成 30 秒移动预热、30 秒移动采样：**102.99 / 33.44 FPS**，最长间隔 **53.56 ms**，GPU 在途峰值 4，完成通知平均 12.97 ms、最长 59.79 ms。运行检查通过，低帧仍不合格；页面观察/提交比例约 0.9995 也不能推翻长帧和呈现验证缺口。

## 已定位的差距

1. **阴影提交成本明显。** CSM 候选 draw 从约 2662 降到 1349 次/帧，RHI 工作减少约 1.6 ms。使用的是 UE 已有 `r.Shadow.CSMCaching=1`，属于配置选择，不能说是新增了 Web 阴影缓存功能。
2. **局部光阴影、遮罩与照明仍有大量 CPU 编码。** CSM 采样约有 518 次 ShadowDepthAtlas draw、129 次 ShadowMaskTexture draw；WebCubeShadowFace 约 84 次。大量小 pass、资源绑定和浏览器 GPU 服务处理仍在。
3. **GPU 着色器工作没有解释全部差距。** 三个 GPU timestamp 样本 pass 合计约 2.75、2.82、3.08 ms，未包含复制与间隙，不能称为完整 GPU 帧。RHI 线程墙钟采样中命令回放约 21%，CreateGroups 自身合计约 6%；WebGPU API、Wasm 工作及等待共同构成剩余成本。
4. **关闭单一效果不足以追平。** Web 关闭透明体积光约 88.39/40.55，关闭距离场 AO 约 86.25/38.51，关闭 AA 约 84.37/37.32 FPS。启动时关闭全部阴影为 171.51/55.98，低帧仍很低，而且画质不等价，明确排除为交付优化。桌面关闭阴影约 308.54/204.67 FPS。

出生视角截图人工对照未见明显新增缺失，但尚未完成全场景画质验收。UE CSM caching 本身会使用不同的深度偏移处理，不能宣称逐像素等价，也不能只凭静止截图证明动态阴影无问题。

## 对“假高帧”的处理

额外观察每帧 GPU 完成通知、在途帧数与完成通知延迟；这些延迟包含浏览器回调递送时间，不等于纯 GPU 执行时间。正常 owner CSM 路径的峰值在途约 4 帧，完成通知平均约 13.83 ms。

| 实验 | FPS / 1% low | 处理 |
| --- | ---: | --- |
| owner 提前请求一个 rAF | 108.68 / 40.67 | 拒绝：峰值在途从 4 增至 5，平均完成通知延迟升至 16.56 ms，低帧无改善 |
| CSM + Render Bundles | 93.21 / 40.68 | 拒绝：平均帧率回退，实际有缓存命中，不能归因为没有启用 |
| CSM + staging 上传页 | 101.13 / 41.36 | 未采纳：收益不足 |
| CSM + JS compute pass 合并原型 | 97.64 / 34.97 | 拒绝：实际 compute pass 从约 161 降到 17，但此原型没有改善帧率和低帧 |
| CSM + 两帧 GPU 完成预算 | 84.16 / 41.25 | 未采纳：在途/预留上限断言通过，最长间隔 32.66 ms，但吞吐下降，低帧仍未接近桌面 |
| Game 本地时钟 | 未测试为候选 | 用户已否决，不重新采用 |

compute 合并原型独立 GPU 回读通过：跨管线、清理遗留 group、复制边界、显式 pass 描述符及 finish 边界的输出均正确。依据是每次 compute dispatch 有独立的资源 usage scope，见 [WebGPU 同步规则](https://gpuweb.github.io/gpuweb/#programming-model-synchronization)。这里只拒绝本次 JS 原型，不能据此认定 C++ 实现或所有 compute 合并都无效。实验脚本保存用于复查，没有进入公共运行时。

PresentMon ETW 没有获得可靠的浏览器呈现 CSV；一次独立控制采集报告 50,169 个丢失事件。最初的原生呈现数据也不完整，不能用于比较。页面观察到的新帧计数不是物理屏幕呈现证明，**目前不能声称已经消除了体感卡顿**。

两帧预算实验使用已有 page rAF + owner GPU 完成反馈，不是 Game 本地调度，也没有固定 FPS 上限。它将 in-flight 控制在两帧，同时使未返回的遮挡结果从约 322 降到 10 次/帧、draw 降至约 1237；这些与反馈时序有关，不能当成同一 workload 下单纯调度加速。首轮采集器错误地要求该实验仍报告 owner mode，已修正断言并用新 tag 重跑，失败记录保留。

## 已合入的代码与验证

- 引擎提交 `7f8084ce4`：Web 内存统计返回 Wasm 线性内存容量与剩余虚拟预算，物理内存字段继续为未知；消除每帧 `GetStats not implemented` 警告。完整线程目标编译、链接、Wasm 校验通过，真实运行确认该警告为零。**没有测得可归因的帧率提升。**
- 构建脚本将对应源码同步到本地 Core overlay，并记录源文件和实际编译副本的哈希；没有改动安装引擎。
- 新增 native/Web 采集脚本、独立候选打包脚本、汇总脚本。候选校验源包 manifest，不覆盖旧包；新生成候选只复制审计过的运行文件，避免带入旧比较页和说明。
- 所有候选和汇总均保留 `performanceAccepted=false`，不因功能检查通过就宣称性能验收通过。
- 初次在运行中切换 ShadowQuality 触发延迟渲染任务断言，失败证据完整保留；后续阴影拆分改为启动时设置。
- 每个 Web 基线/候选启动都有 **834 条管线创建失败日志**，与不支持的 speculative precache 请求计数一致；异步编译失败计数为零。另有相应 shader/格式详情日志。它们是现有预缓存拒绝，**不是“零 Error 日志”**。新采集器记录并核对这些计数，启动完成后的错误单独使检查失败。
- 原生采样完整，但结束时仍返回历史退出码 **777003**，发生于 CSV 完成和日志关闭后；采集明确标记 `cleanExit=false`，不把整个进程生命周期算成功。

## 证据和复现

可携带汇总：`tests/web-platform/evidence/villa-parity-20261106.json`。完整逐帧数组、CSV、截图、日志、CPU profile 和浏览器 trace 保存在本地 `tests/web-platform/results/`，汇总记录原始文件 SHA-256。实验包仍留在本地 build 目录，未发布、未提供用户验收入口。

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
./tests/web-platform/capture-villa-parity-native.ps1 -Tag new-native -SM5 -NoPresentMon
node tests/web-platform/package-villa-parity-candidate.cjs --baseline=villa-parity-memory-20261106 --output=new-csm --csm
node tests/web-platform/capture-villa-parity-web.cjs --folder=new-csm --tag=new-web --seconds=45 --no-presentmon
node tests/web-platform/capture-villa-parity-web.cjs --folder=new-csm --tag=new-web-gpu --seconds=45 --gpu --no-presentmon
node tests/web-platform/verify-web-owner-lookahead.cjs
node tests/web-platform/verify-web-compute-pass-merge.cjs
node tests/web-platform/summarize-villa-parity.cjs
```

浏览器命令需要已运行的本地 8765 服务和 Playwright。各性能测试顺序执行，不与构建或其他游戏采样并行。正式验收仍缺少：平均/低帧接近的实现、可复现的跨平台同路线运动对照，以及可靠的呈现间隔和队列延迟验证。

## 用户要求的提前回退检查

随后用户要求先提供页面检查是否存在负面优化，新增 [人工对照页](http://127.0.0.1:8765/villa-parity-test.html)。页面提供当前 CSM + 内存统计候选、优化前 v74 owner 基线，以及相同新运行时关闭 CSM 的单变量对照。所有链接显式选择 owner 调度、保持不限帧，并在当前标签页导航，避免默认同时运行两个游戏。

这是按用户要求提前进行的回退检查，性能对齐和最终交付状态仍为未完成。页面和三个入口 HTTP 200、跨源隔离响应头、三个包全部 manifest 哈希检查通过；页面截图已检查。本次没有修改运行时或重新解释之前的性能数据。
