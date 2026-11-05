# Web 游戏帧计时与动态模糊取证

日期：2026-11-05。承接 `UE58_WEB_INPUT_BRIDGE_EXPERIMENT.md`。

## 结论

用户已明确反馈 `triplex-input-direct-20261105` 抖动没有任何改善。直连输入不能作为修复。本轮继续测试页面提供 RAF、共享输入队列两种局部改动，均未消除实际上传的动态模糊缩放尖峰；未请求用户重复验收这些参数结果仍异常的包。

新增的实测证据是：游戏线程入口间隔存在长短交替，缩放值与该间隔近似成反比。原调度的一段连续记录如下：

| 捕获 RHI 帧号 | 经验对齐的 GT 序号 | GT 入口间隔 | VelocityScale.X |
| ---: | ---: | ---: | ---: |
| 108 | 107 | 103.86 ms | 51.35 |
| 109 | 108 | 4.52 ms | 1186.47 |
| 110 | 109 | 61.18 ms | 87.17 |
| 111 | 110 | 5.45 ms | 976.80 |
| 112 | 111 | 84.45 ms | 63.15 |
| 113 | 112 | 7.15 ms | 748.02 |

同一轮 204 个样本中，使用 `GT 序号 = 捕获 RHI 帧号 - 1` 对齐，`VelocityScale.X * GT 入口间隔(ms)` 为 5306.08 至 5431.26，中位数 5333.30；错开一个相邻帧时乘积大幅离散。这支持尖峰与帧计时有关，不能单凭计数器差值宣称发现了引擎错帧。

这些是 JS 主循环入口时间，不是直接读取 C++ `DeltaRealTime`。尚未证实该时长和相机前后变换是否对应同一段时间，也未确定错误发生在 GT 计时、相机历史、ViewState 更新还是渲染参数快照。较小的帧时长本身并非错误；需要结合实际运动区间判断归一化是否正确。

## 对照结果

全部保持原场景的 WASM、Cook 和着色器，GI / 反射 / AA = 1 / 1 / 4，并实际派发动态模糊速度展开。未限制帧率。下表的 GT 间隔排除前 90 帧。

| 条件及记录 | 速度样本 | GT 间隔中位数 / 最短 | 小于 8 ms 的 GT 间隔 | VelocityScale.X 最大值 | 运动样本中缩放 > 500 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原输入、原 RAF，game-clock-r2 | 204 | 32.90 / 1.56 ms | 70 / 207 | 3440.42 | 53 / 113 |
| 原输入、页面 RAF，page-raf-r2 | 224 | 22.52 / 1.57 ms | 90 / 225 | 3463.33 | 66 / 107 |
| owner 输入、原 RAF，mailbox-r1 | 221 | 25.86 / 1.62 ms | 79 / 224 | 3343.74 | 53 / 98 |
| 共享输入队列、原 RAF，mailbox-r1 | 214 | 29.81 / 1.41 ms | 89 / 218 | 3795.97 | 62 / 128 |

页面 RAF 已完成握手，实际送出 315 次回调，原生 RAF 时间戳原样转交。共享队列由 GT 在主循环入口读取，页面写入 84 个事件、GT 读取 84 个，最大每批 3 个，无队列溢出或溢出重置。它绕过逐批消息传递，但仍使用原生入队入口与 `PumpMessages`；没有重写 UE 输入消费逻辑。

“运动样本”沿用 `abs(ClipToPrevClip[12]) + abs(ClipToPrevClip[13]) > 0.00001` 的筛选。500 是统计门槛，不是合法值上限。各组鼠标事件受浏览器调度影响，不应通过样本数量差异声称性能改善。

四组最终记录共 863 个速度展开样本，页面错误、GPU 错误和设备丢失均为零。此前页面 RAF 的初测 r1 另有 238 个样本，结果同样有尖峰，但没有记录通道握手与交付计数，主表使用已补齐检查的 r2。

## 实现与验证

- `web-game-clock-observer.cjs` 在诊断包的实际 pthread 运行时中记录 GT 主循环前后时间、RAF 时间戳与消息输入数量，不改变时钟或主循环节奏。共享队列读取量单独统计，不能用消息计数代替它。
- `package-web-game-clock.cjs` 创建只加入观察器的基线，或显式启用页面 RAF 的包。`package-web-input-bridge.cjs --mailbox` 生成同一 JS 实现的 owner / shared 两组。
- `WebWorkerCanvas.js`、host 和 worker 增加显式启用的页面 RAF / 共享输入队列通道。默认仍使用原输入与 owner RAF。共享队列有 256 条上限；溢出释放按键，消费者复制后才发布已读位置。
- 真实 MessagePort 与当前源码处理器测试覆盖时间戳保留、帧取消、输入顺序、环形队列反复回绕、计数器回绕、溢出释放及原有背压。Node 语法检查和两个仓库的差异检查通过。
- 实验打包时校验基线全部资源摘要和派生包的不变资源。采用 JS 替换进行单变量诊断，未完成新的 UBT / WASM 全量构建。

早期 `game-clock-r1` 尝试通过浏览器路由给 pthread 脚本注入观察器，读取超时；该记录失败，不支持任何引擎计时结论。现已改为物理诊断包，探针要求明确指定该包。

mailbox-r1 两组截图曾使用同一文件名，owner 截图已被 shared 覆盖，不能再验其摘要；原始报告保留，证据摘要明确排除这张 owner 截图。现已按组号生成独立文件名。shared 和页面 RAF r2 的停止转向截图已检查，场景可见；静态截图不用于判断动态抖动是否解决。

可版本化摘要：`tests/web-platform/evidence/game-clock-investigation-20261105.json`。原始报告和分析位于 `tests/web-platform/results/motion-blur-inputs-20261105-{game-clock-r2,page-raf-r2,mailbox-r1}{,-analysis}.json`。包报告记录构建时源码摘要，探针报告记录采样时源码摘要；后续清理脚本不回写历史摘要。

`node tests/web-platform/verify-web-game-clock-evidence.cjs` 可重新核对报告摘要、分析来源、设置、样本数、通道计数和有效截图。参考引擎本轮本地提交为 `b747bb3840`，外围源码和证据由根仓库单独提交。

## 下一步边界

不把输入直连、页面 RAF 或共享队列推广为默认修复。现阶段用户已确认可用的临时配置仍是开启 Lumen、关闭动态模糊。

下一个需要直接观察的位置是 `SceneVisibility.cpp` 的 `FSceneViewState::UpdateMotionBlurTimeScale`，以及 `PostProcessMotionBlur.cpp` 构造 `VelocityScale` 的位置。应在同一帧记录最终 Amount、TargetFPS、DeltaRealTime、ViewState 时间和当前 / 上一相机变换，再与上传参数匹配。现有证据不足以通过夹小缩放值或平滑时长代替根因修复。

复验使用尚未存在的标签、原有 8765 服务器，以及含 Playwright 的 `NODE_PATH`：

```powershell
node tests/web-platform/verify-web-input-bridge.cjs
node tests/web-platform/package-web-game-clock.cjs --tag=20261105-clock-recheck
node tests/web-platform/probe-web-motion-blur-inputs.cjs --tag=20261105-clock-recheck --folder=triplex-game-clock-20261105-clock-recheck --game-clock
node tests/web-platform/analyze-web-game-clock.cjs tests/web-platform/results/motion-blur-inputs-20261105-clock-recheck.json
```

页面 RAF 在打包时加 `--page-raf`；共享输入对照使用 `package-web-input-bridge.cjs --tag=<新标签> --mailbox`，探针使用 `--mailbox-tag=<同标签> --game-clock`。`H:/UE_5.8` 安装目录未修改，未推送远程。
