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

## 交互对比页面

后续增加 `http://127.0.0.1:8765/villa-shadow-comparison.html`。
页面在同一视角切换 VSM 开启与传统阴影，切换时销毁旧 iframe 和 worker，
只运行一个场景。支持恢复相机、30 秒转向/移动路线、停止和导出当前观察记录。
页面中的实测表来自上面的历史基准，顶部为当前实例的近 5 秒 Low，二者分别标明。

本页有独立的 `villa-shadow-on-20261111`、`villa-shadow-off-20261111` 包，
使用已修复关闭路径的相同运行时和内容，仅阴影配置不同。
两组分别采集出生点、转向和移动的实际管线记录，再经过
`web-release-defaults.cjs` 收尾，均为 `releaseReady=true`。
这两组入口固定 1920×1080 物理输出、DPR=1，实际 TSR 渲染为 1400×788。
Lumen、VT 与缓存 worker 默认修复保留；原 v7 目录不变。

准备、采集、发布分别由 `package-villa-shadow-comparison.cjs --phase=prepare`、
`probe-villa-startup.cjs --capture --scripted-motion-seconds=15`、
`package-villa-shadow-comparison.cjs --phase=release --corpus=...` 执行，
两组均指定 `--mode=on` 或 `--mode=off`，新包目录不允许覆盖。

`verify-villa-shadow-comparison.cjs` 已验证开启→关闭→开启、相机保留、恢复、
转向、移动、停止、导出、单一引擎 worker，以及桌面/窄窗口的布局与非空画面像素。
最终记录为 `results/villa-shadow-page-final-20261111/result.json`，
页面和包摘要为 `evidence/villa-shadow-comparison-page-20261111.json`。
固定分辨率在 DPR 1、1.5、2 的九项组合和统一发布默认值回归均通过。
窄窗口检查是在桌面 Edge 缩小视口完成，不代表手机 GPU 已验收。
切换、恢复相机或调整窗口后的即时 Low 会包含过渡帧，本轮不作为新的稳定性能测量。

## 键鼠控制修复（2026-11-11）

旧页面加载后调用 `WebProjectViewTest`，把当前视图切到固定 `ACameraActor`，
而键鼠仍交给原有玩家。此前的页面测试只驱动脚本相机，遗漏了真实玩家操作。
新增输入回归首先复现：W 和鼠标拖动后，可见相机的位移及转角均为零，
记录为 `results/villa-shadow-input-before-20261111/result.json`。

页面现在默认使用项目原有玩家和相机。新增 `WebPlayerViewControl` 保存并恢复
玩家位置、角色旋转和控制旋转；不更换项目的输入绑定、碰撞、速度或相机组件。
切换阴影时传递玩家状态，恢复视角回到出生点。自动路线仅在点击运行时接管视图，
手动停止或自然结束都会回到运行前的玩家位置，并把键盘焦点交还场景。
现有诊断用固定相机接口保持原语义。

当前入口改用 `villa-shadow-on-20261111-input-v2` 和
`villa-shadow-off-20261111-input-v2`。新运行时编译及 Wasm 校验通过，
日志为 `results/web-engine-full-thread-20261111-103436.log`。
两组重新采集实际管线并通过统一正式发布收尾，均为 `releaseReady=true`；
Lumen、VT、TSR、物理输出和缓存共享读取锁维持原设置。

中间版本关闭组在首帧多次报告 `A valid external Instance reference no longer exists`。
相同内容与设置的旧运行时对照通过；新运行时显式保留 GPU 实例及适配器引用后通过。
正式宿主因此保留这些对象直至所属 worker 销毁，两组正式采集和最终页面回归
均无 GPU 错误。失败、旧版对照和生命周期诊断记录保留在
`results/villa-startup-shadow-input-off-*`、`results/villa-startup-shadow-old-off-*`，
未使用失败记录或诊断注入记录生成最终预热包。

最终验证为 `results/villa-shadow-input-final-20261111/result.json`：
首次进入、停止路线、切到关闭组、恢复视角、路线自然结束、切回开启组，
六处均使用真实键盘和鼠标事件验证可见相机移动及转向；
位移约 49～104 厘米，转角约 30 度。
同时通过玩家视角保留、单实例、导出、五个桌面/窄窗口布局及画面像素检查。
发布默认值回归、DPR 1/1.5/2 的九项尺寸组合及尺寸不匹配提示恢复检查通过。
本轮不重新定义上方历史性能基准；自由漫游到未采集视角仍可能创建新管线。

## 剩余成本的归属（2026-11-11 后续）

上文未定位的 GPU 成本已有归属：物理页池的原子镜像原先每帧做 4 次整池拷贝，
约占 GPU 帧时间的三分之一。RHI 同步优化已通过编译、GPU 回读及浏览器对照，
实测整池拷贝降为 2 次；带插桩诊断帧率约从 28～29 提升至 34～36 FPS。
这不是新的无插桩开关基准；首次采集仍有一次 GPU 设备丢失，重试及后续测试通过。
依据、完整验证记录和剩余边界见
[UE58_WEB_VSM_MIRROR_SYNC.md](UE58_WEB_VSM_MIRROR_SYNC.md)。
