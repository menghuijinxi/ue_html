# 别墅启动与设备丢失：2026-11-09

本轮定位到启动阶段大量推测性 PSO 编译，制作了独立的实际管线预热包。
当前候选为 `tests/web-platform/build/villa-prewarm-20261109-v3`。
WASM、Cook、画质配置、固定 1920×1080、TAA、Lumen GI 和帧调度保持原包。
没有重新编译引擎，也没有修改 `H:/UE_5.8`、浏览器开关或系统设置。

## 启动测量

同一机器、Chrome、DPR 1.5、固定 1080p；“完成”要求加载层隐藏且运行至少 30 帧。
首次指独立浏览器配置中无页面内容缓存；不代表清除了系统驱动的 Shader 缓存。
后续访问在同一浏览器进程和配置中保留缓存。

| 页面 | 首次访问 | 有内容缓存 |
| --- | --- | --- |
| 我们原 v4 | 23.90 秒 | 16.39 秒 |
| 实际管线预热 v2，无诊断插桩 | 15.87 秒 | 9.91 / 10.11 秒 |
| 最终 v3，无诊断插桩 | 15.96 秒 | 10.71 / 10.02 秒 |
| 官方 5.9，原有官方预热包 | 5.11 秒 | 4.95 秒 |

原版与官方数据使用轻量阶段记录，v2 表中数据未包装 WebGPU API；
这是少量分段测试，不是统计置信区间或跨机器承诺。
v1 带阶段记录时为 15.88 / 9.36 秒；v2 增加移动路线覆盖并恢复相同的 30 帧加载门槛。
v3 保留 v2 同一预热包，修正缓存键和捕获器只忽略描述符顶层调试标签，
防止名为 `label` 的 Shader 常量被误忽略。回归测试先复现错误命中，再确认修复。
清理浏览器缓存后，v3 另外三轮默认调度、无诊断插桩启动及各 20 秒实际输入通过，
均为零设备丢失、零路线内管线遗漏。未对 v3 再重复 Edge 三轮，不将 v2 记录冒充 v3。

最终公开入口验收另用全新 H 盘浏览器配置，验证加载后的 FPS/1% Low、真实画面、
键鼠、移动尺寸布局、运行中 DPR 改变及两版本切换，全部通过。
此工具的终止条件更严格（我们超过 60 帧，官方超过 120 次画布获取），
其 14.88 / 13.55 秒不能混入上表的 30 帧启动计时。
其中官方自己的 ready 标记约 10.83 秒，明显慢于早先约 5 秒记录；
缓存和执行条件会影响结果，本轮没有把 5 秒当成官方启动的固定保证，
也没有据不同终止条件发布新的引擎性能排名。

原版创建约 2540 个 Shader Module，启动异步预编译 1361 条管线。
两条从未用于当前场景的推测性 Compute PSO 因纹理/采样器类型不匹配失败。
仅关闭全局推测性预编译后，模块约 400 个，缓存启动仍为 13.21 秒。
WASM 实例化约 0.2～0.5 秒，不是主要瓶颈。

v2 收录 265 个 Shader Module、301 条完整描述符管线；实际还会按需创建少量未被管线使用的模块。
首次下载原有约 3.4 GB 内容仍有数秒开销，缓存后的 MEMFS 挂载约 1.7 秒。
预热本身约 4 秒，与下载和挂载重叠；后续 UE 初始化仍有约 5 秒。
尚未达到官方 5 秒，不把提早显示加载层或关闭画质功能当作优化。

## 实现与覆盖

- `web-pipeline-prewarm.js` 在资源加载期间创建 GPU 设备，以并发 2 提前异步编译，
  完成后把同一设备交给 RHI。未增加临时设备编译后销毁再编译的流程。
- Shader 源码、布局及完整管线描述符参与匹配；仅忽略诊断标签。
  不同 Shader、入口、常量、布局或设备不共享不兼容对象。
- 本候选以记录预热替代 UE 大范围推测性预编译，原生
  `__webPSOPrecache.enabled` 因而为 false；这不表示关闭了所有 PSO 缓存。
  实际预热状态见 `__webPipelinePrewarm`，必须 ready 且 adopted 后才通过加载门槛。
- 未记录的管线仍通过原有 WebGPU 创建方法生成，不跳过绘制或替换材质。
  当前路线之外首次遇到的新效果仍可能卡顿，需要扩充捕获覆盖。
- 预热包校验 SHA-256，并与 WASM、Cook、配置摘要绑定。
  打包工具要求成功捕获报告，并验证捕获来源未改变；拒绝覆盖历史包。

v1 实际键鼠移动、转向、跳跃 60 秒通过，发现 18 次新管线创建；
收录后生成 v2。v2 Chrome 无诊断插桩连续三轮，每轮输入 20 秒，
实际相机移动和转向、内部尺寸及画质一致性均通过，路线内缓存遗漏为零。
Edge 同样完成三轮无诊断插桩启动及每轮 20 秒输入，零设备丢失和管线遗漏；
首次 16.22 秒，缓存后 10.95 / 10.82 秒。
这是有限路线覆盖，不代表整个别墅所有可能视角已穷举。

对照入口 `http://127.0.0.1:8766/villa-engine-comparison.html#ours` 已使用 v3。
配置中的 `startupBaseline` 保留原 v4 名称。

## 设备丢失

关闭全局/组件推测性编译的诊断实验仍连续两次复现
`A valid external Instance reference no longer exists`。
对应两份 Chrome 转储：

- 2026-11-09 17:17:52（UTC+8），`0xc0000005`，
  Chrome 157.0.8103.39 的 `dxcompiler.dll+0x25a523`。
- 17:18:02，`0xc0000005`，执行地址不属于已加载模块；不能据此指认 DXC。

这说明至少一次同类页面错误伴随原生 Shader 编译器崩溃。
仅由错误文字不能认定 UE 提前释放 Instance，也不能据此宣布 CPU 已损坏。
减少编译数量并控制并发是应用侧缓解措施，不是浏览器原生崩溃根因已修复的证明。
最初捕获实际使用管线时曾显式使用本机受限核心条件；候选性能和稳定性测试均未限制核心。
用户随后清理了整个 browser-profiles 目录，其中原始转储已不在。
`evidence/villa-startup-crash-inspection-20261109.json` 保存清理前实际读取的
时间、异常地址、模块和 SHA-256；这是历史检查摘要，不是重新检查原始转储的结果。

## 复现

先保持本地 8765、8766、8900 服务运行。原版包 v4 保留。
轻量分段、无插桩重复启动与移动，以及生成新候选的命令分别为：

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
$env:TEMP='H:/ue_html/tests/web-platform/build/test-tmp'
$env:TMP=$env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
node tests/web-platform/probe-villa-startup.cjs --tag=new-baseline --rounds=2 --folder=villa-ue59-comparison-20261109-v4
node tests/web-platform/probe-villa-startup.cjs --tag=new-plain --rounds=3 --engine=ours --folder=villa-prewarm-20261109-v3 --plain --motion-seconds=20
node tests/web-platform/probe-villa-startup.cjs --tag=new-edge --rounds=3 --engine=ours --folder=villa-prewarm-20261109-v3 --plain --motion-seconds=20 --browser=msedge
node tests/web-platform/probe-villa-startup.cjs --tag=new-capture --rounds=1 --engine=ours --folder=villa-prewarm-20261109-v3 --capture --motion-seconds=60
node tests/web-platform/package-villa-prewarm.cjs --source=villa-ue59-comparison-20261109-v4 --tag=new-prewarm --corpus=tests/web-platform/results/villa-startup-new-capture/0-corpus.json
node tests/web-platform/verify-web-pipeline-prewarm.cjs
```

`--cvars` 仅用于配置诊断，打包工具拒绝用此类捕获发布。
`--no-precache --capture` 可从原版捕获实际使用管线。
捕获会改变时序，不以捕获成功替代普通页面稳定性验收。
原始报告、截图及管线捕获留在本机 results；构建包留在 build，摘要证据保存到 evidence。
浏览器 profile 是可再生缓存，独立测试每份约占 3～4 GiB，不能无限累积；
清理时应先保留 Crashpad/reports 中需要分析的转储。
