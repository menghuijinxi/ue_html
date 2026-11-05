# GPUBuffer 生命周期与上传页复用实验

2026-11-04，接续 [mimalloc 后的优化定位](UE58_WEB_POST_MIMALLOC_OPPORTUNITIES.md)。已定位每帧 GPUBuffer 创建的主要来源，并完成有上限的上传页候选和同包 ABBA。**创建量约减少 80%，RHI 工作减少约 0.19 ms/帧，平均 FPS 仅增加 0.73%；当前证据不足以启用为默认优化。**

## 定位结果

最初对已验收 v59 包做弱引用生命周期观察：固定视角约 55.82 个新 Buffer/帧，转向约 55.86。调用栈、size、usage 和释放帧表明，约 44.8 个/帧来自 `UnlockBuffer_BottomOfPipe` 的临时上传源，占创建次数约 80%。它们使用 `COPY_SRC | COPY_DST`，包括每帧反复创建的 4、44、912 字节等对象，全部在创建帧末退休销毁。

同一用途的对象大小并不固定，因此只按某几个 size 建缓存会遗漏大量实际工作。已有 1 MiB 帧常量页正在复用；这轮目标是 Lock/Unlock 上传源。

剩余约 11 个/帧主要包括：3 个 32 字节 Clear UAV 常量 Buffer、2 个持久 Uniform 快照、4 个 readback Buffer、1 个查询 resolve Buffer 和 1 个顶点 Buffer。readback 生命周期与上传源不同：观察到 262144 字节读回对象跨越很多帧才释放，不能在帧末直接放入上传页复用规则。观察器记录的是 JavaScript 对象及描述符容量，不代表驱动实际显存或进程 RSS。

## 候选实现

开关 `r.WebGPU.StagingUploadPages=1`，默认 0；测试 RPC 为 `WebLightingQualityTest(19, value)`。`UploadStagingBytes` 将不同上传写入独立的 256 字节对齐区间，再在原有命令位置复制到实际目标。Buffer Lock/Unlock 及 Texture2D staging 使用相同入口，纹理复制保留行距并使用返回的源 offset。

- 每页 1 MiB，最多保留 4 页。大于 1 MiB 的单次上传使用独立临时对象；超出 4 页的部分也只临时保留到帧末。
- 所有 encoder 完成提交后，`RHIEndFrame` 才复位页游标。同帧中已编码的早期复制始终拥有独立源区间；后一帧写入按同一 Queue 顺序排在先前提交之后。
- 切回基线时，在帧末释放已保留页；Shutdown 释放页及当前引用。没有逐帧等待 GPU 排空。
- 每次上传仍执行原有 Queue 写入，未合并上传调用。这个实验测资源对象生命周期变化；正常计时没有 GPU 读回、逐 draw 包装或 profiler。

队列顺序和提交前后规则依据 [WebGPU Queue](https://gpuweb.github.io/gpuweb/#gpuqueue)；不能因 C++ 释放源句柄就提前覆盖未提交命令引用的数据。

## 正常 ABBA

`control → staging → staging → control`，每次重新启动同一 `villa-buffer-lifecycle-v62` WASM，15 秒预热、20 秒正常计时。保留 v59 原 Cook、配置和内容哈希；mimalloc、独立 Game/Render/RHI、核心预算 4、3 个任务 Worker。绑定计划和 TLV 共享均关闭。可见 Edge 156.0.4314.58，2289×1287 CSS、DPR 1，内部 1484×835、输出 2289×1288、TSR=4。沿用线程基准关闭异步 PSO cache consolidation 的约定，两侧一致。

| 指标 | 基线 | 上传页候选 |
| --- | ---: | ---: |
| 合并平均 FPS | 77.36 | 77.93 |
| 合并 1% Low | 33.91 | 35.23 |
| RHI pump 墙钟 ms/帧 | 9.321 | 9.131 |
| 两次独立 FPS | 77.77 / 76.96 | 77.49 / 78.36 |

平均 FPS +0.73%，1% Low +3.88%，RHI 墙钟约 -2.04%。各分支两次 FPS 波动均超过合并增益。direct draw 约 3108 → 3089/帧，也存在约 0.6% 的正常遮挡历史差异；dispatch 两侧均约 158–159/帧。因而只能确认创建量和可见 RHI 成本下降，不能把亚百分比 FPS 或 Low 变化判定为稳定收益。

1% Low 使用各分支两次计时合并后的最慢 `ceil(N×1%)` 个完整 RHI 提交间隔取平均，再求倒数。RHI pump 墙钟来自独立累计计数，与 Game/Render 工作重叠，不是 GPU 执行时间。

## 正确性与验证范围

完整 Web UBT 编译、链接和 WASM 结构验证通过。首次编译遇到新增 `EM_ASM` 对象字面量的宏逗号解析错误，修正括号后重新构建成功；失败日志保留在 results。

最终同一 v62 运行时的生命周期、GPU 字节、流送、窗口和五视角图像检查及精确哈希记录，见 [可复查证据](tests/web-platform/evidence/buffer-lifecycle-20261104.json)。GPU 字节验证在真实引擎每次上传复制后，立即将目标区间复制到独立 readback，并与 CPU 上传快照逐字节比较；检查开、关、再开的切换，以及窗口变化后的非零源 offset。诊断读回独立于正常 FPS 窗口。

最终同包基线 791 帧创建 44,193 个 Buffer，约 55.87 个/帧；候选 788 帧约 11.00 个/帧，减少 80.31%。转向 1,154 帧约 11.05 个/帧。总计完成 **4,096 次 GPU 复制、24,928,104 字节核验，0 差异**；64/256/64/1000 MiB 纹理预算往返触发实际释放和恢复，纹理统计驻留量从 2,256,976 恢复到 482,213,968 字节。960×540 与 1280×720 窗口各完成额外 512 次复制核验，全部运行未捕获 GPU validation、设备丢失、断言或崩溃。

五个视角分别执行 control/staging/control，共 15 张截图，**5/5 组通过原有相邻 control 时序变化阈值**。比较排除动态 HUD，平均 RGB 差阈值为 `max(0.5, control 前后变化 × 1.25)`，超过 8/255 的像素比例阈值为 `max(1%, control 前后变化 × 1.25)`。候选最差平均 RGB 差约 3.99/255；这表示通过带时序漂移基准的图像检查，不表示截图位级一致。

本场景使用一个常驻 1 MiB 页，静止和转向期间页创建计数保持不变。代码限制保留容量为 4 MiB；本轮场景没有触发大上传回退和超过四页的溢出分支。未验证长期运行、设备丢失恢复或其他 Cook 场景，也没有重测 OS GPU 利用率、桌面同条件 GPU 时间或首次 PSO 长帧。候选保持默认关闭。

## 复现

在 `G:/UE_HTML/ue_html` 执行，使用新标签；构建、正常计时、诊断与图像处理串行运行。

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4
node tests/web-platform/package-web-runtime-experiment.cjs --baseline=villa-lumen-off-current-mimalloc-v59 --output=villa-buffer-repeat --evidence=tests/web-platform/results/post-mimalloc-v59-profile-20261104.json
node tests/web-platform/benchmark-villa-threading.cjs --folder=villa-buffer-repeat --throughput=control,staging,staging,control --seconds=20 --warmup=15 --tag=buffer-repeat-abba
node tests/web-platform/probe-web-buffer-lifecycle.cjs --folder=villa-buffer-repeat --tag=buffer-repeat-diagnostic --staging --compare --stress
node tests/web-platform/probe-web-throughput-images.cjs --folder=villa-buffer-repeat --tag=buffer-repeat-images --staging
& 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' tests/web-platform/compare-throughput-images.py tests/web-platform/results/buffer-repeat-images.json tests/web-platform/results/buffer-repeat-image-comparison.json
node tests/web-platform/summarize-buffer-lifecycle.cjs --benchmark=tests/web-platform/results/buffer-repeat-abba.json --diagnostic=tests/web-platform/results/buffer-repeat-diagnostic.json --images=tests/web-platform/results/buffer-repeat-image-comparison.json --output=tests/web-platform/evidence/buffer-repeat.json
```
