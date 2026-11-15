# 别墅展示版性能回退修复（2026-11-15）

上一版按原项目设置打包时，跳过了 `applyAcceptedDefaults`。这个函数同时修改画质选项和 WebGPU 后端效率选项，导致此前已验收的提交合并、绑定缓存、上传页、间接绘制和 VSM 原子缓冲区复用也一起关闭。

修复将其中 15 个 Web 专用后端效率选项放回 CVar 构造默认值，使用 UE 原有的优先级机制，项目和用户配置可覆盖默认值。没有向项目配置中追加覆盖项。仍保留原包的帧调度路径；单独恢复旧版网页帧调度在本机对照中没有改善，不纳入交付。

## 定位证据

同一个 `villa-presentation-20261115` 包、1280×720、DPR=1、Edge、20 秒室内移动和转向，正常推进时间，保留全部长帧，不冻结画面或包装 GPU 方法：

| 对照 | 平均提交帧率 | 每帧 RHI 耗时 | 每帧渲染线程耗时 |
| --- | ---: | ---: | ---: |
| 原包 | 29.88 FPS | 22.01 ms | 16.12 ms |
| 只恢复后端效率选项 | 51.05 FPS | 12.55 ms | 9.95 ms |

这是诊断阶段的单次对照，含首次进入区域时的资源加载长帧。两次测试的工作线程 CPU 校准时长分别约 281–286 ms 与 231–247 ms，存在运行条件波动，因此不能把约 71% 的差值作为修复版的提升率。交付结论以正式包对照和反向复测为准。测试机是 RTX 4090、驱动 621.24，不是用户的 RTX 3070；帧率是视口提交间隔，不等于物理显示时间。

原生 `WebNaniteIdleStatusTest` 在移动前后均返回：未分配资源、资源数 0、初始化 0、更新 0、暂存字节 0、无代理、场景渲染未启用。因此这次定位到的损失来自非 Nanite 渲染路径的后端效率回退。历史 `villa-default-20261107` 的 GI、反射、虚拟阴影为 0，当前项目为 1，不能把两个历史包的帧率差全部归因于 Nanite。

诊断数据：

- `tests/web-platform/results/villa-project-runtime-ab-20261115/report.json`
- `tests/web-platform/results/villa-project-backend-ab2-20261115/report.json`

## 生成与验收

保留原项目、现有 Cook 和原包，使用新运行时生成独立展示包。正式输出仍经过 `web-release-defaults.cjs`，采集或复用与引擎、内容、配置、启动参数和分辨率匹配的实际管线记录，继续隐藏左上角调试面板。

```powershell
node tests/web-platform/package-web-project.cjs --project=villa-project-settings-20261114 --desktop --threads --distance-fields --output-folder=villa-project-performance-20261115
node tests/web-platform/package-villa-presentation.cjs --source=villa-project-performance-20261115 --output=villa-presentation-performance-20261115
```

正式展示版入口：http://127.0.0.1:8775/build/villa-presentation-performance-20261115/index.html

输出：`tests/web-platform/build/villa-presentation-performance-20261115`，13 个文件，3,689,260,339 字节。当前服务使用独立端口 8775，避免已有的 8765 服务冲突。需要重新启动时，可设置 `$env:PORT='8775'` 后执行 `node tests/web-platform/serve.cjs`。

正式包对照与反向复测均使用相同的项目配置和内容、1280×720、DPR=1、普通 Edge 运行时；没有启动配置覆盖、CPU/GPU 分析器或 GPU 方法包装，包含首次进入区域的全部长帧：

| 正式测试 | 旧包 | 新包 | 平均帧率提升 | RHI 耗时变化 |
| --- | ---: | ---: | ---: | ---: |
| 30 秒路线，先旧后新 | 49.36 FPS | 57.27 FPS | 16.03% | 14.13 → 11.57 ms |
| 20 秒路线，先新后旧 | 41.75 FPS | 47.25 FPS | 13.18% | 16.21 → 13.54 ms |

可确认的收益是本机两轮测试约 13%–16%，不能承诺 RTX 3070 达到相同帧率，也不能宣称已经消除全部卡顿。首次访问新区域仍有约 0.2 秒的加载长帧；30 秒路线的 1% low 从 14.20 提升至 15.91 FPS。

配置和发布验证：

- 原项目 1632 个审计输入未变，`DefaultEngine.ini`、`DefaultGame.ini`、`DefaultInput.ini` 与原文件逐字节相同，整个配置包及 Cook 内容与旧展示包一致。
- Lumen GI=1、反射=1、虚拟阴影=1、TSR=4、距离场=1、纹理池 1000 MiB 保持生效。
- 原生 RenderCore 8 个构建动作、Renderer 40 个构建动作通过，安装目录输入未修改；Web 运行时 9 个增量构建动作通过，完整核验 447 个对象文件。
- 新引擎的实际启动管线自动采集通过，展示包复用同一记录并经过统一发布校验；没有默认启用推测式 PSO 预缓存。
- 五次正式漫游及显式覆盖测试均无页面或 GPU 错误，移动前后的 Nanite 原生资源与更新计数均为 0。显式将后端选项设置为 0 后，原生读回确认默认优化被覆盖。
- 已目视检查正式展示包截图，左上角无调试面板。

复测命令：

```powershell
node tests/web-platform/probe-nanite-off-regression.cjs --origin=http://127.0.0.1:8775 --modes=legacy,candidate --baseline-folder=villa-presentation-20261115 --folder=villa-presentation-performance-20261115 --seconds=30 --tour --idle-status --tag=villa-performance-release-ab2-20261115
node tests/web-platform/probe-nanite-off-regression.cjs --origin=http://127.0.0.1:8775 --modes=candidate,legacy --baseline-folder=villa-presentation-20261115 --folder=villa-presentation-performance-20261115 --seconds=20 --tour --idle-status --tag=villa-performance-release-confirm-ba-20261115
node tests/web-platform/probe-nanite-off-regression.cjs --origin=http://127.0.0.1:8775 --modes=candidate --backend-defaults=disabled --folder=villa-presentation-performance-20261115 --seconds=16 --tour --tag=villa-performance-project-override-20261115
```

重跑需更换结果标签，以保留历史记录。一次因 8765 端口被其他服务接管而返回 404 的启动尝试没有测量窗口，已排除并保留失败报告：`results/villa-performance-release-ab-20261115/report.json`。

完整交付证据：`tests/web-platform/evidence/villa-performance-20261115.json`。
