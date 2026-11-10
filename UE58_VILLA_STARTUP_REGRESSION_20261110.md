# 2026-11-10 别墅重打包的启动回归

修复入口：`http://127.0.0.1:8765/build/villa-lumen-vt-20261110-v3/index.html`。
原 `villa-lumen-vt-20261110` 留作故障基线，不再作为推荐入口。

## 原因和责任

虚拟阴影及玻璃偏色在此前已完成适配。这次重打包的引擎改动只包括：

- 对齐安装版 Cook 与 Web 运行时的 Nanite 32 线程转码排列。
- 在 VSM 专用 PSO 尚未完成时继续等待专用管线，避免桌面通用回退创建 Web 不支持的毛发资源。

外围改动为宿主模块加载阶段、天空光隔离宿主、转码编译标志和测试。
没有修改原工程内容，也没有重写 VSM 渲染算法。

实际交付错误在打包流程：`package-web-project.cjs` 仍直接使用 11 月 7 日性能配置，
重新加入 `-WebPSOPrecacheTest`，却没有接入 11 月 9 日已实现的实际管线预热包。
新包不含 `pipelinePrewarm`，启动重新触发大量推测性预编译。
上轮测试已记录 1366 条候选管线失败信息，却只以实际渲染/GPU 验证检查通过交付。
此外上轮测试进程限制了 CPU 核心，不能代表用户正常调度下的启动稳定性。
撤回上轮“通过一次五视角即可交付”的结论。

## 用户故障证据

用户导出的 `ue-startup-diagnostics-2026-11-10T08-07-18-803Z.json` 显示：

- 2026-11-10 16:07:12（UTC+8）第 1 帧发生设备丢失。
- WASM/内容已有缓存，`downloads=0`、`persistentHits=2`；不是重新下载造成的等待。
- 两份 Edge 转储分别为 16:07:12、16:08:10，均为 `0xc000001d`，
  位于 Edge 157.0.4341.42 的 `dxcompiler.dll+0xf41b07`。

这证明设备丢失伴随原生编译器崩溃，不能据此断言其根因或系统硬件状态。
修复减少编译数量并恢复受控预热；不宣称已修复浏览器原生编译器本身。

## 修复

重新捕获当前 Lumen、VT、VSM 包实际使用的管线，包括 30 秒键鼠移动。
得到 321 个 Shader Module、326 条描述符，完整键去重后预热 319 条管线。
沿用已有并发 2、下载期间预热、同设备交给 RHI、完整描述符匹配的实现。
未记录的管线仍正常按需编译。

本轮 WASM、JS、Cook 和配置文件与故障包哈希相同，没有重新 Cook、改画质或改引擎源码。
独立预热打包先生成 v2；普通工程打包接入相同逻辑后生成 v3。
二者 12 个实际发布文件逐字节一致，版本清单只含生成时间差异。

`package-web-project.cjs` 普通线程发布必须明确选择：

- `--pipeline-corpus=<捕获文件>`：正式包，校验成功捕获报告及 WASM/JS/内容/配置哈希。
- `--capture-prewarm`：用于捕获新构建的中间包，关闭旧推测性预编译。
- `--legacy-precache`：显式的旧模式诊断包。

缺少模式直接失败，防止再次静默漏掉优化。新回归测试覆盖哈希不匹配、失败捕获、
画质配置覆盖、发布文件不变及缺少预热的拒绝行为。
五视角测试新增 `--require-recorded-prewarm`，不再错误地要求旧的推测性预编译开启，
并将 `Failed to create compute/graphics pipeline` 日志视为失败。

## 重复启动

Edge 与 Chrome 各三轮，无核心限制、无 WebGPU 性能包装；
1258×552、DPR 1.5，与用户诊断窗口条件一致。每轮加载层隐藏且至少 30 帧后，
继续实际键鼠移动和转向 20 秒。浏览器测试窗口位于屏幕外，保留既有工具的后台计时参数。

| 浏览器 | 首次访问 | 缓存访问 1 | 缓存访问 2 |
| --- | --- | --- | --- |
| Edge | 17.257 秒 | 12.594 秒 | 12.359 秒 |
| Chrome | 16.215 秒 | 12.352 秒 | 12.208 秒 |

六轮均通过，设备丢失、页面错误、管线创建失败日志均为 0；已测移动路线预热遗漏为 0。
原始捕获耗时含诊断包装，不作为修复前后的等条件性能比较。
Lumen 反射、VSM、TSR 与之前对照包不同，不能直接拿 11 月 9 日约 10 秒的计时作为本包基准。
少量重复启动不证明长期或跨设备稳定性。

正式 v3 另完成五视角 2330 帧复核：Lumen GI/反射实际 GPU 派发分别为 51276、9324 次，
VT/VSM 开关及活动路径均为 1，无页面错误、管线创建失败、GPU 验证错误或设备丢失。
五视角出现 11 次未收录管线的正常按需创建，故预热覆盖仍有限。
玻璃两区域色度差为 0.001114、0.000874，低于 0.02 阈值。
实际 VT 资产仍为 0，本次没有改动贴图资产。

## 复现

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-villa-startup.cjs --tag=new-capture --rounds=1 --engine=ours --folder=YOUR-CAPTURE-PACKAGE --browser=msedge --direct --no-precache --capture --motion-seconds=30
node tests/web-platform/package-web-project.cjs --project=triplex-virtual --desktop --threads --distance-fields --output-folder=YOUR-RELEASE --pipeline-corpus=tests/web-platform/results/villa-startup-new-capture/0-corpus.json
node tests/web-platform/probe-villa-startup.cjs --tag=new-validation --rounds=3 --engine=ours --folder=YOUR-RELEASE --browser=msedge --direct --width=1258 --height=552 --dpr=1.5 --plain --motion-seconds=20
```

完整本机记录在 `tests/web-platform/results/villa-startup-lumen-vt-repair-*-20261110`。
精简证据为 `tests/web-platform/evidence/villa-startup-regression-20261110.json`。
