# Web 遮挡历史与 HZB 异步读回实验

2026-11-04。增加默认关闭的两种候选：普通遮挡查询消费有效历史、普通物体 HZB 使用四槽异步读回。实例 HZB 可独立开启或与普通物体 HZB 组合。性能验收尚未完成，当前不能给出收益百分比。

## HZB 的两个用途

`r.InstanceCulling.OcclusionCull=1` 在 GPU 上使用 HZB 剔除实例，可用于植被、ISM/HISM 等实例系统。`r.HZBOcclusion=2` 是另一条路径：测试普通 primitive 的包围盒，把可见性结果读回，供 CPU 的场景可见性处理使用。它也能处理普通静态网格，不局限于植被。

本次主要修复第二条路径的 Web 异步消费。旧实现只有一份纹理读回，下一帧读取时往往还未就绪，随后又被下一次测试替换。四槽实现保留待完成读回及对应的 primitive 身份、相机、包围盒和采样帧；只锁定已经就绪的槽。槽全部占用时跳过本次提交，保守恢复可见，避免覆盖仍在进行的读回。

## 历史结果与可见性边界

普通查询路径保存待完成 query 的引用，消费时使用 `RHIGetRenderQueryResult(..., false)`，结果按 primitive 身份匹配，并只保留较新的完整结果。查询池在旧 generation 仍被引用时换用新 query，避免池复用后把别次测试误当作旧采样。正常提交与限流提交都记录来源。

两种候选共享这些有效性条件：结果最多距当前 8 个引擎帧且不超过 80 ms；投影和视口匹配；相机位置差不超过 0.5 cm，旋转矩阵误差不超过 0.00001；目标包围盒位置和 extent 差不超过 0.01 cm。可移动目标及 WPO 目标不使用缓存剔除。重复使用结果不会延长其寿命；切换历史模式会使此前记录失效。缺失、未完成、过期或不匹配的结果按可见处理。

这些条件降低快速转向时消费旧结果的风险，但不能证明所有场景安全。相机不动而遮挡物移动、材质改变遮挡轮廓等情况仍可能使静态目标短暂延迟出现；80 ms 是结果年龄上限，不是已经测得的视觉延迟或正确性保证。人工验收应重点检查走出墙角、快速回头、门窗变化、运动遮挡物和阴影。

## 当前验证与性能测试阻塞

v65 完成 Web 多线程 mimalloc 编译、正常 UBT 链接、WASM 检查和保持原 Cook/config 的打包。短测确认普通查询历史和普通物体 HZB 都消费过真实结果，HZB 环形读回完成计数增长；未捕获 GPU 验证错误。该版本的短测并非性能验收：纹理流送进入了五秒窗口，且机器正在运行其他 GPU 工作。

排查时关闭测试浏览器，RTX 4090 仍有 83%–99% 占用，显存约 21 GiB，系统存在 `cod.exe`。复跑上轮未改动的 v64 包也只有 **17.76 FPS / 1% Low 8.71**，此前同包约 77.89 FPS。因此不能把这批低帧率归因于候选，也不能由其中的分支差值计算优化收益。

v65 的本地调度历史分支没有消费到满足年龄限制的结果，脚本按预期失败，保留原始报告，不计作有效候选性能样本。最终测试脚本增加启动前 GPU 空闲检查，并等流送 pending 为 0、引擎运行超过 600 帧后再额外预热。启动测试浏览器前 GPU 已超过 50% 占用时直接拒绝计时。

v66 补齐模式切换的历史失效和限流提交的查询跟踪，已完成最终编译、链接、WASM 检查和打包，引擎改动提交为 `76fc69d1e`。启动正式对照前 GPU 为 99%，空闲门禁拒绝启动测试浏览器；最终 v66 尚未做运行、完整性能交错对照和人工视觉验收。构建、打包及失败输入哈希见 [实验记录](tests/web-platform/evidence/occlusion-history-20261104.json)。

## 测试入口与复现

启动工作区现有 8765 静态服务后，打开 `http://127.0.0.1:8765/occlusion-experiments.html`。每次只运行一个入口，模式切换使用重新加载。页面提供五种剔除模式与两种调度组合：原路径、有效查询历史、普通物体 HZB、实例 HZB、两种 HZB 组合。

Game 本地调度保留为吞吐诊断，未增加 GPU 完成预算；真实输入延迟和后台节流尚未验收，不能据此视为默认调度替代。新剔除与本地调度都默认关闭。实验开关：`r.Web.OcclusionHistory`；查询等待预算保持 0，不与上一轮 8 ms 等待实验混用。

```powershell
tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4
node tests/web-platform/package-web-runtime-experiment.cjs --baseline=villa-lumen-off-current-mimalloc-v59 --output=villa-occlusion-repeat --evidence=tests/web-platform/results/post-mimalloc-v59-profile-20261104.json
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-occlusion-history.cjs --folder=villa-occlusion-repeat --tag=occlusion-repeat-normal --modes=control,history,hzb,instances,hzb-instances,hzb-instances,instances,hzb,history,control --seconds=20 --warmup=15
node tests/web-platform/probe-web-occlusion-history.cjs --folder=villa-occlusion-repeat --tag=occlusion-repeat-local --modes=control-local,history-local,hzb-local,hzb-instances-local,hzb-instances-local,hzb-local,history-local,control-local --seconds=20 --warmup=15
node tests/web-platform/summarize-web-occlusion-history.cjs --reports=tests/web-platform/results/occlusion-repeat-normal.json,tests/web-platform/results/occlusion-repeat-local.json --output=tests/web-platform/evidence/occlusion-repeat.json
```

正常计时使用可见 Edge、2289×1287、相同初始视角及原始光照，没有 profiler、逐 draw 包装或额外 GPU 时间戳。内建历史统计保持启用，其成本包含在计时中。FPS 是 RHI 提交吞吐；1% Low 从提交间隔中最慢 1% 的平均时间求倒数，均不是物理显示帧率或输入延迟。
