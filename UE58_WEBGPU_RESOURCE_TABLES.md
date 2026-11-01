# WebGPU 资源表增量更新与 UE 公共实现接入

2026-11-01 游戏关闭后重新测量：四轮 **51.44→51.51 FPS（+0.15%）**，整体持平；新增 CPU/API/GPU 性能图。资源解析采样有所减少，但 API 提交量基本不变。详见 [统一复测记录](UE58_WEBGPU_IDLE_RETEST.md)。以下保留原始验证与历史数据。

本次把 Web 绘制中的资源表更新接到 UE 的 `SetUniformBufferResourcesFromTables()`，静态 UB 绑定接到 `ApplyStaticUniformBuffers()`。候选页面：[TriplexHouseVilla](http://127.0.0.1:8765/build/villa-resource-tables-candidate/index.html)。对照包为上一轮 GPUScene 候选 `villa-gpuscene-candidate`。

引擎配套提交：`b7d7f66a1`（开放 RHI/Internal 包含路径）。本轮机器可读汇总：[完整验证记录](G:/UE_HTML/ue_html/tests/web-platform/results/resource-tables-v3-validation-summary.json)。

## 最终实现

- shader 加载时把 Cook 资源表移入 FRHIShader 的标准数据，并通过 RHICore 初始化运行期 static slots。独立拒绝探针继续支持没有 FRHIShader owner 的元数据。
- shader UB 绑定变化、静态 UB 变化、RHI 命令顺序中的 UB 内容更新使解析状态失效；比较实际 UB 指针和内容版本，只对变化的资源表设置 dirty bits。
- UE 公共枚举器处理资源表验证和 texture/SRV/UAV/sampler 路由。Web Binder 保存类型及槽位对应的资源，draw 通过已确定的来源读取它们。
- 绑定来源首次使用时确定，正常 draw 不再反复解析 JSON 和 uniform 来源。`r.WebGPU.ValidateBindingCache=1` 时保留原解析路径，对照每个绑定的当前资源及 prepared descriptor。
- 保留 TextureReference 身份，并在使用时读取它的当前目标；纹理流送更换目标不要求重新绑定整个 UB。常量内容版本、pass/access serial、帧末引用释放及单帧常量快照机制继续参与失效判断。
- 新增资源表提交次数、处理的 UB 数量和首次绑定来源解析次数。诊断分多次 EM_ASM 调用发布，避免超过当前工具链单次 16 参数限制；性能录制也增加运行失败检查。

原项目设置、画质、场景内容和 Cook 数据不变。此次为运行时修改，使用现有 Cook 重新打包；对照工具严格要求 `content.bin`、`config-files.json` 的 SHA 相同。

相关源码：

- [WebGPUDynamicRHI.cpp](G:/UE_HTML/ue_html/tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp)
- [WebGPUDynamicRHI.h](G:/UE_HTML/ue_html/tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.h)
- [UE 资源表枚举器](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/RHI/Internal/RHIUniformBufferUtilities.h:97)
- [UE 静态 uniform 应用](G:/UE_HTML/UnrealEngine-1/Engine/Source/Runtime/RHICore/Public/RHICoreShader.h:65)

## 验证记录

线程版正常 UBT 编译/链接、WASM 结构校验和重新打包通过。最终包普通模式完成 45 秒、约 1040 帧的行走与转向；最终包另一次开启绑定校验完成 45 秒、约 1380 帧，累计校验 **40,014,367** 个绑定条目，无绑定来源或 descriptor 不一致。两次 GPUScene、独立 Draw/RHI 线程和新资源表计数检查均通过，未捕获运行错误。

原始记录：[普通行走](G:/UE_HTML/ue_html/tests/web-platform/results/project-gameplay-resource-tables-normal-v3.json)、[开启校验行走](G:/UE_HTML/ue_html/tests/web-platform/results/project-gameplay-resource-tables-validation-v3.json)、[构建结果](G:/UE_HTML/ue_html/tests/web-platform/results/web-engine-full-thread-build-results.json)。

### 正常模式帧率对照

`resource-tables-v3-abba.json` 四轮依次为旧、新、新、旧；每轮预热 20 秒、测量约 15 秒，视角、项目设置及渲染尺寸检查一致。此次测量后台游戏已经退出，其他原生构建/探针也已结束。因此只能比较本组新旧包，不能把这里的 53 FPS 与上轮受游戏干扰的 20 FPS 相减归因给本修复。

| 轮次 | FPS | RHI 工作 ms/帧 |
| --- | ---: | ---: |
| 旧包 1 | 52.937 | 14.245 |
| 新包 1 | 53.340 | 14.131 |
| 新包 2 | 53.140 | 14.173 |
| 旧包 2 | 52.890 | 14.322 |
| 旧包合并 | **52.913** | **14.283** |
| 新包合并 | **53.240** | **14.152** |

FPS 按总帧数/总测量时间合并，差值 **+0.62%**；RHI 工作时间按测量帧数加权，差值 **−0.92%**。差异很小，本次不能视作显著帧率提升，也没有足够重复组估计统计置信区间。

新包第一轮预热后的计数约为 **571 次资源表提交、624 个 UB/帧，首次绑定来源解析为 0 次/帧**。draw 仍需要整理组描述和动态偏移，接入公共解析器只消除了其中一部分工作。

纹理流送由旧包 resident/requested 5728 mips、482213968 bytes，变为新包 5731 mips、482820176 bytes，增量约 0.58MiB。公共资源表路径现在会更新纹理 last-render time，可能影响此处请求；本组测试没有单独隔离这个因素，不能认定因果。没有修改流送池或纹理质量配置。

原始记录：[四轮对照](G:/UE_HTML/ue_html/tests/web-platform/results/resource-tables-v3-abba.json)。

### CPU 图与画面核对

新旧分别录制 5 秒 CPU 采样和独立的 5 秒 API 计数，均完成，无运行错误。CPU 图按实际采样期间的 RHI 帧数归一化：

| 所选函数的采样 self 合计，ms/帧 | 旧包（243 帧） | 新包（241 帧） |
| --- | ---: | ---: |
| `CreateGroups` 所有同名采样节点 | 1.633 | 1.498 |
| 旧 `ResolveBinding` / `ResolveUniform`，新 `ResolveDrawBinding` / `CommitShaderResources` | 0.863 | 0.480 |
| 上述范围合计 | 2.496 | 1.978 |

这些是所选函数的统计采样 self，受内联、符号归属和录制扰动影响，不能当作精确耗时或相加推算 FPS。尤其旧图存在 `ReleaseConstants → Realloc → free → mutex_unlock` 热点，新图则有较大的 `SetDrawBindings` self，单组短录制不足以证明这两者是独立变化。整体收益以正常模式 ABBA 为准。

API 计数进一步说明剩余工作基本不变：`setVertexBuffer` **7959.96 → 7973.33 次/帧**，`setBindGroup` **1397.47 → 1399.27 次/帧**，`createBindGroup` **80.20 → 80.25 次/帧**。这次减少了重复的绑定来源解析，未减少场景绘制或这些 API 提交。后续仍应优先评估引擎并行绘制路径、顶点读取方式，并在修改前区分分配器与编码开销。

可查看 [旧包 CPU/API 性能图](G:/UE_HTML/ue_html/tests/web-platform/results/performance-capture-resource-tables-v3-baseline-profile.html)、[新包 CPU/API 性能图](G:/UE_HTML/ue_html/tests/web-platform/results/performance-capture-resource-tables-v3-candidate-profile.html)、[采样与 API 汇总](G:/UE_HTML/ue_html/tests/web-platform/results/resource-tables-v3-profile-comparison.json)。页面包含 worker CPU 火焰图及 pass/API 数据；旁边保留原始 `.cpuprofile` 和 trace 文件。

四轮截图人工核对未见明显画面回归。旧新图的 RGB 平均绝对差约 **0.82/255**，旧旧约 **0.76/255**，新新约 **0.83/255**，处于重复录制的波动范围。这不是全场景像素正确性的证明。见 [旧左新右截图](G:/UE_HTML/ue_html/tests/web-platform/results/resource-tables-v3-scene-pair.png)、[截图差异记录](G:/UE_HTML/ue_html/tests/web-platform/results/resource-tables-v3-scene-comparison.json)。

### 验证边界

早期诊断扩展曾因单次 EM_ASM 参数超过 16 个而在约第 31 帧触发 JS 异常；现已拆分，以上最终普通模式测试覆盖到千帧，失败的早期录制不进入上表。

原生模块的编译/链接已检查；原生像素探针缺少现成 shader fixtures，补建时又遇到 Worker 批次不匹配，未列为通过项。新增的原生资源表复用/纹理引用回归检查保留在探针中，本次实际场景验收以网页测试为准。

## 复现

```powershell
& tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -SkipHostPreparation -MaxParallelActions 4 -StandaloneCompiles
node tests/web-platform/package-web-project.cjs --project=triplex-project --desktop --threads --distance-fields --reuse-cook --output-folder=villa-resource-tables-candidate

$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-project-gameplay.cjs --folder=villa-resource-tables-candidate --tag=resource-tables-normal-v3 --runs=1 --seconds=45 --dpr=1.25 --require-render-threads --require-gpuscene --require-resource-tables
node tests/web-platform/probe-web-project-gameplay.cjs --folder=villa-resource-tables-candidate --tag=resource-tables-validation-v3 --runs=1 --seconds=45 --dpr=1.25 --require-render-threads --validate-binding-cache --require-gpuscene --require-resource-tables
node tests/web-platform/compare-web-rhi-adaptation.cjs --baseline=villa-gpuscene-candidate --candidate=villa-resource-tables-candidate --tag=resource-tables-v3 --headless --warmup-seconds=20
```

性能阶段不开绑定校验、API 计数/计时或 CPU 采样；录制工具的诊断钩子仍安装。CPU/API 捕获单独运行，不把其帧率混入 ABBA。后台应用是否运行及 GPU 占用应随各次测量记录，不能直接与上一轮受另一游戏干扰的绝对帧率比较。

本次只处理资源表更新。并行 MeshDrawCommand/RDG/RHI、manual vertex fetch、PSO 预缓存等后续候选仍按 [引擎机制复用审查](UE58_WEBGPU_ENGINE_REUSE_AUDIT.md) 的边界单独评估。
