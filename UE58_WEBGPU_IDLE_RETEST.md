# 后台游戏关闭后的性能复测（2026-11-01）

游戏关闭后，GPUScene 的大幅收益仍成立；资源表增量更新整体帧率持平；手动顶点读取和并行绘制仍较慢。实例 HZB 此次持平，之前受干扰的 −8% 不能当作其确定回退幅度。此轮保持原有默认行为。

本轮沿用各次已测包和原项目设置，以旧→新→新→旧顺序逐组复测。没有重新 Cook、打包或修改渲染实现。每轮预热 20 秒、测量约 15 秒，出生视角、viewport 1863×1030、DPR 1.25；每组均检查设置、位置、角度及实际渲染尺寸一致。

环境监测每 5 秒记录一次进程，共 631 个样本，没有发现 cod.exe 或 UE 编译进程。其他日常程序仍运行；这不代表整机完全空闲，也不是 GPU 利用率监测。各浏览器测试串行执行，CPU/API/GPU 捕获与正常帧率测量分开。

## 四轮结果

| 对照项 | 旧包 FPS | 新包 FPS | 变化 | 旧→新 RHI ms/帧 | 两次旧包漂移 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 手动顶点读取 | 50.74 | 42.17 | -16.89% | 14.84→18.78 | +2.33% |
| 资源表增量更新 | 51.44 | 51.51 | +0.15% | 14.69→14.65 | -0.69% |
| GPUScene | 31.10 | 51.41 | +65.28% | 26.08→14.66 | -1.28% |
| 并行绘制命令构建 | 52.09 | 50.94 | -2.22% | 14.51→14.83 | +0.47% |
| RHI 适配第二版 | 26.29 | 29.06 | +10.52% | 30.02→28.37 | +0.59% |
| 绑定缓存第三版 | 28.76 | 30.50 | +6.03% | 28.44→26.59 | -0.90% |
| WebGPU 绑定布局 | 30.27 | 30.37 | +0.33% | 26.73→26.83 | +0.16% |
| 常量上传 | 30.95 | 30.94 | -0.03% | 26.16→26.31 | -1.37% |
| Render Bundle | 30.78 | 31.16 | +1.26% | 26.26→26.13 | +0.36% |

FPS 按总帧数/总测量时间合并，RHI 工作时间按测量帧数加权。每项只有一组四轮，基线漂移用于提示环境波动，不构成统计置信区间。小幅变化不能视作稳定收益，各行百分比也不能相加。

资源表和并行命令构建此前已有游戏关闭时的记录，本轮仍按用户要求重跑。历史 RHI 适配基线目录曾被覆盖，本次改用 `triplex-before-dx-binding-20261101` 的保留副本，其 Wasm、Cook 内容和配置 SHA 与原始记录一致。其余各对照三项 SHA 均与原测量记录匹配。未重跑已被后续版本替代的失败中间版本。

## 各轮与历史结果

### 手动顶点读取

本次四轮 FPS：50.16 / 41.92 / 42.42 / 51.32。合并 50.74→42.17（-16.89%）；历史该组为 22.15→19.35（-12.62%）。历史负载不同，绝对差值不能归因于本轮代码修改。

包：villa-parallel-recording-default / villa-manual-vertex-fetch。原始结果：[idle-20261101-manual-fetch-abba.json](G:/UE_HTML/ue_html/tests/web-platform/results/idle-20261101-manual-fetch-abba.json)。

### 资源表增量更新

本次四轮 FPS：51.61 / 51.60 / 51.42 / 51.26。合并 51.44→51.51（+0.15%）；历史该组为 52.91→53.24（+0.62%）。历史负载不同，绝对差值不能归因于本轮代码修改。

包：villa-gpuscene-candidate / villa-resource-tables-candidate。原始结果：[idle-20261101-resource-tables-abba.json](G:/UE_HTML/ue_html/tests/web-platform/results/idle-20261101-resource-tables-abba.json)。

### GPUScene

本次四轮 FPS：31.30 / 51.21 / 51.60 / 30.90。合并 31.10→51.41（+65.28%）；历史该组为 12.05→19.90（+65.08%）。历史负载不同，绝对差值不能归因于本轮代码修改。

包：triplex-project-distance-fields-threads / villa-gpuscene-candidate。原始结果：[idle-20261101-gpuscene-abba.json](G:/UE_HTML/ue_html/tests/web-platform/results/idle-20261101-gpuscene-abba.json)。

### 并行绘制命令构建

本次四轮 FPS：51.97 / 51.02 / 50.86 / 52.21。合并 52.09→50.94（-2.22%）；历史该组为 52.85→51.83（-1.94%）。历史负载不同，绝对差值不能归因于本轮代码修改。

包：villa-resource-tables-candidate / villa-parallel-recording-candidate。原始结果：[idle-20261101-parallel-recording-abba.json](G:/UE_HTML/ue_html/tests/web-platform/results/idle-20261101-parallel-recording-abba.json)。

### RHI 适配第二版

本次四轮 FPS：26.21 / 28.99 / 29.12 / 26.37。合并 26.29→29.06（+10.52%）；历史该组为 17.48→19.90（+13.84%）。历史负载不同，绝对差值不能归因于本轮代码修改。

包：triplex-before-dx-binding-20261101 / villa-rhi-adaptation-v2。原始结果：[idle-20261101-rhi-adaptation-abba.json](G:/UE_HTML/ue_html/tests/web-platform/results/idle-20261101-rhi-adaptation-abba.json)。

### 绑定缓存第三版

本次四轮 FPS：28.89 / 30.64 / 30.36 / 28.63。合并 28.76→30.50（+6.03%）；历史该组为 29.34→31.93（+8.82%）。历史负载不同，绝对差值不能归因于本轮代码修改。

包：villa-rhi-adaptation-v2 / villa-dx-binding-v3。原始结果：[idle-20261101-dx-binding-abba.json](G:/UE_HTML/ue_html/tests/web-platform/results/idle-20261101-dx-binding-abba.json)。

### WebGPU 绑定布局

本次四轮 FPS：30.24 / 30.82 / 29.91 / 30.29。合并 30.27→30.37（+0.33%）；历史该组为 31.18→32.22（+3.33%）。历史负载不同，绝对差值不能归因于本轮代码修改。

包：villa-dx-binding-v3 / villa-webgpu-layout。原始结果：[idle-20261101-webgpu-layout-abba.json](G:/UE_HTML/ue_html/tests/web-platform/results/idle-20261101-webgpu-layout-abba.json)。

### 常量上传

本次四轮 FPS：31.17 / 31.10 / 30.79 / 30.74。合并 30.95→30.94（-0.03%）；历史该组为 33.31→33.64（+0.99%）。历史负载不同，绝对差值不能归因于本轮代码修改。

包：villa-webgpu-layout / villa-webgpu-uploads。原始结果：[idle-20261101-webgpu-uploads-abba.json](G:/UE_HTML/ue_html/tests/web-platform/results/idle-20261101-webgpu-uploads-abba.json)。

### Render Bundle

本次四轮 FPS：30.72 / 31.98 / 30.34 / 30.83。合并 30.78→31.16（+1.26%）；历史该组为 13.07→13.27（+1.56%）。历史负载不同，绝对差值不能归因于本轮代码修改。

包：villa-webgpu-uploads / villa-webgpu-bundles-v3。原始结果：[idle-20261101-render-bundles-abba.json](G:/UE_HTML/ue_html/tests/web-platform/results/idle-20261101-render-bundles-abba.json)。

## 新的 CPU、API 与 GPU 捕获

资源表、手动顶点读取、GPUScene、并行命令构建的新旧包均单独捕获 5 秒 API、5 秒 CPU 采样及 3 个 GPU timestamp 帧。统计采样受内联、符号归属和录制扰动影响；包含时间会重叠，不能相加推算帧率。3 帧 GPU pass 合计不包含复制及间隙，不等于完整 GPU 帧时间。

| 对照项 | setVertexBuffer / 帧（旧→新） | setBindGroup / 帧 | createBindGroup / 帧 |
| --- | ---: | ---: | ---: |
| 资源表增量更新 | 7959.26→7966.88 | 1397.53→1398.48 | 80.76→81.84 |
| 手动顶点读取 | 7974.07→6260.38 | 1399.36→2237.66 | 80.12→192.22 |
| GPUScene | 11197.46→7973.98 | 7787.96→1399.47 | 563.22→81.50 |
| 并行绘制命令构建 | 7966.73→7983.15 | 1398.46→1411.48 | 81.16→81.16 |

- 资源表增量更新：[旧包性能图](G:/UE_HTML/ue_html/tests/web-platform/results/performance-capture-idle-20261101-resource-tables-baseline-profile.html)、[新包性能图](G:/UE_HTML/ue_html/tests/web-platform/results/performance-capture-idle-20261101-resource-tables-candidate-profile.html)。
- 手动顶点读取：[旧包性能图](G:/UE_HTML/ue_html/tests/web-platform/results/performance-capture-idle-20261101-manual-fetch-baseline-profile.html)、[新包性能图](G:/UE_HTML/ue_html/tests/web-platform/results/performance-capture-idle-20261101-manual-fetch-candidate-profile.html)。
- GPUScene：[旧包性能图](G:/UE_HTML/ue_html/tests/web-platform/results/performance-capture-idle-20261101-gpuscene-baseline-profile.html)、[新包性能图](G:/UE_HTML/ue_html/tests/web-platform/results/performance-capture-idle-20261101-gpuscene-candidate-profile.html)。
- 并行绘制命令构建：[旧包性能图](G:/UE_HTML/ue_html/tests/web-platform/results/performance-capture-idle-20261101-parallel-recording-baseline-profile.html)、[新包性能图](G:/UE_HTML/ue_html/tests/web-platform/results/performance-capture-idle-20261101-parallel-recording-candidate-profile.html)。

CPU 采样的具体观察：

- 资源表：所选资源解析函数 self 约 1.00→0.48 ms/帧；CreateGroups self 约 2.06→2.03 ms/帧。公共解析路径减少部分工作，但整体 FPS 仍持平。
- 手动读取：CreateGroups 包含采样约 8.37→10.08 ms/帧，SetDrawBindings 约 12.05→18.74 ms/帧。结合新增 bind group 数量，资源组准备和绑定仍是明确的优化方向；这两个包含时间重叠，不能相加。
- 并行录制：Render 线程绘制录制栈包含采样约 0.58→0.26 ms/帧；三个任务 worker 合计约 0.91 ms/帧。日志再次确认物理任务线程 3、5、4 执行，任务数为 3；任务合计不是关键路径时间。
- GPUScene：drawIndexed 约 6083→2992 次/帧，setBindGroup 约 7788→1399 次/帧。当前收益伴随实际提交数量下降。


## HZB、PSO 与 RDG

以下诊断保留独立记录；预期失败只表示障碍被再次复现，不表示功能已经可用。

- 实例 HZB：四轮为 47.98 / 48.09 / 48.80 / 48.65 FPS，合并 **48.32→48.45（+0.27%）**。两次基线漂移 +1.40%，尚无明确收益。
- 传统 HZB：回读入队 1600 次、完成 1599 次、消费 0 次。对应帧结果消费障碍依旧存在，其 FPS 不作为有效 HZB 收益。
- PSO：仍在 ShaderCodeArchive.cpp:1754 触发多线程 shader 创建契约检查；没有形成可用的预缓存候选。
- RDG：135 个渲染目标，池 467.66MiB，快照时占用 203.16MiB；转身后的逻辑纹理 1267.19MiB、buffer 58.30MiB，未知格式为零。UE 资源池继续复用，native allocator 未接入；这是逻辑账本，仍不等于驱动物理显存。
- 独立 3×2 像素回读再次通过，rowPitch=64 pixels、height=2。

- instance-hzb：[原始记录](G:/UE_HTML/ue_html/tests/web-platform/results/idle-20261101-instance-hzb.json)；pass=true。
- traditional-hzb：[原始记录](G:/UE_HTML/ue_html/tests/web-platform/results/idle-20261101-traditional-hzb.json)；pass=false。
- pso-precache：[原始记录](G:/UE_HTML/ue_html/tests/web-platform/results/idle-20261101-pso-precache.json)；pass=false。
- rdg-ledger：[原始记录](G:/UE_HTML/ue_html/tests/web-platform/results/idle-20261101-rdg-ledger.json)；pass=true。

## 画面核对

资源表、手动顶点读取、GPUScene 和并行绘制四组的新旧截图已人工核对，未观察到明显网格、材质或光照缺失。旧新 RGB 平均绝对差约 0.70–0.78/255，旧旧/新新约 0.62–0.83/255，场景存在时间相关变化；这不是全场景像素正确性证明。
[截图并排图](G:/UE_HTML/ue_html/tests/web-platform/results/idle-20261101-scene-contact.png)：从上到下依次为资源表、手动读取、GPUScene、并行绘制，左旧右新。差异数据为 results/idle-20261101-scene-comparison.json。

## 审计与复现

总记录：[idle-20261101-suite.json](G:/UE_HTML/ue_html/tests/web-platform/results/idle-20261101-suite.json)，包括所有包、脚本及输出 SHA、各组前后环境快照。环境逐次记录为 tests/web-platform/results/idle-20261101-environment.jsonl。

```powershell
node tests/web-platform/retest-web-performance-idle.cjs --prefix=idle-newrun
node tests/web-platform/analyze-web-performance-idle.cjs --prefix=idle-newrun
```

复测前需启动 monitor-web-performance-environment.ps1，传入同标记的 environment.jsonl 与 monitor.stop 路径，并配置现有 Playwright NODE_PATH；8765 本地服务需运行。不要复用已有输出标记来冒充新测量。
