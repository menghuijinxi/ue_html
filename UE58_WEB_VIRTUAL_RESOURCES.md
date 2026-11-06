# Web 虚拟纹理与虚拟阴影

2026-11-06，测试项目为 `H:/TriplexHouseVilla/TriplexHouseVilla.uproject`。
原始工程已选择 `r.Shadow.Virtual.Enable=1`；配置没有显式覆盖
`r.VirtualTextures`，UE 5.8 的该变量默认值为 1。
引擎基础适配提交：`8d947d8baa`。

## 当前状态

基础资源、着色器转换和浏览器管线验证通过。完整别墅与 VT 对照场景 Cook、打包均已完成，
别墅运行包约 3.65 GB，对照场景约 622 MB；浏览器关卡验收尚未完成，
不能把这些基础结果当作虚拟纹理流送、虚拟阴影画面或桌面效果对照通过。

测试副本为 `tests/web-platform/build/projects/triplex-virtual`，
使用 `--project-settings` 保留原工程渲染设置。原始工程和 `H:/UE_5.8` 安装目录不作修改。

资产只读检查找到 689 张 Texture2D，其中 688 张缺失资产索引标签，
已加载读取真实属性；启用资产级 `VirtualTextureStreaming` 的数量为 0。
因此当前别墅只能验证全局 VT 支持开关，不能单独证明实际 VT 流送可用。
检查脚本为 `tests/web-platform/inspect-virtual-texture-assets.py`，
结果为 `tests/web-platform/results/virtual-texture-assets.json`。
隔离副本 `triplex-vt-fixture` 已从默认光照关卡创建普通纹理/虚拟纹理对照板，
使用相同的 1024 像素多尺度棋盘图。原生四视角截图及色彩检查已完成；
此样例已完成 Cook 和打包，浏览器验证仍在进行。浏览器通过条件还包括移动相机后的新增物理页上传，
不能只凭 VT 资源对象存在判定流送通过。

## 实现范围

- Web 桌面 SM5 路径启用虚拟纹理能力判断及非 Nanite VSM；ES3.1 不作为验收路径。
- VT 页表更新改用原始字节缓冲区，按每条四个 uint16、共 8 字节解包。
  原来的通用 typed-buffer 转换会把这类数据误读为 16 字节记录。
- VSM 的 R32_UINT 纹理原子操作转成 WGSL 存储缓冲区原子操作。
  每个 mip 有独立镜像，包含尺寸、行跨度与数组层数；访问执行坐标边界检查。
  RHI 在资源转换时同步纹理与镜像，保留现有页标记、清理和采样算法。
- 非 Nanite 剔除的六组 CPU 元数据合并成一个 SRV；层级页表的两组页边界临时合并，
  计算完成后复制回现有缓冲区。普通剔除占 15 个存储缓冲区，HZB 剔除和层级页表占 16 个。
- Web VSM 使用 UE 现有的普通原子计数分支。SMRT 继续执行完整射线采样，
  暂不使用依赖非一致子组控制流的提前退出优化。
- VSM 剔除着色器中的网格边界 ShaderPrint 调试输出局部关闭，以满足 HZB 模式的绑定上限。
  保留 UMG/Slate 及实际阴影渲染。
- 运行时诊断增加 VT/VSM 路径状态，以及已加载 VT 资产和实际 VT 资源数量。
  开启项目支持本身并不能证明关卡材质正在使用虚拟纹理。
- VSM 启用的 HZB Froxel 路径在 WGSL 中不能使用共享内存投票控制屏障。
  Web 分支用容量为候选数两倍的共享原子哈希表去重，保留全部深度单元；
  屏障只在一致控制流中执行，原生分支不变。
- VT 物理页的 `UpdateTexture2D` 支持 BC1/2/3/4/5/6H/7 及已有采样颜色格式，
  按压缩块处理源偏移、行填充、区域边界和 mip，保留上传数据快照及命令顺序。
- VSM 投影的 Wave Operations 断言允许已有的 Web 标量实现；
  缓存动态标记位图按完整 uint32 上传，避免 279 字节等尾部范围不满足 WebGPU 四字节对齐。
- VT 物理池支持显式线性/sRGB 采样视图；同时带存储用途时采用线性存储和 sRGB 采样视图。
- 绘制通道内允许 Volatile 缓冲从零偏移执行可丢弃写入，为新内容分配独立 GPU 缓冲。
  已记录绘制保留旧缓冲，绑定缓存重新解析新缓冲；普通缓冲、部分偏移及读锁仍受原校验约束。
- 共享 View 采样器的 mip 偏移由 WGSL 的显式 bias 或梯度缩放实现，保留显式 LOD 语义。
  使用无 ICU 依赖的词法解析，偏移常量随绑定更新，已提交绘制保留各自的常量缓冲。
- 依据适配器能力申请 16K 二维纹理上限，覆盖非 Nanite VSM 的完整光栅视口。
  VSM 合成的 RG16 UNORM 遮罩使用不可过滤的整数坐标读取绑定。
- 天空光单向量读取支持 64KB 池化分配，仅绑定所需的 16 字节范围。
- 顶点管线只包含反射中实际使用的属性，允许 VSM 分块间接绘制附带冗余的 UE 顶点声明。
- VT/VSM 诊断状态合并为位标志，遵守当前 Emscripten 单次 EM_ASM 最多 16 个参数的限制。

## 已完成验证

| 检查 | 结果 |
| --- | --- |
| 项目设置与覆盖顺序 | 12 项断言通过 |
| 既有 Lumen 设置检查 | 10 个用例通过 |
| VT/VSM 全局着色器转换 | 71 类、358 个可编译排列通过；绑定调整后定向重测 |
| Edge WebGPU 模块与管线 | 358 个模块、335 条计算管线通过 |
| 实际 UE VT 页表绘制回读 | 6/8 位物理页坐标编码、零/非零更新起点；2048 个像素无差异 |
| 原生 Dawn 原子镜像回读 | 12 组尺寸/mip/数组组合；22401 个值核对通过 |
| HZB Froxel 实际 GPU 回读 | 重复、碰撞、负深度切片、无限深度及不完整视口五例通过；集合、计数、HZB 像素无差异 |
| VT 区域上传原生 GPU 回读 | 11 种格式、mip 0/1 共 22 例，7260 字节无差异；既有 12 组原子测试重测通过 |
| 隔离 RenderCore、Renderer 与线程 Wasm | 编译通过，最终打包仍须核验构建摘要 |
| 原生截图基线 | 别墅三个视角及 VT 样例四个视角完成；VSM=1，保留工程设置 |
| 完整项目 Cook / 打包 | 别墅与 VT 对照场景通过，均使用原项目设置和桌面 SM5 |
| 线性/sRGB 视图实际采样 | RGBA8、BGRA8，以及带 UAV 的 RGBA8，共 9 例通过 |
| 通道内 Volatile 缓冲版本 | 连续写入后左右红/绿两次绘制回读通过；原子镜像和纹理上传重测通过 |
| 共享采样器 mip 偏移 | -1、0、0.5、1、2 五组偏移；普通采样、显式 bias、梯度和固定 LOD 共 80 个像素通过 |
| 池化天空光缓冲 | 16 字节与 64KB 分配，GPU 写入后以单向量常量视图读取均通过 |
| 冗余顶点声明 | 三组 UAV 间接绘制忽略未使用属性，像素原子与纹理回读通过 |

页表绘制测试使用真实转换后的 `TPageTableUpdateVS` 与 `TPageTableUpdatePS`，
包含跨八个四边形实例边界的 11 条更新和未使用尾部实例。
原子回读包含重复调度、保留结果、清理后重写和错误资源契约拒绝。

主要证据：

- `tests/web-platform/results/web-virtual-resource-gpu.json`
- `tests/web-platform/results/web-froxel-gpu.json`
- `tests/web-platform/build/virtual-resource-rhi-upload/lumen-storage-rhi.json`
- `tests/web-platform/build/virtual-resource-runtime-rhi/lumen-storage-rhi.json`
- `tests/web-platform/results/virtual-texture-native-image-check.json`
- `tests/web-platform/results/villa-distance-fields-virtual-native-capture.json`
- `tests/web-platform/results/villa-distance-fields-vt-fixture-native-capture.json`
- `tests/web-platform/build/virtual-resource-rhi/lumen-storage-rhi.json`
- `tests/web-platform/build/virtual-resource-probe/20261106-100811/virtual-resource-shader-results.json`
- `tests/web-platform/build/virtual-resource-probe/20261106-101919/virtual-resource-shader-results.json`
- `tests/web-platform/build/virtual-resource-probe/20261106-102253/virtual-resource-shader-results.json`

此机器曾在默认 CPU 调度下出现 MSVC 内部错误和浏览器编译异常。
通过的重测使用 CPU 亲和性 `4294901760`；不据此作跨设备稳定性或性能承诺。

## 复现入口

```powershell
node tests/web-platform/verify-web-virtual-resource-settings.cjs
node tests/web-platform/verify-web-lumen-settings.cjs
./tests/web-platform/probe-web-virtual-resources.ps1 -AllPermutations
```

`verify-web-virtual-resource-gpu.cjs --input=目录1,目录2` 按后一个目录覆盖相同着色器排列，
逐个创建浏览器模块和计算管线，并执行真实页表绘制回读。输入应为探针的
`ShaderConversion` 子目录。测试报告包含实际输入文件摘要。

完整项目使用 `cook-web-engine.ps1 -Mode WebGPU-SM5 -Scene Project -UseProjectSettings`，
地图 `/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla`，报告 ID `triplex-virtual`。

## 尚未验收的边界

完整别墅画面、动态相机下的 VSM 更新/缓存、真实 VT 资产流送、运行性能和显存峰值尚需验收。
实际首帧已修复 VSM 投影断言、位图上传对齐、sRGB 视图与临时顶点缓冲上传。
已继续修复共享采样器偏移、16K 光栅范围、天空光池化缓冲、阴影遮罩绑定、
冗余顶点声明和诊断参数上限。浏览器持续运行及截图验收仍在进行。
浏览器探针使用专用持久配置和单个页面，避免大型资源包的隐私存储配额及恢复页面缓存锁干扰。
镜像同步增加了 GPU 存储与复制开销，当前优先验证正确性。
扩展全局探针检查的 1970 个模块中，有 55 个排列不能直接创建浏览器计算管线：
53 项属于 Lumen 头发/高度场/可视化路径的存储缓冲区超限，
2 项为 Histogram/Panini 的原始 RG32F 读写存储格式限制。
这些结果保存在 `web-virtual-cook-gpu-progress.json`，不应将 VT/VSM 专项通过扩大为所有全局排列通过。
不包含 Nanite、硬件光追、移动端兼容性或收费 SDK。
