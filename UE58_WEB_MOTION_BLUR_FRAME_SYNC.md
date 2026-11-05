# Web 动态模糊线程同步对照

日期：2026-11-05。承接 `UE58_WEB_GAME_CLOCK_INVESTIGATION.md`。本轮完成原生 CPU 取证、独立复测和不含 CPU 诊断代码的预览包。

## 当前结果

`r.OneFrameThreadLag=0` 是目前有重复测量支持的解决候选。它取消游戏线程相对渲染线程的帧超前，使帧末同步等待当前渲染与 RHI 工作，不限制固定 FPS，不改引擎时钟，也不减弱 Lumen 或动态模糊。

手动预览：

http://127.0.0.1:8765/build/triplex-motion-frame-sync-20261105/index.html

该预览沿用 `triplex-project-lumen-shadows-fixed-20261104` 的原版 WASM、运行时 JS、输入桥接、Cook 和着色器。配置唯一变化是 `r.OneFrameThreadLag=0`，另更新页面标题及资源清单；没有 CPU 诊断代码，不受此前直连或共享队列实验影响。尚未获得用户视觉验收，不把参数尖峰消失表述为最终画面已修复。

## CPU 与上传参数

在 `GetVelocityFlattenParameters` 增加默认关闭、仅 Web 编译的 `r.Web.MotionBlurTrace`，记录最终 Amount / TargetFPS、视图真实时间及 DeltaRealTime、ViewState 帧号、当前 / 前帧位置和旋转、完整 ClipToPrevClip、CPU 生成的缩放与上限。

诊断在调用线程同步复制值，随后单向传给 owner；不延后读取 View 或栈指针，不等待 GPU，也不要求常驻渲染线程响应 JS 读取请求。记录各自限制到 600 条。构建覆盖及准备脚本已同步纳入该文件，安装引擎未修改。

四组有效 CPU 对照共 867 个速度展开样本，每个样本均通过以下检查：

- CPU 帧号和捕获 RHI 帧号相同；两个缩放分量、上限和 16 个矩阵元素与真实上传值完全相同。
- 当前 CPU 时间减前帧时间，恰好等于本帧 DeltaRealTime。
- 本帧的上一相机位置及旋转，恰好等于前帧的当前值；ViewState 帧号连续。
- 运行时最终 Amount=0.5、TargetFPS=30，时间缩放符合原版公式。

这显著削弱“参数上传拿错帧”“相机历史落后一帧”及“着色器自行产生数千级缩放”的解释。先前基于 JS 计数器的经验对齐，已在本轮由真实 CPU 帧号替代。

## 重复对照

1280x720、DPR 1，延续此前本机浏览器 / GPU 进程 CPU 掩码 `0xffff0000`。每次独立浏览器进程先预热 90 帧，再执行相同转向操作。全部 GI / 反射 / AA = 1 / 1 / 4，实际派发动态模糊。

| 条件 | 样本 | 最短 DeltaRealTime | 缩放最大值 | 小于 8 ms 的帧 | 运动帧中缩放 > 500 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原同步，cpu-r4 | 221 | 1.35 ms | 3964.84 | 77 | 53 / 116 |
| 完全同步，cpu-sync-r1 | 208 | 17.00 ms | 313.63 | 0 | 0 / 102 |
| 原同步复测，cpu-r5 | 225 | 1.60 ms | 3333.77 | 78 | 56 / 112 |
| 完全同步复测，cpu-sync-r2 | 213 | 17.31 ms | 308.02 | 0 | 0 / 90 |
| 原版 WASM 预览，frame-sync-preview | 212 | 未直接读取 CPU | 334.69 | 未直接读取 CPU | 0 |

共 1079 个最终上传样本，页面 / GPU 错误和设备丢失均为零。复测启动日志确认 `r.OneFrameThreadLag=0` 已载入。最终原版 WASM 预览没有读取 CPU 参数，不把根据缩放反推的时长当作直接实测。

中心屏幕固定 DeviceZ=0.5 的相机运动半径代理值：原同步两轮 P95 为 21.93 / 27.51 px，最大都触及 32 px 上限；完全同步两轮 P95 为 3.37 / 3.71 px，最大 4.40 / 5.21 px。它只是根据矩阵和缩放计算的代理值，不是速度纹理回读或最终画面模糊半径。

## 原因与边界

源码位置：

- `SceneVisibility.cpp` 的 `FSceneViewState::UpdateMotionBlurTimeScale`：固定 TargetFPS 时，以目标帧时长除以视图 DeltaRealTime。
- `PostProcessMotionBlur.cpp` 的 `GetVelocityFlattenParameters`：再乘以画面宽度与 Amount。CPU 已生成尖峰，上传没有改变它。
- `RenderCore/Private/RenderingThread.cpp` 的 `FFrameEndSync::Sync`：默认允许帧重叠；`r.OneFrameThreadLag<=0` 将 RT / RHI 的重叠数量降为 0。

最符合目前证据的机制是：Web 的线程调度和帧末等待产生长帧、快速追赶帧交替；输入驱动的离散相机变化落到非常短的帧时长上，原版模糊公式便将它解释为极高的运动速度。例：cpu-r4 第 111 帧 DeltaRealTime=2.93 ms，存在约 0.7 度相机变化，缩放=1823；相邻帧的相机历史与时间均连续。HUD 的窗口平均 FPS 不呈现这一逐帧组合。

完全同步两次都消除了此次采样中的短帧与缩放尖峰，原同步复测仍重现。这比单纯改变输入传输通道更有因果支持。Lumen 的工作量可能使调度问题更容易触发，尚未单独量化它对等待点的贡献；本轮没有证明 Lumen 光照算法自身损坏，也没有直接测量每个输入事件的物理采样区间。

代价是减少 GT / RT / RHI 的 CPU 并行重叠，其他场景可能降低吞吐。自动化输入和诊断有开销，本轮不作性能基准；仍有约 300 ms 长帧，不能宣称卡顿已全部消失。候选仅放入独立预览包，未推广为所有 Web 场景的默认配置。

## 验证与失败记录

- 原生线程目标两次完成编译、链接及 WASM 结构验证；最终有效构建记录保存在 `results/motion-blur-cpu-20261105-build.json`。
- `verify-web-motion-blur-cpu.cjs` 直接执行实际生成 JS 中的 CPU 捕获函数，验证 wasm64 指针、同步复制和跨线程传输。
- `analyze-web-motion-blur-cpu.cjs` 严格逐帧比较 CPU / 上传参数、时间和相机历史。
- `verify-web-motion-blur-sync.cjs` 检查两轮复现、两轮候选、原版预览与不变资源摘要；证据位于 `evidence/motion-blur-frame-sync-20261105.json`。
- cpu-r1 因诊断传参超出当前生成器支持范围失败；cpu-r2 因尝试向常驻线程请求读取而超时；cpu-r3 未取得完整结果，浏览器在读取阶段关闭，同时发现回复含不可克隆的诊断数组方法。关闭的具体原因未单独证明。三次均排除，保留原报告。改为两个指针参数、立即复制与单向传输后，增加了直接执行生成代码的验证。

参考引擎本轮本地提交为 `a410562fb8`；外围构建、对照脚本、预览配置打包器和证据由根仓库单独提交，均未推送远程。

复验需要现有 8765 服务器、Playwright 的 NODE_PATH 和对应 Cook：

```powershell
node tests/web-platform/verify-web-motion-blur-cpu.cjs tests/ue-web-smoke/Binaries/Web/UEWebEngineThreads.js
node tests/web-platform/verify-web-motion-blur-sync.cjs
node tests/web-platform/package-web-motion-blur-ab.cjs --frame-sync-only --tag=<新标签>
```

CPU 诊断包使用 `package-web-game-clock.cjs --tag=<新标签> --cpu-params`，完全同步组追加 `--sync-frame`；探针使用 `--folder=<诊断包> --game-clock --cpu-params`。普通预览使用同一探针的 `--folder=<预览包>`。所有测量标签须为新名称。
