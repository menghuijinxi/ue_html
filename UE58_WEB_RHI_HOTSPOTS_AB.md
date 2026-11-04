# Web RHI 三项热点对照

2026-11-03 实施，2026-11-04 在断电重启后重新测试。接续 v47 窗口共享快照修复，测试 TriplexHouseVilla 的原 Cook 和项目设置。全部候选包显式使用 mimalloc；编译脚本的默认分配器仍为 dlmalloc。保留距离场、TSR、局部光及项目质量设置，关闭状态沿用项目配置，未添加画质覆盖。

## 三个独立变量

`-WebRHIExperiment=control/tick/metadata/storage/all` 只在 UE 命令行初始化后的 `ConfigureStartup` 读取一次，运行中不反复解析命令行。

| 模式 | 修改 |
|---|---|
| control | 使用原 JSON 绑定校验和原同步 RHITick |
| tick | 浏览器的空 RHITick 直接返回；保留非浏览器事件处理 |
| metadata | Shader 加载时将存储缓冲区的读写属性、元素格式/步长、packing 和顶点读取槽位转成原生结构；绘制时读取原生字段 |
| storage | 同一存储缓冲区视图跨 encoder/Pass 使用时，复用已准备的 buffer/offset/size，重新检查当前资源访问状态，并更新校验代次 |
| all | 同时启用以上三项 |

storage 路径要求与上次成功准备的 RHI 视图相同，缓存保留强引用。缓冲区视图的资源、范围和格式不会变化；当前 Web 后端的缓冲区 GPU handle 在初始化后保持不变。每次访问代次改变仍通过 `RequireAccess` 检查 capability、CPU lock、transition 和当前访问状态。纹理绑定及附件冲突检查沿用原路径，Uniform 内容和帧内分配也沿用原路径。

本次 storage 与 v48 的跳过 Shader 扫描实验不同；v48 补丁仍未应用。这次针对缓存未命中后反复进行的存储缓冲区描述符构造/视图校验，不放宽整个绑定组的失效规则。

metadata 保留原 JSON 校验函数作为对照及错误拒绝接口。验证模式对真实绑定比较原生与 JSON 的结果和错误文本，并构造缺失读写字段、错误读写类型、缺失格式/步长、错误格式/步长等四类错误。验证模式还完整重建描述符，与跨 Pass 复用结果比较；正式 FPS 关闭验证模式。

重启后的 v52 移动测试持续 30 秒，推进到 1131 帧，移动约 158 cm、转向约 44.8°，约 3212 万次缓存描述符比较和 1200 次错误拒绝检查通过；另一次测试通过六个视角与四组窗口尺寸/DPR 切换。人工检查截图的材质、局部光、阴影与距离场画面，没有发现本轮修改造成的异常。

参考引擎桌面实现：`D3D12Shaders.cpp` 在 Shader 创建时从 `FShaderCodeReader` 提取 `FShaderCodePackedResourceCounts` 到原生成员；`D3D12StateCache.cpp::SetNewShaderData` 直接使用这些成员，`ApplyState` 按缓存状态提交绑定。该设计支持在 Shader 加载时完成不可变元数据解析、绘制时使用原生结构的方向。Web 的 bind group 和 D3D12 descriptor table 接口不同，本次没有照搬其具体描述符堆管理，也没有跳过 UE/后端的资源状态校验。

## 测试顺序与计时口径

先单独进行六视角、窗口/DPR 切换与移动中的完整绑定校验。正式测试使用同一 Wasm，依次运行 control、tick、metadata、storage、storage、metadata、tick、control；每次重启页面，预热 15 秒后记录 20 秒。同一二进制中的启动开关隔离三个变量。

再将默认 all 包与未修改 RHI 的 v47 做独立 ABBA，检查相对于上轮实际交付包的净效果。所有正式测试保持默认出生点、Edge 前台、2289×1287 CSS、DPR 1、UE 核心预算 4、3 个 Task Worker，Game/Render/RHI 各独立。构建、打包、CPU profiler 与正式 FPS 串行。

FPS 根据完成的 RHI viewport present 计数。1% Low 是最慢 1% 帧间隔均值的倒数；同模式两轮的原始间隔合并计算。固定视角 Low 不代表遍历场景的 Low。每轮保存相机、渲染参数、绘制量、前台状态和开关实际生效状态。

## 构建与早期失败

v49 首次启动失败，原因是测试开关放在 RHI 构造函数读取，浏览器预创建设备早于 `FCommandLine` 初始化。该失败保留原始日志，修复为在原有 `ConfigureStartup` 阶段读取。v50 是修复初始化顺序后的中间包；v51 又补齐跨 Pass 复用后的代次更新，通过六视角、窗口/DPR、移动与 1200 次错误拒绝检查。

v51 独立对照在计时前被生效检查拦截：启动器没有把新开关转发到 UE 重建的命令行，原本要求 control，实际仍是 all。没有进入正式计时。v52 补齐启动器参数解析、允许值检查和转发，最终用于正式测试。v49/v50/v51 均不计入性能结果，v51 的正确性报告保留。

编译保持 417 个单元中的 416 个 `-O2`、一个 Chaos `-O1`，最终链接没有新增 `-O`、SIMD 或 LTO，保留断言。Cook 内容、配置与 v47 逐字节一致。

## 重启后的独立对照

| 模式 | 两轮 FPS | 合并 FPS | 相对 control | 合并 1% Low |
|---|---|---:|---:|---:|
| control | 74.57、75.46 | 75.01 | — | 30.75 |
| tick | 75.84、75.80 | 75.82 | +1.08% | 31.88 |
| metadata | 76.43、78.24 | 77.33 | +3.09% | 35.11 |
| storage | 76.27、77.15 | 76.71 | +2.26% | 30.79 |

前后两次 control 相差约 1.2%，未重现断电前的 50–78 FPS 大范围波动。各轮每帧 draw 约 3016–3061，仍有约 1.5% 的工作量差异，且两轮不足以估计长期方差。metadata 的 Low 本轮高约 14.2%，storage 的 Low 基本相同；这些固定出生点的短窗口结果不能保证场景遍历时的 Low 同等改善。

计数证明分支生效：tick 每帧少一次同步 RHITick；metadata 每帧约 534 次存储绑定使用原生元数据；storage 每帧约 265 次跨 Pass 复用描述符并检查当前访问状态。RHI 工作时间 control 约 9.58–9.70 ms/帧，tick 约 9.56–9.58，metadata 约 9.10–9.42，storage 约 9.21–9.39。独立提升不能相加为组合收益，metadata 与 storage 会减少彼此覆盖的工作，需另看实际组合对照。

## 组合包与 v47 对照

首组 ABBA 最后一次旧版降至 71.95 FPS，因此补做反向 BAAB。没有丢弃这次较慢的旧版记录，两组完整保留：

| 顺序 | v47 每轮 FPS | v52 每轮 FPS | 旧版合并 FPS | 新版合并 FPS | 相对提升 |
|---|---|---|---:|---:|---:|
| v47 / v52 / v52 / v47 | 75.20、71.95 | 78.57、78.92 | 73.58 | 78.75 | +7.03% |
| v52 / v47 / v47 / v52 | 73.63、67.02 | 83.91、83.97 | 70.32 | 83.94 | +19.36% |
| 全部八轮 | — | — | 71.95 | 81.34 | +13.06% |

八轮的原始间隔合并后，1% Low 为 29.82 → 34.41 FPS（+15.38%）；超过 33.33 ms 的帧为 23 → 16，各版本记录约 80 秒。RHI 工作时间旧版约 9.52–10.75 ms/帧，新版约 8.66–9.17。两组方向一致，支持保留组合实现为 v52 默认路径；具体提升仍受运行波动影响，不能承诺固定增加 13%。反向组旧版最低 67.02 FPS，说明重启未消除全部波动，环境监控没有发现构建或游戏进程，尚不能解释这部分变化。

组合模式下每帧约 265 次描述符复用，另约 269 次使用原生元数据完成完整校验，说明后两项覆盖同一部分工作。没有将两项独立计数或独立增益相加。

## 单独 CPU 采样

正式 FPS 完成后，分别重新启动同一个 v52，选择 control 与 all，单独抓取所有 Worker 的 CPU 栈。每个线程约 6–7 秒，停止各线程采样的时刻不同。以下是占该线程采样时长的包含子调用比例，路径会重叠：

| 路径 | control | all |
|---|---:|---:|
| Game：RHITick（主要为同步代理等待） | 6.44% | 未采到 |
| Game：全部匹配的同步代理路径 | 6.49% | 未采到 |
| RHI：存储绑定 JSON 校验 | 3.02% | 未采到 |
| RHI：原生存储绑定校验 | 未采到 | 0.15% |
| RHI：JSON 字段哈希查询 | 1.99% | 0.15% |
| RHI：CreateGroups | 20.13% | 19.03% |
| RHI：SetDrawBindings | 28.48% | 28.92% |
| RHI：JS 命令回放 | 11.77% | 10.51% |
| RHI：资源访问校验 | 2.71% | 2.59% |

采样支持空同步和绘制时 JSON 查询确实减少。`SetDrawBindings`、`CreateGroups`、JS 命令回放仍是值得细分的路径，尚未证明剩余差距全部来自 UE C++，也没有证明 WebGPU/Wasm 交互已经没有问题。应进一步区分组缓存未命中的描述符准备、顶点/索引状态提交和浏览器实际 API 执行。占比不是单个调用耗时，不能直接换算为每帧省去多少毫秒，也不能用两个包含关系的比例相加估算总损耗。本轮未测真实 GPU 时间，未定位全部 Low 尖峰。

原始日志、逐帧间隔、截图、Worker CPU 栈保存在 `tests/web-platform/results/`；可审查的哈希与汇总为 [最终证据](tests/web-platform/evidence/rhi-hotspots-20261104.json)、[control 栈汇总](tests/web-platform/evidence/rhi-hotspots-v52-reboot-control-costs-20261104.json)、[all 栈汇总](tests/web-platform/evidence/rhi-hotspots-v52-reboot-all-costs-20261104.json)。最终汇总核对源码、包、417 个编译单元、原 Cook/配置、全部 16 个正式窗口和 64 个环境监控样本，均通过；保留后台用户软件，不代表独占机器。没有构建或游戏进程，不等于没有其他调度或 GPU 干扰。

推荐实测页面：`http://127.0.0.1:8765/build/villa-rhi-hotspots-v52/index.html`。v47 保留用于回归。v52 默认启用三项；诊断开关继续保留，不要求用户调整项目渲染设置。

## 复现

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
./tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -Mimalloc -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4 -RendererRevision d175ae4ae
node tests/web-platform/benchmark-villa-threading.cjs --folder=villa-rhi-hotspots-v52 --rhi=control,tick,metadata,storage,storage,metadata,tick,control --tag=rhi-isolation-rerun
node tests/web-platform/benchmark-villa-threading.cjs --folders=villa-browser-metrics-v47,villa-rhi-hotspots-v52,villa-rhi-hotspots-v52,villa-browser-metrics-v47 --tag=rhi-combined-rerun
node tests/web-platform/benchmark-villa-threading.cjs --folders=villa-rhi-hotspots-v52,villa-browser-metrics-v47,villa-browser-metrics-v47,villa-rhi-hotspots-v52 --tag=rhi-combined-reverse-rerun
node tests/web-platform/verify-villa-command-stream.cjs --folder=villa-rhi-hotspots-v52 --tag=rhi-views-rerun --window-metrics
node tests/web-platform/benchmark-villa-threading.cjs --folder=villa-rhi-hotspots-v52 --rhi=control --seconds=5 --warmup=10 --profile-workers --tag=rhi-profile-control-rerun
node tests/web-platform/benchmark-villa-threading.cjs --folder=villa-rhi-hotspots-v52 --rhi=all --seconds=5 --warmup=10 --profile-workers --tag=rhi-profile-all-rerun
node tests/web-platform/summarize-rhi-hotspots.cjs
```

断电前的 `villa-rhi-hotspots-v52-isolation.json` 只有五个已完成记录窗口，八轮未完成，且不同窗口出现 50–78 FPS 的波动。该原始报告保留，不用于最终性能结论。重启后核对全部包产品哈希、相关源码哈希，候选 v52 完整，未重写原包。

后台用户软件继续运行；重启后的环境监控为 `results/villa-rhi-hotspots-v52-reboot-environment.jsonl`，正式测试、正确性及采样均使用带 `reboot` 的新标签。CPU 栈单独采集，不将线程采样占比换算为精确的每帧节省时间，也不将相互包含的路径占比相加。
