# 别墅手动流畅度对照

入口：`http://127.0.0.1:8766/villa-engine-comparison.html#ours`。
顶部切换 UE 5.8 v71 与 UE 5.9 官方版。切换会移除前一个 iframe 及其运行时，
每次从同一关卡出生点开始。比较时只保留这一张场景页面。

## 对齐条件

配置源是 `tests/web-platform/villa-engine-comparison.json`。
两边均使用桌面 WebGPU、固定 1920×1080 画布、100% 渲染比例、Epic 各项质量、
TAA、软件 Lumen GI、496 MiB 纹理池；关闭 Lumen 反射、硬件光追、
Nanite、VSM、动态分辨率、运动模糊和 UE VSync，`t.MaxFPS=0`。
页面只对固定画布进行 CSS 缩放，窗口尺寸和系统 DPI 不改变渲染像素数量。
顶部现在显示运行时读回的场景尺寸和画布尺寸，不能只凭窗口大小判断渲染分辨率。
`8900/index.html?tier=desktop` 是另一个普通入口，会响应窗口变化，
也会使用官方自动选择的画质配置；它不是这个固定 1080p 对照入口。
实测改变官方页面视口后，SceneColor 和画布同步变成 1280×720，
再恢复为 1920×1080。固定尺寸来自对照页的 iframe，不是 5.9 不支持调整分辨率。

这是新设定的共同配置。此前官方普通链接会自动选择 Medium，
不能把那一页记录的 119.6 FPS 当成本页官方版本的测量值。
浏览器呈现节奏与两种运行时各自的队列控制仍然存在。

## 构建来源

- 我们：本机保留的 `villa-scheduling-latest-v71` 运行时，
  WASM SHA-256 `88f09cc19f6694495d0c73c45394a52ce2ac369450674b14c0b9aeffda38171a`。
  配套使用 `triplex-project-lumen-shadows-fixed-20261104` 的 Lumen Cook；
  加入 `desktop-accepted-20261107` 性能设置、页面帧预算 3 和直接游戏线程输入。
  生成包为 `build/villa-ue59-comparison-20261109-v3`。
- 官方：已完成构建的 Epic UE 5.9，
  提交 `589a52b5abcf7b0ee0e2fd9de58b4d2872672f21`，通过启动参数覆盖共同设置；
  官方引擎源码、WASM 和 Cook 文件没有修改。

本机已没有 `villa-default-20261107` 和它的验收二进制。
因此这里明确标为 v71，不能声称原样恢复了 11 月 7 日验收版本，
也没有重新编译当前参考引擎源码。引擎版本、着色器生成、Cook 和调度实现不同；
主要画质参数和视角对齐不等于全部内部算法或逐像素结果相同。

## 服务与复现

8765 是已有的 `serve.cjs`，8900 是官方 `serve.py --net none`。
新增 `serve-villa-engine-comparison.cjs` 只监听 `127.0.0.1:8766`：
普通路径转发到 8765，`/official/` 转发到 8900。
它原样传递压缩、Range 和隔离响应头，使两种运行时可在同一隔离来源下加载。
没有放宽官方 CORP 限制，也没有向局域网公开服务器。

独立打包入口：

```powershell
node tests/web-platform/package-villa-engine-comparison.cjs
```

脚本先验证历史包和运行时摘要，拒绝覆盖已存在的输出。
只对不改写的 Cook 文件使用硬链接，配置、运行时及 HTML 均为独立副本。

浏览器验证：

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/verify-villa-engine-comparison.cjs --tag=20261109-final
```

验证包括真实 Chrome 出图、隔离状态、画布/内部尺寸、运行时主要设置、
官方控制台实际 CVar、键盘移动、场景截图、移动尺寸布局及页内版本切换。
完整输出留在 `tests/web-platform/results/villa-engine-comparison-20261109-final/`。
这轮提供手动对照入口，没有发布新的 FPS 排名或端到端输入延迟结论。

## 帧统计与 PSO 预热修正

2026-11-09 后续验证发现：之前官方的 `Wasm.PipelinePrewarm=1`、
`Wasm.PipelinePrewarmPSOCache=1` 虽然开启，但没有预热资源，
日志显示预热管线为 0。我们的 v71 则启用了 `-WebPSOPrecacheTest`，
所以此前不能说两边已经对齐了 PSO 预热。

现使用 5.9 自带的 `wasm-prewarm.js` 录制和 `prewarm_pack.py` 打包，
在官方 stage 安装 `TriplexHouseVilla/Content/WebGPUPrewarm-SF_WEBGPU_SM5.json`，
并由官方工具更新 `wasm-cache.json`。对照入口指定 `prewarm=1`、
`prewarm_return=full`，确保回访也加载完整预热包。
实测准备完成 261 条独立管线，出生点加载记录到 145 次 render 和
128 次 compute 复用，预热失败为 0。复用次数包含重复使用，不是独立管线数量。
这是官方页面的管线预热方式，和我们引擎内的 PSO precaching 实现不同；
录制覆盖出生点和短距离行走，不承诺整个别墅任意视角都没有首次编译。

官方页面右上角新增 FPS、1% Low、帧间隔、实际尺寸和预热命中数量。
复用现有 HUD 的采样算法，官方数据来自最终画布纹理取得后的队列提交，
我们仍来自 RHI 提交线程。导出文件分别标记这两种来源；
两者都不是显示器实际呈现时间，也不是直接用页面 requestAnimationFrame 当引擎 FPS。
安装脚本使用内容哈希脚本名，并同步刷新压缩版 index.html，避免旧缓存。

复现命令（录制使用新的 tag，原始数据和生成包保留在本机 results 中）：

```powershell
node tests/web-platform/install-ue59-comparison-hud.cjs
$captureTag='capture-new-20261109'
node tests/web-platform/inspect-villa-quality.cjs "--tag=$captureTag" --engine=official --capture --affinity=4294901760
$uePython='E:/UE59WebBenchmark/emsdk-6.0.10/python/3.13.3_64bit/python.exe'
$prewarmTool='E:/UE59WebBenchmark/engine-5.9/Engine/Platforms/Wasm/Build/Tools/web/prewarm_pack.py'
$officialStage='H:/ue_html/tests/web-platform/build/ue59-official-villa-20261109'
$captureDir="H:/ue_html/tests/web-platform/results/villa-quality-$captureTag"
& $uePython $prewarmTool pack "$captureDir/webgpu-capture.json" --stage $officialStage --out "$captureDir/pack" --after-ready 60
& $uePython $prewarmTool install "$captureDir/pack/WebGPUPrewarm-SF_WEBGPU_SM5.json" --stage $officialStage
node tests/web-platform/verify-villa-engine-comparison.cjs --tag=20261109-hud-final
```

录制和清晰度诊断曾使用受限 CPU 核心，不能用它们的 FPS 做性能排名。
最终 `20261109-hud-final` 双引擎验证在默认 CPU 调度下通过，包含 HUD、
真实尺寸、PSO 状态、CVar、移动、切换及 390×844 布局验证，页面/GPU 校验错误为 0。
`20261109-hud-layout` 另验证官方 HUD 的最终位置。
引擎 WASM、Cook 和原始 `E:/UE59WebBenchmark/package/Wasm` 归档未修改。

## 清晰度调查边界

两边的实际 SceneColor 和输出画布均为 1920×1080，
不是只看 HTML 的 width/height。原生像素截图中抽查的白墙、木材纹理尺寸相同；
将官方纹理池临时从 496 调到 2048 MiB 后，一部分纹理提升了 mip，
但没有明显消除所观察到的墙面差异。临时增加锐化会改变观感，
不能据此判断原始差异的原因，也没有把这些诊断修改加入交付配置。
交付仍为两边 496 MiB、100% 渲染比例和 TAA。

相同质量等级并不保证不同版本的 Lumen 中间缓冲、纹理格式或后处理逐项相同。
当前尚未定位剩余清晰度差异的单一原因；之前普通入口的自动画质也是比较时
需要排除的变量。不要由此直接推导等画质性能胜负。
原生截图与资源记录在 `results/villa-quality-20261109-inspect/`，
该轮截图之后读取录制文件失败，成功录制另存于 `20261109-capture`；
失败记录保留，未当作完整验证通过。

## 调试边界

准备阶段发现旧 Lumen Cook 与 11 月 6 日 VT 运行时不兼容；改用配套 VT Cook 后，
曾出现 D3D12 管线创建/设备丢失，受限核心下又暴露纹理原子视图断言。
这些失败记录保留在 `20261109-a`、`20261109-b`、`20261109-c`、
`20261109-ecores` 的结果中，没有把失败包作为最终入口。

最终 v71 组合已在默认 CPU 调度下完成两种引擎的出图和移动验证，
`20261109-proxy` 记录双方通过且无页面/GPU 校验错误。
之前的受限核心诊断不用于最终页面，也不据一次通过宣称宿主间歇故障已修复。
官方原有的未构建静态光照与纹理池超预算提示仍保留。
