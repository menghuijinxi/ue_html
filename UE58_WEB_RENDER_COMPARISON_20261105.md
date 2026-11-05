# Web 性能优化合并与四组渲染对照

日期：2026-11-05。

## 背景与合并

用户反馈旧包设置 `r.OneFrameThreadLag=0` 后严重抖动明显减轻，键盘移动没有明显卡顿，但鼠标转向仍有很强的卡顿感。本轮按用户要求先合并最新性能优化，再准备四个独立入口，不将已有线程同步候选表述为完整修复。

两个仓库均已执行 `git fetch origin`，解决原先未完成的合并。根仓库整合远程 `718350c`，合并提交 `298c89d`；引擎仓库整合远程 `75d375164c`，合并提交 `1b09219ce2`。都已通过远程提交为本地祖先的检查，没有推送。

冲突处理同时保留有效遮挡历史、Game 本地调度、RHI 优先级唤醒，以及原有默认关闭的输入直连、共享输入队列、页面 RAF 和动态模糊 CPU 取证。显式页面 RAF 不再同时隐式启用本地帧时钟，冲突的时钟组合会明确拒绝。输入、共享队列回绕与溢出、取消回调、本地调度暂停和恢复的回归检查通过。

## 四组配置

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
