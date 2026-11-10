# 2026-11-10 别墅虚拟阴影移动性能

## 原因与修复

v6 在相同画质、相同相机起点下静止约 30 FPS，持续转向约 10 FPS，
往返移动约 9～11 FPS。移动期间没有新建管线，RHI CPU 时间约 10 ms/帧，
因此这次持续掉帧不是管线预热失效。

GPU 时间戳把主要开销定位到非 Nanite 虚拟阴影深度绘制。
原子纹理兼容层把尺寸、行步幅和层数放在同一原子缓冲的前四个字中；
转换后的像素着色器每个像素执行五次 `atomicLoad`，集中访问这些共享地址。
静止时阴影页缓存避免了大部分绘制，转向后大量页面重新绘制，暴露这一热点。

正式实现仅修改 Web 阴影像素路径：从现有 `VirtualShadowMap` 常量缓冲读取
`PhysicalPoolSize` 和 `StaticCachedArrayIndex`，按原镜像布局计算索引。
保留 256 字节头部、256 字节行对齐、坐标与层边界检查，以及深度 `InterlockedMax`。
没有修改页申请、缓存失效、裁剪、光源数量、阴影分辨率或采样数。
其他原子纹理路径不变，桌面非 Web 着色器分支不变。

- 引擎入口：`reference-engine/Engine/Shaders/Private/ShadowDepthPixelShader.usf`。
- 共享写入函数：`reference-engine/Engine/Shaders/Private/VirtualShadowMaps/WebVirtualShadowDepth.ush`。
- Cook 覆盖与新增文件纳入原有源码核验，今后普通 Cook 自动包含本次修复。
- 新包：`tests/web-platform/build/villa-lumen-vt-20261110-v7`。

## 验证方法

测试机器为 RTX 3070，Edge 正常 CPU 调度，单个测试页面。
CSS 视口 1280×800、DPR 1.5；实际输出 1920×1080，TSR 内部渲染 1400×788。
Wasm、配置、宿主和缓存 worker 与 v6 的 SHA-256 一致。
Cook 资源变化限于材质着色器及其归档，网格、纹理、地图和天空光捕获不变。

相机从 `(-175,-80,160)`、俯仰 -5°、偏航 50° 开始，游戏线程驱动：
15 秒转一圈；15 秒内沿 X/Y 方向往返四次。测试包含静止、首次/重复转向、
转向后静止、首次/重复移动六段，每段 15 秒。独立 GPU 诊断不参与普通 FPS 对比。
FPS 来自真实 RHI 提交帧间隔，不等同于显示器呈现时间。

最终相同脚本、相同设置的普通 Edge 对比：

| 阶段 | v6 FPS | v7 FPS | v6 P95 ms | v7 P95 ms |
| --- | ---: | ---: | ---: | ---: |
| 静止 | 30.79 | 30.67 | 33.83 | 33.76 |
| 首次转向 | 10.04 | 30.41 | 207.54 | 35.59 |
| 重复转向 | 10.22 | 30.50 | 203.21 | 35.01 |
| 首次往返移动 | 9.62 | 30.12 | 215.58 | 35.36 |
| 重复往返移动 | 10.42 | 30.27 | 205.58 | 35.21 |

新包全部六段零管线新建、零预热遗漏、零 GPU/页面错误。
首次移动最慢帧 73 ms，重复移动最慢帧 42 ms；不声称彻底消除所有帧波动。
对比输入为 `vsm-motion-baseline-verified-20261110` 和
`vsm-motion-optimized-verified-20261110`。回归门槛已用旧版对旧版确认失败，
新版对旧版通过；不会把没有优化的版本当作通过。

`verify-web-virtual-shadow-depth.cjs` 编译并执行正式共享函数，覆盖五组尺寸与层数，
行填充、原有较大深度、三个重叠片元和 X/Y/层越界输入；37,632 个 uint 全部一致。
故意破坏镜像头部以证明深度写入使用传入参数，越界输入使用更大深度以检出错误写入。
实际 Cook 输出中的 25 个阴影像素着色器均保留 `atomicMax`，不再包含 `atomicLoad`。

GPU 时间戳诊断记录中，旧版首次转向的阴影深度采样为 146.41、23.72、96.99 ms；
新版为 1.51、0.39、0.72 ms。相机由游戏帧驱动，具体采样角度会受帧率影响，
这些数值用于定位热点，不作逐像素同帧比较。正式 FPS 对比使用完整同路线窗口。
新版六段 GPU 诊断均通过，采样证据为
`results/vsm-motion-gpu-compact-release-20261110/result.json`。

同视角静止/转向返回截图排除 HUD 后，RGB 每通道平均绝对差分别约
0.73/255 和 0.71/255；平均差超过 16 的像素占比分别约 0.087% 和 0.076%。
人工检查未见阴影、窗帘或玻璃外观退化。这是新旧 Web 版本对比，不扩大桌面一致性验收范围。

早期 GPU 诊断曾在 CDP 导出全部通道记录时关闭页面，日志未报 GPU 校验错误。
诊断脚本已改为只导出帧间隔、API 汇总及选定 GPU 帧的完整通道；
修改后全部阶段完成，失败报告保留，不作为性能结论依据。

## 预热与发布

新的 Cook 必须使用与内容哈希匹配的新预热记录。
仅采集出生点会遗漏转向时的八条管线；因此增加可选的
`--scripted-motion-seconds=15`，在采集时运行真实转向及往返路线。
最终记录包含 317 个模块、325 条实际管线描述，通过普通发布入口自动复用，
没有回到推测式 PSO 预热。性能测试另行断言移动阶段零管线新建及零预热遗漏。

最终 `--plain` 正式页面验证在 Edge 下连续运行两轮，未注入性能观察器，
冷启动 16.576 秒，缓存启动 11.753 秒；两轮均实际键鼠移动/转向 10 秒并通过，
没有 GPU 或页面错误。证据为 `results/villa-startup-v7-release-plain/result.json`。
该出生点键鼠路线各出现一条预热未覆盖管线；上述六段固定路线仍全部零遗漏。
实际管线记录覆盖已采集路径，不承诺所有未来视角或材质排列零编译。

首次无预热 Edge 采集发生一次设备丢失，发布校验正确阻止交付。
成功记录由隔离 Chrome 在 CPU 亲和性 `4294901760` 下取得；
此限制仅用于采集，不进入发布页面或正式 Edge 性能测试。
该经历不代表无预热编译或所有设备的稳定性已通过。

引擎本地提交：`73f7aa6bea3`（优化 Web 虚拟阴影移动时的原子缓冲头部争用）。

Lumen GI/反射、VSM、VT 保持开启，TSR 和渲染尺寸保持一致。
统一发布默认值测试、VT/VSM 设置 12 项断言和 Lumen 设置 10 项均通过。
高 DPI 单次缩放、多页共享读取锁、分辨率及抗锯齿面板沿用已验证的相同文件。
本次没有重新修改 `H:/UE_5.8` 或原始 `H:/TriplexHouseVilla` 工程。

## 复现

```powershell
node tests/web-platform/verify-web-virtual-shadow-depth.cjs
node tests/web-platform/probe-villa-vsm-motion.cjs --folder=villa-lumen-vt-20261110-v6 --tag=baseline-new
node tests/web-platform/probe-villa-vsm-motion.cjs --folder=villa-lumen-vt-20261110-v7 --tag=optimized-new
node tests/web-platform/compare-villa-vsm-motion.cjs --baseline=tests/web-platform/results/vsm-motion-baseline-new/result.json --candidate=tests/web-platform/results/vsm-motion-optimized-new/result.json
```

需要现有 8765 本地服务和 Playwright。两版顺序运行，避免并行浏览器或编译任务干扰。
对比门槛要求移动吞吐至少翻倍、P95 帧间隔减半、静止退化不超过 10%，
且画质设置、计时脚本和被测包摘要一致。它是同机器受控回归检查，不是跨硬件 FPS 承诺。

结果位于 `tests/web-platform/results/villa-vsm-motion-comparison.json`，
GPU 回读位于 `web-virtual-shadow-depth.json`，发布核验位于
`villa-lumen-vt-20261110-v7-package.json`。
测试范围仍是该别墅的静态场景短路线；不包含动态物体专项、长时压力或移动设备验收。
该别墅实际 VT 资产数量为零，VT 开启不能替代独立 VT 场景验收。
