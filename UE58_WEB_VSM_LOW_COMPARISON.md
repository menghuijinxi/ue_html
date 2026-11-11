# 2026-11-11 虚拟阴影开关与 1% Low 对比

## 结果

充分预热后的有效样本显示：VSM 开启时，转向和移动的 1% Low
分别比传统阴影低约 38% 和 33%；平均帧率低约 42%。
这是较大的持续运行代价，当前优化并未让两种阴影方法达到接近的性能。

| 阶段 | 关闭 VSM 平均 FPS | 开启 VSM 平均 FPS | 关闭 1% Low | 开启 1% Low | Low 降幅 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 静止 | 52.24 | 29.91 | 35.34 | 26.62 | 24.7% |
| 转向 | 51.38 | 29.91 | 40.95 | 25.32 | 38.2% |
| 往返移动 | 51.89 | 29.86 | 39.71 | 26.58 | 33.1% |

转向 P99 帧间隔从 22.12 ms 增至 38.59 ms，移动从 22.02 ms 增至 36.72 ms。
十二个有效阶段均零管线新建、零 GPU/页面错误、零超过 50 ms 的间隔；
最慢间隔为 41.80 ms。这些样本没有重现持续移动掉到个位数的旧问题，
但不能由此推断所有冷启动、复杂视角或长时间运行都没有卡顿。

逐轮数据同样支持该趋势：关闭时转向 Low 为 41.36/40.59，开启为 24.96/26.80；
关闭时移动 Low 为 40.33/39.37，开启为 26.69/26.55 FPS。
这不是显著性检验或跨硬件承诺。具体剩余成本的 GPU 通道归属尚未在本轮定位。

汇总及哈希：`tests/web-platform/evidence/shadow-methods-low-20261111.json`。
输入为 `results/villa-shadow-methods-20261111-fixed-abba/result.json` 已完成的前两轮，
以及 `results/villa-shadow-methods-20261111-fixed-ba-warm/result.json` 的完整两轮。

## 比较口径

比较同一别墅、相同 Cook 资源与运行时，仅在浏览器测试实例的内存配置中改变
`r.Shadow.Virtual.Enable`。关闭组保留传统阴影，`r.ShadowQuality=5`，
不是关闭全部阴影。两种阴影算法的外观不同，结果不代表同等画质下的性能差异。

测试机器为 RTX 3070，Edge 157.0.4341.42。CSS 视口 1280×800、DPR 1.5，
实际渲染 1400×788、输出 1920×1080，抗锯齿 TSR。Lumen GI、反射和 VT
设置均保持开启。该场景的实际 VT 纹理数量仍为零，不据此声称 VT 压力测试通过。

每次加载后先运行 15 秒转向和 15 秒往返移动，再等待 5 秒。
静止、转向、移动分别测量 30 秒，四轮顺序为关、开、开、关。
相机起点为 (-175,-80,160)、俯仰 -5°、偏航 50°，沿用游戏线程自动路线。
每秒读取状态，核验实际阴影路径、尺寸、抗锯齿和相机运动。
测量窗口内必须零管线新建；发布包模式还要求零预热遗漏。

帧率来自 RHI 提交间隔，不是显示器实际呈现时间。
1% Low 定义与网页 HUD 相同：取最慢 `ceil(N*0.01)` 个间隔的平均值，
然后用 1000 除以该值。这里每种模式每段合并两轮原始间隔，不平均各轮 Low，
也不把两轮之间的停顿拼成一个帧间隔。HUD 使用最近 5 秒窗口，数值会更易波动。

## 关闭路径修复

原 v7 在关闭 VSM 后触发原子纹理绑定断言。传统阴影和 VSM 共用的深度着色器
保留 `OutDepthBufferArray` 的原子访问绑定，但传统阴影提供的
`Dummy-OutDepthBuffer` 占位纹理没有 `TexCreate_AtomicCompatible`。

修复位于 `reference-engine/Engine/Source/Runtime/Renderer/Private/ShadowDepthRendering.cpp`：
仅在 `PLATFORM_WEB` 下给占位纹理补充该标记，保留尺寸、格式与原有绑定验证。
没有放宽 RHI 校验，也没有降低阴影质量。现有普通构建脚本已经自动同步该文件，
后续编译会包含修复。修改后增量编译、链接和 Wasm 结构验证通过，
传统阴影实际进入场景并完成路线。
引擎提交为 `556dd8fda26`。

本次使用 `villa-shadow-ab-20261111-diagnostic` 隔离诊断包，两组使用同一新运行时。
它沿用 v7 的内容和配置，通过统一发布收尾的显式 `capture-only` 模式生成，
`releaseReady=false`，没有将旧 Wasm 的预热记录套用到新运行时。
路线在计时前实际执行预热，本结果只讨论预热后的运行表现。
用户正在使用的正式 v7 目录没有被覆盖，正式启动速度不由本次诊断验收。

## 未计入的数据

- 最初尝试通过命令行覆盖开关，但启动器未透传该参数；实际路径核验拒绝了该轮。
- 原 v7 的关闭组触发上述占位纹理断言，未进入性能统计。
- 首个交叉会话完成关、开两轮后被中断，第三轮没有采样；仅保留已完成的前两轮。
- 首次反向会话出现异常慢帧，转向阶段新建 16 条管线，被零编译门槛拒绝。
  该会话静止 1% Low 为 2.23、转向为 3.45 FPS，说明无发布预热记录的诊断包
  不能保证只预热一次就进入稳定状态。慢帧的全部成因未定位，不将其归咎于 VSM 本身。
  失败原始记录保留为 `results/villa-shadow-methods-20261111-fixed-ba/result.json`。
- 后续重跑复用同一浏览器配置，两种模式仍需分别经过相同路线预热和完整校验。

## 复现

运行当前本地服务后：

```powershell
node tests/web-platform/benchmark-villa-shadow-methods.cjs --folder=villa-shadow-ab-20261111-diagnostic --capture-package --tag=shadow-abba-new --seconds=30 --warmup=15
node tests/web-platform/summarize-villa-shadow-methods.cjs --input=tests/web-platform/results/shadow-abba-new/result.json --output=tests/web-platform/results/shadow-abba-new-summary.json
```

发布包测试省略 `--capture-package`，继续强制发布预热已采纳。
未完成会话默认不允许汇总，只有显式 `--allow-interrupted` 才能排除
最后一个完全没有采样的运行；所有计入阶段仍逐项重新验证。
两份输入的脚本哈希、包哈希、资源哈希、浏览器版本、预热时间和采样长度必须相同。

## 收尾验证

- 普通线程目标增量编译、链接及 Wasm 结构校验通过；构建日志为
  `results/web-engine-full-thread-20261111-092739.log`。
- 四轮十二个阶段通过逐帧间隔、真实路径、相机运动、画质和零管线编译检查。
- 汇总器拒绝失败会话，以及没有显式声明的中断会话；正向合并通过。
- 虚拟资源设置 12 项与 Lumen 设置 10 项验证通过。
- 原 v7 的 13 个发布产品哈希全部保持不变；诊断包的内容、配置、
  宿主和缓存 worker 与 v7 一致。
- 没有修改安装引擎或原始别墅工程，没有发布新正式版本。
