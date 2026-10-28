# 外部项目 Web 打包进度

## 2026-10-28：别墅多线程候选及同源性能对照

已将复杂别墅打包为独立 `UEWebEngineThreads` 候选，地址为 `http://127.0.0.1:8765/build/triplex-house-villa-threads/index.html`；同源单线程对照为 `http://127.0.0.1:8765/build/triplex-house-villa-desktop/index.html`。原日常地址 `build/triplex-house-villa/` 本轮没有覆盖。

`package-web-project.cjs --desktop --threads` 复用桌面 Cook/Stage，检查独立线程构建的对象、定义、平台覆盖和产品哈希，打包 Engine Worker 与页面桥接文件。本次重新 Cook 原别墅 SM5 配置，保留 BC/BC6H、256 MiB mip 池、4096 CSM、原光源和材质参数；两个包的 `content.bin`、清单和配置逐项同哈希，内容包为 519,086,543 字节。线程包共 10 个文件、702,207,846 字节；同源单线程包共 8 个文件、701,451,062 字节。

首次复杂场景启动复现了 `SceneUpdateCommandQueue.h:178` 的重复场景命令断言。诊断发现 `BP_WaterFall_532` 的移除已执行，较早排队的添加才到达：没有独立 Render 线程时，CPU 线程提交的添加进入游戏线程队列，随后游戏线程立即移除，顺序发生反转。Web 的组件批量注册现在仅在没有独立 Render 线程时回到游戏线程顺序执行，保留其余 CPU 任务、本地 IO 并行及原有断言。`ActorComponent.cpp` 加入隔离构建覆盖和来源审计。Chrome/Edge 各三次独立冷启动及两个视角检查通过；临时诊断日志已移除，没有修改安装引擎。

性能探针为 `probe-web-project-threads.cjs`。每个浏览器依次执行单线程、多线程、多线程、单线程；每个视角预热 90 帧、采样 5 秒，使用正常游戏时间以保留遮挡历史。两视角分别为室内 `(-175,-80,160,-5,50)` 与反向近景 `(-175,-80,160,-5,230)`，后者画面是厨房近景，脚本历史标签为 `wall`。两版均使用 FXAA，实际内部尺寸和输出尺寸逐组一致。

别墅沿用原有 screen-percentage 自动模式：1920×1080 输出内部为 1400×788；3840×2160 输出内部为 1920×1080。以下是输出尺寸，并非原生 4K 渲染。本轮没有通过降低任一版画质取得性能差异。

| 视角及输出尺寸 | Chrome 单 / 多 FPS | Edge 单 / 多 FPS | 多线程变化 |
| --- | ---: | ---: | ---: |
| 复杂室内，1080p | 32.7 / 29.4 | 31.6 / 28.5 | -10.1% / -9.8% |
| 反向近景，1080p | 33.4 / 30.1 | 32.3 / 29.4 | -10.0% / -9.2% |
| 复杂室内，4K 输出 | 21.2 / 31.1 | 20.3 / 30.0 | +46.8% / +47.6% |
| 反向近景，4K 输出 | 34.1 / 30.7 | 33.1 / 30.0 | -10.0% / -9.2% |

复杂室内 4K 输出的帧间隔 p95：Chrome 51.8→40.6ms，Edge 54.4→42.1ms；其他三组反而变差，完整分布保留在报告。页面 10ms 定时器的 p95 间隔从约 64～102ms 降至约 11ms。GPU 通道合计仍约 5～10ms，没有与帧率同比降低。当前 Game 与 Render/RHI 仍在同一个 Engine Worker，不能把全部收益归因于 CPU 任务并行；也不能声称各视角都会提速。headless、API 采样及桌面其他负载会影响绝对帧率，这不是用户全屏显示 FPS 或 UE 独立 Game/Draw 计时。

线程版共享 WASM 堆为 577,437,696 字节，约 550.7 MiB；621 个 bulk 仍通过本地 IO 流送，读取缓存上限 16 MiB。热启动命中两项持久缓存、下载次数为零。截图检查了真实室内和反向近景，CPU 任务在线程 ID 不同的工作线程运行。

第一次性能运行受到用户同时使用电脑、显存耗尽的干扰，含严重低帧及 GPU 采样超时，保存在 `web-project-triplex-house-villa-threads-benchmark-vram-contended-results.json`，不用于收益计算。清空干扰后的运行完成 Chrome 四轮，但 Edge 最后一轮单线程基线在第 417 帧后发生一次 `memory access out of bounds`。该完整失败报告保存在 `web-project-triplex-house-villa-threads-benchmark-single-edge-oob-results.json`；表中 Chrome 数据来自其中四轮完整且无错误的 Chrome 记录，并另核对两版内部尺寸和 AA 一致。随后 Edge 独立重测四轮通过，见 `web-project-triplex-house-villa-threads-benchmark-edge-results.json`。这次单线程越界尚未定位，不能因复跑通过宣告已修复，也不与显存干扰或已修复的场景命令断言混为一谈。

故障前后证据另见 `web-project-triplex-house-villa-threads-scene-command-before-fix-results.json`、`web-project-triplex-house-villa-threads-order-diagnostic-1-results.json` 和 `web-project-triplex-house-villa-threads-order-fixed-{1,2,3}-results.json`。完整引擎构建与两个包的来源哈希均已核对；长期稳定性、独立 Render/RHI、原生 4K 别墅渲染及 UE 桌面画质对照仍未由本轮验收。

修复后的同一线程引擎也重新打包默认关卡，`web-engine-threads-results.json` 的 Chrome/Edge 回归通过：包含真实 CPU 线程、输入、缩放至实际 4K、断网本地读取/CRC/取消、热启动零下载，以及贴地近球向上看的画面对照。本地服务的两版别墅入口均为 HTTP 200，COOP/COEP 保持线程所需设置。

复用本次桌面 Cook/Stage 的构建与测试：

```powershell
./tests/web-platform/build-web-engine.ps1 -Threads -MaxParallelActions 4 -StandaloneCompiles
./tests/web-platform/build-web-engine.ps1 -MaxParallelActions 4 -SkipHostPreparation -StandaloneCompiles
node tests/web-platform/package-web-project.cjs --project=triplex-house-villa --desktop --threads
node tests/web-platform/package-web-project.cjs --project=triplex-house-villa --desktop
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-project-threads.cjs --smoke
node tests/web-platform/probe-web-project-threads.cjs --seconds=5
```

## 2026-10-27：别墅切换桌面 SM5 延迟渲染

应用户要求，用修改后的引擎重新 Cook、编译并打包 `/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla`。候选目录为 `tests/web-platform/build/triplex-house-villa-desktop`，通过浏览器检查后发布到原地址 `http://127.0.0.1:8765/build/triplex-house-villa/index.html`。原工程 `H:/TriplexHouseVilla` 和安装引擎不作源码或资产修改。以下 ES3.1 记录保留为历史结果。

项目 Cook、Stage、Package 现支持独立 `--desktop` 路径及报告，不覆盖移动 Cook。新配置使用 `SF_WEBGPU_SM5`、桌面延迟渲染、4096 CSM、原关卡光源和指定 HDRI SkyLight；保留 BC/BC6H 压缩、256 MiB mip 池和 OPFS 本地流送。沿用准备项目已有的 512 纹理组上限，不在本轮扩大纹理预算。667 张纹理中 607 张具有 mip 链，GPU 格式估算总量 210,559,592 字节，不等同整个场景显存。

首次启动依次暴露并修正三个桌面兼容缺口：IES 浮点纹理在 Cook 内按线性数据处理，移动云材质改写仍仅用于 ES3.1；恢复 SM5 反射通道需要的黑色 Cube/CubeArray 默认纹理；指定 HDRI 已导出的亮度与 SH 在桌面路径复用，避免再次同步读回 GPU，同时继续执行桌面 cubemap mip 和高光过滤。这是现有天空图像的预处理数据，不是新增场景 lightmap 烘焙。

原生反射探针还需要 `LockTextureCubeFace` 写入 CubeArray。RHI 现按 `ArrayIndex * 6 + FaceIndex` 定位，锁记录、状态检查和队列上传统一使用物理层。新增两组立方体、六面、三级 mip 的并行锁定及 GPU 回读隔离测试，覆盖录制和 bypass 模式，每模式核验 252 个新增像素值；桌面纹理和缓冲区回归通过。另重跑 181 项/模式的纹理、压缩、IES、反射及 mip 流送回归，更新与既有桌面能力不符的三个旧拒绝断言，全部通过。修复期间曾把锁模式校验误用于解锁描述，普通贴图启动当场失败，现仅在锁入口检查模式，回归使用引擎真实解锁包装。

巡游在第 62 帧发现 `VelocityClippedDepth.UAVDummy` 使用的 `PF_R32G32_UINT` 尚未映射；固定室内视角与仅缩放测试没有触达该通道。现补齐 `rg32uint` 的无符号采样类型、纹理格式和 SPIR-V storage image 格式，新增双通道大整数清除及 GPU 回读测试，不关闭透明材质或速度通道。桌面纹理回归每模式现核验 6492 个值，独立故障报告为 `web-project-triplex-house-villa-desktop-rg32ui-before-fix-results.json`。

完整正常 UBT 构建和 SM5 Cook 成功，最终包为 8 个文件、702,262,514 字节，其中内容包 519,087,085 字节。Chrome/Edge 在 1280x720 / DPR 1、1896x938 / DPR 1.5 四组室内测试均通过，实际报告 `shaderPlatform=47`、`featureLevel=3`，创建 GBufferA/B/C 并上传 BC 纹理；无 GPU、页面或内容加载错误。每组均保留 621 个本地 bulk 文件，MEMFS bulk 数据为零，块缓存不超过 16 MiB。单轮八秒室内采样约 31～33 FPS，只记录当前机器观测，不作跨版本性能结论。双浏览器各一分钟多视角巡游/缩放均通过，分别从第 61 帧推进至 1079/1649 帧。最终包的普通页面另在两浏览器 DPR 1/1.5/2 下验证六次启动、18 个窗口状态及真实 Pawn 移动，不使用 GPU API 钩子，全部通过。

引擎源码提交为 `18f4907e2`，未推送。发布脚本要求同一候选包通过四组室内检查、双浏览器 DPR 1/1.5/2 的 18 个普通页面启动/缩放状态，以及各一分钟巡游，校验报告和产品哈希后备份旧包、最后更新 HTML。

原别墅地址已更新为本次桌面包，旧版八个文件按原 HTML 哈希保存在 `build/triplex-house-villa-before-desktop-9da40a9bdc28`，发布证据为 `web-project-triplex-house-villa-desktop-publish-results.json`；默认关卡原发布目录的八个产品哈希未变。发布地址 HTTP 200，Chrome/Edge 均再次通过启动、室内绘制、GBuffer、BC 和本地流送检查，记录于 `web-project-triplex-house-villa-desktop-published-results.json`。新包沿用内容哈希缓存和本地读取方式，SM5 Cook 内容与旧 ES3.1 内容不同，需要首次缓存新版本。

本轮故障证据保留为 `web-project-triplex-house-villa-desktop-{ies,cube,sky-readback,cube-array,unlock}-before-fix-results.json`，纹理旧断言失败保留为 `triplex-desktop-streaming-outdated-expectations-results.json`。最终入口为 `web-project-triplex-house-villa-desktop-cook-results.json`、`web-engine-full-build-results.json`、`web-desktop-resources-results.json`、`web-texture-streaming-native-results.json` 和 `web-project-triplex-house-villa-desktop-candidate-results.json`。

**未完成边界：** 未接入 Lumen、完整实时多次反弹 GI、虚拟阴影和体积雾；这次没有完成别墅的 UE 桌面同视角画质验收，不能把默认关卡既有对照结果套用到别墅。长期稳定性、历史间歇性崩溃、地图旅行和 UMG 外观问题也不由本轮短测宣告解决。默认关卡原发布目录保持原样。

```powershell
& tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-SM5 -Scene Project `
  -Project H:/ue_html/tests/web-platform/build/projects/triplex-house-villa/TriplexHouseVilla.uproject `
  -Map /Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla `
  -Profile H:/ue_html/tests/web-platform/cook-profiles/TriplexHouseVillaDesktopEngine.ini `
  -ReportId triplex-house-villa -TextureCompression BC -CompressHDRCubemaps -StopOnShaderError
& tests/web-platform/build-web-engine.ps1 -MaxParallelActions 4
node tests/web-platform/stage-web-engine.cjs --project=triplex-house-villa --desktop
node tests/web-platform/package-web-project.cjs --project=triplex-house-villa --desktop
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-project.cjs --project=triplex-house-villa --desktop --warmup-frames=30 --seconds=8 --report=desktop-candidate --view=-175,-80,160,-5,50
node tests/web-platform/probe-web-default-startup.cjs --desktop --project=triplex-house-villa --candidate --runs=1 --report=triplex-house-villa-desktop-candidate
node tests/web-platform/probe-web-project-stability.cjs --project=triplex-house-villa --desktop --browser=Chrome --seconds=60 --resize --minimal --require-handles --report=desktop-stability
node tests/web-platform/probe-web-project-stability.cjs --project=triplex-house-villa --desktop --browser=Edge --seconds=60 --resize --minimal --require-handles --report=desktop-stability
node tests/web-platform/publish-web-project-desktop.cjs --project=triplex-house-villa
node tests/web-platform/probe-web-project.cjs --project=triplex-house-villa --desktop --published --smoke=1 --warmup-frames=30 --seconds=5 --report=desktop-published --view=-175,-80,160,-5,50
```

## 2026-10-23：修复 Slate 状态断言和顶点格式缺口

用户的 `ue-startup-diagnostics-2026-10-23T09-43-03-799Z.json` 在第 308 帧退出，日志明确记录 `SlateElementIndexBuffer before=0x8 after=0x70`。旧独立包启动后按 Esc 可稳定复现同一 `RHICreateTransition` 断言。原始报告保存在 `results/user-slate-transition-crash-20261023.json`；这次句柄诊断没有报失效，属于已定位的另一条故障路径，不能与前一节的第 991 帧绑定组问题混为一谈。

根因是 RHI 把 RDG 的逻辑收尾状态当成实际资源绑定能力校验。Slate 创建的纯索引缓冲区没有 ShaderResource 标志，但 RDG 会统一将缓冲区收尾到默认 `SRVMask`。现在只允许顶点/索引缓冲区在 transition 中进入、离开这个精确状态，真实 SRV 创建、着色器绑定和资源使用仍保留能力校验；不增加 Storage usage，不关闭断言。越过该点后，真实 Slate 管线又暴露缺少 `VET_UShort2` 映射，现补为 `Uint16x2`。

新增原生回归覆盖 Slate 顶点/索引缓冲区的收尾与恢复、无 SRV/UAV 能力的拒绝、16 位无符号顶点属性管线，以及恢复绘制后的 GPU 像素回读，共九项 Slate 检查；完整原生综合探针的 129 项通过。既有材质/viewport、纹理/mip 流送及七项遮挡回归另行重跑。原生测试先记录旧实现中仅 `slate-index-rdg-epilogue` 失败，再验证修复后全部通过。

浏览器测试先执行真实 Esc 输入，确认能越过旧断言并实际提交 Slate 绘制，再重新加载场景，通过显式测试入口 `WebProjectWidgetTest` 加载项目已有 `W_Sofa1`，持续绘制、移除、重建并缩放窗口。测试入口只有被调用时才创建控件，不修改项目资产或正常启动行为。Chrome/Edge 各执行一分钟，使用 2552x1308 / DPR 1.5；完整正常 UBT、两个独立包和默认光照/天空关卡另行验证。`verify-web-slate-menu.cjs` 同时核验故障前后证据、源码/产品哈希与这些回归报告，明确区分本次断言修复和既有未解决故障。

**尚未验收的边界：** Esc/Z 后切图另有 `InvalidURL`，引擎会回退重载当前关卡；这轮未修复地图旅行。`W_Sofa1` 已持续提交 Slate draw，但截图中控件仍未正确显示，不能把本轮结果当作 UMG 外观或交互验收。此前的绑定组句柄断言、序列转换异常和极端预算/缩放下的进程退出、超时仍未解决。原有巡游测试只移动相机，未触达界面路径；本轮把真实按键和项目控件绘制加入了独立回归。

更新后的日常地址仍为 `http://127.0.0.1:8765/build/triplex-house-villa/index.html`。内容资产哈希未变，本地内容缓存继续复用；新 WASM 按新哈希保存。

```powershell
& tests/web-platform/probe-web-slate-transitions.ps1
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-project-stability.cjs --browser=Edge --seconds=60 --width=2552 --height=1308 --dpr=1.5 --slate-menu --resize --minimal --require-handles --report=slate-menu-final
node tests/web-platform/probe-web-project-stability.cjs --browser=Chrome --seconds=60 --width=2552 --height=1308 --dpr=1.5 --slate-menu --resize --minimal --require-handles --debug-handles --report=slate-menu-final
node tests/web-platform/probe-web-default-scene.cjs --packaged
node tests/web-platform/verify-web-slate-menu.cjs
```

## 2026-10-23：保留绑定组崩溃证据，补充句柄诊断

用户的 `ue-startup-diagnostics-2026-10-23T08-23-05-328Z.json` 属于当前遮挡查询版本，在第 991 帧的 `SetDrawBindings -> wgpuRenderPassEncoderSetBindGroup -> WebGPU.getJsObject` 断言退出。缺少的是绑定组对应的 JS 对象；报告没有实际句柄地址、创建/释放顺序，也没有设备丢失或 GPU 校验错误，不能据此认定显存耗尽。用户文件原样保存在 `results/user-bindgroup-crash-20261023.json`。

**原始崩溃尚未定位、尚未修复。** 大窗口 2552x1308 / DPR 1.5 的原包巡游、缩放、不同房间视点、强制 JS 回收及多轮 mip 预算测试未复现同一断言；不能用复跑通过覆盖用户故障。旧的 Edge `createBindGroup` 序列转换异常也继续作为未解决记录保留。

本轮可审查改动是 Web 端诊断能力。引擎自己的 Emdawn port 覆盖在句柄缺失时报告具体地址、帧号、堆容量与调用栈；`?debug=1` 模式额外保留最近 256 次创建/释放事件，包含对象类型。环形存储有固定上限，普通模式不保留操作历史；大量句柄操作的完整跟踪会增加 CPU 成本，因此没有默认启用。导出的启动报告加入 `gpuHandles`、纹理流送、遮挡统计和浏览器完整构建版本。没有吞掉断言、返回空绑定组或禁用现有渲染功能。

引擎仓库提交为 `6306a5ce5`，未推送。安装引擎保持原样。

新增 wasm64 独立测试复用 RHI 的创建四组、释放布局、绑定后释放的顺序。Chrome/Edge 各执行原版/诊断版正常路径、故意提前释放、超过 32 位的无效地址，以及普通模式正常/失效路径，共 16 组。每次正常路径完成 2,048,000 次绑定组创建/绑定/释放；故障注入用于验证诊断能区分已释放和未创建地址，不代表复现或修好了用户崩溃。完整 Web 运行时构建、两个独立包和默认带光照/天空场景回归另行检查。

极端测试另有失败：每一两帧切换 32/256 MiB 预算、瞬移并缩放时，出现浏览器渲染进程退出；15 帧切换测试出现超时，调试复跑中也有持续低帧和等待 `clear-memory` 超时。当前未证明这些故障与第 991 帧句柄断言同源，均不计为修复通过。报告保留 `bindgroup-fast-churn-before`、`handle-diagnostics` 和 `handle-churn-debug`，汇总 `web-handle-diagnostics-results.json` 明确记录 `originalCrashFixed=false`。

日常地址保持 `http://127.0.0.1:8765/build/triplex-house-villa/index.html`。需要完整创建/释放历史时使用 `http://127.0.0.1:8765/build/triplex-house-villa/index.html?debug=1`，复现后导出的报告才包含对应环形记录。内容缓存仍按同源与内容哈希复用。

```powershell
& tests/web-platform/build-web-bindgroup-lifetime.ps1
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-bindgroup-lifetime.cjs
node tests/web-platform/probe-web-project-stability.cjs --browser=Edge --seconds=60 --width=2552 --height=1308 --dpr=1.5 --resize --require-handles --report=handle-diagnostics-final
node tests/web-platform/probe-web-project-stability.cjs --browser=Chrome --seconds=60 --width=2552 --height=1308 --dpr=1.5 --resize --require-handles --debug-handles --report=handle-diagnostics-final
node tests/web-platform/probe-web-default-scene.cjs --packaged
node tests/web-platform/verify-web-handle-diagnostics.cjs
```

## 2026-10-23：启用异步硬件遮挡剔除

用户反馈复杂室内方向很慢、面对墙面时很快。本轮复现发现 UE 原有视锥剔除正常，但 `SceneVisibility.cpp` 在 Web 下直接禁止遮挡查询，RHI 也没有实现查询创建、提交和结果读取。相同室内视点把画布缩为四分之一像素，帧率变化很小；CPU 分析中的绑定组创建和绘制提交占用明显，不能仅凭视角差异判断为纹理显存耗尽。

现复用 UE 的包围盒查询、分组与历史管理，通过 WebGPU occlusion query 实际测试深度可见性；每个查询 pass 批量 resolve / copy，再异步 map 回读。浏览器主线程不等待 GPU，未完成结果按可见处理。WebGPU 的非零结果只表示可见，不假设它是精确像素数，因此关闭精确样本数能力。保留现有视锥剔除，未启用 HZB、GPUScene 或间接绘制。

第一次非阻塞接入虽然能回读零结果，正常连续帧中大部分结果却尚未就绪，绘制反而增加。`visibility-metrics-results.json` 保留该失败边界：房间约 2221 次 indexed draw 增至 2497 次，查询待完成计数远高于可读计数。Web 现设置 `r.NumBufferedOcclusionQueries=2`，加上移动渲染本身的一帧，共缓冲三帧，允许浏览器完成异步回调；原生平台默认值不变。测试也发现冻结渲染时间会令 UE 每帧重置遮挡历史，因此性能验收保留正常游戏时间，不能用冻结时钟的画面对照冒充遮挡剔除验收。

最终独立包的同视点开关对照显示，房间 indexed draw 约从 2221 降至 1750，减少约 21%；反向近墙视角约从 1481 降至 765，减少约 48%。数字包括深度、阴影及查询自身绘制，不等于物体数量。房间中约 1100 次阴影绘制仍保留，大量可见物体的绑定组创建仍需后续优化。浏览器采样存在预热和运行负载差异，FPS 不能跨不同运行直接比较；当前脚本预热 600 帧，反转开关顺序重复采样，并把绘制次数、查询结果、CPU 回调和 GPU pass 时间分开保存。GPU 时间戳是近似测量，不包含所有复制和呈现开销。

最终关闭 CPU 分析器的六阶段对照如下。两组房间采样交换开关顺序，开启阶段的测量窗口内查询未就绪计数增量均为零。不同系统负载下早期试验得到过更高的绝对 FPS，以下仅引用最终源码和包的同轮结果，不把不同运行拼接成性能收益。

| 测试视点 | Chrome 关闭 / 开启 FPS | Edge 关闭 / 开启 FPS | 总绘制减少 |
| --- | ---: | ---: | ---: |
| 复杂房间 | 16.0 / 19.7 | 15.9 / 19.2 | 约 21% |
| 反向近墙 | 19.8 / 32.9 | 19.0 / 32.0 | 约 48% |
| 复杂房间，逆序重复 | 16.0 / 19.7 | 15.7 / 19.2 | 约 21% |

普通 UBT Web 完整构建及两个关卡的 Cook、Stage、独立打包通过。原生新增七项遮挡检查覆盖提交前不可读、被深度挡住、可见、重复读取以及查询复用后不返回旧结果；既有材质 / viewport 的 267 项和纹理 / mip 流送的 362 项检查通过。浏览器像素对照要求开关剔除后的 RMS 小于 3、明显变化像素少于 1%，并同时记录正常时间漂移。最终双浏览器长测、本地流送及默认关卡验收记录由 `verify-web-occlusion.cjs` 汇总。

最终汇总通过并核对 5140 个不同文件。Chrome / Edge 各三分钟多视点循环分别完成 3799 / 6068 帧增量，无页面异常、GPU 校验错误或设备丢失；期间少量尚未完成的查询继续按可见处理。两浏览器各完成冷下载、关闭浏览器后缓存复用、断网 64 MiB 驱逐、恢复 256 MiB 预算，重开后两个大文件均零下载，mip 恢复仍从本地磁盘读取。默认关卡双浏览器的光照 / 天空对照、窗口恢复及损坏包 / 配置拦截通过。长测与功能回归的帧数只用于存活检查，不用于跨浏览器 FPS 比较。

引擎仓库提交为 `35550774b`。这轮没有改灯光、材质、AO、反射和 BC 资源规格，也未声称已解决与编辑器的画质差异。三帧历史存在异步遮挡的一般延迟；快速转向、长期运行和 8 GB 总显存仍需要按实际负载持续验证，三分钟无错误不等于无限期稳定。

```powershell
& tests/web-platform/probe-web-occlusion.ps1
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/profile-web-visibility.cjs --report=visibility-final-chrome --browser=Chrome --occlusion --no-cpu-profile
node tests/web-platform/profile-web-visibility.cjs --report=visibility-final-edge --browser=Edge --occlusion --no-cpu-profile
node tests/web-platform/probe-web-project-stability.cjs --browser=Chrome --seconds=180 --report=occlusion-stability
node tests/web-platform/probe-web-project-stability.cjs --browser=Edge --seconds=180 --report=occlusion-stability
node tests/web-platform/probe-web-project-local-io.cjs --browser=Chrome
node tests/web-platform/probe-web-project-local-io.cjs --browser=Edge
node tests/web-platform/probe-web-default-scene.cjs --packaged
node tests/web-platform/verify-web-occlusion.cjs
```

## 2026-10-23：接入本地磁盘 mip 读取和持久缓存

按用户收窄后的范围实现本地 IO：首次完整下载 `content.bin` 到浏览器 OPFS，之后 mip 从本地文件读取，不为每张贴图发网络请求，也没有引入 HTTP Range 服务。内容和 WASM 各自按 SHA256 标识版本，下载时逐块校验，完整写入后才提交完成标记；文件不变时重开浏览器直接复用，内容变化才取新版本。当前缓存用于同源地址，切换域名、端口、清理站点数据或浏览器回收存储后需要重新下载。

此前 `serve.cjs` 对全部文件返回 `Cache-Control: no-store`，确实使普通浏览器缓存无法复用。现在无版本 URL 使用 ETag / 条件请求，未变返回 304；带内容哈希的 URL 使用 immutable 缓存，过期版本返回 409，避免把新字节误存到旧版本。大体积内容包和 WASM 另外存入 OPFS，复用不依赖浏览器是否保留大文件 HTTP 缓存。

621 个 `.ubulk` 只在 MEMFS 保留文件元数据，正文留在本地磁盘；worker 使用 256 KiB 块、16 MiB LRU、最多四个并发操作。读取产生的临时结果及 UE 目标内存另外占用内存，16 MiB 不是应用总内存上限。启动所需的 `.uasset` / `.uexp`、配置、最低 mip、几何和引擎分配仍保留；没有声称已实现全部资源的 CPU 内存流送。

Web 平台的异步文件句柄把读取和取消接到现有 UE `IAsyncReadRequest`，通过事件循环通知单线程 `FIoDispatcher`，不在主线程自旋等待磁盘。取消后丢弃晚到的结果，避免写入已经释放的 WASM 目标。真实关卡首次验证发现 UE 路径带有 `/../../../`，现复用 MEMFS 自身的路径解析后匹配本地文件。安装引擎保持原样。

Chrome、Edge 均完成首次下载、关闭浏览器后复用同一配置重开、断网降预算到 64 MiB、清空读盘缓存后恢复 256 MiB。首次只下载两个大文件，重开两个大文件均零网络请求、零下载字节；恢复 mip 时磁盘读取增加 523 次，下载字节不变，所有 `.ubulk` 的 MEMFS 正文合计为零。独立测试另验证跨块读取、缓存淘汰、取消后不写目标、文件变更后下载一次及本地坏块拒绝。默认关卡旧负例只接受旧的哈希报错文案，新路径提前以 409 拒绝，已保留该失败记录并更新断言。

实际 `.ubulk` 为 142,905,344 字节，约 136.29 MiB；剩余启动文件为 256,296,333 字节。两个独立包各八个文件。普通 UBT Web 完整构建、默认关卡双浏览器及损坏版本 / 配置拦截、别墅反射 / 阴影开关与恢复通过；画面回归汇总核对 9,764 个条目、9,609 个不同文件。未改变灯光、材质和压缩规格，也未解决与编辑器的画质差异。引擎仓库提交为 `efea15213`。

稳定性仍有未解决项：Chrome 三分钟多视点完成 4,855 帧增量，无页面 / GPU 错误。Edge 首次长测第 1,560 帧抛出 `createBindGroup` 的 `entries` 无法转为序列异常；相同源码和包复跑三分钟通过，但原因尚未定位，不能以复跑通过声称已修复。失败保留在 `web-project-triplex-house-villa-local-io-stability-edge-sequence-failure-results.json`，本地 IO 汇总也引用该记录，验收仅覆盖已验证的流送及缓存行为。

```powershell
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/verify-web-http-cache.cjs
node tests/web-platform/probe-web-local-io.cjs --browser=Chrome
node tests/web-platform/probe-web-local-io.cjs --browser=Edge
node tests/web-platform/probe-web-project-local-io.cjs --browser=Chrome
node tests/web-platform/probe-web-project-local-io.cjs --browser=Edge
node tests/web-platform/probe-web-project-stability.cjs --browser=Chrome --seconds=180 --report=local-io-stability
node tests/web-platform/probe-web-project-stability.cjs --browser=Edge --seconds=180 --report=local-io-stability-repeat
node tests/web-platform/verify-web-project-local-io.cjs
```

## 2026-10-23：接通压缩纹理 mip 流送

本轮按用户要求优先补齐纹理流送。Web Cook 平台和 RHI 现在都声明支持 UE 纹理流送，默认池预算为 256 MiB、临时预算为 32 MiB；继续使用原 BC / BC6H 资源和 mip 链。清单仍为 667 张纹理、607 张多 mip、60 张单 mip，估算全量压缩数据为 210,559,592 字节，没有通过进一步缩图替代流送。运行时 613 张 UTexture2D 纳入流送管理，其最大 mip 合计 6,121 级。

RHI 接入 RHICore 纹理分配 / 释放统计和内存查询，让 UE 根据实际存活资源估算预算。多个 mip / face 可同时锁定，解锁时分别上传对应子资源；访问和状态转换仍检查 CPU 锁。UE 5.8 已有的 `AsyncReallocateTexture2D` 路径负责重新分配并复制公共 mip，新 mip 从 Cook 的 `.ubulk` 上传，不另造一套距离判断器。未启用当前后端不支持的异步纹理创建。

初次接通后出现 309 张纹理更新长期 pending、驻留数据一直约 2.15 MiB 的问题。根因是 `FIoDispatcher` 构造时直接查询 `FGenericPlatformProcess::SupportsMultithreading()`，绕过 Web 的单线程覆盖，把请求交给不存在的工作线程。现在仅在 `PLATFORM_WEB` 下查询实际 `FPlatformProcess`，使用已有的同步 IO 分发；其他平台保留原逻辑。构建报告同时审计参考源码和构建覆盖中的 `IoDispatcher.cpp`，临时排查日志已移除。未修改 `H:/UE_5.8` 安装目录。

新增原生 `-WebTextureStreamingProbe`，实际执行 RGBA8 / BC1 的七级 mip 初始化、缩小 / 放大分配、公共 mip 复制、同时锁定两个 mip、尾部 1x1 采样及取消分配后的内存回收。记录 / 直通两种模式共 362 项纹理检查通过，既有 global / static-material / direct-material / viewport 的 267 项检查也通过。普通 UBT Web 构建、两个关卡的 Cook / 独立打包均完成。

浏览器探针核对真实驻留状态、pending 数、GPU 上传 / 复制和包哈希。Chrome 八轮、Edge 两轮 256 / 64 MiB 预算切换均通过：餐桌视点可流送驻留数据从 81,870,928 字节降至 2,256,976 字节，恢复预算后为 62,546,000 字节；每次恢复均有公共 mip 复制和新数据上传，pending 清零，重复分配没有累计增长。恢复后不必立即回到首次缓存量，UE 同时考虑可见需求、预算和缓存。

Chrome 八轮测试还隔离采集了新增 GPU 进程的 WDDM 专用显存。第三至第八轮恢复时从约 1,831.58 MiB 到 1,839.60 MiB；最后多个视点约 2,061.42 MiB。驱动会缓存分配，不能把纹理估算字节当作实际进程显存，或声称切换低预算后物理显存立即同步释放。

默认关卡的双浏览器灯光 / 窗口恢复 / 损坏包拦截回归，以及别墅的反射 / 阴影开关与恢复回归通过。`verify-web-project-surfaces.cjs` 复核 9,746 个条目、9,596 个不同文件；压缩规格、反射捕获、当前构建 / Cook / 包和截图哈希一致。这些对照用于防止流送破坏已有渲染链路，不代表室内画质已与编辑器一致。

开启流送后，高 DPI 1854x909、DPR 1.5 的实际画布仍为 2424x1364。Chrome / Edge 各三分钟真实时间多视点运行分别到 4,853 / 4,979 帧，均无页面异常、GPU 校验错误、设备丢失或曝光断言；先前出错的移动 CSM 绑定也确实被执行。最终 `verify-web-project-streaming.cjs` 汇总通过，核对 4,678 个不同文件、621 个 `.ubulk`、当前包哈希、原生检查、八轮显存趋势、双浏览器流送和长测。历史 IO 挂起记录仅作为失败证据，不冒充当前源码产物。独立引擎仓库提交为 `c2eccd1e9`（接通 Web 纹理池并修复单线程 mip 读取挂起）。

预算边界：256 MiB 纹理池包含固定的非流送采样纹理；本场景约 151 MiB 的固定部分及最小 mip 尾不能靠流送卸载，所以 64 MiB 只作为驱逐压力测试，不能声称满足该总预算。渲染目标、几何、着色器和驱动缓存另外占用显存。当前实现从预加载的 MEMFS 内容包读取 mip，尚未实现 HTTP Range 下载，也未限制 CPU 内容包内存。室内 PBR、编辑器画质一致性和手机仍独立待验收。

```powershell
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
& tests/web-platform/probe-web-texture-streaming.ps1
node tests/web-platform/probe-web-project-streaming.cjs --browser=Chrome --report=streaming-final --memory --cycles=8
node tests/web-platform/probe-web-project-streaming.cjs --browser=Edge --report=streaming-final
node tests/web-platform/probe-web-project-stability.cjs --browser=Chrome --seconds=180 --report=streaming-stability
node tests/web-platform/probe-web-project-stability.cjs --browser=Edge --seconds=180 --report=streaming-stability
node tests/web-platform/probe-web-default-scene.cjs --packaged
node tests/web-platform/probe-web-project.cjs --project=triplex-house-villa --smoke=1 --warmup-frames=120 --seconds=6 --surfaces=1 --report=streaming-surfaces --view=-175,-80,160,-5,50
node tests/web-platform/verify-web-project-surfaces.cjs --report=streaming-surfaces --texture-probe=streaming-native-texture --texture-inventory=triplex-textures-streaming --output=triplex-house-villa-streaming-surfaces-audit-results
node tests/web-platform/verify-web-project-streaming.cjs
```

## 2026-10-23：修复转向后阴影绑定引发的运行崩溃

用户提供的 `ue-startup-diagnostics-2026-10-23T03-36-51-061Z.json` 记录了第 926 帧的 `FViewInfo::UpdatePreExposure()` 崩溃。在曝光断言之前，WebGPU 已反复拒绝 `MobileCSMAndSpotLightShadowmap`：真实深度纹理支持 `UnfilterableFloat|Depth`，管线布局却要求可过滤的 `Float`。原地出生点 45 秒未复现；新增高 DPI 多视点探针后，在出生点把 yaw 从约 90 度转至 180 度即可稳定复现，第 24 帧出现相同绑定错误，第 27 帧触发 `FinalPreExposure > 0.0f` 和 `unreachable`。这是可见性变化触发的移动 CSM 材质变体，之前固定餐桌视点的短测没有覆盖。

反射中的实际名称为 `MobileDirectionalLight_DirectionalLightShadowTexture` 和 `MobileDirectionalLight_DirectionalLightShadowSampler`，原有深度名称分类只覆盖 `SceneDepth`、`ShadowDepth`、`DepthTexture` 等形式，漏掉了这两个条目。现在把移动方向光阴影纹理声明为 `unfilterable-float`，其手动 PCF 采样器声明为 `non-filtering`。只修正 RHI 布局分类，没有改曝光计算、灯光参数、纹理规格或绑定缓存。无效命令提交消失后，原曝光断言也不再发生；没有通过关闭阴影或吞掉断言规避崩溃。

新增 `probe-web-project-stability.cjs`，使用用户的 1854x909、DPR 1.5 视口，保留正常游戏时间，循环切换出生点朝向、餐桌正反视角和楼上视点。探针记录第一条 GPU 错误、设备丢失、引擎断言、帧数、堆容量和实际绑定布局，并要求确实执行先前出错的 binding 6 / sampler 10。修改前的两个失败记录保留在 `results`，其中完整布局复现记录同时包含阴影校验错误和曝光崩溃。

修改后 Edge 运行约 189 秒至 5,194 帧，Chrome 约 190 秒至 5,320 帧，均无 GPU 校验错误、设备丢失、页面异常或曝光断言。实际画布为 2424x1364；两者采样到的 WASM 堆容量均保持 577,437,696 字节，这只是堆容量，不是 GPU 驻留显存。原生 global / static-material / direct-material / viewport 的 267 项检查及 BC / IES / 反射纹理的 238 项检查通过。

普通 UBT Web 构建、原生 RHI 模块构建和两个独立目录的重新打包通过。`verify-web-project-stability.cjs` 汇总用户诊断、历史失败复现、当前源码 / 构建 / Cook / 包哈希、原生检查、双浏览器多视点记录及画面 / 默认关卡回归。历史失败的源码和包引用仅作为历史证据，不冒充当前产物。

本轮解决的是这份诊断对应的阴影绑定崩溃。三分钟测试不能证明无限期稳定，纹理流送仍未实现，长期 GPU 显存预算及室内 PBR 与编辑器的一致性仍未验收。`reference-engine` 无新增修改，安装引擎源码保持原样。

```powershell
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-project-stability.cjs --browser=Edge --seconds=180 --report=crash-shadow-fixed
node tests/web-platform/probe-web-project-stability.cjs --browser=Chrome --seconds=180 --report=crash-shadow-fixed
node tests/web-platform/verify-web-project-stability.cjs
```

## 2026-10-23：纠正排查重点并修复每帧绑定与常量分配开销

用户指出上一轮几乎没有画质提升，AO 不是主要矛盾，并怀疑低帧率源于缺少流送及显存压力。这个反馈成立：不能用通道开关产生像素差异替代室内画质验收。本轮优先测 CPU、实际 GPU 进程显存及分辨率 / 灯光对照，没有继续扩展 AO。

代码确认 `GRHISupportsTextureStreaming = false`，纹理流送仍未实现。旧版运行时 NVIDIA 整卡占用约 7.8 GB / 8 GB；WDDM 中本次隔离 Chrome GPU 进程专用显存为 6,674,530,304 字节，约 6.22 GiB。旧版每帧创建约 8,610 个 buffer、3,413 个绑定组；每帧 buffer 描述大小只有约 7.44 MiB，实际分配和驱动开销远大于描述字节。先前约 696 MB 的累计纹理描述估算不能代表实际显存，更不能据此排除显存压力。这里只确认压力，未采集换页事件，不能断言换页就是低帧率主因。

同一视点 720p 旧版约 4.34 FPS，降至 360p 仍仅约 4.81 FPS。CPU 火焰图显示 `ResolveBinding` 每次绘制反复遍历 JSON 参数和资源表，大量时间消耗在字符串查找及内存分配；完整回调约 245 ms。绑定阶段还为每个 draw 的每个 uniform 重新创建 buffer。两处均是后端实装问题，不能归因于场景复杂或直接通过降低纹理规格规避。

现在着色器加载时解析固定绑定字段，首个成功绑定后缓存经过校验的槽位路径；每次绘制仍读取当前资源和静态 uniform，保留布局、类型和访问状态检查。只缓存实际不可变的反射条目，测试传入的可变 JSON 不缓存。uniform 按当前常量内容及反射大小复用 GPU buffer；常量变化时生成新快照，让已编码的旧 draw 保留原值。资源表或纹理引用改变仍即时生效。`$Globals` 同样只在数据变化时失效。没有修改灯光、曝光、贴图、Cook 配置或着色器材质计算。

同一诊断脚本复测为 30.39 FPS、回调约 31.99 ms，每帧约 131 个 buffer、约 0.14 MiB 上传描述；测试 Chrome GPU 进程专用显存降至 2,041,159,680 字节，约 1.90 GiB。多阶段重复视点、关灯及恢复期间继续记录进程显存。新版测试开始时其他应用已占用更多显存，因此不能直接拿两次整卡数字相减；必须比较隔离浏览器的 GPU 进程。常规双浏览器 1280x720 固定视点短测为 Chrome 32.38 / Edge 31.41 FPS。新旧固定时间截图 RMS 约 1.11，视觉保持一致，属于性能修复。

原生 global / static-material / direct-material / viewport 共 267 项检查通过，其中新增重复实际 draw 不再上传相同 uniform 的检查；同一 uniform 在两次 draw 间更新、纹理引用切换、空 uniform 及资源生命周期检查仍通过。BC / IES / 六面 HDR 及 mip 纹理检查 238 项通过。新版双浏览器 AO / 反射 / 阴影关闭与恢复、默认关卡及损坏包拦截回归通过。`verify-web-project-submission.cjs` 关联当前源码、构建、包、原生读回和浏览器截图，另外审核历史 CPU 基线、每帧分配、进程显存下降及画面未改变；旧版历史包哈希按历史证据保留，不冒充当前包。

画质仍未修复：关闭天空光后，皮革、木材和金属的局部高光、法线及反射差异更明显，说明 PBR 计算并非全部失效；当前强天空漫反射没有室内遮挡，掩盖了这些差异。这个观察不能证明所有材质通道均正确。后续画质工作应围绕实际材质输入、环境漫反射及房间尺度天空可见性，而不是继续增加 AO 或整体调整曝光。流送、长期显存预算、完整分辨率资源和手机仍未验收。

```powershell
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/profile-web-project.cjs --report=submission-cached
node tests/web-platform/probe-web-project.cjs --project=triplex-house-villa --smoke=1 --warmup-frames=10 --seconds=6 --surfaces=1 --report=submission-final --view=-175,-80,160,-5,50
node tests/web-platform/verify-web-project-submission.cjs
```

## 2026-10-23：室内 PBR 链路排查与修复

用户指出新版室内虽能看清，却像自发光，质感远差于编辑器。默认示例关卡主要展示开阔空间里的方向光和天空光，不足以覆盖封闭室内所需的天空遮挡、间接光、局部反射和密集灯光阴影。别墅原项目启用了 Lumen GI / 反射及虚拟阴影，Web 目前采用 ES3.1 前向路径；原始天空光的球谐照明没有房间尺度的可见性信息，直接照亮室内表面，是仍然偏平的重要原因。不能把加载了 Lit 材质或截图非黑当作编辑器画质一致。

本轮恢复关卡已有的 31 个烘焙反射捕获（13 个盒形、18 个球形）。Web 移动 Cook 现在请求 `EncodedHDR`；此前平台默认只请求 `FullHDR`，与移动运行时保留的格式不一致。RHI 增加线性 `rg11b10ufloat` 二维 / 立方体纹理上传和采样，保留六面与完整 mip，不要求可选的压缩 HDR 渲染目标能力。场景颜色仍按实际 RenderTarget 能力选择 RGBA16F。另修复初次加载时反射代理早于纹理分配创建的问题：上传后刷新组件渲染状态，避免资源存在但初始代理仍绑定旧资源。

项目启用一层半分辨率 SSAO 及移动聚光灯阴影。移动 AO 通道实际要求 `r.AmbientOcclusionLevels > 0`，所以仅设置功能开关、保留默认 `-1` 不会执行该通道。深度金字塔选择 UE 现有逐级栅格路径，避开当前 Web RHI 不支持的 R16F storage image 和 subgroup 计算分支。补齐六种 UE Vulkan 标准全局采样器，正确声明深度金字塔源纹理的非过滤绑定。Web 前向材质直接采样生成的 AO 纹理；原前向代码读取阴影遮罩 alpha，与此路径生成的独立 AO 纹理没有连通。这些更改均限制在 Web 或项目配置内，没有改动原场景的灯光强度和曝光。

新增 `-WebTextureReflectionProbe`，在原生记录 / 直通两种模式验证 RG11B10 六面四级 mip、非法 RT / sRGB 创建拒绝和六种全局采样器绑定。与既有 BC / IES / TextureSRV 检查合计 238 项。浏览器 `--surfaces=1` 冻结材质时间，保持曝光使用真实帧间隔；固定视点充分预热后分别关闭 AO、反射和阴影，每步恢复并比较逐像素 RMS，要求效果变化超过恢复误差。开关实际值、原始值、截图哈希和 GPU 错误均记录到报告中。

新增原生 `-RenderOutput=... -RenderView=x,y,z,pitch,yaw` 参考截图。这里使用编辑器世界的 SceneCapture2D，匹配相机几何但没有运行原地图 BeginPlay，也不是编辑器主视口；材质动态参数和曝光 / GI 仍可能不同，不能作为逐像素一致性证明。清单确认 31 个捕获均有 128 分辨率、524,280 字节编码 HDR 数据。原生图与初始网页图保留用于核查差异。

本轮验收入口为 `verify-web-project-surfaces.cjs`，关联当前源码、普通 UBT 构建、原生模块、Cook、包、压缩 mip 清单、双浏览器开关截图及默认关卡回归。`nativeVisualParityVerified`、`performanceAccepted` 和 `vramBudgetVerified` 始终独立记录；SSAO 不是房间尺度 GI，烘焙反射捕获也不等于 Lumen 动态反射。原有 `M_GlassBlur` 的移动 SceneColor 兼容问题仍需处理。

独立引擎仓库对应提交为 `cbe50407f`（修复 Web 室内 AO 采样与反射捕获初始绑定）。普通 UBT Web 构建、原生 RenderCore / Renderer 模块构建及两个关卡的 Cook / 打包均通过，安装引擎的审计输入未修改。新增测试保留了修改前的失败证据：AO 开关原先没有有效差异，反射恢复也存在约 4.69 的固定偏差；修复后关闭 AO / 反射的 RMS 约为 6.6 / 11.6，恢复误差约 1.1。关闭阴影的 RMS 约 61.7，明显超过恢复误差。两浏览器均上传 31 个 RG11B10 捕获，无 GPU 校验错误或设备丢失。

逐图核查后，反射和接触遮蔽有所改善，但整间房仍过于均匀明亮，与原生参考差距明显。这一轮只完成基础链路修复，不能宣称用户指出的室内整体偏平已经解决；后续重点应是房间尺度的天空可见性及间接光，而不是继续整体调曝光。默认室外示例关卡通过也不代表复杂室内光照通过。

最终汇总审计通过 9,103 个条目、8,953 个不同文件，全部核对当前文件哈希。默认关卡在 Chrome / Edge 的灯光对照、窗口恢复及损坏包 / 配置拦截回归通过。旧 RenderCore 报告记录了已被后续 Renderer 构建替换的 UBT；本轮重新构建 RenderCore 并重做两个关卡的 Cook、打包与浏览器验证，没有跳过不一致检查。

当前独立目录 6 文件共 582,004,473 字节。纹理清单仍为 667 张、607 张多 mip、60 张单 mip，相比未压缩基线保留每张纹理的宽高、面数和 mip 数，压缩估算仍为 210,559,592 字节。双浏览器累计纹理创建描述估算均为 696,130,268 字节，包含新增阴影和 AO 目标及反射资源，不能当作实际驻留显存。1280x720 固定餐桌视角短时为 Chrome 4.73 / Edge 4.36 FPS，性能及 8 GB 显存预算均未验收。

```powershell
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-project.cjs --project=triplex-house-villa --smoke=1 --warmup-frames=10 --seconds=6 --surfaces=1 --report=pbr-final --view=-175,-80,160,-5,50
node tests/web-platform/audit-cooked-textures.cjs --cook-report=tests/web-platform/results/web-project-triplex-house-villa-cook-results.json --output=tests/web-platform/results/triplex-textures-pbr-final.json
node tests/web-platform/verify-web-project-surfaces.cjs
```

## 2026-10-23：修复室内照明

用户指出别墅网页几乎全黑。本轮对照关卡清单确认：原地图有强度 7 的指定 HDRI SkyLight、103 个聚光灯、4 个点光源和9个矩形灯；先前兼容性包在 Cook 时关闭了 SkyLight，配置也禁用了本地灯。这些设置直接影响画面，原有“非空白”检查却把窗外少量亮像素算作通过。

现在新增室内区域亮度检查，以及运行时 SkyLight 关闭、本地灯关闭、全部恢复三组画面对照。固定视点参数为 `--view=x,y,z,pitch,yaw`；该测试相机只在探针调用时启用。运行和开关灯后均检查页面错误、GPU 校验和设备丢失。本地灯验收使用逐像素 RMS、变化像素比例与恢复误差的对比；保留原地图自动曝光时，关闭灯光后曝光提高，不能要求全图平均亮度一定下降。

指定立方体 SkyLight 在原生 UE 中按原组件参数计算平均亮度及三阶 RGB 球谐，并保存 `WebSkyCaptures.bin`。浏览器核对组件路径、立方体、分辨率、旋转和下半球设置后读取系数；立方体 GPU 过滤继续执行，只绕开浏览器目前缺少的同步浮点读回。缺失、过期或损坏的数据使加载明确失败。光源强度、后处理曝光与原地图保持一致。

Web 移动前向路径接通本地灯网格；WGSL 不接受的 subgroup 裁剪变体在 Web 局部排除，编译和运行均选择每单元单线程路径，同时关闭 Web 的双层网格及 specialization constants 变体。Web 使用固定列表以减少存储缓冲绑定数量，每格容量至少覆盖当前可见灯光和反射捕获数量；不提高设备默认绑定上限。未接入的 GPU 灯网格调试反馈与灯名缓冲在 Web 局部排除。其他平台继续使用原逻辑。

IES 图集在 Web 选择 UE 现有栅格更新路径，避免 WebGPU 不支持的 R16F storage image；RHI 增加单 mip、线性 R16F 二维数组的分层渲染、采样视图和状态转换。仍拒绝该数组的 CPU 初始化和 UAV 用途。原生 `-WebTextureIESProbe` 只清除第二层并读回两层，验证第一层不受影响；和 BC 探针一起在记录、直通两种模式执行。

最终照明汇总 `verify-web-project-lighting.cjs` 已通过：核对 9,099 个审计条目、8,946 个不同文件，源码、构建、Cook、包和截图哈希均一致。普通 UBT Web 构建、原生 Renderer/RenderCore 构建、两个关卡重新 Cook 和打包均通过，安装引擎审计输入保持原样。之前关闭 SkyLight 的 BC 基线保留为历史记录。

对应独立引擎仓库提交为 `bd55e94ef`（恢复 Web 天空光与移动前向局部灯照明）；外围 RHI、打包与回归脚本由工作区根仓库保存。

原生纹理测试已通过 172 项；指定 HDRI 的平均亮度为 `0.535156`，球谐首项为 `(1.63477, 1.76367, 2.23242)`，准备文件为 310 字节。当前纹理审计仍为 667 张、607 张多 mip、60 张单 mip，压缩估算仍是 210,559,592 字节。这里的数字不表示实测总显存。

最终餐桌视角在 Chrome、Edge 均通过，室内采样可见比例约 98.4%，亮度均值约 155.3；关闭天空光后降到 36.5 / 40.5。关闭局部灯后逐像素 RMS 为 11.62 / 8.19，恢复误差仅 1.12 / 0.48，证明变化超过画面自身漂移。两次运行均无 GPU 校验错误或设备丢失。缺少天空光数据的故障注入在两浏览器均于第 0 帧明确失败；默认关卡的灯光、窗口恢复及损坏包/配置拦截回归通过。

当前独立目录 6 文件共 562,698,698 字节。最终双浏览器累计纹理创建描述估算均为 500,972,160 字节，展开等价估算为 1,536,155,628 字节；含运行时光照/阴影目标，不是实际驻留显存。固定餐桌视角短时约 5.25 / 5.03 FPS，尚未达到可用帧率。

额外冷启动及不同取景中遇到浏览器页面崩溃和 GPU 设备失效，保留 `lighting-chrome-crash`、`lighting-kitchen-angle` 等失败记录；不能声明稳定性验收通过。Lumen 间接光、桌面反射、接触阴影和部分材质仍与编辑器有差异，未完成同视点原生画质匹配。低帧率、8 GB 总显存预算与长期稳定性继续单独验收。

本轮证据位于 `tests/web-platform/results`：`web-project-triplex-house-villa-lighting-final-results.json`、对应原图/开关灯/恢复截图、`web-project-triplex-house-villa-skylight-cache-results.json`、`triplex-textures-lighting-final.json` 和 `triplex-house-villa-lighting-audit-results.json`。原生 172 项纹理结果位于 `tests/web-platform/build/lighting-native-texture/texture-srv-results.json`。

当前照明包的复现命令如下；需要先完成普通 UBT Web 构建及原生 Renderer/RenderCore 宿主构建。与历史压缩基线相比，项目 Cook 不再传 `-DisableProjectSkyLight`。

```powershell
& tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-ES31 -Scene Project -Project H:/ue_html/tests/web-platform/build/projects/triplex-house-villa/TriplexHouseVilla.uproject -Map /Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla -Profile H:/ue_html/tests/web-platform/cook-profiles/TriplexHouseVillaEngine.ini -ReportId triplex-house-villa -TextureCompression BC -CompressHDRCubemaps -StopOnShaderError -SkipBuild
node tests/web-platform/stage-web-engine.cjs --project=triplex-house-villa
node tests/web-platform/package-web-project.cjs --project=triplex-house-villa
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-project.cjs --project=triplex-house-villa --smoke=1 --warmup-frames=10 --seconds=15 --lighting=1 --local-lights=1 --report=lighting-final --view=-175,-80,160,-5,50
node tests/web-platform/probe-web-project-skylight-cache.cjs
node tests/web-platform/audit-cooked-textures.cjs --cook-report=tests/web-platform/results/web-project-triplex-house-villa-cook-results.json --output=tests/web-platform/results/triplex-textures-lighting-final.json
node tests/web-platform/verify-web-project-lighting.cjs
```

## 2026-10-22：历史 BC 兼容性基线

以下为关闭天空光时的压缩验证记录，保留其数据与失败边界，不代表当前照明包的验收结论。

本轮继承 TriplexHouseVilla 打包工作，按用户要求先接通 GPU 纹理压缩，再处理帧率。所有项目准备、Cook 和构建输出均在 `H:/ue_html`；原项目 `H:/TriplexHouseVilla` 和安装引擎源码保持原样。`reference-engine` 本轮无修改。

准备脚本复制内容项目，复用现有编辑器宿主和 Web 插件；运行时按 `/Game` 地图参数加载原关卡，保留原有 GameMode、PlayerController 和输入配置。当前入口是 `http://127.0.0.1:8765/build/triplex-house-villa/index.html`。

### 纹理路径

- `-TextureCompression BC` 让 Cook 保留 DXT1/DXT5、BC4/BC5、BC6H/BC7，使用 UE 自带 DXT 和 Intel ISPC 编码器；不在浏览器解压回 BGRA8。颜色的 sRGB 标志、法线的 BC5 编码和原有 mip 链保留。
- `-CompressHDRCubemaps` 明确允许把 HDR 立方体的 RGBA16F 改为 BC6H；仍尊重资产的 `CompressionNone`。这是有损处理，尚未完成同视点原生画质比较。
- WebGPURHI 在适配器提供能力时请求 `texture-compression-bc`。压缩纹理只具有采样和复制用途，不能当作渲染目标或存储纹理。上传和复制按实际块数处理，包括 2x2、1x1 的尾部 mip，以及立方体六面。
- 压缩包在下载引擎及场景前检查 BC 能力；不支持时显示具体原因。当前仅接通 BC 包，ASTC/ETC2 包和实际手机验收待做，不能把桌面 BC 包当成通用手机版。

在相同的 Web LOD 512 配置下，对全部 667 个项目 2D/立方体纹理平台头进行统计：

| 项目 | 未压缩基线 | 最终 BC 包 |
| --- | ---: | ---: |
| 纹理数据估算，含 mip 和立方体六面 | 1,241,770,628 字节 | 210,559,592 字节 |
| 多 mip 纹理 | 607 | 607 |
| 单 mip 纹理 | 60 | 60 |
| Stage 内容包 | 1,419,511,380 字节 | 374,756,614 字节 |
| 独立网页目录，6 个文件 | 1,602,238,226 字节 | 557,485,463 字节 |

最终项目格式为 438 个 DXT1、199 个 BC5、18 个 DXT5、2 个 BC6H、9 个 BGRA8 和1个 RGBA16F。BGRA8 保留包括不能按 BC 块对齐的原尺寸资源；单 mip 资源不会因为 LOD 上限自动生成低分辨率 mip。单看原贴图目录为 642 个，其中 607 个具有多级 mip，35 个单 mip；其余项目纹理是 UI 等其他目录资源。

上述数字来自 Cook 平台头与块大小，不是驱动实测显存，也不包括顶点、索引、uniform、深度和后处理缓冲。不能仅凭纹理小于 8 GB 宣称整场景通过显存预算。

### 验证与边界

- 普通 UBT Web 目标完整编译、实际链接通过；安装版编辑器插件编译通过。
- Cook 为每次运行保存宿主准备报告快照；共用宿主的 BuildSettings 表编译/链接启用可复现输出，连续默认关卡和别墅 Cook 的 DLL 哈希一致，避免后一次重链使前一次证据失效。首次汇总发现的旧指纹不匹配保留为失败报告。
- 最终严格汇总通过：核对 11,313 个审计条目、11,234 个不同文件，源码、产物和截图哈希零不匹配；逐项比较压缩前后全部项目纹理的尺寸、mip 数与立方体面数一致。历史未压缩 Cook 只复核保存的资产字节，不要求旧版源码指纹与当前修改相同。
- 原生 TextureSRV 回归及可选 `-WebTextureBCProbe` 已执行。BC 探针在记录和直通两种模式共通过 160 项，验证七种 BC 格式的四级 mip 上传、BC1 分级采样、跨纹理复制、立方体六面各级采样、sRGB 直接采样和非法创建拒绝，无 GPU 校验错误。
- Chrome、Edge 已实际渲染最终 BC 包，GPU 创建描述中包含 BC1/BC3/BC5/BC6H，而非仅在 Cook 报告中声称压缩。两浏览器累计纹理描述估算均为 299,514,544 字节，同批纹理展开估算为 1,334,698,012 字节，GPU 校验和设备丢失均为零。浏览器探针把纹理描述估算与累计缓冲分配分开记录；未达到 60 帧时统计模块尚未发布堆大小，保持空值，不把缺失值记为零增长。
- Chrome、Edge 均通过实际压缩能力预检和模拟缺少 BC 的拦截，共四组。加载进度与失败处理的双浏览器回归 24 项通过。
- 默认关卡重新 Cook、Stage 和生成完整网页目录；Chrome、Edge 原图、方向光/天空关闭与恢复、竖屏及窗口恢复检查通过，内容和配置哈希破坏均在开始渲染前拦截，无页面或 GPU 错误。首次 `--packaged --runtime-only` 组合虽然两浏览器启动和原图通过，却因该选项跳过了打包验收必需的画面对照和窗口检查而汇总失败，失败报告另存；最终使用完整 `--packaged` 路径通过，没有删除断言。
- 当前只是兼容性基线：显式 Cook 开关关闭别墅 SkyLight，原因是其捕获需要尚未实现的同步浮点 GPU 回读。方向光和 Lit 静态网格仍加载；室内明显偏暗，不能作为完整画质验收。默认关卡不使用这个项目专用开关。
- `M_GlassBlur` 依赖移动路径不支持的 SceneColor，仍回落到默认材质；相关运行错误保留在报告中。音频、本地灯、桌面反射、Lumen、虚拟阴影等不在当前项目配置范围，UMG/Slate 依赖继续保留。
- 单帧约 6253 次 draw、每帧大量临时 uniform 缓冲分配仍是显著问题；短时性能很低，尚未处理或验收。本轮探针通过状态表示压缩上传、启动与实际渲染检查通过，不表示帧率、长期稳定性或 8 GB 总显存预算通过。

主要证据保存在 `tests/web-platform/results`：

- `triplex-textures-uncompressed.json`、`triplex-textures-bc-final.json`：项目纹理清单、格式、mip 和估算。
- `web-project-triplex-house-villa-cook-results.json`、`web-project-triplex-house-villa-stage-results.json`、`web-project-triplex-house-villa-package-results.json`：Cook、Stage、独立目录和来源/产物哈希。
- `web-project-triplex-house-villa-bc-final-results.json`：最终包桌面浏览器的真实 GPU 格式、渲染截图和短时性能观测。
- `web-project-triplex-house-villa-bc-preflight-results.json`：桌面实际能力与缺少 BC 的故障注入。
- `web-default-scene-results.json`、`web-startup-transfers-bc-current-results.json`：默认关卡完整包与加载流程回归。
- `triplex-bc-final-audit-results.json`：当前来源、产物、截图和同尺寸纹理清单的严格汇总。
- `build/bc-native-texture/texture-srv-results.json`：原生压缩纹理回归，位于 `tests/web-platform`。

### 复现

从工作区根目录执行；普通 UBT 完整构建必须先成功，不能用诊断链接冒充。

```powershell
node tests/web-platform/prepare-web-project.cjs --project=H:/TriplexHouseVilla/TriplexHouseVilla.uproject --id=triplex-house-villa --texture-size=512 --input-profile=tests/web-platform/cook-profiles/TriplexHouseVillaInput.ini
& tests/web-platform/build-web-engine.ps1
& tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-ES31 -Scene Project -Project H:/ue_html/tests/web-platform/build/projects/triplex-house-villa/TriplexHouseVilla.uproject -Map /Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla -Profile H:/ue_html/tests/web-platform/cook-profiles/TriplexHouseVillaEngine.ini -ReportId triplex-house-villa -TextureCompression BC -CompressHDRCubemaps -StopOnShaderError -DisableProjectSkyLight
node tests/web-platform/stage-web-engine.cjs --project=triplex-house-villa
node tests/web-platform/package-web-project.cjs --project=triplex-house-villa
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-texture-compression.cjs --project=triplex-house-villa
node tests/web-platform/probe-web-project.cjs --project=triplex-house-villa --smoke=1 --warmup-frames=10 --seconds=15 --report=bc-final
node tests/web-platform/verify-web-project-compression.cjs --project=triplex-house-villa
```

10 帧预热仅用于当前压缩链路检查。脚本默认仍为 120 帧，历史 120 帧超时失败保留，不以降低预热帧数消除性能问题。独立目录需要提供跨源隔离响应头的 HTTP 服务；现有 `serve.cjs` 继续监听 8765。
