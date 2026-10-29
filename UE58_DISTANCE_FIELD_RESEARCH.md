# 别墅距离场收益验证与 Web 接入计划

2026-10-29。本轮只验证桌面距离场的实际收益和 Web 缺口，不实现网页距离场，不追查冰箱金属颜色变化。未修改原关卡或 `H:/UE_5.8` 安装目录。

## 结论

值得优先接入 **DFAO 对天空光的遮蔽**。同关卡、同机位、固定曝光下，关闭 DFAO 后，楼板下方、梁墙交界、柜体周围大幅失去明暗层次；重新开启后恢复。保持自动曝光时也能复现用户观察到的桌面差异。

这次变化主要来自 DFAO。仅开启 DFAO 与“距离场效果全部开启”几乎一致；仅开启距离场阴影与“全部关闭”几乎一致。场景实际灯光均未设置 `bUseRayTracedDistanceFieldShadows`，因此本轮不能据此评价距离场阴影的效果或成本。

这里补的是天空光遮蔽，不是新的间接光反弹。不能承诺接入后等同 Lumen，或解决所有光照差异。桌面开启 DFAO 的对照本身也有楼板下方的斑驳，后续验收应同时关注这些瑕疵，不能只比较是否变暗。

对照入口：

- `http://127.0.0.1:8765/results/villa-distance-fields-comparison.html`：三个机位、两种曝光、四项贡献对照和分割滑杆。
- `tests/web-platform/results/villa-distance-fields-comparison.png`：客厅自动曝光，左关闭、右仅 DFAO。
- `tests/web-platform/results/villa-distance-fields-final-1080p-verified.json`：图像差异、曝光、CSV 耗时、资源快照和来源哈希。

## 验证方法

使用安装版 UE 的原生 D3D12 / SM5，加载独立复制的原别墅关卡；不替换材质，不改变灯光强度或后处理体积资产。测试启动配置统一关闭硬件光追、GI 方法、反射方法和 VSM，与当前 Web 包的这些选择相同；原有反射捕获保留。本轮不是保留编辑器全部默认特性的最终画质验收。

输出原生 1920×1080，Screen Percentage 100%，无动态分辨率。纹理流送池设为 512 MiB，仅约束本轮桌面测试；它不同于正式全分辨率 Web 包的 1024 MiB，不据此比较两端纹理清晰度或总显存。材质时间冻结，保留眼适应；每项预热 240 帧，再采集 240 帧，CSV 有效 GPU 样本为 239 帧。

每个机位分别测试固定 EV100=-1 和关卡原自动曝光，按以下顺序切换：

| 项目 | r.DistanceFieldAO | r.DistanceFieldShadowing |
| --- | ---: | ---: |
| both | 1 | 1 |
| off | 0 | 0 |
| ao | 1 | 0 |
| shadows | 0 | 1 |
| restore | 1 | 1 |

主测试共 30 项；另做启动时禁用距离场资源的 12 项对照、客厅资源快照的 10 项复验。更早的 `baseline`、`living-check` 只用于探索，不作为本表性能基准。

| 机位 | 位置 cm | 俯仰 / 朝向 / FOV |
| --- | --- | --- |
| interior | -175, -80, 160 | -5 / 50 / 90 |
| kitchen | -175, -80, 160 | -5 / 230 / 90 |
| living | -20, 200, 130 | 12 / -35 / 90 |

客厅机位已查看实际截图，包含用户对照中的冰箱、白砖墙、挂钟、沙发和上层楼板。原生实测为 2241 个静态网格组件、591 个唯一网格，全部有有效距离场数据；SkyLight 为 Movable，强度 7，遮蔽最大距离 1000 cm。

## 画面结果

下表为固定曝光图像的平均 RGB 通道绝对差，范围 0～255；它是显示图像差异，不是物理亮度或画质评分。

| 机位 | off 对 ao | off 对 shadows | both 对 ao | both 对 restore |
| --- | ---: | ---: | ---: | ---: |
| interior | 94.09 | 0.14 | 0.14 | 0 |
| kitchen | 73.13 | 0.12 | 0.10 | 0 |
| living | 113.14 | 0.12 | 0.12 | 0 |

固定曝光的五个状态，实际曝光值均为 2。自动曝光下，客厅开启 / 关闭的曝光值为 2 / 0.577，室内为 2 / 0.427，厨房均为 2。因此自动曝光会参与最终差异，但固定曝光对照已经排除了“只因眼适应变化”的解释。

开关恢复后的相同状态图像逐像素一致。仅开阴影和仅开 DFAO 相比对应基准约 0.1/255 的残差，不足以解释主画面变化。本轮不对冰箱颜色单独归因。

## 耗时与资源

硬件为 RTX 3070 8 GB。主测试全适配器显存采样为 1614～3523 MiB，未处于之前显存耗尽的条件；该数值包含其他应用，不是 UE 单进程用量。

| 项目 | 原生测量 |
| --- | --- |
| GPU/SkyLightDiffuse 中位数 | 室内约 0.374 ms，厨房约 0.277 ms，客厅约 0.364～0.367 ms |
| 客厅固定曝光总 GPU 中位数 | both 6.55 ms，off 6.10 ms，ao 6.59 ms，restore 6.84 ms |
| 客厅独立复验总 GPU 中位数 | both 6.37 ms，off 6.02 ms，ao 6.65 ms，restore 6.48 ms |
| 当前网格距离场砖块图集 | 32 MiB |
| 全局距离场页图集 | 16 MiB |
| Bent Normal AO 纹理快照 | 2.4375 MiB |
| 591 个唯一网格 CPU 距离场资源 | 1,173,256 字节 |
| 其中 AlwaysLoadedMip | 861,208 字节，已包含在 CPU 资源中，不能重复相加 |
| StreamableMips BulkData | 13,028,008 字节，约 12.42 MiB |

`SkyLightDiffuse` 范围确实包围本轮的距离场光照计算；它包含其他天空光工作，**不是精确的 DFAO 净增量**。总 GPU 时间有频率和调度波动，其他机位甚至出现开启状态总耗时低于关闭的情况，不能用一次相减宣称固定性能代价。上述原生数字也不能预测 WebGPU 帧率。

静止预热后 `GlobalDistanceFieldUpdate` 很低，不能代表移动相机、移动模型或首次上传成本。资源快照按 `DistanceField` 名称筛选合计 79.10 MiB，但包含旧的 8/16 MiB 图集分配和 0.125 MiB 字体纹理，也不保证覆盖所有临时及历史资源，**不能当作精确增量显存**。Web 需要独立统计当前、峰值和延迟释放量。

运行时关闭 `r.DistanceFieldAO` 后，CSV 的网格图集仍为 32 MiB；“效果关闭”并不等于“资源释放”。另起进程设置 `r.GenerateMeshDistanceFields=0`，2241 个组件均无距离场，图集统计也不再出现。两个进程的纹理池与分配顺序不同，不能用整进程显存直接相减得出精确增量。

这些是未 Cook 原生资产的数据大小，不是未来 Web 内容包的准确增量。正式接入后必须对实际 Cook / 包清单重新计量。主测试没有崩溃，原生日志仍有项目既有的 Automation 条件失败、旧枚举导入及缺失 StarterContent 导入包消息，不能称为全日志零错误。

## Web 当前缺口

以下均已从本地源码核对，不是 WebGPU API 理论支持的替代验收。

| 层次 | 当前情况 | 需要完成 |
| --- | --- | --- |
| Cook 配置 | `TriplexHouseVillaFullresDesktopEngine.ini` 的 `r.GenerateMeshDistanceFields=0` | 仅在距离场候选配置生成并保留数据 |
| 目标平台 | `FWebCookSettings::UsesDistanceFields()` 为 false，且不支持 `DistanceFieldAO` 目标特性 | 两项同时接通；`StaticMesh.cpp` 的剥离判断任一不满足都会删除数据 |
| Shader 平台 | `SP_WEBGPU_SM5` 的 `bSupportsDistanceFields=false` | 依赖通过后启用编译及运行分支；ES3.1 保持独立 |
| 初始化 / 绑定 | `FXRenderingUtils.cpp` 的 Web 分支拒绝距离场参数 | 审计实际调用方并按能力恢复原生参数，不直接删除所有保护 |
| 体积纹理 | 已有云 3D 纹理，但白名单不含距离场所需的全部 R8 / R32_UINT 等格式 | 补采样、存储、视图、上传及格式能力协商 |
| UAV 清除 | 整数纹理清除拒绝 3D，缓冲只允许清零 | 补 3D 清除、非零及哨兵值的实际语义 |
| Typed Buffer | 目前主要覆盖 uint32 / uint4 / float4；部分 HLSL Buffer 被转为 StructuredBuffer | 核对 G8 UNORM、float、int 和索引步长；压缩字节不能直接当 float 元素读取 |
| GPU 间接执行 | DispatchIndirect 和部分 DrawIndirect 仍走未实现保护 | 补真实间接派发及物体分块剔除所需绘制，不靠 CPU 回读绕过 |
| 着色器 / 缓冲能力 | 顶点 SRV、原子数组和跨通道资源使用仍需验证 | 对实际 DF Shader 的 VS 读缓冲、存储原子、屏障和工作组尺寸做最小回读测试 |
| 资源流送 | 网格 DF 有 AlwaysLoadedMip 和 StreamableMips | 复用现有本地 OPFS / 异步 BulkData，不增加逐网格网络请求 |

全局距离场代码会保存 GPUScene 实例索引，但已核对的对象网格分配由 `bLumenEnabled && Lumen::UseGlobalSDFObjectGrid(...)` 控制。只接 DFAO 时不应据此直接扩大为完整 GPUScene / Lumen 移植；仍需核验这一路径的实际编译、绑定和消费者。

参考源码入口：

- `reference-engine/Engine/Source/Runtime/Engine/Private/StaticMesh.cpp:2628`：Cook 剥离。
- `reference-engine/Engine/Source/Runtime/Engine/Private/SceneManagement.cpp:78`：距离场编译条件。
- `reference-engine/Engine/Source/Runtime/Renderer/Private/FXRenderingUtils.cpp:163`：Web 参数保护。
- `reference-engine/Engine/Source/Runtime/Renderer/Private/IndirectLightRendering.cpp:2214`：实测 GPU 范围及距离场光照调用。
- `reference-engine/Engine/Source/Runtime/Renderer/Private/GlobalDistanceField.cpp:908`：对象网格的 Lumen 条件。
- `reference-engine/Engine/Source/Runtime/Engine/Public/DistanceFieldAtlas.h`：网格距离场及可流送数据。
- `tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp`：纹理、缓冲、UAV 与资源状态。
- `tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUUnsupportedRHI.h`：间接执行保护。

## 建议实施顺序

1. **保留资源并补基础能力。** 独立桌面候选构建接通 Cook 的两个条件，核对网格数量、体积尺寸、mip 和内容哈希；为 3D 读写 / 清除、压缩 Typed Buffer 解码、原子和间接执行做真实 GPU 回读。先让一个实际网格距离场与原生采样值一致，再扩到场景。
2. **接网格图集、全局距离场和本地流送。** 复用 UE 稀疏砖块及全局距离场更新算法，恢复对象缓冲与参数；异步读取现有本地资源，复用 staging / fence 回读能力处理流送请求。分别记录 CPU 常驻、暂存、GPU 图集和历史的预算，覆盖相机穿行、瞬移和模型更新。
3. **恢复原生 DFAO 天空光链路。** 接通对象剔除、锥体追踪、历史重投影、上采样及天空光合成，保留原有光源、曝光和材质。同关卡同机位做 off → on → restore；固定曝光验证贡献，自动曝光验证最终观感。不用统一压暗、对比度或屏幕 AO 代替。
4. **浏览器验收后发布。** Chrome / Edge 分别测试默认关卡与别墅，覆盖原生窗口分辨率、4K、运动历史、后台恢复和流送压力。与本轮桌面图像对照，测真实 Web GPU 时间及 8 GB 环境总显存；单独保留能力不满足时的明确选择。距离场阴影作为后续独立项，不与本轮 DFAO 收益混报。

每个阶段先完成可审查的小交付及验证，再扩大范围。基础能力和全局场通过前，不在当前发布包中直接打开距离场总开关。本轮没有测 Web DFAO，也没有给出它的工期或帧率保证。

## 复现与验证

```powershell
& tests/web-platform/capture-villa-distance-fields.ps1 -Mode prepare
& tests/web-platform/capture-villa-distance-fields.ps1 -Report final-1080p
& tests/web-platform/capture-villa-distance-fields.ps1 -NoDistanceFieldResources -Report no-resources-1080p
& tests/web-platform/capture-villa-distance-fields.ps1 -View living -Report living-resource-1080p
& tests/web-platform/analyze-villa-distance-fields.ps1 -Report final-1080p
& tests/web-platform/analyze-villa-distance-fields.ps1 -Report no-resources-1080p
& tests/web-platform/analyze-villa-distance-fields.ps1 -Report living-resource-1080p
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/verify-villa-distance-fields.cjs
```

`prepare` 使用现有准备脚本复制原项目并编译工作区编辑器模块。`capture` 在独立隐藏的原生编辑器进程内运行，可选钩子为 `-WebDistanceFieldComparison=<json>`，未传参数时不执行。没有保存修改后的地图。

本轮原生模块构建通过，30 项主对照、12 项启动资源关闭及 10 项资源复验完成；图像、曝光、CSV 来源哈希和资源快照核验通过。对照页在 Chrome 的 1440×1000 与 390×844 视口测试了全部 48 个选项组合，图像尺寸、菜单和滑杆通过，无页面及网络错误。只验了静止镜头，未将其当作运动、4K 或长期运行验收。生成项目、PNG、CSV、日志和报告位于忽略目录 `tests/web-platform/build` / `results`。
