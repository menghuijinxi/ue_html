# Web 手动顶点读取验证

2026-11-01 游戏关闭后重新测量：四轮 **50.74→42.17 FPS（−16.89%）**，回退再次复现，默认继续关闭。新增 CPU/API/GPU 捕获仍显示资源组准备与绑定增加，详见 [统一复测记录](UE58_WEBGPU_IDLE_RETEST.md)。以下保留原始验证与历史数据。

本轮接回 UE 的 `FLocalVertexFactory` 手动顶点读取并完成场景验证，但 ABBA 测试帧率下降 **12.6%**，因此保留显式实验入口，默认仍关闭。项目使用 `G:/UE_HTML/TriplexHouseVilla` 的现有配置，通过隔离副本 Cook；不覆盖项目画质设置。并行绘制录制维持默认关闭。

## 实现范围

- 仅使用 `cook-web-engine.ps1 -ManualVertexFetch` 的 SM5 实验包开启该能力；引擎默认 SM5 与 ES3.1 均保持关闭。该参数生成隔离的 DDPI，只改变这一个 SM5 能力位，不修改项目配置。
- `bSupportsTypedBufferSRVs` 仍关闭。当前实现只支持显式识别的 LocalVF / GPUSkin passthrough 顶点资源，以及原有的 32 位 storage buffer 路径；没有宣称提供完整桌面 typed buffer 能力。
- 静态网格恢复 UE 默认 position / tangent / UV SRV 创建逻辑，运行时使用引擎现有的 vertex factory、uniform resource table、流布局和绘制命令。
- Web shader 编译层将相关 `Buffer<float2/float4>` 转为读取原始字节并解码。半精度 UV、32 位 UV、SNORM8 / SNORM16 切线和 UNORM8 颜色保留原始压缩存储，没有展开副本。
- 同一材质可用于不同顶点格式的网格。RHI 根据当前 SRV 格式绑定一个 16 字节 uniform，按格式组合缓存；不会每次绘制上传它。格式码参与 prepared descriptor 缓存版本，防止复用旧格式。
- shader 按 SRV 实际范围检查元素索引，避免越界索引乘法溢出；RHI 保留范围、对齐、访问状态和格式兼容性检查。

位置和实例相关的原有 32 位资源沿用已有实现。UE 已支持绝对 VertexID；WebGPU indexed draw 的 base vertex 不做额外补偿。

完整 Cook 成功，4222 次转换中有 234 个实际顶点 shader 使用该路径；它们最多使用 8 个 storage buffer、6 个 uniform buffer。Cook 记录的 GPUScene 与 manual vertex fetch 均为 true，通用 typed buffer 能力仍为 false。

## 场景运行验证

性能实测包为 [villa-manual-vertex-fetch](http://127.0.0.1:8765/build/villa-manual-vertex-fetch/index.html)。运行时和 Cook 数据均有 SHA 审计；项目配置与旧包对比，除 SM5 manual vertex fetch 能力外，其余运行配置完全相同。

增加显式实验参数后，重新 Cook 并打包为 [villa-manual-vertex-fetch-final](http://127.0.0.1:8765/build/villa-manual-vertex-fetch-final/index.html)。该包与上述实测包的 Wasm、运行配置和所有 shader code archive 完全相同，Cook 内容仅 global shader map 文件的字节发生变化。缓存命中而不执行 shader 编译时也会从 Cook 参数确定实验能力，避免漏带匹配的 DDPI。

最终包已补做 10 秒行走及实际手动读取计数检查，通过，无捕获到的错误（第 2→144 帧）。[最终核验](G:/UE_HTML/ue_html/tests/web-platform/results/manual-fetch-final-validation.json)包含构建、Cook、包和各轮验证的 SHA 记录。

- 普通行走 45 秒，到第 788 帧，无捕获到的运行错误；采样末尾累计约 130 万次手动读取绘制，格式 uniform 缓存为 2 个组合。
- 开启绑定缓存一致性校验后再行走 45 秒，到第 545 帧，检查 **17,504,645** 个缓存条目，无来源解析或 prepared descriptor 不一致。
- 实际行走截图已检查，暂未发现网格、UV、法线或颜色异常；完整像素对照和帧率结果见性能部分。

记录：[普通行走](G:/UE_HTML/ue_html/tests/web-platform/results/project-gameplay-manual-fetch.json)、[绑定校验行走](G:/UE_HTML/ue_html/tests/web-platform/results/project-gameplay-manual-fetch-validation.json)、[Cook 绑定统计](G:/UE_HTML/ue_html/tests/web-platform/results/manual-fetch-cook-bindings.json)。

## 性能与画面对照

同场景、出生视角、项目设置、1484×835 内部渲染尺寸及 2289×1287 输出，以旧→新→新→旧顺序测试，每次预热 20 秒、测量约 15 秒；关闭 API 计数和 CPU 采样，两个包均不开启并行绘制录制。

| 指标 | 原有固定顶点流 | 手动读取实验 |
| --- | ---: | ---: |
| 第一轮 FPS | 22.192 | 19.323 |
| 第二轮 FPS | 22.104 | 19.382 |
| 合并 FPS | 22.148 | 19.352 |
| RHI 工作时间 / 帧 | 33.40 ms | 40.97 ms |

本轮后台 `cod.exe` 游戏进程始终运行，存在 CPU/GPU 资源争用。上表只用于本轮交错对照，不能直接和之前游戏关闭时约 53 FPS 的结果比较。

另行抓取 API 和 CPU 性能图，确认固定流绑定减少，但新增的逐网格 storage SRV 绑定成本更高：

| 调用 / 帧 | 原有固定顶点流 | 手动读取实验 | 变化 |
| --- | ---: | ---: | ---: |
| setVertexBuffer | 8010.2 | 6272.2 | -21.7% |
| setBindGroup | 1403.8 | 2240.1 | +59.6% |
| createBindGroup | 80.0 | 197.8 | +147.3% |
| drawIndexed | 3010.0 | 2994.6 | -0.5% |

RHI worker 的 5 秒 CPU 栈采样按完成帧数归一化后，`CreateGroups` 包含时间约 **11.08→30.97 ms/帧**，`SetDrawBindings` 约 **19.89→40.41 ms/帧**；顶点缓冲 API 栈反而由 **5.71→4.85 ms/帧**。这些是统计采样及其父调用的包含时间，会重叠，且有采样开销，不能相加或当作精确计时；但结合调用数足以把当前回退重点定位到资源组准备和绑定。

每包仅取 3 帧 GPU timestamp 时，原有包 pass 总和约 5.6～17.6 ms，实验包约 14.7～35.8 ms，受后台负载影响波动明显；不能据此量化 shader 解码本身的 GPU 成本，也不能把 CPU 绑定解释当作唯一损耗来源。

UE D3D12 后端本来就将这些 SRV 格式映射到 `DXGI_FORMAT_R8G8B8A8_SNORM`、`R16G16B16A16_SNORM` 和 `R16G16_FLOAT`（`D3D12RHI.cpp:155/190/204`）；本次复用同一 vertex factory，Web 适配层保留原始打包数据并补格式解码。它并不自动保证比浏览器固定顶点流更快，当前实现的资源绑定代价已经抵消收益。

静态截图人工检查未发现网格、UV 或明显光照异常。旧/新 RGB 平均绝对差为 **0.893/255**；旧/旧为 0.428，新/新为 0.705，场景有时间相关变化，因此没有宣称像素完全一致。

记录：[ABBA](G:/UE_HTML/ue_html/tests/web-platform/results/manual-fetch-abba.json)、[原版性能图](G:/UE_HTML/ue_html/tests/web-platform/results/performance-capture-manual-fetch-baseline-profile.html)、[实验性能图](G:/UE_HTML/ue_html/tests/web-platform/results/performance-capture-manual-fetch-candidate-profile.html)、[调用与栈对比](G:/UE_HTML/ue_html/tests/web-platform/results/manual-fetch-profile-comparison.json)、[画面对照](G:/UE_HTML/ue_html/tests/web-platform/results/manual-fetch-scene-pair.png)。

ABBA 运行时的 Cook 报告另存于 `results/manual-fetch-candidate-cook.json`，其 SHA 对应 ABBA 内记录的历史报告；通用 `web-project-triplex-project-desktop-cook-results.json` 已由最终显式实验 Cook 更新。

结论：本次只作为已验证的实验实现保留，默认包继续使用固定顶点流。继续优化应先减少手动读取带来的逐网格资源组切换和重复准备，再重新测量；不能仅用减少 `setVertexBuffer` 次数作为启用依据。

## 格式验证

`WebManualVertexFetchProbe` 使用同一套 UE → DXC/SPIR-V → Tint/WGSL 编译路径，`verify-web-manual-vertex-fetch.cjs` 在实际浏览器 GPU 上 dispatch 并回读结果。

8 组 UV / 切线组合共检查 288 个浮点结果，覆盖 SNORM 负数与极值、半精度次正规数与最大有限值、颜色通道、32 位数据、零切线默认值、256 字节非零 view offset，以及超出 SRV 范围的索引。全部通过，最大绝对误差约 `5.98e-8`，无 GPU 校验错误。

记录：[格式回读](G:/UE_HTML/ue_html/tests/web-platform/results/manual-vertex-fetch-formats.json)。

编译并执行格式探针（先完成 native Cook module 构建与隔离 Cook host 准备；本地 HTTP 服务需在 8765 端口运行）：

```powershell
$env:WEBGPU_TINT_DIR='G:/UE_HTML/ue_html/.tools/dawn-v20261009.190412/bin'
$env:WEBGPU_INTERMEDIATE_DIR='G:/UE_HTML/ue_html/tests/web-platform/results/manual-vertex-fetch-shader/conversion'
& .tools/ue58-web-cook-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe G:/UE_HTML/ue_html/tests/ue-shader-host/UEShaderHost.uproject -run=WebShaderProbe -WebManualVertexFetchProbe -Output=G:/UE_HTML/ue_html/tests/web-platform/results/manual-vertex-fetch-shader -nullrhi -unattended -nop4 -nosplash -nosound
node tests/web-platform/verify-web-manual-vertex-fetch.cjs
```

## 复现

构建运行时：

```powershell
& tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -MaxParallelActions 4 -StandaloneCompiles
```

重新 Cook shader 排列必须使用 `-UseProjectSettings`，不能拿旧 Cook 只更换能力开关：

```powershell
$env:UE_ENGINE_ROOT='D:/UE_5.8/Engine'
& tests/web-platform/cook-web-engine.ps1 -Engine D:/UE_5.8 -Mode WebGPU-SM5 -Scene Project -Project G:/UE_HTML/ue_html/tests/web-platform/build/projects/triplex-project/TriplexHouseVilla.uproject -Map /Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla -ReportId triplex-project -UseProjectSettings -ManualVertexFetch -StopOnShaderError
node tests/web-platform/stage-web-engine.cjs --project=triplex-project --desktop
node tests/web-platform/package-web-project.cjs --project=triplex-project --desktop --threads --distance-fields --output-folder=villa-manual-vertex-fetch-final
```
