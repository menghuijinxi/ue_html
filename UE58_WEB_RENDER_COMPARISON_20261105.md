# Web 性能优化合并与四组渲染对照

日期：2026-11-05。

## 当前：分别切换遮挡与调度优化

用户反馈同一组优化在本机导致帧率大幅下降，在另一台设备却明显提升。本轮先拆分有效遮挡历史与 Game 本地帧调度，用四种组合隔离主效应和组合影响。由于上一轮还同时切换了 RHI 唤醒，额外增加 E 单独检查它。以下全部读取同一个 D 包，不修改引擎或包的全局默认值。

| 组别 | 遮挡历史复用 | Game 本地调度 | RHI priority 唤醒 | 入口 |
| --- | --- | --- | --- | --- |
| A：全部关闭 | 关闭 | 关闭，owner RAF | 关闭，channel | [打开 A](http://127.0.0.1:8765/build/triplex-motion-lumen-blur-lag1-20261105-blur/index.html?occlusion=control&clock=owner&rhiwake=channel) |
| B：只开遮挡历史 | 开启 | 关闭，owner RAF | 关闭，channel | [打开 B](http://127.0.0.1:8765/build/triplex-motion-lumen-blur-lag1-20261105-blur/index.html?occlusion=history&clock=owner&rhiwake=channel) |
| C：只开本地调度 | 关闭 | 开启，local | 关闭，channel | [打开 C](http://127.0.0.1:8765/build/triplex-motion-lumen-blur-lag1-20261105-blur/index.html?occlusion=control&clock=local&rhiwake=channel) |
| D：遮挡与调度均开 | 开启 | 开启，local | 关闭，channel | [打开 D](http://127.0.0.1:8765/build/triplex-motion-lumen-blur-lag1-20261105-blur/index.html?occlusion=history&clock=local&rhiwake=channel) |
| E：只开 RHI 唤醒 | 关闭 | 关闭，owner RAF | 开启，priority | [打开 E](http://127.0.0.1:8765/build/triplex-motion-lumen-blur-lag1-20261105-blur/index.html?occlusion=control&clock=owner&rhiwake=priority) |

A / B 与 C / D 分别比较相同时钟下的遮挡开关；A / C 与 B / D 分别比较相同遮挡路径下的 Game 时钟；A / E 比较 RHI 唤醒。本轮 D 固定 `rhiwake=channel`，与之前默认三项都开的无参数 D 链接不同。E 在不支持 `scheduler.postTask` 的浏览器中仍回退 channel，必须结合运行状态判读。

固定条件：Lumen GI / 反射、动态模糊质量 4、TSR 全部开启，`r.OneFrameThreadLag=1`、`t.MaxFPS=0`。运行时、Cook、输入桥接和分辨率配置相同。每次只运行一个入口，等待启动预热结束，用相同窗口、分辨率、视角和路线比较平均 FPS 与 1% Low；两台设备分别记录，不合并成一项通用收益结论。

用户另已在桌面端确认：人为限帧没有复现同样问题，但显卡算力不足、实际降到十几帧时也会出现画面抖动；当前 Web 的 Low 帧也在十几帧。按用户决定，**暂停画面抖动排查与修复**，保留现有实现及历史取证，本轮只准备性能开关对照，不宣称此前发现的 Web 路径差异已被证明是唯一原因。

探针与核验脚本现在支持独立的 `--occlusion=control|history`、`--clock=owner|local` 和 `--rhiwake=channel|priority`，并拒绝与 `--optimizations-off` 混用。参数解析和预期模式共用 `web-performance-modes.cjs`，启动 URL 和实际生效模式均写入证据。

五组验证记录使用以下标签；浏览器功能探针含 GPU 包装和进程亲和性设置，其短窗口 FPS 不作为设备间性能比较数据。

| 组别 | 测量标签 |
| --- | --- |
| A | `20261105-split-off` |
| B | `20261105-split-history` |
| C | `20261105-split-clock-retry1` |
| D | `20261105-split-history-clock` |
| E | `20261105-split-rhi` |

五组均通过独立 Edge 启动、实际鼠标转向、相机与项目配置、Lumen / TSR / 动态模糊输出及绑定检查，遮挡 / 时钟 / 唤醒的实际值与表格一致。A 至 D 实际唤醒均为 channel；E 检测到 priority 支持，实际进入 priority。五组未捕获运行错误、GPU validation 或 device lost，截图像素检查通过，D 截图人工查看正常；文件校验再次确认使用相同完整编译的运行时和 Cook，测试浏览器均已关闭。

C 首次测量标签 `20261105-split-clock` 在进入引擎前失败，未应用配置或运行优化路径，原始报告保留，具体启动原因未确定。补充启动失败诊断记录后，以 `20261105-split-clock-retry1` 新会话复测通过；该首次失败不纳入性能对比。测试开关的八种有效参数组合及无效 / 冲突参数检查通过，脚本语法和差异空白检查通过。以上均为功能及配置验证，未据此判断本机或另一设备的优化收益。

运行后完整记录保留在 `tests/web-platform/results/motion-blur-ab-<标签>-runtime*`，文件与运行证据写入 `tests/web-platform/evidence/render-matrix-<标签>.json`。复现 B 的命令如下；其余组只替换标签和对应三个模式，重复测量须使用新标签。

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-motion-blur-ab.cjs --tag=20261105-split-history --package-tag=20261105-blur --case=lumen-blur-lag1 --occlusion=history --clock=owner --rhiwake=channel "--profile-root=$env:TEMP/ue-web-performance-split-20261105"
node tests/web-platform/verify-web-render-matrix.cjs --tag=20261105-split-history --package-tag=20261105-blur --case=lumen-blur-lag1 --occlusion=history --clock=owner --rhiwake=channel
```

## 历史：关闭刚合入的默认优化

用户反馈本机新版本反而更卡。本轮以动态模糊矩阵的 D 为基准，增加以下回退入口。两个链接读取同一个包，运行时、Cook、分辨率、输入桥接和项目配置完全相同，只通过已有启动开关切换新启用的三项优化。

| 对照 | 遮挡历史 | Game 时钟 | RHI 唤醒 | 入口 |
| --- | --- | --- | --- | --- |
| D，当前默认优化 | history | local | priority | [优化开启](http://127.0.0.1:8765/build/triplex-motion-lumen-blur-lag1-20261105-blur/index.html) |
| D，关闭新启用优化 | control | owner | channel | [优化关闭](http://127.0.0.1:8765/build/triplex-motion-lumen-blur-lag1-20261105-blur/index.html?occlusion=control&clock=owner&rhiwake=channel) |

固定保留 Lumen GI / 反射开启、TSR 开启、动态模糊质量 4、`r.OneFrameThreadLag=1`、`t.MaxFPS=0`。关闭版用 `?occlusion=control&clock=owner&rhiwake=channel` 恢复原遮挡查询、owner RAF 和 MessageChannel 唤醒。它是同一新运行时的开关回退，不是合并前的二进制；此前已有的绑定缓存等优化继续保留。刚拉取但默认关闭的 BindingPlan、StagingUploadPages、OcclusionQueryWaitMs 和 TLVShareCascades 不属于本轮开关变量。

独立 Edge 运行验证通过：实际模式为 `history.enabled=false`、`gameClock.mode=owner`、`rhiWake.requested/active=channel`，启动参数不含 `-WebGameLocalClock` 或页面帧调度。BindingPlan、上传页复用和查询等待预算在运行中均为关闭；Lumen、TSR 和动态模糊输出仍实际创建并使用，鼠标输入已确认抵达游戏线程且旋转相机。未捕获运行错误、GPU validation 或 device lost；截图像素检查与人工查看通过。入口 HTTP 200 及跨源隔离响应头通过，测试浏览器已关闭。

文件核验再次确认 D 包与先前完整编译记录、配置和 Cook 校验值一致，没有修改任何发布包文件或全局默认值。可携带证据为 `tests/web-platform/evidence/render-matrix-20261105-optimizations-off.json`，完整记录为 `tests/web-platform/results/motion-blur-ab-20261105-optimizations-off-runtime*`。

探针增加独立测量标签、已有包标签、单组选择和优化回退参数，复现如下；重复测量须换新 `--tag`，保留既有结果。

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-motion-blur-ab.cjs --tag=20261105-optimizations-off --package-tag=20261105-blur --case=lumen-blur-lag1 --optimizations-off "--profile-root=$env:TEMP/ue-web-performance-control-20261105"
node tests/web-platform/verify-web-render-matrix.cjs --tag=20261105-optimizations-off --package-tag=20261105-blur --case=lumen-blur-lag1 --optimizations-off
```

此轮只确认回退有效及渲染、输入正常，不据短窗口探针 FPS 判断性能变化。实际卡顿、鼠标手感与抖动仍待用户比较；每次只运行一个页面，保持相同分辨率及移动路线，并等待启动预热结束。

## 历史：动态模糊对照

用户更正：需要比较动态模糊开关，抗锯齿不是本轮变量。以下入口替代上一轮抗锯齿对照，四组统一保留 TSR（`r.AntiAliasingMethod=4`），不限帧率，沿用刚合并并编译的性能优化运行时 `triplex-perf-merged-20261105`。

| 组别 | Lumen GI / 反射 | 动态模糊 | r.OneFrameThreadLag | 入口 |
| --- | --- | --- | --- | --- |
| A | 关闭 | 开启 | 1 | [打开 A](http://127.0.0.1:8765/build/triplex-motion-no-lumen-blur-20261105-blur/index.html) |
| B | 开启 | 关闭 | 1 | [打开 B](http://127.0.0.1:8765/build/triplex-motion-lumen-no-blur-20261105-blur/index.html) |
| C | 开启 | 开启 | 0 | [打开 C](http://127.0.0.1:8765/build/triplex-motion-lumen-blur-lag0-20261105-blur/index.html) |
| D | 开启 | 开启 | 1 | [打开 D](http://127.0.0.1:8765/build/triplex-motion-lumen-blur-lag1-20261105-blur/index.html) |

动态模糊开启时使用与原项目相同的质量 4，保持原来的 Amount / TargetFPS；关闭时仅设置 `r.MotionBlurQuality=0`。四组 JS/WASM、Cook、输入与调度代码相同，只修改配置、标题及资源清单，C / D 的配置只差线程参数。上一轮入口与证据保留为历史，下面原来的验证描述对应标签 `20261105-perf`。

本轮使用 `--motion-matrix` 打包，标签为 `20261105-blur`。运行探针会核对动态模糊输出的创建和实际绑定；B 两项必须为零，其余三组必须大于零，同时每组都检查 TSR、Lumen 和鼠标转向。测试浏览器 profile 新建在 C 盘临时目录 `ue-web-motion-20261105`，避免继续占用 H 盘空间，不清理或覆盖已有 profile。

四组均已在独立 Edge 会话中通过启动、实际鼠标转向和截图像素检查，最终相机 AA 全部为 4。A 没有 Lumen screen probe；B 的动态模糊输出与绑定均为零；A / C / D 均创建并使用动态模糊输出。四组都启用原有 TSR、有效遮挡历史、Game 本地时钟和 RHI priority 唤醒，未启用 CPU 取证，未捕获 GPU validation、device lost 或运行错误。四个入口 HTTP 200 与隔离响应头通过，所有本轮测试浏览器均已关闭。

文件和配置核验通过，四组 JS/WASM 与上一轮完整编译记录匹配；除配置、标题与清单外，所有文件保持同一基线。可携带证据为 `tests/web-platform/evidence/render-matrix-20261105-blur.json`，完整记录为 `tests/web-platform/results/motion-blur-ab-20261105-blur-runtime*`。本轮只重打配置包，没有修改或重编引擎；鼠标卡顿及抖动的体验仍待人工对比。

```powershell
node tests/web-platform/package-web-motion-blur-ab.cjs --motion-matrix --baseline=triplex-perf-merged-20261105 --tag=20261105-blur
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-motion-blur-ab.cjs --tag=20261105-blur "--profile-root=$env:TEMP/ue-web-motion-20261105"
node tests/web-platform/verify-web-render-matrix.cjs --tag=20261105-blur
```

## 背景与合并

用户反馈旧包设置 `r.OneFrameThreadLag=0` 后严重抖动明显减轻，键盘移动没有明显卡顿，但鼠标转向仍有很强的卡顿感。本轮按用户要求先合并最新性能优化，再准备四个独立入口，不将已有线程同步候选表述为完整修复。

两个仓库均已执行 `git fetch origin`，解决原先未完成的合并。根仓库整合远程 `718350c`，合并提交 `298c89d`；引擎仓库整合远程 `75d375164c`，合并提交 `1b09219ce2`。都已通过远程提交为本地祖先的检查，没有推送。

冲突处理同时保留有效遮挡历史、Game 本地调度、RHI 优先级唤醒，以及原有默认关闭的输入直连、共享输入队列、页面 RAF 和动态模糊 CPU 取证。显式页面 RAF 不再同时隐式启用本地帧时钟，冲突的时钟组合会明确拒绝。输入、共享队列回绕与溢出、取消回调、本地调度暂停和恢复的回归检查通过。

## 历史：抗锯齿对照

新运行时基线目录为 `triplex-perf-merged-20261105`，四组打包标签为 `20261105-perf`。同一基线的运行时、场景 Cook、输入方式及分辨率配置在四组之间完全相同。动态模糊沿用项目设置，所有版本都不限制 FPS，CPU 取证默认关闭。

| 组别 | Lumen GI / 反射 | 抗锯齿 | r.OneFrameThreadLag | 目录 |
| --- | --- | --- | --- | --- |
| A | 关闭 | TSR，方法 4 | 1 | [打开 A](http://127.0.0.1:8765/build/triplex-motion-no-lumen-aa-20261105-perf/index.html) |
| B | 开启 | 关闭，方法 0 | 1 | [打开 B](http://127.0.0.1:8765/build/triplex-motion-lumen-no-aa-20261105-perf/index.html) |
| C | 开启 | TSR，方法 4 | 0 | [打开 C](http://127.0.0.1:8765/build/triplex-motion-lumen-aa-lag0-20261105-perf/index.html) |
| D | 开启 | TSR，方法 4 | 1 | [打开 D](http://127.0.0.1:8765/build/triplex-motion-lumen-aa-lag1-20261105-perf/index.html) |

前两组未指定的线程参数明确采用默认值 1。关闭 Lumen 同时关闭其 GI、反射和运行允许开关；没有换用移动渲染。四组继承合并后默认的有效遮挡历史、Game 本地调度与 RHI priority 唤醒，浏览器没有 `scheduler.postTask` 时维持已有 MessageChannel 回退。

## 验证

完整多线程 mimalloc 运行时完成正常 UBT 编译与链接，47 个任务，编译错误及失败进程均为零，WASM 结构检查通过。构建日志为 `tests/web-platform/results/web-engine-full-thread-20261105-114939.log`，独立构建记录为 `tests/web-platform/results/triplex-perf-merged-20261105-build.json`。本轮重新编译并打包运行时，保持已经审计的场景 Cook 和着色器资源，不重复 Cook。

四版均在独立的无界面 Edge 测试会话中完成启动和鼠标转向，实际相机发生旋转。最终相机的 GI / 反射 / AA 与对应配置一致；A 未创建 Lumen screen probe，B 未创建 TSR 资源，C / D 同时运行 Lumen 和 TSR，四版都实际使用动态模糊输出。默认有效遮挡历史、本地时钟和 RHI priority 唤醒均生效；输入采用原 owner 转发，动态模糊 CPU 取证没有启用。四版都未捕获 GPU validation、device lost 或运行错误。

四个入口的 HTTP 200 与隔离响应头检查通过。截图像素检查及人工查看确认场景正常显示；这是运行与配置验证，不是鼠标手感或完整画质验收。

`verify-web-render-matrix.cjs` 再次验证四组文件、配置差异及实际运行结果：新 JS/WASM 与本轮完整构建相同，四组除配置、页面标题和清单外全部文件与新基线一致，C / D 的配置只差线程参数。可携带证据为 `tests/web-platform/evidence/render-matrix-20261105-perf.json`，完整日志、截图及运行报告保留在 `tests/web-platform/results/motion-blur-ab-20261105-perf-runtime*`。

本轮测试创建的独立 Edge profile 缓存保留在 `tests/web-platform/build/browser-profiles/motion-ab-20261105-perf-*`。尝试清理已关闭的 A 测试 profile 时，执行策略以 `blocked by policy` 拒绝命令，未执行删除；没有改用其他方式绕过拦截。四版功能测试已全部完成，测试浏览器均已关闭。

复现命令：

```powershell
./tests/web-platform/build-web-engine.ps1 -Threads -SkipHostPreparation -MaxParallelActions 4
node tests/web-platform/package-web-runtime-experiment.cjs --baseline=triplex-project-lumen-shadows-fixed-20261104 --output=triplex-perf-merged-20261105 --evidence=tests/web-platform/results/triplex-project-lumen-shadows-fixed-20261104-package.json
node tests/web-platform/package-web-motion-blur-ab.cjs --render-matrix --baseline=triplex-perf-merged-20261105 --tag=20261105-perf
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-motion-blur-ab.cjs --tag=20261105-perf
node tests/web-platform/verify-web-render-matrix.cjs --tag=20261105-perf
```

运行探针会检查启动配置、最终相机 GI / 反射 / AA、实际 Lumen / TSR 资源与动态模糊派发、相机转向、默认调度模式及 GPU 错误。探针含 GPU API 包装和启动预热，不用它的短窗口 FPS 宣称性能收益或输入延迟改善。鼠标转向和画面抖动的最终体验由用户逐版复核，每次只运行一个版本。
