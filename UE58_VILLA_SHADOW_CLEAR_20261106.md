# TriplexHouseVilla：转向期间阴影遮罩 pass 合并

2026-11-06。接续三帧长帧缓解候选，聚焦转向时的帧时间。上一版候选和 owner 原版均完整保留；三帧调度仍待用户体感测试，本轮不升级默认。新增开关 `r.WebGPU.MergeShadowMaskClear` 默认 0。

## 定位与实现

固定路线诊断显示，预热后的转向没有新 shader/pipeline 创建，纹理视图创建仅约 0.08 次/帧，排除了最初怀疑的高频视图重建。RHI 工作从平移约 5.9 ms/帧上升至转向约 6.7 ms/帧，render pass 从约 211 增至 230。诊断启用 API 包装，数值只用于定位，不当作正常 FPS。

逐附件统计定位到局部灯阴影遮罩：清理 `ShadowMaskTexture` 时没有深度附件，随后的阴影投影却绑定 `SceneDepthZ`，所以既有 RDG 合并不能跨越这两个 pass。随着转向可见局部灯增多，每帧产生约四十个这种独立清理 pass。

候选在 Web 单视图、普通局部灯遮罩路径中，让清理 pass 绑定与投影相同的深度/模板附件、加载动作和访问声明。选择 Target/Resolve 的逻辑与 `RenderShadowProjections` 一致；仍调用原来的局部矩形 `DrawClearQuad`，该调用关闭深度/模板写入。UE 的 RDG 继续自行检查资源依赖和附件兼容性，只有通过现有合并条件时才减少 begin/end。

保留每盏灯的清理范围、投影、光照、阴影分辨率、AA、纹理资源和绘制命令；没有移除阴影或跳过可见光源。毛发、多视图和方向光清理沿用原路径。公共默认关闭；实验包继承上一轮 `RDGMergeRenderPasses=1`、memory32、计算复用及三帧候选配置。

## 采集约束

可见 Edge、1280×720、DPR 1，同一 Wasm/JS/Cook，A/B/B/A 四次独立浏览器会话。每次预热 30 秒，各路线再测 30 秒；固定路线由 Game tick 按墙钟推进，不以页面低频 RPC 逐帧移动相机。moving/turning 先走预热路线，并断言稳定窗口没有 shader/pipeline 创建。首次区域的新编译另外保留。

正常采集不带逐 draw、pass 和资源创建计数包装、trace、CPU profiler 或额外 GPU 完成查询；仅保留 pipeline/shader 创建统计以区分首次编译。统计完整 RHI 提交间隔；1% low 为最慢 `ceil(N*0.01)` 个间隔均值的倒数，包含所有长帧，不计不同窗口之间的空隙。这不是物理显示帧率或输入到显示延迟。

保持 page rAF、RHI priority、总未完成预约上限 3、未提交上限 2。没有恢复 Game 本地调度、扩大队列、限帧或改变画质。旧三帧候选的正式入口和包未被覆盖。

## 验证结果

各路线两次独立窗口合并，每侧 60 秒。原始逐帧文件前缀为 `tests/web-platform/results/turning-clear-*`，每轮单独保存捕获器源码、日志、相机和 GPU 预算快照。诊断与正式计时分离保存。

| 路线 | 对照 FPS / 1% low | 候选 FPS / 1% low | 对照→候选最长 ms |
| --- | ---: | ---: | ---: |
| 首次区域 | 127.51 / 53.01 | 130.40 / 54.03 | 45.84 → 48.45 |
| 平移 | 125.09 / 52.34 | 126.23 / 52.12 | 56.64 → 74.55 |
| 转向 | 109.97 / 44.15 | 113.33 / 53.48 | 40.02 → 36.22 |
| 重复区域 | 128.33 / 45.20 | 134.21 / 56.50 | 39.65 → 40.75 |

转向平均约 +3.06%、1% low 约 +21.12%，P95 13.88 → 13.41 ms、P99 18.44 → 14.51 ms。单窗 A1/B1/B2/A2 的转向 FPS / low 为 109.26 / 42.58、113.27 / 53.53、113.40 / 53.77、110.68 / 50.26。候选两次接近，但对照 low 波动仍明显；合并 low 使用全部最慢间隔，不是各窗 low 的算术平均。转向 >33.33 ms 两侧都是 3 次。

**平移没有 low 改善**，候选第二窗有 74.55 ms 尖峰，P99 12.91 → 14.29 ms；不能把转向收益扩写成全部路线都更平滑。首次区域每侧每窗都有 1 个 shader、6 个 render pipeline 创建，其最长帧也未改善；后三段无新增编译。重复区域 low 改善，但最大间隔略增。

单独 API 诊断中转向 render pass 约 229.91 → 189.72/帧。这个对照是上一版二进制，两个诊断窗口长短不同（10/15 秒），仅用于验证调用数量机制，不用于 FPS 收益。正式 A/B 则使用同一新二进制，所有运行期页面/GPU 错误断言通过。

![四个转向窗口的全部帧间隔](tests/web-platform/results/turning-clear-frames-20261106.png)

曲线里 A1 最后约四秒有一段连续抖动，A2 没有同等幅度的抖动；这会放大合并 low 的百分比收益。没有同步 trace 能将这段抖动归因于本次改动，因此保留两个独立对照和全部样本。两次候选 low 都高于两个对照，但当前样本量不足以证明长期、所有方向或所有设备都有同幅收益。

独立静止 GPU 完成探针复用原有 `onSubmittedWorkDone()` 回调，不叠加完成请求。对照→候选：平均反馈 11.90 → 11.75 ms，P99 **22.95 → 23.10 ms**，最大 35.19 → 34.65 ms，在途峰值均为 3。回调时间包含浏览器调度，不是纯 GPU 时长；P99 没有改善，不能声称延迟全面下降。

两边各通过纹理上传→复制→异步回读。绑定条目重算新增约 680.6 万 / 711.3 万次，无断言或运行期 WebGPU 错误；每份启动日志仍有 834 个已知不支持的预缓存请求，计数与 unsupported 对应，不能写成整份日志无错误。

五视角截图人工检查未见新增阴影、材质或亮度异常。排除 HUD 后的 RGB 平均绝对差 0.48–1.07/255，包含时域 AA/光照漂移，只作描述，不作为像素完全等价证明。静止诊断 draw/帧约 1353.82 → 1353.94、dispatch 约 161.37，两侧负载相当。

![五视角对照](tests/web-platform/results/turning-clear-views-20261106.jpg)

输入回归第一次误传 `--default-settings`，该参数删除 URL 的 page/framebudget 开关，导致实际 owner 时钟与预期 page 时钟不符。采集器在正式计时之前断言失败，未产生输入性能窗口；失败 JSON、源码和日志保留。修正调用后以 `input-retry` 新 tag、G 盘隔离 profile 和正式 page3 URL 重测，不覆盖失败证据。

实际打包输入桥各预热和采样 30 秒的回归：

| 指标 | 对照 | 候选 |
| --- | ---: | ---: |
| FPS / 1% low | 113.56 / 43.78 | 124.10 / 42.78 |
| 最长帧 ms | 29.14 | 39.91 |
| 行程 cm / 累计转向 | 2652 / 1712° | 2718 / 1764° |
| draw / 帧 | 1753 | 1416 |
| GPU 反馈平均 / P99 / 最长 ms | 12.23 / 32.47 / 42.38 | 11.14 / 30.56 / 53.07 |

两次实际路线不同、候选 draw 少约 19%，**不能将这组平均 FPS 当作性能收益**。low 及最长帧没有改善，最慢完成反馈还增加约 10.7 ms；不接受为默认，也不宣称已经改善真实输入手感。两侧总预约峰值 3、未提交峰值 2；所有采样帧的 GPU 回调最终返回。页面观察进度/提交进度约 99.73% / 99.74%，仍非物理呈现验证。

两边均通过模拟 document 隐藏后停止生产、恢复后继续的检查；这不等于操作系统冻结标签页。最终三帧调度和上一版均待人工体感判断。本轮的固定转向收益值得保留，但周期长帧、平移尖峰和自由输入的回退仍是未完成边界。

完整构建/链接与 Wasm 结构检查通过，`LightRendering.cpp` 被 `Module.Renderer.9.cpp` 实际编译。构建副本和源文件 SHA-256 一致，包生成时校验编译对象、响应、定义和产物哈希。后续构建脚本也显式复制并审计该源文件；未修改 H:/UE_5.8。证据生成器为 `summarize-villa-shadow-clear.cjs`，生成 `evidence/villa-shadow-clear-20261106.json`；`performanceAccepted=false`、`defaultEnabled=false`、`physicalPresentationValidated=false`。

JS 语法和 Git diff 检查通过；比较页 22 个链接均 HTTP 200。所有修改本地提交，未推送远程。

引擎提交：`8a27c9f05`。

## 复现

使用新的输出目录和 tag，避免覆盖历史证据；所有浏览器采集串行进行。

```powershell
tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4 -LowerMemory64
node tests/web-platform/package-villa-parity-candidate.cjs --baseline=villa-owner-credit-transient-20261106 --output=shadow-clear-control-repro --runtime-build=tests/web-platform/results/web-engine-full-thread-build-results.json
node tests/web-platform/package-villa-parity-candidate.cjs --baseline=shadow-clear-control-repro --output=shadow-clear-candidate-repro --merge-shadow-clear
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-scheduling-motion.cjs --folder=shadow-clear-control-repro --tag=shadow-clear-a1-repro --modes=page3 --seconds=30 --warmup=30 --width=1280 --height=720
node tests/web-platform/probe-web-scheduling-motion.cjs --folder=shadow-clear-candidate-repro --tag=shadow-clear-b1-repro --modes=page3 --seconds=30 --warmup=30 --width=1280 --height=720
```

随后以新 tag 重复 B2、A2。诊断时额外传 `--api-counts`；`--profile-workers` 只在正式路线窗口结束后单独录制转向线程栈。带 API 包装的窗口不得计入正常 FPS 汇总。
