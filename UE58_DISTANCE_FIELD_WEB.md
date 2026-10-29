# 桌面 WebGPU 距离场候选版

日期：2026-10-29。原生收益与实施依据见 [UE58_DISTANCE_FIELD_RESEARCH.md](UE58_DISTANCE_FIELD_RESEARCH.md)。

对应独立参考引擎提交：`5beee8ed1`。

## 本轮实现

接通桌面 SM5 的网格距离场 Cook、稀疏砖块图集、全局距离场和 UE 原有 DFAO 天空光链路。没有用屏幕 AO、统一压暗或修改材质替代。ES3.1 不参与本轮；Lumen、距离场阴影和体积纹理原子仍未作为支持项交付。

Cook 必须显式传入 `-DistanceFields`，打包必须显式传入 `--distance-fields`；打包校验 Cook、配置、平台能力和源码哈希匹配。候选输出目录带 `distance-fields`，未覆盖原发布目录。

底层新增或补齐：

- R8/G8、R32_FLOAT、R32_UINT 三维纹理视图及非零清除。
- G8 上传缓冲的明确 UNORM8 字节解码；float/int 标量存储缓冲和 Raw UAV。
- GPU 间接派发、非索引间接绘制及 16/32 位索引间接绘制，保留参数范围和资源状态校验。
- 像素 UAV 所需的 UE 既有占位渲染目标路径。
- DFAO 分块索引使用 32 位布局；缺少体积原子时不编译 Lumen coverage atlas 排列。
- Web 着色器显式存储格式和全屏插值声明。
- 大缓冲清除使用二维派发，避免 4K 下超过 WebGPU 单维工作组上限。

距离场流送沿用 UE 的 BulkData 和现有本地 OPFS IO，没有新增逐网格网络下载。贴图继续保持全分辨率与原有 1 GiB 纹理流送池。

## 验证与边界

真实 WebGPURHI GPU 回读通过 30 项检查，两个命令模式合计核验 33,587,298 个值。其中包含实际 Cook 的距离场上传着色器、非连续砖块、未覆盖区域、非零哨兵、间接参数偏移，以及跨越 65,535 个工作组边界的大缓冲清除。诊断着色器包由实际 Cook 的元数据和未修改 WGSL 重建；该测试与浏览器实际加载 Cook 着色器库的测试分别记录。

默认关卡和别墅均已完成桌面 Cook 与多线程运行时打包。别墅候选：

- 591 个有效唯一网格距离场。
- CPU 距离场资源 1,139,392 字节，可流送 BulkData 13,406,176 字节。这是 Cook 后计量，不应和未 Cook 原生资产大小强行等同。
- 网格图集实际尺寸 1024×1024×32，R8，约 32 MiB；全局场页图集 1024×1024×16，约 16 MiB。
- 4K 的 DistanceFieldNormal、BentNormal 历史纹理分别可达到 1920×1080 RGBA16F。日志按标签记录最后一次创建的纹理描述，**不是完整当前/峰值增量显存账本**。
- 本地 IO 读缓存上限仍为 16 MiB；BulkData 未完整复制进 MEMFS。复用持久化缓存的 Chrome 1080p 复验下载量为 0。

Chrome / Edge 的别墅 4K 实测均为内部 3840×2160、输出 3840×2160，开关、镜头移动、瞬移及返回原机位均通过，没有 GPU 验证错误或设备丢失。测试保留多线程，但 Game 与 Render/RHI 未分离。

默认关卡在 Chrome / Edge 的 1280×720 回归分别运行 981 / 965 帧通过，恢复残差分别为 0.035 / 0。默认关卡没有在本轮按 4K 验收。

客厅同机位 `(-20,200,130,12,-35)`，测试相机使用手动曝光、请求 EV100=-1。off → on → off 的平均 RGB 差约 81/255；恢复残差约 0.49/255。该差异不是画质评分，也不能证明与原生逐像素一致。网页和已有原生同机位图都能看到相近的楼板、墙面遮蔽分布及块状伪影。冰箱颜色差异未追查。

本机 RTX 3070 8 GB 的短时采样：

| 浏览器 / 分辨率 | 关闭中位数 | 开启中位数 | 恢复中位数 |
| --- | ---: | ---: | ---: |
| Chrome / 1920×1080 | 8.36 ms | 9.28 ms | 8.07 ms |
| Chrome / 3840×2160 | 27.57 ms | 28.92 ms | 26.66 ms |
| Edge / 3840×2160 | 27.27 ms | 29.66 ms | 27.46 ms |

每项为 12 帧 GPU 通道时间之和，遗漏复制和通道间空隙；不是完整 GPU 帧时间，也不是性能保证。整适配器显存采样约 6.8～7.7 GiB，包含浏览器和其他应用，不能用于推导 DFAO 净增量。尚未完成长期运行、后台恢复、精确资源寿命账本、不同显卡能力分级和完整桌面画质对齐。

## 入口

服务根目录为 `tests/web-platform`，端口 8765：

- `/build/ue-default-template-distance-fields-threads/index.html`
- `/build/triplex-house-villa-df-distance-fields-threads/index.html`

运行时诊断增加 `__webDistanceFields`。`WebDistanceFieldTest(0/1)` 和 `WebDistanceFieldTestExposure(EV100)` 仅用于测试，后者要求已通过 `WebProjectViewTest` 创建测试相机；正常进入关卡不会覆盖原曝光。

## 复现

以下命令在工作区根目录执行。Cook 的 `-SkipBuild` 要求已有与当前源码匹配的隔离 Cook host / shader worker / RenderCore / Renderer 构建；不匹配时会拒绝运行。

```powershell
& tests/web-platform/build-web-engine.ps1 -Threads -MaxParallelActions 4
& tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-SM5 -Scene DefaultTemplate -DistanceFields -SkipBuild -StopOnShaderError
node tests/web-platform/stage-web-engine.cjs --desktop --default-template
node tests/web-platform/package-web-default-template.cjs --desktop --threads --distance-fields

& tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-SM5 -Scene Project `
  -Project H:/ue_html/tests/web-platform/build/projects/triplex-house-villa-df/TriplexHouseVilla.uproject `
  -Map /Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla `
  -Profile H:/ue_html/tests/web-platform/cook-profiles/TriplexHouseVillaFullresDesktopEngine.ini `
  -ReportId triplex-house-villa-df -TextureCompression BC -CompressHDRCubemaps `
  -DistanceFields -SkipBuild -StopOnShaderError
node tests/web-platform/stage-web-engine.cjs --desktop --project=triplex-house-villa-df
node tests/web-platform/package-web-project.cjs --desktop --threads --distance-fields --project=triplex-house-villa-df

$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-distance-fields.cjs
node tests/web-platform/probe-web-distance-fields.cjs --edge
node tests/web-platform/probe-web-distance-fields.cjs --folder=triplex-house-villa-df-distance-fields-threads `
  --camera=-20,200,130,12,-35 --fixed-ev=-1 --width=3840 --height=2160
```

测试使用 H 盘独立持久化浏览器配置；大型关卡不适用临时隐身配置的较小配额。报告、PNG 和二进制回读在忽略的 `tests/web-platform/results` / `build` 中。`probe-distance-field-rhi.ps1` 需要预先准备距离场 probe 的 float/uint worker 着色器和 `prepare-distance-field-probe.cjs --conversion=<实际Cook的ShaderConversion目录列表>`；缓存命中的 Cook 不一定重新导出所有着色器，可用分号连接多个实际 Cook 输出目录。
