# Lumen 与动态模糊异常调查

日期：2026-11-04。范围：网上相似案例、安装版桌面源码与 Web 参考源码差异、实际浏览器参数取证。本轮分析原因，不修改引擎渲染实现。

## 当前结论

2026-11-05 补充实验：页面直连 Game Thread、绕过 RHI owner 并取消输入的额外页面 RAF 等待后，两次复测仍有数千级速度缩放尖峰。输入送达延迟有所改善，但没有消除参数异常，削弱了“输入转发阻塞是主因”的解释。详见 `UE58_WEB_INPUT_BRIDGE_EXPERIMENT.md`；具体排查重点应继续放在游戏帧时长、相机历史和参数快照的对应关系。

目前最有证据支持的方向是：Web 的输入、Game Thread 与渲染调度使相机帧间运动和模糊归一化时长未能稳定对应，Lumen 的额外工作暴露或放大了这个问题。实际上传给速度展开着色器的缩放值存在显著尖峰，相近相机位移因此可能在清晰帧与强模糊帧之间交替。

这是有运行证据支持的首要假设，尚未证明具体责任点是输入批处理、Game Thread 的 DeltaRealTime、ViewState 更新，还是 RHI 参数快照。没有把“关闭动态模糊正常”直接等同于 Lumen 光照算法错误。

用户已完成的手动对照见 `UE58_WEB_MOTION_BLUR_AB.md`：

| 条件 | 用户观察 |
| --- | --- |
| 关闭 Lumen，保留动态模糊，实际 10 FPS | 无明显抖动 |
| 开启 Lumen，关闭动态模糊，原调度 | 无明显抖动 |
| 原始 Lumen 与动态模糊同时开启 | 剧烈模糊与抖动 |

两组帧率与调度不同，尚不能证明 Lumen 是必要条件，也不能排除它主要通过调度影响触发问题。

## 网上调查

本轮未找到官方确认、可直接对应本项目 WebGPU 移植的“Lumen 与动态模糊组合”缺陷工单。以下相似问题属于不同机制，论坛反馈不能作为本项目根因的证明。

| 资料 | 问题与办法 | 对本项目的意义 |
| --- | --- | --- |
| Epic《Post Process Effects》Motion Blur | 模糊基于速度数据；Target FPS 用于保持相对目标帧率的模糊，数值越高模糊越少；0 与实际帧率关联。Amount 控制强度，Max 限制屏幕宽度百分比 | 先检查速度和时长；调小 Amount / Max 或提高 Target FPS 可以缓解，不能证明修好了数据对应关系 |
| Epic 论坛 2020 年《Motion blur is affected by time dilation in UE 4.25》 | 作者报告低帧率、时间膨胀与模糊时长相互影响；讨论涉及时间缩放修正与 Target FPS 设置 | 相似的是计时归一化。我们的源码已经采用 DeltaRealTime，不应照抄旧版本修正 |
| Epic 论坛 2023 年《UE 5.0 Ghosting issues with Instanced Static Meshes and TSR / Temporal AA》 | 作者反馈把移动实例改为移动其组件后问题消失；讨论指向移动组件与实例速度数据的差异 | 错误的前后帧运动关系能产生很像抗锯齿或模糊故障的图像。本场景主要是相机转向，不能直接套用 ISM 修复 |
| Epic 论坛《Lumen GI causes ghosting in viewport and in render》，2026-01-09 至 01-23 的回复 | Epic 支持人员建议尝试 `r.Lumen.ScreenProbeGather.Temporal.MaxFastUpdateModeAmount=0.999`，以增加噪声换取较少光照历史拖影；也提到 GI / Reflections Quality=4。原报告者反馈效果不明显，关闭动态模糊仍有拖影 | 这是光照历史累积方向的缓解办法，不能作为本项目已验证的解决方案。与本项目关闭动态模糊即无明显抖动的结果不同 |
| Epic《Temporal Super Resolution》 | 强调排查错误运动矢量，提供 VisualizeMotionBlur / VisualizeReprojection 和 TSR 可视化 | 对后续检查当前帧、上一帧变换及速度纹理有直接指导意义 |
| Epic《Lumen Global Illumination and Reflections》及《Lumen Technical Details》 | Lumen 的缓存更新会延迟间接光照变化；Lighting Update Speed 调整光照响应，快速相机运动也可能影响场景更新 | 这些选项主要针对光照历史与缓存响应，不能直接解释全画面模糊速度的参数尖峰 |

资料：

- https://dev.epicgames.com/documentation/en-us/unreal-engine/post-process-effects-in-unreal-engine
- https://forums.unrealengine.com/t/motion-blur-is-affected-by-time-dilation-in-ue-4-25/143141?page=2
- https://forums.unrealengine.com/t/ue-5-0-ghosting-issues-with-instanced-static-meshes-and-tsr-temporal-aa/835073
- https://forums.unrealengine.com/t/lumen-gi-causes-ghosting-in-viewport-and-in-render/2702446
- https://dev.epicgames.com/documentation/en-us/unreal-engine/temporal-super-resolution-in-unreal-engine
- https://dev.epicgames.com/documentation/en-us/unreal-engine/lumen-global-illumination-and-reflections-in-unreal-engine
- https://dev.epicgames.com/documentation/en-us/unreal-engine/lumen-technical-details-in-unreal-engine

## 源码差异

以下安装目录文件只读取和比较，未修改 `H:/UE_5.8`。

### 动态模糊主算法一致

将 CRLF 统一为 LF 后，以下两份 `PostProcessMotionBlur.cpp` 全文一致：

- `H:/UE_5.8/Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessMotionBlur.cpp`
- `reference-engine/Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessMotionBlur.cpp`

规范化 SHA256：`6e5129b1293d46b2d9a1372f6fde928d3aabf8d7a6b3c0fb9f25235389f46e6b`。

`SceneVisibility.cpp` 中 `FSceneViewState::UpdateMotionBlurTimeScale` 函数也完全一致，规范化 SHA256 为 `e8ef2bd9b445896fa6540beddc59fc73ae79a9e895b9a4e58e3fac79b4224d76`。Web 在该文件中的遮挡查询重置发生在保存前帧相机数据之后，没有直接改写该模糊公式。

正常非暂停帧中，当 Target FPS 大于 0 时：

```text
MotionBlurTimeScale = (1 / MotionBlurTargetFPS) / DeltaRealTime
VelocityScale.X = ViewWidth * 0.25 * MotionBlurAmount * MotionBlurTimeScale
```

位置：

- `reference-engine/Engine/Source/Runtime/Renderer/Private/SceneVisibility.cpp:5652`
- `reference-engine/Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessMotionBlur.cpp:614`
- `reference-engine/Engine/Shaders/Private/MotionBlur/MotionBlurVelocityFlatten.ush:67`

着色器将屏幕运动乘以 VelocityScale 后限制长度。默认 Target FPS 来自 `Engine/Private/Scene.cpp`，为 30；实际后处理体积仍可以覆盖它。本轮没有读取到最终 Amount、Target FPS 和 CPU DeltaRealTime，因此没有把默认值当作运行时已测值。

如果运动确实与帧时长成比例，稳定的低帧率会被归一化补偿。异常在于非零相机位移恰好落到缩放极大的帧：即使平均 FPS 稳定，也可能交替出现清晰帧和强模糊帧。

### Web 的输入与调度不同

`tests/web-platform/web-engine-host.js:287` 的输入链：

1. 页面 RAF 批量提交输入，最多一批在途。
2. 等待 input-ack 后才能提交下一批。
3. 连续鼠标移动会合并 dx / dy。
4. 发送的是九个数值组成的事件数组，没有事件采样时间。
5. `web-engine-worker.js:83` 先接收输入，再转发给 Game Thread Worker。
6. `WebApplication.cpp:333` 在 Game Thread 消费队列，以原始位移触发 OnRawMouseMove。

游戏帧通过 `Engine/Platforms/Web/Build/WebWorkerCanvas.js` 向 canvas / RHI owner 请求 RAF。`tests/ue-web-smoke/Source/UEWebEngine/Private/UEWebEngine.cpp:182` 的 EngineFrame 调用正常的 `GEngineLoop.Tick()`；引擎从实际执行时刻更新世界时间，并没有用录制视频的时间或 HUD 平均 FPS 计算动态模糊。

因此输入与游戏帧都经过承担 WebGPU 工作的 owner。Lumen 增加工作量时，输入批次的到达与执行时刻可能更不均匀；事件又没有携带采样时间。这是可疑的 Web 独有差异，需要后续用同一时间轴记录输入批次、GT Tick 和实际渲染视图来证明。

`FWebPlatformTime::Seconds()` 将 `emscripten_get_now()` 的毫秒乘以 0.001；本地 Emscripten 的 pthread 版本使用 `performance.timeOrigin + performance.now()` 同步线程时间原点。未发现“忘记毫秒转秒”或“不同 Worker 必然使用不同时间原点”的源码证据。

### 着色器和 TSR 差异

Web 为存储格式、NaN 检查和线程组同步增加了局部分支。`MotionBlurVelocityFlatten.ush` 使用完整工作组屏障，避免直接假定桌面 wave 内存可见性。主 C++ 公式未变，仍需将 Web 转换后的数值结果纳入怀疑范围。

源码允许 TSR 提前生成速度展开纹理，模糊再复用；可用 `r.MotionBlur.AllowExternalVelocityFlatten` 控制。但本轮实际匹配到的入口是：

```text
main_0000362c_8681433e = FMotionBlurVelocityFlattenCS
VelocityScale: $Globals offset 0, size 8
VelocityMax:   $Globals offset 8, size 4
View_ClipToPrevClip: View offset 2240, size 64
```

该入口与实际 Cook 转换文件 `build/web-project-triplex-project-desktop-cook/20261102-125359/ShaderConversion/534D683943EC23E55F5ABD92B1091217/input.json` 一致。因此本轮并不能把问题归咎于 TSR 复用速度展开的分支。

## 浏览器取证

脚本：`tests/web-platform/probe-web-motion-blur-inputs.cjs`。

它在自己的隐藏 Edge 进程中截获真实计算管线、绑定组、动态偏移、queue.writeBuffer 和 queue.submit，读取提交前的参数副本；未在 GPU 上插入等待，未修改引擎算法。优先使用实际运行 WGSL 的布局，布局读取器与已有 SPIR-V 反射的字段偏移交叉验证。所有字段必须处于实际 uniform binding 的有效大小内。

环境：1280x720、DPR 1、浏览器与 GPU 进程 CPU 掩码 `0xffff0000`。先推进 90 帧，再执行每 50 ms 一次、每次约 4 px 的真实鼠标转向，然后停止并继续采样。自动化鼠标事件也会受浏览器调度影响；本轮不是等速物理输入或性能基准。

可信记录：

- `tests/web-platform/results/motion-blur-inputs-20261104-r5.json`：193 / 85 个样本；Lumen 开启时 VelocityScale.X 为 13.88 至 3332.78，A 为 18.09 至 61.05。
- `tests/web-platform/results/motion-blur-inputs-20261104-r7.json`：增加绑定范围检查后的复验，具体摘要见随附证据文件。
- `tests/web-platform/results/motion-blur-inputs-20261104-paced.json`：保留 Lumen 与动态模糊，仅在自己的诊断进程中加入 10 FPS owner RAF 限制。
- `tests/web-platform/evidence/motion-blur-investigation-20261104.json`：摘要、来源和边界。

最终比较：

| 条件 | 样本 | VelocityScale.X 最小 / 中位 / 最大 | 派发间隔中位数 |
| --- | ---: | ---: | ---: |
| Lumen + 动态模糊，原调度，r7 | 194 | 18.30 / 159.82 / 3396.54 | 28.68 ms |
| Lumen 关闭、动态模糊保留，A 的 10 FPS 调度，r7 | 86 | 17.29 / 53.33 / 58.92 | 100.21 ms |
| Lumen + 动态模糊，单独加入 10 FPS 调度 | 86 | 16.89 / 53.33 / 63.31 | 100.65 ms |

三组的 AA 设置均为 4；最后一组 GI / 反射仍为 1 / 1，实际执行动态模糊速度展开。页面错误、GPU 错误与设备丢失均为零。采集仍包含约 300 ms 长间隔，不能据此宣称消除了长帧。

复核已通过：两个脚本的 Node 语法检查、当前独立速度展开着色器的 5 个关键字段与 SPIR-V 反射偏移及大小比较、366 个最终样本的统计和设置核对、源文件与原始报告 SHA256 校验，以及上述桌面源码一致性比较。

新增的单变量比较显著削弱了“Lumen 与动态模糊算法必然不兼容”的解释：两者仍同时运行，规整调度后数千级缩放尖峰没有重现。这支持时序相关方向，尚未由用户判断该组的视觉抖动，也没有证明是哪一段时序发生错配。

r5 中第 139、141、143 帧的相机重投影矩阵一致，VelocityScale.X 分别约 1986、795、3293；之间的第 140、142 帧矩阵接近恒等。使用这些矩阵对中心屏幕、固定 DeviceZ=0.5 的纯相机运动作示例估算，模糊半径代理值约为 23.69、9.49、32 px；中间帧接近 0。32 是此次实际上传的长度上限。这里的代理值不是速度纹理像素回读，也不是最终画面的模糊半径实测。

早期 r1 至 r4 的诊断脚本尝试未通过完整取证，保留失败记录。r6 的额外 View_RealTime 读取跨用了另一个着色器布局，其字段不在当前有效上传范围内，作废，不用于计时或根因结论。最终脚本已移除该读取并增加有效范围检查。不会将这些无效时间值解释为引擎时间异常。

## 解决方向与边界

当前可用的临时配置仍是保留 Lumen、`r.MotionBlurQuality=0`，即用户已验收的 B。它屏蔽了症状，尚未修复根因。

优先修复方向是让输入采样、相机前后帧变换与归一化时长对应同一段真实时间。下一次需要在 CPU 生成参数的位置记录：帧号、最终 MotionBlurAmount / TargetFPS、DeltaRealTime、ViewState 时间、当前 / 上一相机变换，并与页面输入批次的采样与消费时间对齐。只有确定是哪一段对应错误后，才修改调度、输入桥接或参数快照。

提高 Target FPS 或降低 Amount / Max 可以作为受控缓解测试；不能把平滑掉峰值、夹小时间缩放或长期关闭 Lumen 当作已定位的修复。TSR 速度展开复用、着色器精度和资源快照仍保留为次级假设。

本轮未修改安装引擎、参考引擎实现、项目默认渲染设置或用户当前的 B 预览窗口。

## 复验

预先设置含有 Playwright 的 `NODE_PATH`，使用既有 8765 本地服务器，并保留上述历史 Cook 反射目录：

```powershell
node tests/web-platform/probe-web-motion-blur-inputs.cjs --tag=20261104-recheck-inputs
node tests/web-platform/probe-web-motion-blur-inputs.cjs --tag=20261104-recheck-paced --lumen-paced-only
```

标签必须使用尚未存在的新名称，脚本拒绝覆盖既有测量。CPU 掩码用于本机此前的驱动编译器兼容环境，不应直接推广到其他机器。
