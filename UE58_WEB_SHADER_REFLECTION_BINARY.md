# Web 着色器反射数据：JSON 热点与二进制迁移

2026-11-04 后续：本文记录早期 schema 2 迁移，当时运行时仍还原 JSON 对象树。现已改为从 Compact Binary 直接读取原生结构，正常路径不再创建该树；新实现、验证及启动对照见 [原生元数据读取](UE58_WEB_NATIVE_SHADER_METADATA.md)。下文旧版数据保留作为历史对照。

## 热点具体在做什么

反射数据记录着色器需要的纹理、采样器、缓冲区、绑定槽位、参数类型和字节偏移。例如 UE 需要据此知道某张纹理属于哪个 bind group、相机矩阵应该写入常量缓冲区的哪个位置。这里的“反射”不是画面上的镜面反射，也不是每次启动重新运行 HLSL 编译器。

之前的 Web Cook 已经完成反射和 WGSL 转换，但把结果保存成了 JSON。启动时 `FWebGPUDynamicRHI::LoadShader` 会把 UTF-8 文本转换为 FString，再用 UE 的通用 JSON reader 建立对象树。调用发生在 RHI Owner，集中解析会推迟 WebGPU 管线请求的发起和回调处理。

原始原生 trace 中，1,685 次着色器加载共花费 3.701 秒，其中 `WebShader_MetadataJSON` 为 3.289 秒；同期 `WebShader_CreateModule` 的 C++ API 调用累计约 0.220 秒。后者仅代表同步调用边界，不是浏览器后台完整编译时间。

因此 JSON 的 CPU 开销和浏览器内部 PSO 编译/缓存处理是两个问题。用户实际 28.071 秒启动记录末尾仍有大量 PSO 等待，优化反射不能单独消除这部分等待。

## 为什么不用引擎已有能力

应当使用二进制。JSON 是早期便于诊断字段时留下的实现，并非 WebGPU 限制。

本地 UE 5.8 的 `D3D12Shaders.cpp::InitStandardShaderWithCustomSerialization` 使用 `FMemoryReaderView` 和 `SerializeShaderResourceTable` 读取 Cook 产物。Web 特有的 WGSL group/binding 映射仍需保存，但没有理由必须用文本表示。

Babylon.js 的 [WebGPU 实现说明](https://raw.githubusercontent.com/BabylonJS/Documentation/master/content/setup/support/webGPU/webGPUInternals/webGPUOverview.md) 同样保留缓冲区、参数、纹理和采样器的布局信息；其[计算着色器说明](https://doc.babylonjs.com/features/featuresDeepDive/materials/shaders/computeShader/)要求提供绑定映射，因为浏览器接口不直接返回 WGSL 的这些反射结果。这支持保留绑定数据，并不支持启动时额外解析大型 JSON。

本次复用 UE Core 的 [FCbWriter / Compact Binary](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Core/FCbWriter)，避免另写二进制格式和底层解析器。

## 最终改动

- Cook 将反射结果写为 UE Compact Binary，包头 schema 升为 2，并更新 shader format/DDC 版本。WGSL 编译路径不变。
- RHI 直接验证并读取二进制类型、数值和字符串，省去 UTF-8 整体转换和 JSON 词法/数字解析。
- 为控制改动范围，读取结果仍构造成现有绑定代码使用的 UE 对象树；尚未改为全程访问二进制视图，因此对象分配和字段查找仍有成本。
- schema 1 的旧 Cook 包保留原来的 JSON 读取路径。诊断 API 可把二进制转换成可读文本；游戏加载路径不进行这次转换。
- 诊断用 JavaScript 包解码器同步支持 schema 2，游戏运行时使用的是 UE 的 C++ 读取实现。

## 被撤回的尝试

将反射解析移回调用线程、逐个转发 GPU 模块创建，会引入大量同步线程往返，整段启动明显变慢，已撤回。

UTF-8 JSON view 两轮原生 trace 的累计解析约 3.50 / 3.46 秒，没有显示收益。对现有 JSON 预先去掉每行缩进的 A/B/B/A 中，原版解析约 3.328 / 3.335 秒，改动版约 3.325 / 3.317 秒，差异不足以证明有效。这些改动全部撤回，未修改 UE 通用 JSON reader。

上述 trace 对照按解析 scope 比较；切换 WASM 版本有资产重新读取，不能把整页总时间差全部归因于解析实现。

## 原生等价性验证

从实际 Villa 包的两份 UE shader archive 提取全部 3,852 份元数据。原生 commandlet 对每份执行 JSON 解析、UE Compact Binary 写入、二进制读取，并用 UE `FJsonValue::CompareEqual` 检查全部字段和值相同。

| 同一批元数据 | JSON | UE Compact Binary |
|---|---:|---:|
| 保存大小 | 176,553,912 B | 104,989,760 B |
| 原生解析/读取累计 | 3,591.52 ms | 2,164.13 ms |

这里覆盖完整 Cook 库，并非仅启动实际加载的子集；原生时间不等于浏览器时间。体积减少约 40.5%，本次原生读取样本耗时减少约 39.7%。

额外验证中文字段/值、转义控制字符、空对象/数组、布尔、null、小数及大整数；拒绝 4 个截断输入和 1 个尾随垃圾输入。独立 JavaScript 读取器也通过全部 3,852 份原始 JSON 的逐对象等价性和同样的异常长度检查。

原生结果：`tests/web-platform/results/villa-shader-metadata-probe-v28/metadata-probe.json`。

## 完整场景验证

新运行时已通过旧 JSON Villa 包的浏览器启动和首帧完成验证；这次运行与 Cook 并行，只用于兼容性验证，不用于性能结论。

二进制 Villa 已在独立目录按原项目设置重新 Cook，退出码 0，shader failures 为 0。原项目全部 1,632 个输入文件的哈希保持一致。两份归档共 3,852 个条目全部为 schema 2；新旧归档的 WGSL 清单和反射语义清单逐份匹配，比较时仅排除有意更新的 schema / formatVersion。

普通包与 trace 包分别使用同一份运行时对照新旧 Cook；每对的 WASM 和 config-files.json 哈希相同。PSO 并发均为 8，未加画质覆盖。

### 浏览器原生 trace：A/B/B/A

Cook、编译和 Insights 导出均未与这些性能捕获同时运行。每轮关闭后重开同一 Edge 测试 profile，启动至 60 游戏帧后导出原生 trace。

| 轮次 | 格式 | 实际加载着色器数 | 反射读取累计 | UE Init / 打开关卡 |
|---|---|---:|---:|---:|
| A1 | JSON | 1,682 | 3.598 s | 8.194 s |
| B1 | Compact Binary | 1,681 | 1.863 s | 7.148 s |
| B2 | Compact Binary | 1,686 | 1.796 s | 6.716 s |
| A2 | JSON | 1,685 | 3.546 s | 8.432 s |

反射读取累计均值 **3.572 → 1.829 秒，减少约 48.8%**。捕获结束前的少量延迟加载使总数量略有变化；占主要停顿的同一批 1,475 个着色器在四轮中数量完全一致，其反射读取分别为 2.912 / 1.531 / 1.485 / 2.872 秒。二进制两轮没有进入旧 JSON 读取 scope。

UE Init 均值约 8.313 → 6.932 秒，减少约 1.381 秒。反射位于 RHI 线程，与其他线程工作及等待重叠，不能把累计读取时间直接相加解释整段启动。

切换内容包会使应用缓存重新下载整个 content.bin：A1 / B1 / A2 的记录包含重新取得资产。因此不将这些轮次整页总时间的差值视作反射优化收益。

### 普通包：完整资产缓存命中的启动样本

另用非 trace 的普通包各捕获两轮，保留首轮记录，下面只比较各自第二轮。两轮均 `downloadedBytes=0`、`persistentHits=2`，设置和输出分辨率一致。手动导出按钮也通过真实下载验证。

| 阶段 | JSON | Compact Binary |
|---|---:|---:|
| WASM instantiate，含资产等待 | 0.227 s | 0.235 s |
| 内容挂载 | 2.671 s | 2.013 s |
| PreInit | 2.342 s | 2.001 s |
| UE Init / 打开关卡 | 7.564 s | 6.092 s |
| 启动线程验证和同步 | 1.426 s | 1.502 s |
| **导航至加载层撤下后两个 RAF** | **17.327 s** | **14.847 s** |

本机这对缓存命中样本的可见边界提前 **2.480 秒**。这是页面标记，不是显示器扫描输出，也不是捕获脚本的 elapsedMs；后者还包含后续等待，不能混用。挂载和 PSO 排队也有变化，不能把全部 2.480 秒归给反射解析。此处每种格式只有一个符合完整资产缓存条件的普通启动样本；它不代表用户之前 28.071 秒、PSO 尾部明显更长的那次浏览器状态。

四轮 trace 与四轮普通启动均无未捕获 GPU 错误或崩溃，PSO 请求 1,108 个全部完成处理；其中原有 8 个 workgroup_size(512) 超过请求设备限制的计算预缓存拒绝仍存在。没有把“全部处理完成”写成“全部创建成功”。初始场景截图检查通过；本轮没有据此宣称稳定帧率或长距离移动已得到改善。

## 测试页和证据

- 普通测试页：[villa-reflection-binary-v28](http://127.0.0.1:8765/build/villa-reflection-binary-v28/index.html)，保留 FPS / 1% Low 和“导出启动分析”。新 Cook 首次打开需要重新取得内容包，应与后续缓存命中的启动分开记录。
- trace 包：`tests/web-platform/build/villa-reflection-binary-trace-v28`。
- 汇总及源文件 / Cook / 构建 / 捕获 / .utrace 的 SHA-256：`tests/web-platform/evidence/shader-reflection-binary-20261103.json`。
- 四轮完整原生 trace：`tests/web-platform/results/villa-reflection-abba-{a1,b1,b2,a2}-v28-0.utrace`。
- 普通包捕获：`tests/web-platform/results/villa-reflection-normal-{a,b}-v28.json`，对照选择 run 1，run 0 保留缓存状态证据。

后续进一步减少这部分成本，应让绑定代码直接消费二进制视图或固定结构，减少目前仍需建立的对象树。用户记录里的额外 PSO 尾部仍需单独关联 UE 管线身份、浏览器排队和缓存状态调查。
