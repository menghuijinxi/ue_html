# Web 桌面局部灯立方体阴影

日期：2026-10-30。适用于 WebGPU SM5 桌面延迟路径。

## 问题与实现

此前 Web 策略直接排除了点光源和矩形灯的立方体阴影。SSR、TAA、SSAO、DFAO 或 LTC 正常执行，不能补回这部分遮挡。

现在区分两种能力：

- `SupportsOnePassPointLightShadows`：需要向多个纹理层输出的原生单遍路径，Web 仍不声明支持。
- `UsesSixPassPointLightShadows`：Web SM5 六遍绘制。
- `SupportsPointLightShadows`：供阴影创建、分配和投影使用，兼容上述两条路径。

Web 每面使用独立二维深度附件，复用 UE 的灯光矩阵、网格选择、材质透明裁剪与 WPO，然后复制到立方体对应面。缓存的静态深度先逐面复制，再叠加可移动物体；没有移动物体时继续直接使用 UE 的缓存。无需几何着色器、顶点层索引或 GPUScene。

投影继续使用 UE 的 `MainOnePassPointLightPS` 和 `CubemapHardwarePCF`。后端新增 `PF_ShadowDepth` 深度立方体、完整面复制、`SCF_Less` 比较采样器和 WGSL 深度纹理绑定。Tint 反射没有输出比较采样器类型，因此编译阶段按其规范化 WGSL 中的 group/binding 声明补充元数据，运行时依据元数据建布局。普通旧着色器的新增字段可缺省，原格式和缓存仍兼容。

Web 的 PCF 采样基在立方体竖轴附近改用另一条参考轴，避免叉积为零。原生路径保持原实现。

## 验证入口

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-cube-depth.cjs
node tests/web-platform/probe-web-distance-fields.cjs --edge --folder=triplex-house-villa-df-distance-fields-threads --cases=tests/web-platform/villa-cube-shadow-cases.json --tag=cube-shadow-shipped
```

底层浏览器探针验证六个深度面、静态缓存往返复制与比较采样的实际读回像素。场景探针要求六面均发生复制，且当前机位确实执行局部灯阴影投影；同时保留 SSR、SSAO、DFAO、TAA 和 LTC 检查。

旧包实测 306 帧，`cubeShadowDraws=0`、`cubeShadowCopies={}`，在投影断言处失败。第一次尝试遇到浏览器设备丢失，复测取得上述独立失败信号。

## 边界

六遍绘制比原生分层路径增加提交开销，复用静态阴影缓存降低重复绘制。此实现没有增加光追、虚拟阴影、静态光照、胶囊阴影或移动端支持。接触阴影和 AO 的最终像素贡献须单独对照，不能从立方体阴影恢复推断全部桌面效果已经一致。

## 最终结果

参考引擎的 RenderCore、Renderer 以及 WASM 多线程完整引擎目标构建通过。新增阴影着色器经 `-StopOnShaderError` Cook 成功。别墅和默认关卡都已重新 Cook、Stage、打包；别墅资源包 3,077,921,962 字节，页面共 10 个产品、3,261,868,274 字节。安装引擎被审计的输入哈希保持不变。

| 验证 | 结果 |
| --- | --- |
| `cube-shadow-shipped` | Edge 1280×720 正常时钟 369 帧；测试期投影 366 次；截至该机位截图六面分别复制 442 次 |
| `cube-shadow-off` | 只覆盖 `r.AllowPointLightCubemapShadows=0`；429 帧，投影计数 0，门把手投影消失 |
| `cube-shadow-quality` | Edge 车库/客厅/门厅 830 帧；纸箱、地毯、高光像素检查通过，TAA/SSR/SSAO/DFAO/LTC 保留 |
| `cube-shadow-default` | Chrome 默认关卡 648 帧，包含缩小和恢复窗口 |
| GPU 检查 | 上述四轮均无 GPU 校验错误、设备丢失或页面异常 |
| 底层六面回读 | 缓存往返复制与比较采样得到预期交替黑白像素，无 GPU 错误 |

首个新包在 RDG 创建状态转换时失败：`WebCubeShadowFace before=0x8200 after=0x80`。RHI 的深度资源校验遗漏了 `PF_ShadowDepth` 的 CopySrc/CopyDest；补齐后原失败场景通过。没有关闭 RDG 校验或改用无阴影回退。

`compare-villa-cube-shadows.cjs` 生成 `results/villa-cube-shadow-comparison.png` 和对应 JSON。三列分别为桌面参考、Web 关闭局部灯阴影、Web 开启。Web 单变量对照的平均绝对 RGB 差：

- 门把手投影区域：42.8796/255。
- 门框墙面：1.5071/255。
- 墙脚：1.1876/255。

这些数值证明局部灯阴影对最终像素有贡献，不是桌面一致性评分。门把手与花盆附近投影已恢复；墙脚仍有差别，且桌面参考的纹理驻留不同，尚不能宣称 AO、接触阴影和纹理细节全部对齐。本轮未增加新的完整 GPU 帧时间测量，六遍开销没有作为性能达标项验收。此前记录的浏览器 `STATUS_ACCESS_VIOLATION` 也未据此宣布修复。

额外的 Windows/Dawn 独立探针模块没有完成链接：MSVC 14.50 在 `WebGPUDynamicRHI.cpp` 报内部错误，14.44 在距离场/模式探针中也报内部错误或编译器访问冲突。日志保留在 `results/cube-shadow-native-rhi-build*.log`。这与实际 WASM 浏览器构建、原生 Cook 模块和浏览器 GPU 验证分别记录；没有把独立探针失败标为通过。

## 性能追踪补充

后续实测发现，六面缓存复制虽已实现，缓存创建入口仍漏接 Web 六遍能力，而且默认 150 MiB 预算存在压力。性能修正补上入口、允许 Web 普通静态深度复用，并将 Web 默认预算设为 256 MiB。缓存开关对照验证实际绘制与像素，详见 [性能记录](UE58_WEB_PERFORMANCE.md)。此前关于缓存降低重复绘制的说明不能替代这次运行验证。

## 2026-11-04：门厅大片错误投影

用户反馈的地面大片黑影可在别墅门厅复现。固定机位为 `(-775,-300,180)`，俯仰 `-30`、偏航 `270`、FOV `90`，画布 `1280×720`。原生端使用项目设置和相同机位捕获。问题属于六面局部灯深度提交，不是 Lumen 间接光本身的错误。

### 根因与修复

`ShadowDepthRendering.cpp` 的 Web 六面分支把 `FInstanceCullingDrawParams` 放在栈上，并立即复制给六个 RDG 绘制参数。UE 的延迟实例裁剪随后在 `FInstanceCullingMergedContext::MergeBatches` 回填 `InstanceDataByteOffset` 和 `IndirectArgsByteOffset`，此时原栈变量已失效，六份副本也仍然持有初始零偏移。部分灯光因此读取首个批次的实例或间接绘制参数，将不属于该灯光批次的几何写进阴影缓存。

修复将共享结果分配到 RDG 生命周期内存，六面绘制执行时都读取同一个、已回填的结果。各面的参数仍声明相同的缓冲区和 Scene 依赖，保留 RDG 资源跟踪。阴影缓存、批处理、Lumen GI、Lumen 反射和 TSR 均继续开启。

参考引擎提交：`6823184255`（修复 Web 六面阴影延迟实例裁剪参数失效导致的错误投影）。

单变量排查记录在 `results/lumen-shadow-isolation-20261104-*.json`：

- 关闭反射、WebGPU 绑定组缓存或网格动态合批均不能消除错误。
- 关闭局部灯立方体阴影会同时移除错误和正常投影，只用于定位。
- 关闭阴影缓存可去除大片伪影，但还会改变正常投影，不能作为修复。
- 同会话清空并重建阴影缓存，错误稳定复现，排除启动机位和一次性脏数据。
- 保留阴影缓存、仅关闭 `r.InstanceCulling.AllowBatchedBuildRenderingCommands` 后投影恢复，作为独立的同步参考。

### 回归结果

新增 `probe-web-lumen-shadow-artifacts.cjs`，校验产品哈希、固定相机、记录六面复制和 GPU 错误，并按同步参考的窗帘、地面区域断言平均绝对 RGB 误差不超过 `2/255`。旧包在同一断言上失败，修复包通过：

| 阶段 | 窗帘误差 /255 | 地面误差 /255 | 结果 |
| --- | ---: | ---: | --- |
| 旧运行时，缓存开启 | 25.2673 | 14.4877 | 按预期失败 |
| 修复运行时，缓存开启 | 0.5517 | 0.5177 | 通过 |
| 修复运行时，清空后重新缓存 | 0.6738 | 0.5337 | 通过 |

修复包同会话运行 446 帧，三个阶段均无页面异常、GPU 校验错误和设备丢失。六面分别记录到 722 次深度复制；该计数证明路径实际执行，不是性能分数。原生同机位对照保留在 `results/villa-distance-fields-lumen-shadow-20261104-native-desk.png`。汇总脚本 `summarize-web-lumen-shadows.cjs` 验证各报告与图片哈希，生成 [可追溯结果](tests/web-platform/evidence/lumen-shadow-artifacts-20261104.json) 和 `results/lumen-shadow-artifacts-20261104-comparison.png`。

补查俯视地毯机位 `(-750,-300,200,-45,270)`：独立生成同机位同步参考，修复版默认批处理运行 187 帧，窗帘和地面区域误差分别为 `0.5785/255`、`0.5088/255`，六面分别复制 222 次，无 GPU 校验错误或设备丢失。报告为 `results/lumen-shadow-regression-20261104-overhead.json`，该机位的相同区域坐标用于批处理等价性回归，不代表区域内容与主机位相同。

WASM 完整引擎目标增量编译与正常链接通过。新包为 `build/triplex-project-lumen-shadows-fixed-20261104`，保留旧包，`content.bin`、内容清单和配置包逐字节不变，只替换运行时。没有修改安装引擎，也没有重新 Cook 着色器或内容。

复测示例，`--tag` 每次使用新名称：

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-lumen-shadow-artifacts.cjs --tag=lumen-shadow-sync-new --folder=triplex-project-lumen-shadows-fixed-20261104 --baseline-only --affinity-mask=4294901760 --settings='{"r.InstanceCulling.AllowBatchedBuildRenderingCommands":0}'
node tests/web-platform/probe-web-lumen-shadow-artifacts.cjs --tag=lumen-shadow-check-new --folder=triplex-project-lumen-shadows-fixed-20261104 --cache-cycle --affinity-mask=4294901760 --reference-report=tests/web-platform/results/lumen-shadow-sync-new.json
& H:/ue_html/tests/web-platform/start-web-preview.ps1 -Folder triplex-project-lumen-shadows-fixed-20261104 -AffinityMask 4294901760
```

本机测试显式将独立 Edge 浏览器及其 GPU 进程限制在 `0xffff0000`，绕过另行记录的宿主着色器编译器崩溃；不修改项目设置或用户已有浏览器。该亲和性不是本次阴影修复的一部分。本轮只验收复现的门厅投影，不能据此宣称全部材质和光照达到原生一致、长期性能或移动端达标，也没有重新验收默认示例关卡。桌面参考图和像素误差分别用于视觉对照与回归，不混作完整画质评分。
