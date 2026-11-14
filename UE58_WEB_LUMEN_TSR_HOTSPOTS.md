# Lumen 与 TSR 热点优化

日期：2026-11-12。测试项目：`H:/TriplexHouseVilla`。
参考引擎提交：`3839f747a3`。

后续更正：用户反馈体感回退后，已将大分块恢复为默认关闭。
原 32x32 包及以下测量记录保留用于对照，不能作为当前默认值。
当前交付、跨版本复测及未解决边界见
[TSR 默认值回退与流畅度复核](UE58_WEB_SMOOTHNESS_REGRESSION.md)。

本轮实现 TSR 卷积大分块，减少重复计算滤波边界。Lumen 页表读取和局部缓存实验
没有取得稳定收益，保留诊断工具，不加入运行时默认路径。

## 实现

本轮最初以 `r.WebGPU.TSRLargeTiles=1` 默认尝试 32x32 分块，后续已撤回此默认值。
它同时选择 UE 的着色器排列和
CPU 派发尺寸；`0` 使用原有 16x16 分块。细线检测、权重松弛、着色拒绝三个通道
使用一致的选择条件。Cook 保留两种排列，原生平台不编译新增 Web 大分块排列。
普通 SM5 打包的共享 Cook 校验要求三个卷积 Shader 的新排列清单，
拒绝缺清单或只有旧排列的 Cook 缓存，提示重建原生 Renderer 并重新 Cook。
该检查是入口保护，仍需原有产物摘要校验和浏览器真实派发验证。

大分块要求 RHI 实际报告的工作组总线程数和 X 维上限均至少 1024，
共享内存至少 16416 字节。RHI 从申请成功的 device 额度设置
`MaxWorkGroupInvocations`，取总线程数与 X 维上限的较小值；
不能沿用 UE 默认的 1024 推断浏览器支持。
共享内存门槛覆盖 16 KiB 的四通道 LDS 以及两个按 16 字节计入额度的共享标量。
额度不足自动选择原有 16x16 路径。

滤波 halo 仍为原参数，未削减历史重建、抗闪烁或细线检测。
默认 halo=3 时，每块有效输出从 10x10 变为 26x26。
这一变化减少边界重复，但更大的工作组也会改变占用率，整体收益必须实测。

没有修改 Lumen 探针数量、反射质量、历史分辨率、采样数或 AA 方法。
此前的 VSM 自适应采样、间接命令复用、页标记与镜像同步保持开启。
内部渲染 1400x788、输出 1920x1080、TSR，Lumen GI/反射、VT、VSM 保持开启。
当前别墅实际 VT 资产仍为 0，不能据此证明真实 VT 流送性能。

## 验证

正式测试包：`http://127.0.0.1:8765/build/villa-tsr-tiles-20261112/index.html`。
第三项优化的源码和报告保留；其旧 C 盘页面在外部清理后已失效。

WASM 完整链接、独立原生 Renderer 构建、重新 Cook、Stage、Package
均走原有审计和正式收尾流程。安装引擎输入摘要未变。
首次自动管线采集遇到既有的
`A valid external Instance reference no longer exists` 启动失败，发布门槛正确拦截。
使用已有浏览器缓存目录重新采集成功后，正式包安装了匹配当前 WASM、Cook、
配置和启动参数的实际记录，没有加回 `-WebPSOPrecacheTest`。
本轮不声称修复该偶发启动错误。

测试期间，外部 C 盘的历史包、Cook 和浏览器 profile 目录被清理。
从保留在工作区的采集快照和实际 corpus 恢复交付包，除含 mtime 的
`asset-versions.json` 外，全部 12 个交付文件的 SHA256 与首次测试包一致。
恢复关系记录在 `results/tsr-package-recovery-20261112.json`，没有改写既有测试报告。
Cook 和 Stage 另在工作区重建成功；重建 Cook 的非确定性资产序列化使资源包哈希变化，
没有把它混入原包的对比测试。本轮交付的是经过正式收尾且逐文件校验恢复的测试包。
后续输出和浏览器 profile 均位于工作区本地目录。

GPU 诊断与帧率测试分开：

- GPU 模式临时拆分 compute pass，静止和转动各采 8 帧。
  实际派发确认关闭优化为 256 线程，开启优化为 1024 线程。
  TSR RejectShading 静止约 1.180 → 0.975 ms，转动约 1.303 → 0.983 ms。
  这种诊断改变同步开销，不能换算成正式 FPS。
- 帧率使用同一不可变包的启动开关对比，保留正常 compute-pass 复用。
  每轮先预热转动、移动路线，再测静止、转动、移动；
  测量窗口要求无管线创建、无新增预热 miss，配置和分辨率不变。
  先 ABBA，再 BAAB 复测，完整结果由证据脚本汇总。
- 同机位截图排除黑边与性能面板后，平均通道绝对差约 0.725/255，
  平均通道差大于 8 的像素约 0.335%。人工检查未见明显接缝或材质回退；
  时间、随机采样与历史积累不完全相同，不要求逐像素一致，也不外推全部视角。
- 三种回退分别模拟 RHI 收到的总线程数、X 维上限和共享内存不足。
  物理设备仍保留正常额度，因为场景其他既有着色器使用 1024 线程。
  此项只验证 TSR 选择，不能表述为完整场景已支持低额度设备。
  X 维检查首次启动再次遇到外部 Instance 失效；
  共享内存检查首次启动遇到 DXC `E_OUTOFMEMORY`，后者当时系统仍有大量可用内存。
  独立重跑均通过，失败报告保留，不计入有效窗口；本轮不声称修复这些启动错误。

最终指标、报告摘要和范围见
`tests/web-platform/evidence/lumen-tsr-hotspots-20261112.json`。

同一包八轮 ABBA+BAAB、每阶段每轮 20 秒，合并原始提交间隔后：

| 阶段 | 16x16 FPS | 32x32 FPS | 16x16 1% Low | 32x32 1% Low |
| --- | ---: | ---: | ---: | ---: |
| 静止 | 46.39 | 47.11 | 33.77 | 35.13 |
| 转动 | 46.94 | 47.13 | 34.94 | 34.13 |
| 移动 | 46.36 | 46.89 | 32.43 | 32.89 |

平均提升约 0.39%～1.55%，不是大幅整体提升。转动 Low 约下降 2.3%，
两组顺序测试均有轻微回落；静止和移动 Low 的变化也存在轮间波动。
当时默认保留大分块只依据 TSR 单项收益，后续流畅度验收说明此依据不足。
不能宣称改善了所有 Low 帧，
更不能据此认为 VSM 移动卡顿已经解决。可用 `r.WebGPU.TSRLargeTiles=0`
恢复原分块；对照测试只在内存中覆盖该设置。

## Lumen 实验边界

诊断中分别尝试按粗层 MIP 过渡条件跳过页表读取、
在单个 invocation 内缓存最近页表坐标，以及 TSR subgroup 投票归约。
它们只在浏览器内存中替换候选 WGSL；正式包不包含这些改写。
配对 GPU 采样里，Screen Probe、Radiosity 和 Reflection 的改善不一致，
部分通道反而变慢，不能挑选其中一次较低值作为默认收益。

本轮没有修改 Lumen 算法，也没有把“已定位热点”写成“已优化成功”。

## 复现

依次执行，避免多个场景争用 GPU。每个 tag 必须使用新目录。

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/diagnostics/probe-lumen-tsr-hotspots.cjs --mode=0 --folder=villa-tsr-tiles-20261112 --tsr-tiles=0 --tag=tsr-control-new
node tests/web-platform/diagnostics/probe-lumen-tsr-hotspots.cjs --mode=0 --folder=villa-tsr-tiles-20261112 --tsr-tiles=1 --tag=tsr-candidate-new
node tests/web-platform/benchmark-villa-indirect-reuse.cjs --optimization=tsr --folder=villa-tsr-tiles-20261112 --tag=tsr-abba-new --seconds=20 --gpu-state
node tests/web-platform/benchmark-villa-indirect-reuse.cjs --optimization=tsr --folder=villa-tsr-tiles-20261112 --tag=tsr-baab-new --seconds=20 --order=1,0,0,1 --gpu-state
node tests/web-platform/verify-villa-indirect-release.cjs villa-tsr-tiles-20261112 tsr-release-new
```
