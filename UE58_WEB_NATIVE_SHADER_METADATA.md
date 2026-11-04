# Web 着色器元数据直接读取原生结构

2026-11-04。接续 v52。旧 schema 2 的 Cook 虽已使用 UE Compact Binary，但加载时仍完整创建 `FJsonObject/FJsonValue` 树。这轮消除正常启动中的这棵树，并同步移除渲染消费者对它的依赖。

## 实现与范围

`WebGPUShaderRuntimeMetadata.h` 定义原生绑定、资源表数组、UE 参数映射、Uniform 资源成员及像素输出掩码。读取器先调用 UE 的 Compact Binary 长度/类型/尾随数据校验，再从非拥有的字段视图提取这些数据。字段的整数范围、必需类型、分组范围和反射绑定对应关系继续校验。不会把二进制整个转换成文本或通用对象树，也不为未使用的反射成员创建节点。读取完成后，结构中的字符串和数组拥有自身数据，不保存指向临时 Shader Code 的悬空视图。

资源表继续交给 UE 原有 `FShaderResourceTable` 和脏标记更新逻辑。管线布局、绑定路由、存储纹理格式/访问模式及 MRT 输出掩码改读原生成员；已验证的描述符缓存和当前访问状态检查继续生效。

这轮沿用已有 Compact Binary 编码及 schema 2，没有自制底层二进制解析器，也没有改变 Cook、WGSL、Shader 标识、项目配置或画质。现有包能直接获益。Cook 中用于诊断的完整反射数据仍存在，包体体积没有因此减少；本轮解决加载时的对象构造和运行时占用。若后续裁掉诊断载荷，应另行升级 Cook 格式并核验缓存失效。

默认使用原生读取器。`-WebShaderMetadataDOM` 为启动 A/B 保留原对象树读取器，再导入同样的原生结构；两组运行同一 Wasm 和 Cook。旧 schema 1 仍经 JSON reader 导入原生结构。

`-WebShaderMetadataValidate` 同时读取原生结构和原始对象树，逐字段比较，再允许绑定验证代码使用旧 JSON 路径作参考。它仅用于正确性检查，不能用于正式启动性能数据。运行中临时开启缓存验证、此前没有保留 DOM 时，使用原生元数据重新构造描述符并比较缓存；JSON 专属的错误拒绝对照只在原对象树存在时执行。

## 早期失败与验证边界

初次编译修正了 UE `FCbFieldView` 访问器的可变错误状态，以及 EM_ASM 对对象字面量逗号的宏解析问题。v55 普通启动、六视角和窗口/DPR 通过，但在运行中开启绑定验证时触发旧 JSON 路径访问空对象；这次失败保留，不用于性能。v56 补齐无 DOM 的动态校验路径，并添加启动时显式的 JSON 参考验证模式。

原生编辑器目标全量增量编译还遇到既有 WebGPU feature 查询的 MSVC C4800 警告升级为错误。本轮没有把该失败宣称为原生 RHI 通过；随后只构建 `UEShaderHost` 模块，用 NullRHI commandlet 验证实际同一份解析器。浏览器运行时使用完整 Web Target 编译/链接。

## 测量口径

原生语料来自实际别墅 Cook 的全部 3852 份 Shader 元数据，比较二进制直读与原 JSON 对象的全部运行时字段，并拒绝截断、尾随数据及必需字段错误。原生时间与浏览器时间分开报告。对象内存使用 UE `GetMemoryFootprint()` 与原生结构的 `sizeof + GetAllocatedSize()` 统计，属于对象分配规模，不是进程 RSS，也不包含分配器控制块、碎片或 GPU 内存。

浏览器同一页面重开，先记录一轮缓存准备，再做 DOM / native / native / DOM。分别记录元数据读取累计、实际 Shader 数量、PreInit、UE Init、第一游戏帧和加载层撤下后的两次 RAF；整页耗时不能直接归因于元数据读取。正式测量与构建、打包、原生语料测试及 CPU profiler 串行，保留用户后台软件。

## 实测结果

最终运行时为 v57，继续使用 mimalloc。417 个编译单元中 416 个 `-O2`、1 个 Chaos `-O1`；最终链接未增加 O2、SIMD 或 LTO，断言继续启用。两组启动使用同一 Wasm，DOM 参考模式也导入原生结构，以便渲染消费者完全相同；因此这组 A/B 比较读取方案，不等于旧 v52 原封不动的启动对照。

原生 NullRHI commandlet 在实际 Cook 的 3852 份元数据上，逐份比较直读结果与 JSON 参考的所有运行时字段，3852/3852 相同；13 个原生读取异常输入全部拒绝，既有完整格式往返和异常测试也通过。

| 完整 Cook 语料，原生测试 | 二进制还原完整 DOM | 二进制直读原生结构 |
|---|---:|---:|
| 累计读取 | 2031.94 ms | 358.93 ms |
| 对象分配规模 | 1026.96 MiB | 55.91 MiB |

本轮同机语料测试中读取耗时减少 82.3%，对象分配规模减少 94.6%。这是完整语料的对象统计，不能说浏览器启动直接少占约 1 GiB。

浏览器两组各两轮平均，均为持久资产缓存命中、零下载；第一轮下载准备不计入平均。这里的整页可见时间从页面 `timeOrigin` 算到加载层撤下后的两次 RAF，包含文件访问、Wasm、UE 和管线等待。

| 浏览器阶段 | DOM 参考 | 原生直读 |
|---|---:|---:|
| 默认启动，实际加载 Shader 数量 | 166 | 166 |
| 默认启动，元数据累计读取 | 133.43 ms | 15.38 ms |
| 默认启动，UE Init | 2729.84 ms | 2803.93 ms |
| 默认启动，整页可见 | 8.251 s | 8.314 s |
| PSO 批量诊断，实际加载 Shader 数量 | 1683.5 | 1680.5 |
| PSO 批量诊断，元数据累计读取 | 1527.93 ms | 123.51 ms |
| PSO 批量诊断，UE Init | 5991.25 ms | 4605.58 ms |
| PSO 批量诊断，首游戏帧 GPU 完成 | 13.823 s | 12.646 s |
| PSO 批量诊断，整页可见 | 15.022 s | 14.596 s |
| PSO 批量诊断，Wasm 内存容量 | 1924071424 B | 1386741760 B |

默认启动元数据读取减少约 88.5%，但它本来只占约 0.13 秒，这组整页结果未显示明确收益。批量诊断读取减少约 91.9%，UE Init 缩短约 1.39 秒；整页可见只缩短约 0.43 秒（2.8%）。异步管线请求、回调、资产读取及加载层等待有重叠，不能把元数据省下的 1.4 秒直接当整页收益。Wasm 容量是线性内存增长后的容量，不代表实时在用内存或浏览器 RSS。

批量诊断使用 8 并发 PSO，未修改浏览器 GPU 缓存容量。每轮均存在原有 8 个 `workgroup_size(512)` 超出请求设备限制的管线拒绝，DOM 与原生两组一致；这轮不将该 PSO 诊断宣称为全部管线成功，默认游戏页不启用 PSO 预缓存。较早释放 CPU 可以加快发起请求，但剩余管线与加载等待仍需另行分析。

## 正确性与回归

v57 已通过六视角、四种窗口/DPR、移动和转向；最终截图人工检查光照、材质及距离场表现。显式 JSON 参考模式验证 33336120 个描述符并完成 1200 个错误合约拒绝对照；另一轮正常无 DOM 加载后才动态开启验证，验证 15358761 个描述符且 DOM 加载数保持 0，覆盖 v55 曾经崩溃的路径。正确性模式的双读耗时不进入正式性能统计。

默认正常路径的 Shader 元数据 `domLoads=0`。Cook 内容 SHA256 仍为 `bb707f08ad34fcfc2ca0da99893edf063d733a9a4ddf75efc1cd4d63c800190d`，配置文件与 v52 相同。运行时 Game/Draw/RHI 独立线程、4 核预算、GPUScene 和资源表逻辑继续启用。

使用 v52 / v57 / v57 / v52 顺序做固定出生点回归，每轮预热 15 秒、测量 20 秒，2289×1287 CSS、DPR 1，实际内部渲染 1484×835、TSR（AA=4）。没有启动 recorder、CPU profiler 或分配插桩。

| 指标，合并两轮 | v52 | v57 |
|---|---:|---:|
| 平均 FPS | 80.75 | 79.97 |
| 最慢 1% 帧时间均值换算 FPS | 37.21 | 35.37 |
| P99 帧时间 | 17.00 ms | 16.92 ms |
| 超过 33.3 ms 的帧数 | 5 / 3228 | 7 / 3199 |

平均 FPS 差约 -1.0%，未看到明确的持续帧率收益；1% Low 也没有改善，不能把启动优化说成运行流畅度提升。两组设置、摄像机、线程模式和分辨率一致，绘制约 3005–3021 次/帧、计算分派约 66.4 次/帧。正式启动和 FPS 窗口覆盖 36 个环境采样点，未发现游戏或编译进程干扰；保留的 TGitCache、下载、远程控制及音乐进程仍有后台 CPU 活动，汇总记录其上限，不将小差异当稳定提升。

## 复现与证据

默认测试页：[villa-native-metadata-v57](http://127.0.0.1:8765/build/villa-native-metadata-v57/index.html)。

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/capture-web-startup-phases.cjs --folder=villa-native-metadata-v57 --tag=<新标签> --profile=<新profile> --rounds=5 --metadata=native,dom,native,native,dom
# 批量诊断将 folder 换成 villa-native-metadata-pso-v57。
node tests/web-platform/benchmark-villa-threading.cjs --folders=villa-rhi-hotspots-v52,villa-native-metadata-v57,villa-native-metadata-v57,villa-rhi-hotspots-v52 --tag=<新标签>
```

原始结果在 `tests/web-platform/results/`：`villa-native-metadata-probe-v56/metadata-probe.json`、`villa-native-metadata-v57-normal-startup.json`、`villa-native-metadata-v57-pso-startup.json`、`villa-native-metadata-v57-views.json`、两份 `project-gameplay-native-metadata-v57-*.json`。启动抓取保存执行时的脚本及哈希；环境监控另存 JSONL。源码、运行时、原 Cook、截图与测量报告最终校验汇总到 `tests/web-platform/evidence/native-shader-metadata-20261104.json`。
