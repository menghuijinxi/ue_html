# Web 遮挡历史与 HZB 异步读回实验

2026-11-05 更新。**有效历史＋Game 本地调度已设为默认**。用户完成快速移动人工测试，未发现缺物或明显操作延迟，并明确要求启用。此前同包十八轮固定视角性能复测中，该组合为 **108.33 FPS / 1% Low 54.49**；同调度基线为 96.56 / 46.62，分别提升 **12.19% / 16.88%**。普通物体 HZB 和实例 HZB 保持独立对照项。

## 默认启用与切回原路径

新包 `villa-occlusion-default-v67` 无需 URL 参数即可使用有效查询历史和 Game 本地调度：`http://127.0.0.1:8765/build/villa-occlusion-default-v67/index.html`。后续线程包的公共启动器也默认选择 `history` 和本地调度；Web CVar `r.Web.OcclusionHistory` 默认 1，程序的默认遮挡模式为 `history`。原有测试包保留各自版本，避免覆盖历史证据。

切回完整原路径使用 `?occlusion=control&clock=owner`。只恢复原调度使用 `?clock=owner`；只关闭有效历史使用 `?occlusion=control`。对比页的原调度链接显式包含 `clock=owner`，不依赖默认值。显式 `-WebFrameScheduler=1..4` 仍选择页面帧时钟；本地调度与页面帧时钟不能同时指定。

页面隐藏状态在 Game Worker 启动前保存，本地调度启动时读取当前隐藏状态；后续隐藏/恢复继续更新暂停状态。Game Worker 回报实际启用的时钟和暂停状态，诊断名为 `__webGameFrameClock`。页面关闭或启动失败时移除时钟的 visibility 监听。

用户的人工观察确认快速移动没有发现缺物或明显操作延迟；未量测输入到显示的毫秒数，也不将此结论推广为所有动态遮挡场景的正确性证明。默认启用记录与运行检查见 [默认模式验证](tests/web-platform/evidence/occlusion-history-default-20261105.json)。

v67 完成多线程 mimalloc 编译、正常 UBT 链接、WASM 检查及原 Cook/config 打包。按“无参数默认 → 显式原路径 → 无参数默认”启动三次，实际时钟分别为 local / owner / local；默认两次均消费完成的有效历史，HZB、实例 HZB 及查询等待均为 0。两次默认十秒短测为 105.07 / Low 54.14、101.22 / Low 55.49，仅用于启动回归，不替代前述十八轮性能结论。

两次默认启动均检查隐藏处理函数：隐藏期间提交帧计数停止，恢复后继续；另一次从隐藏状态启动，Game Worker 报告暂停，600 ms 启动观察窗的帧计数仅从 0 到 1，恢复后正常运行。自动化通过模拟 `document.hidden` 检查处理函数，不宣称浏览器真实后台节流已经验收。十组默认值和显式覆盖组合检查通过，全部运行未捕获 GPU 验证或运行错误。引擎默认值与状态回报提交为 `75d375164`。

## GPU 空闲后的十八轮复测

2026-11-04 晚至 11-05 凌晨，复用已经构建的 `villa-occlusion-history-v66`，没有修改运行时、Cook、配置或画质。原调度按 `control → history → hzb → instances → hzb-instances → hzb-instances → instances → hzb → history → control` 跑十轮；Game 本地调度按 `control → history → hzb → hzb-instances → hzb-instances → hzb → history → control` 跑八轮。实例 HZB 单独分支只测原调度。

每轮使用独立可见 Edge 会话，等运行超过 600 帧且纹理流送 pending 为 0，再额外预热 15 秒，计时 20 秒。启动测试前 GPU 占用约 2%–3%；每轮启动浏览器前的占用为 2%–25%，均通过空闲门禁。脚本核验实际 HZB/实例 CVar、查询等待预算 0、相同相机/画质/视口及计时前后流送完成。十八轮全部通过，没有捕获 GPU 验证或运行错误。

下表每格为两轮合并的 **FPS / 1% Low**。Low 从两轮全部提交间隔中取最慢 `ceil(N×1%)` 个间隔的平均值求倒数，不是两次 Low 的算术平均。

| 剔除模式 | 原调度 | Game 本地调度 |
| --- | ---: | ---: |
| 原路径 | 80.63 / 33.00 | 96.56 / 46.62 |
| 有效查询历史，不阻塞 | **86.38 / 35.63** | **108.33 / 54.49** |
| 普通物体 HZB，四槽读回 | 75.73 / 34.36 | 77.01 / 40.10 |
| 实例 HZB | 79.64 / 31.86 | 未单独测试 |
| 普通物体 HZB＋实例 HZB | 73.21 / 34.55 | 76.32 / 39.95 |

只加查询历史，原调度下 FPS 提升 7.13%、Low 提升 7.97%。只比较同为 Game 本地调度的两组，查询历史额外提升 FPS 12.19%、Low 16.88%；组合相对完整原路径为 FPS +34.35%、Low +65.13%，这个组合差值同时包含调度与历史消费变化，不能全归因于遮挡查询。

最好的组合两次独立运行分别为 **108.25 / Low 53.64**、**108.40 / Low 55.39**，固定视角平均帧率较接近。其同调度基线两次为 96.18 / Low 50.04、96.93 / Low 45.21，Low 存在波动；这是本机本场景的一次交错实验，不代表移动视角或跨环境稳定增幅。

本地调度原路径的 RHI 查询读取全部未就绪，保守绘制，每帧约 3854 个 direct draw。加历史后，每帧约消费 554 条有效历史、其中约 517 条判为遮挡，direct draw 降至约 2842，RHI 工作墙钟从约 9.84 降至 8.71 ms/帧。因此这次高帧率伴随真实历史结果消费。仍有约 129 次/帧的可见回退和少量查询过期丢弃；primitive 以外的阴影等查询维持原路径，不能称为所有查询都已恢复消费。

普通物体 HZB 在原调度下每帧完成一份读回、消费约 595 条历史，direct draw 约 2562；本地调度每帧约完成 0.993 份、消费约 591 条历史。这证明候选生效，但它在两种调度下都没有提高平均帧率。组合实例 HZB 也没有收益。本轮没有拆解 HZB 的 GPU 测试、纹理上传、读回和调度各自耗时，不能只由绘制数推断瓶颈。

性能复测当时，正常窗口的两张静态截图目视未见明显缺物，运动视觉仍待人工验收，因此当时没有启用默认。随后用户的快速移动人工检查及默认启用决定见上节。FPS 是 RHI 提交吞吐；没有测物理显示帧率、输入到显示延迟或计时窗口内的 OS GPU 利用率。

本次汇总、实际运行脚本副本及包文件哈希见 [性能复测证据](tests/web-platform/evidence/occlusion-history-performance-20261105.json)。原始 JSON 为 `tests/web-platform/results/occlusion-v66-normal-20261104.json` 和 `occlusion-v66-local-20261104.json`；此前外部 GPU 高占用的失败样本保留，未合入本次汇总。

## HZB 的两个用途

`r.InstanceCulling.OcclusionCull=1` 在 GPU 上使用 HZB 剔除实例，可用于植被、ISM/HISM 等实例系统。`r.HZBOcclusion=2` 是另一条路径：测试普通 primitive 的包围盒，把可见性结果读回，供 CPU 的场景可见性处理使用。它也能处理普通静态网格，不局限于植被。

本次主要修复第二条路径的 Web 异步消费。旧实现只有一份纹理读回，下一帧读取时往往还未就绪，随后又被下一次测试替换。四槽实现保留待完成读回及对应的 primitive 身份、相机、包围盒和采样帧；只锁定已经就绪的槽。槽全部占用时跳过本次提交，保守恢复可见，避免覆盖仍在进行的读回。

## 历史结果与可见性边界

普通查询路径保存待完成 query 的引用，消费时使用 `RHIGetRenderQueryResult(..., false)`，结果按 primitive 身份匹配，并只保留较新的完整结果。查询池在旧 generation 仍被引用时换用新 query，避免池复用后把别次测试误当作旧采样。正常提交与限流提交都记录来源。

两种候选共享这些有效性条件：结果最多距当前 8 个引擎帧且不超过 80 ms；投影和视口匹配；相机位置差不超过 0.5 cm，旋转矩阵误差不超过 0.00001；目标包围盒位置和 extent 差不超过 0.01 cm。可移动目标及 WPO 目标不使用缓存剔除。重复使用结果不会延长其寿命；切换历史模式会使此前记录失效。缺失、未完成、过期或不匹配的结果按可见处理。

这些条件降低快速转向时消费旧结果的风险，但不能证明所有场景安全。相机不动而遮挡物移动、材质改变遮挡轮廓等情况仍可能使静态目标短暂延迟出现；80 ms 是结果年龄上限，不是已经测得的视觉延迟或正确性保证。人工验收应重点检查走出墙角、快速回头、门窗变化、运动遮挡物和阴影。

## 构建与首次测试记录

v65 完成 Web 多线程 mimalloc 编译、正常 UBT 链接、WASM 检查和保持原 Cook/config 的打包。短测确认普通查询历史和普通物体 HZB 都消费过真实结果，HZB 环形读回完成计数增长；未捕获 GPU 验证错误。该版本的短测并非性能验收：纹理流送进入了五秒窗口，且机器正在运行其他 GPU 工作。

排查时关闭测试浏览器，RTX 4090 仍有 83%–99% 占用，显存约 21 GiB，系统存在 `cod.exe`。复跑上轮未改动的 v64 包也只有 **17.76 FPS / 1% Low 8.71**，此前同包约 77.89 FPS。因此不能把这批低帧率归因于候选，也不能由其中的分支差值计算优化收益。

v65 的本地调度历史分支没有消费到满足年龄限制的结果，脚本按预期失败，保留原始报告，不计作有效候选性能样本。最终测试脚本增加启动前 GPU 空闲检查，并等流送 pending 为 0、引擎运行超过 600 帧后再额外预热。启动测试浏览器前 GPU 已超过 50% 占用时直接拒绝计时。

v66 补齐模式切换的历史失效和限流提交的查询跟踪，已完成编译、链接、WASM 检查和打包，引擎改动提交为 `76fc69d1e`。首次启动正式对照前 GPU 为 99%，空闲门禁拒绝启动测试浏览器，当时未做 v66 运行与完整性能验证。该次构建、打包及失败输入哈希保留在 [首次实验记录](tests/web-platform/evidence/occlusion-history-20261104.json)；之后 GPU 空闲的成功复测见上节。

## 测试入口与复现

启动工作区现有 8765 静态服务后，打开 `http://127.0.0.1:8765/occlusion-experiments.html`。每次只运行一个入口，模式切换使用重新加载。页面提供五种剔除模式与两种调度组合：原路径、有效查询历史、普通物体 HZB、实例 HZB、两种 HZB 组合。

Game 本地调度现为默认，未增加 GPU 完成预算；输入延迟通过人工观察，尚未量测。剔除开关为 `r.Web.OcclusionHistory`，查询等待预算保持 0。十八轮性能证据中的 `acceptedForDefault=false` 记录的是复测当时的状态，之后的人工验收及默认启用由独立记录保存。

```powershell
tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4
node tests/web-platform/package-web-runtime-experiment.cjs --baseline=villa-lumen-off-current-mimalloc-v59 --output=villa-occlusion-repeat --evidence=tests/web-platform/results/post-mimalloc-v59-profile-20261104.json
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-occlusion-history.cjs --folder=villa-occlusion-repeat --tag=occlusion-repeat-normal --modes=control,history,hzb,instances,hzb-instances,hzb-instances,instances,hzb,history,control --seconds=20 --warmup=15
node tests/web-platform/probe-web-occlusion-history.cjs --folder=villa-occlusion-repeat --tag=occlusion-repeat-local --modes=control-local,history-local,hzb-local,hzb-instances-local,hzb-instances-local,hzb-local,history-local,control-local --seconds=20 --warmup=15
node tests/web-platform/summarize-web-occlusion-history.cjs --reports=tests/web-platform/results/occlusion-repeat-normal.json,tests/web-platform/results/occlusion-repeat-local.json --output=tests/web-platform/evidence/occlusion-repeat.json
```

正常计时使用可见 Edge、浏览器视口 2289×1287、内部渲染 1484×835、输出 2289×1288、相同初始视角及原始光照，没有 profiler、逐 draw 包装或额外 GPU 时间戳。内建历史统计保持启用，其成本包含在计时中。FPS 是 RHI 提交吞吐；1% Low 从提交间隔中最慢 1% 的平均时间求倒数，均不是物理显示帧率或输入延迟。
