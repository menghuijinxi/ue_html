# Nanite WebGPU 接入记录

更新：2026-11-06。首阶段完成可见性写入的编译、资源布局和执行验证。
这还不是完整 Nanite 支持，当前发布场景仍走既有网格路径。

## 已实现

- 在参考引擎 `NaniteWritePixel.ush` 增加
  `COMPILER_WEBGPU && WEB_NANITE_PACKED_VISIBILITY` 分支。
  只支持非调试的颜色可见性写入，每像素保持完整 32 位 ID 和 32 位深度位模式。
- 可见性目标使用每元素 8 字节的结构化缓冲区。
  写入期间为 `atomic<vec2<u32>>`，结束后可作为 `uint2` 只读结构化缓冲区消费。
  这不是 R64_UINT 纹理模拟，也没有把深度和 ID 拆成两个独立的原子竞争。
- 不读取正在原子写入的目标；`EarlyDepthTest` 保留深度钳制，略过可选的提前拒绝。
  最终可见性仍由整体原子最大值确定。
- 新增像素坐标、零宽度、缓冲区行容量检查；先除后乘，避免线性地址溢出。
- 原生与浏览器 RHI 仅在适配器提供时申请 `atomic-vec2u-min-max`。
  加载需要该扩展的着色器时检查设备特性，缺失则明确失败。
- 更新 Web ShaderFormat 缓存版本，接入本地 Cook 着色器覆盖审计。
  安装目录 `H:/UE_5.8` 未修改。

## 编译约定

固定 Tint 的 SPIR-V reader 不能接收通用 Int64，当前采用受限编译原语：

1. HLSL 声明保留前缀 `WebNaniteAtomicMax_` 的 `RWStructuredBuffer<uint>`。
2. 通过无返回值的 `InterlockedCompareStore(target, ID, depthBits)` 传递两项输入。
   这只是中间表示，不能执行其标量语义。使用带副作用的指令，避免普通 store
   在 DXC 优化时被合并或删掉。
3. DXC/SPIR-V/Tint 产生丢弃返回值的 `atomicCompareExchangeWeak`。
4. `WebGPUNaniteAtomics.h` 按 token 和结构解析这一受限形式，将目标转换成独立的
   `array<atomic<vec2<u32>>>` 类型，将每次调用转换为
   `atomicStoreMax(target, vec2<u32>(ID, depthBits))`。
5. 更新最终资源步长为 8，移除中间标量格式，再由 `tint_info` 验证 WGSL、
   资源反射与 UE 参数绑定，然后才生成 Web shader packet。

转换器拒绝普通读写、分量写入、其他原子操作、消费 compare 返回值、指针逃逸、
资源类型或反射数量不符。未知形式直接编译失败。
共享旧结构类型的普通资源不变。该约定只供 Web 原语使用，不能当作通用 HLSL 原子转换。
更换 DXC/Tint 后必须重跑连续写入与资源布局测试。

## 验证结果

设备：NVIDIA GeForce RTX 3070，原生 Dawn D3D12；浏览器报告 NVIDIA/Ampere、非 fallback。
Chrome `157.0.8103.39`，Edge `157.0.4341.42`，均无附加实验开关。

| 验证层 | 本轮结果 |
| --- | --- |
| UE 实际 include 编译 | `NaniteWritePixel.ush` 经现有 ShaderFormat 编译 CS/VS/PS；另编译只读消费 CS |
| 编译器防误用 | 9 项拒绝检查通过，共享类型及普通着色器保持不变 |
| 优化语义 | CS/PS 同线程先写胜者、再写较弱值；两次写入均保留为整体原子操作 |
| Chrome 与 Edge | 各 10 组 GPU 回读通过，零未捕获 GPU 错误 |
| UE 原生 RHI | recorded/bypass 两种模式各 6 项通过，实际 UE 参数绑定、子视图与 dispatch |
| Wasm64 后端 | `BrowserDynamicRHI.cpp` 线程配置编译通过；未重新链接、打包完整场景 |
| ShaderCompileWorker | program 版本模块构建通过；本轮着色器验证使用 host 的直接编译路径 |
| 已有顶点取数回归 | 重新编译后 8 组格式 GPU 回读通过 |

浏览器用例包含 8,199 个候选值争用、无符号 ID 同深度排序、深度优先级、
深度钳制、片元与计算的两种提交顺序、非零缓冲区视图偏移、短视图、越界坐标、
零宽度和极端宽度。每组检查前后保护区、输入未被改写，以及随后只读消费的逐字结果。
其中单独的混合胜者用例确保片元和计算阶段都能贡献最终像素。

证据快照：`tests/web-platform/evidence/nanite-ue-visibility-20261106.json`。
原始 WGSL、packet、反射、日志在忽略目录 `tests/web-platform/results/nanite-ue-*`。
宿主使用 CPU affinity 3；一次未限制亲和性的运行在进入 commandlet 前发生
CoreUObject 访问异常，改用该宿主配置后完整流程通过，未将其认定为 Nanite shader 错误。

## 复现

前提：既有隔离 Cook host、固定 Dawn/Tint、DXC、Web 平台配置已准备，
Chrome/Edge 和 Playwright 可用。

```powershell
cd H:/ue_html
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
./tests/web-platform/probe-nanite-ue.ps1
```

默认构建宿主与 Worker 模块，审计并准备覆盖，编译实际 UE shader，
运行原生 RHI 和两种浏览器。已构建时可加 `-SkipBuild`。
仅重跑浏览器可执行 `node tests/web-platform/verify-web-nanite-visibility.cjs`。
浏览器验证自建临时 localhost 服务，结束后释放。

## 尚未接通

- 渲染器 RDG 可见性缓冲分配、原生 R64 纹理消费者到缓冲区的切换；
  当前只读消费是独立探针，尚未连接 UE 的 HZB、DepthExport、材质和 GBuffer。
- Nanite 真实资产 Cook 数据保留、页解码、cluster 层级 LOD 与剔除、
  VS/PS 光栅和 Compute 微三角形光栅的完整接入。
- 页流送、缺页请求、淘汰与依赖 fixup、冷/热缓存及设备恢复。
- 默认带灯光天空的关卡验收，以及高密度资产性能与原生同视角对比。
- 不具备新原子特性的设备兼容路径。

`bSupportsNanite`、`bSupportsUInt64ImageAtomics` 和 Wave 平台声明保持原值。
不能据本轮检查宣称通用 64 位原子、全部 Nanite permutations、真实 Nanite 场景
或硬件光追已受支持。本轮结果也不能用于估计完整 Nanite 的帧耗时。

下一阶段先接 RDG 缓冲与深度/HZB 消费，保留一个真实 Nanite 资产的构建数据，
跑通驻留页、cluster 剔除和固定不透明材质的 VS/PS 路径，再扩展材质与流送。
