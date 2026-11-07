# 已验收的网页默认配置

2026-11-07，用户明确反馈：“这版改善明显，可以用于默认值。之前的性能优化也都无异常情况，都用于默认值。”据此将 `villa-input-raw-free-20261107` 的完整已测组合提升为默认，发布 `villa-default-20261107`。

默认入口：`http://127.0.0.1:8765/villa.html`，进入不带实验 URL 参数的关卡。`villa-low-test.html` 和 `villa-parity-test.html` 已标注验收结果并链接默认版；P0 工具首页也新增入口。旧包和 30 FPS 对照保持可用。

## 生效范围

- 默认不限帧，`bEnableMouseSmoothing=False`、`r.MotionBlurQuality=0`；30 FPS 是对照选项。
- 使用页面 RAF、总在途预算 3 帧、未提交上限 2 帧、直接游戏线程鼠标输入、遮挡历史、RHI 优先级唤醒和启动 PSO 预缓存。
- 保留已测 CSM 缓存、计算 pass 复用、上传页、RDG pass 合并、批量提交、输出 encoder 复用、逐帧常量快照、阴影遮罩清理合并、转向查询合批、光网格容量分桶、查询回读池、绑定访问重验、动态常量绑定组复用和绑定计划。
- 实际已测包的 worker 还带有 `__webReuseReplayScratch=true` 前缀。本次逐字核对后，通过包内资产字段保留相同行为，没有漏掉这个隐含设置。
- WASM、Cook、着色器、原项目的其他配置与已验收包保持一致。没有加入之前测试失败且未包含在该包中的“合批保留时间”“新进入视野合批”等扩展。

精确设置由 `tests/web-platform/web-accepted-defaults.cjs` 统一保存，配置名为 `desktop-accepted-20261107`。这是桌面线程包的默认策略，保留引擎 CVar 的底层可选开关，不影响原生桌面工程。

## 后续构建与打包

`build-web-engine.ps1 -Threads` 的普通非 Trace、非 SIMD 构建默认选择 mimalloc 和 lowered memory64，即已验收的 32 位线性内存访问；`-LowerMemory64:$false` 仍可显式创建原 memory64 对照。

`package-web-project.cjs` 与 `package-web-default-template.cjs` 的普通桌面线程包自动应用已验收配置，并检查构建报告中 lowered memory64 已启用。`--legacy-defaults` 保留原配置打包路径，移动/非线程包及项目 Trace 包不自动应用。配置覆盖仅写入新包，原始 UE 项目与历史 Cook/Stage 文件不被修改。`package-web-runtime-experiment.cjs` 等明确用于同配置 A/B 的实验工具继续保留其输入基线，不偷偷改变实验变量。

页面 host 从包内 `gameFrameClock`、`pageFrameBudget`、`inputBridge` 读取默认值，显式 URL 参数仍可覆盖；旧包未声明新配置时仍采用原 fallback，避免重新解释历史实验。`web-performance-modes.cjs` 继续服务历史 render/motion 矩阵，不代表新生产包的默认值。

本轮交付复用用户已验收二进制，无需重编译或重新 Cook。默认包由以下命令生成：

```powershell
node tests/web-platform/package-villa-parity-candidate.cjs --baseline=villa-input-raw-free-20261107 --output=villa-default-20261107 --accepted-defaults --current-worker
```

## 验证

`verify-web-input-bridge.cjs` 和 `verify-web-frame-credits.cjs` 通过，包括包内默认选择、显式 owner/local 覆盖、帧预算、事件顺序、背压与暂停恢复。默认包全资源摘要及配置核对通过：所有有效 SystemSettings 与用户实际测试的包一致，其他项目配置不变；启动日志确认全部默认 CVar 应用。

真实 Edge 在 **没有任何 URL 参数** 的条件下完成启动、12 秒鼠标预热与 12 秒测量，确认实际 page 时钟、直接输入、转向查询合批、绑定重验、回读池、PSO 预缓存运行；隐藏处理器暂停/恢复、停手恢复、闭合轨迹朝向检查通过，页面/GPU 错误为零。闭合鼠标轨迹恢复原方向误差低于 0.0001 度。截图场景正常。

这一轮是默认配置验收，没有用单次 FPS 与前一轮不同路线时长的数字宣称性能提升，也没有重新测量物理显示器端的输入延迟。普通项目/模板的打包源码已接入共同配置，本轮实际浏览器验证对象是上述保留已验收运行时的默认包，不声称重新完成所有项目的 Cook/全量构建。

证据：`tests/web-platform/evidence/accepted-defaults-20261107.json`。重新核验：

```powershell
node tests/web-platform/verify-web-accepted-defaults.cjs
```

历史取证文件保持原始验收状态；本文件和新证据记录用户最新批准。两个 Git 仓库仅主仓库有本轮变更，参考引擎无改动；本地中文提交，不推送远程。
