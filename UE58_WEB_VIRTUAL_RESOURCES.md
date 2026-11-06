# Web 虚拟纹理与虚拟阴影

2026-11-06，测试项目为 `H:/TriplexHouseVilla/TriplexHouseVilla.uproject`。
原始工程已选择 `r.Shadow.Virtual.Enable=1`；配置没有显式覆盖
`r.VirtualTextures`，UE 5.8 的该变量默认值为 1。
引擎基础适配提交：`8d947d8baa`。

## 当前状态

基础资源、着色器转换和浏览器管线验证通过。完整别墅 Cook、打包及浏览器关卡验收尚未完成，
不能把这些基础结果当作虚拟纹理流送、虚拟阴影画面或桌面效果对照通过。

测试副本为 `tests/web-platform/build/projects/triplex-virtual`，
使用 `--project-settings` 保留原工程渲染设置。原始工程和 `H:/UE_5.8` 安装目录不作修改。

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

## 已完成验证

| 检查 | 结果 |
| --- | --- |
| 项目设置与覆盖顺序 | 12 项断言通过 |
| 既有 Lumen 设置检查 | 10 个用例通过 |
| VT/VSM 全局着色器转换 | 71 类、358 个可编译排列通过；绑定调整后定向重测 |
| Edge WebGPU 模块与管线 | 358 个模块、335 条计算管线通过 |
| 实际 UE VT 页表绘制回读 | 6/8 位物理页坐标编码、零/非零更新起点；2048 个像素无差异 |
| 原生 Dawn 原子镜像回读 | 12 组尺寸/mip/数组组合；22401 个值核对通过 |
| 隔离 RenderCore、Renderer 与线程 Wasm | 编译通过，最终打包仍须核验构建摘要 |

页表绘制测试使用真实转换后的 `TPageTableUpdateVS` 与 `TPageTableUpdatePS`，
包含跨八个四边形实例边界的 11 条更新和未使用尾部实例。
原子回读包含重复调度、保留结果、清理后重写和错误资源契约拒绝。

主要证据：

- `tests/web-platform/results/web-virtual-resource-gpu.json`
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
镜像同步增加了 GPU 存储与复制开销，当前优先验证正确性。
不包含 Nanite、硬件光追、移动端兼容性或收费 SDK。
