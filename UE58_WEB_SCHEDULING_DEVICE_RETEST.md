# 最新运行时的跨设备调度复测包

2026-11-06 状态更新：用户反馈原始版本画面堵塞、完整限流版本仍抖动，本地调度优化已否决，源码默认回退 owner。采用决定见 [本地调度已否决](UE58_WEB_LOCAL_SCHEDULING_REJECTED.md)。

后续更正：以下固定视角提交吞吐测试不能排除实际画面卡顿。持续键鼠运动下的画面堵塞已在另一设备复现，最新方案将尚未提交的 Game/Render 工作一并计入预算，见 [完整流水线预算修复](UE58_WEB_LOCAL_PIPELINE_BUDGET_20261105.md) 和 [v74 新包](UE58_WEB_SCHEDULING_PIPELINE_V74_RELEASE.md)。

2026-11-05。按用户反馈，Game 本地调度在另一台设备上开启后帧率暴跌，本轮同步两个仓库的最新源码，保留本机提交，重新编译运行时并准备同包开关入口。本机四轮固定视角对照没有复现掉帧；不能据此判断其他设备或 Lumen 场景的收益。

## 同步与构建

- 外围远端 `bba3099e1b272e421eb9ed08a46a477cfaf68e82`，合并提交 `5b3db64`。
- 引擎远端 `1b09219ce296439a5117ee0add11367710c87f47`，合并提交 `93f9ea35a`。
- 普通 Git HTTPS 连接重置或超时，改用 GitHub API 读取 Git 对象；每个对象重建后核验其原始 SHA-1，再更新远端跟踪引用并执行正常 Git 合并。两个远端提交都已验证为本地 HEAD 的祖先，原有未推送提交保留，没有推送。
- Web 多线程 mimalloc 完整 UBT 构建、链接及 WASM 结构验证通过，编译错误与失败进程均为零。日志为 `tests/web-platform/results/web-engine-full-thread-20261105-145808.log`。
- 复用 `villa-lumen-off-current-mimalloc-v59` 已审计的 Cook、内容和配置，逐字节保持一致。本机没有远端最新 Lumen 测试包的二进制资源，本轮没有重新 Cook，也没有将结果外推到 Lumen 开启场景。

## 使用

[打开开关对照页](http://127.0.0.1:8765/build/villa-scheduling-latest-v71/comparison.html)。页面前两个入口分别关闭和开启 Game 本地调度，均保留有效遮挡历史及 RHI priority 唤醒。下方提供远端最新的五种拆分组合，便于继续隔离遮挡历史、本地调度和 RHI 唤醒。

便携压缩包为 `tests/web-platform/build/villa-scheduling-latest-v71.zip`。完整解压后运行 `start.cmd`，需要 Python 3，浏览器打开 `http://127.0.0.1:8875/comparison.html`。`serve.py` 只监听本机，提供 WebGPU 所需的跨源隔离响应头和 WASM MIME。先后运行两个入口，每次关闭上一个页面，保持相同窗口、视角及路线。包内 `benchmark-summary.json` 保存本机测量值与边界。

## 本机四轮结果

同一 JS/WASM、Cook 和配置，顺序为 owner → local → local → owner。每轮独立可见 Edge 会话，至少运行 600 帧并等待流送完成后，再预热 15 秒，采样 20 秒。有效遮挡历史与 RHI priority 均开启，只改变 Game 时钟。没有 CPU profiler、逐 draw 包装、额外 GPU 时间戳或查询；保留既有 HUD 和低频统计。

| 指标 | 关闭本地调度，owner | 开启本地调度，local |
| --- | ---: | ---: |
| 合并平均 FPS | 81.27 | 104.29（+28.32%） |
| 合并 1% Low | 33.52 | 66.21（+97.53%） |
| 两轮 FPS | 81.58 / 80.97 | 103.76 / 104.82 |
| 两轮 1% Low | 35.19 / 32.95 | 65.60 / 66.96 |

实际渲染为 1484×835、输出 2289×1288，TSR=4，GI/反射方法均为 0。四轮相机、配置及分辨率一致，均消费真实遮挡结果，流送 pending 为零，未捕获运行错误、GPU validation 或 device lost。场景截图人工检查正常。FPS 与 Low 来自 RHI 提交间隔，不代表物理显示帧率或输入延迟。

输入转发、共享队列回绕及溢出、时钟选择、取消回调和本地时钟暂停恢复回归通过；两轮 local 浏览器运行也通过模拟 visibility 暂停恢复。模拟处理函数不等于真实后台窗口验收。便携服务的六类资源 HEAD、八个入口、隔离响应头与 WASM MIME 检查通过，对照页已实际渲染检查。

可携带证据为 [scheduling-device-retest-20261105.json](tests/web-platform/evidence/scheduling-device-retest-20261105.json)。原始测量、构建及打包证据留在忽略的 `results` 目录；压缩包及完整输出位于忽略的 `build` 目录。新增对照页打包脚本不修改已有运行时、配置和默认开关。

## 复现

```powershell
./tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4
node tests/web-platform/package-web-runtime-experiment.cjs --baseline=villa-lumen-off-current-mimalloc-v59 --output=villa-scheduling-repeat --evidence=tests/web-platform/results/post-mimalloc-v59-profile-20261104.json
node tests/web-platform/package-web-scheduling-preview.cjs --folder=villa-scheduling-repeat
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-occlusion-history.cjs --folder=villa-scheduling-repeat --tag=scheduling-repeat-abba --modes=history,history-local,history-local,history --seconds=20 --warmup=15 --expect-rhi-wake=priority --lifecycle
```

本轮只验证本机 Lumen 关闭场景中的两个主要时钟入口。五组拆分入口沿用现有参数选择，未逐组测量性能。另一台设备的回退原因、Lumen 开启场景、运动画质及实际输入到显示延迟仍未确定，未修改调度实现或全局默认值。
