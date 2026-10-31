# 别墅按项目设置打包与显存修复

源项目：`G:/UE_HTML/TriplexHouseVilla/TriplexHouseVilla.uproject`。地图：`/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla`。

后续从启动早期实际操作发现的角色速度通道崩溃，修复与回归结果见 [别墅移动崩溃修复](UE58_VILLA_MOVEMENT_CRASH.md)。本报告中的固定视角测试不能替代该操作回归。

引擎修复本地提交：`05dae2bb5`（html 分支）。未推送远程。

## 设置与构建

本次使用 `--project-settings` 和 `-UseProjectSettings`，不使用旧的别墅或默认关卡渲染配置。不附加渲染 CVar、贴图尺寸、曝光、天空或输入配置覆盖。保留项目的距离场、静态光照、贴图压缩和插件默认配置。项目已经关闭 Lumen 和虚拟阴影，打包器只检查这些设置，不修改它们。

工作副本只添加本机 Cook 模块、目标平台注册和不含 CVar 的平台标识。原项目的配置和资源保持原有哈希。Web 能力仍由后端声明，例如硬件光追和分层体积渲染的支持不会因复制项目配置而自动增加。

本机安装引擎是 `D:/UE_5.8`（5.8.1），参考分支为 5.8.3。编译使用工作区内的隔离覆盖，不修改安装引擎源码。以下命令在仓库根目录执行：

```powershell
$env:UE_ENGINE_ROOT='D:/UE_5.8/Engine'
$env:UEEngineRoot='D:/UE_5.8/Engine'
$env:P1_ENGINE='D:/UE_5.8'
node tests/web-platform/prepare-web-project.cjs --project=G:/UE_HTML/TriplexHouseVilla/TriplexHouseVilla.uproject --id=triplex-project --project-settings

& tests/web-platform/build-native-rendercore.ps1 -Engine D:/UE_5.8 -Module RenderCore -MaxParallelActions 8
& tests/web-platform/build-native-rendercore.ps1 -Engine D:/UE_5.8 -Module Renderer -MaxParallelActions 8
& D:/UE_5.8/Engine/Build/BatchFiles/Build.bat UEShaderHostEditor Win64 Development -Project=G:/UE_HTML/ue_html/tests/ue-shader-host/UEShaderHost.uproject -NoHotReloadFromIDE -NoUBA -MaxParallelActions=4
& tests/web-platform/build-web-engine.ps1 -Engine D:/UE_5.8 -Threads -StandaloneCompiles -MaxParallelActions 10

& tests/web-platform/cook-web-engine.ps1 -Engine D:/UE_5.8 -Mode WebGPU-SM5 -Scene Project -Project G:/UE_HTML/ue_html/tests/web-platform/build/projects/triplex-project/TriplexHouseVilla.uproject -Map /Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla -UseProjectSettings -ReportId triplex-project -StopOnShaderError -SkipBuild
node tests/web-platform/stage-web-engine.cjs --project=triplex-project --desktop
node tests/web-platform/package-web-project.cjs --project=triplex-project --desktop --distance-fields --threads
node tests/web-platform/serve.cjs
```

页面：`http://127.0.0.1:8765/build/triplex-project-distance-fields-threads/index.html`。服务器提供共享内存所需的隔离响应头。运行时为 wasm64、多线程、WebGPU 桌面延迟渲染。

## 显存原因与修复

1. Emdawn 的句柄删除只删除 JavaScript 表项。GPUBuffer/GPUTexture 仍可能等待垃圾回收，驱动分配不能及时回收。现在将末次引用释放的资源放入退休队列，在 RHI 帧末确认所有编码器已提交后调用 `destroy()`。不能在句柄删除时立即销毁，因为上传缓冲可能仍被未提交的复制命令引用。交换链纹理由浏览器管理，明确排除。
2. 着色器对象跨帧保存绑定资源和 `$Globals` 缓冲，延长了临时缓冲及纹理的生命周期。现在只在本帧保留，用帧末清理解除引用。小常量使用 1 MiB 分页、256 字节对齐的不可变区间，减少独立 GPU 分配和上传。
3. Web 的 `PF_ShadowDepth` 使用 D32，但 UE 的字节统计和本机 D3D12 都使用 D16，阴影缓存实际占用因此超过统计。现在统一使用 D16 和 2 字节统计，阴影分辨率及缓存预算仍由原项目决定。

`probe-web-resource-retirement.cjs` 在真实 Edge WebGPU 上验证 4 MiB 上传复制：提交前保持资源有效，提交后销毁，回读逐字一致；同时检查交换链纹理未被销毁。该测试不调整渲染设置。

## 受控对照

先使用字节完全相同的默认关卡资源，只替换 JS/WASM 运行时来隔离资源生命周期修复的影响。以下为 1280×720、DPR 1、同三个视角的浏览器进程专用显存，取自 WDDM 进程计数器：

| 返回室内视角 | 旧运行时 | 生命周期修复后 |
| --- | ---: | ---: |
| 帧数 | 2619 | 2637 |
| 专用显存 | 3929.82 MiB | 479.82 MiB |
| 存活缓冲描述字节 | 674.34 MiB | 8.28 MiB |
| 存活纹理描述字节 | 371.97 MiB | 371.97 MiB |

这组对照尚未加入 D16 格式修复。两个测试的时长不同，构建并行负载也不同，不能据此推导 CPU 加速比例。三个视角截图的平均 RGB 绝对差分别约为 0.61、1.73、2.82 / 255，包含动画时间差。报告为 `tests/web-platform/results/project-memory-observer-smoke.json`、`project-memory-default-retirement-fixed.json`；受控资源包位于 `build/retirement-default-diagnostic`。

GPU 描述统计只统计活跃对象的逻辑大小，不能替代驱动实测；`web-gpu-memory-observer.cjs` 使用弱引用，避免探针自身保留资源。浏览器专用显存由 `gpu-process-memory.cjs` 按独立浏览器配置目录定位进程树，避免把其他程序占用算进来。

## 别墅最终实测

`project-memory-villa-project-fixed.json` 通过：90 秒视角测试、共 2232 帧、GPU 验证错误和设备丢失均为 0，全部探针设置覆盖为空。正式资源包约 3.51 GB（十进制），内容包约 3.32 GB，1959 个 Cook 包、5157 个运行资源文件。多线程和单线程运行时均通过正常 UBT 链接；交付网页使用多线程运行时。

| 视角 | 帧 | WDDM 专用显存 | 活跃缓冲 | 活跃纹理 |
| --- | ---: | ---: | ---: | ---: |
| 启动 | 61 | 1590.85 MiB | 46.95 MiB | 906.36 MiB |
| 室内稳定 | 779 | 1712.82 MiB | 46.78 MiB | 1005.23 MiB |
| 转向厨房 | 1600 | 1764.52 MiB | 47.56 MiB | 1014.14 MiB |
| 返回室内 | 2232 | 1757.18 MiB | 46.79 MiB | 1013.64 MiB |

运行时读取确认距离场生成、距离场 AO/阴影、静态光照、DBuffer 均开启，纹理池仍为项目的 1000 MiB，Lumen/VSM 仍关闭。591 个独立网格带距离场。截图观察正常，D16 阴影、六面局部灯阴影和转向遮挡恢复未出现 GPU 错误。帧末累计回收 87964 个 GPU 资源，返回室内后的缓冲占用回到原水平。

原项目抗锯齿 CVar 保持 4；Web SM5 的实际视图按引擎能力回退到 TAA（2），原生 SM6 使用项目路径。因此两端并非完全相同的功能集合。三个视角截图的平均 RGB 绝对差约为 3.93、1.05、3.95 / 255，记录在 `villa-project-pc-web-comparison.json`。没有调曝光、降低贴图上限或关闭距离场来减小显存。

带内存探针时，稳定室内约 49.7 ms/帧、厨房约 36.6 ms/帧、返回室内约 49.2 ms/帧。这只记录最终版本的表现，未做近期 CPU 提交的逐个 A/B，不能据此给出 CPU 优化比例。原生编辑器采样还受刷新频率和不同渲染路径影响。

可见 Edge 窗口也已启动正式包，以原生玩家出生点运行，并验证原项目 W 键输入：玩家沿 Y 方向移动约 138 cm，无错误。证据为 `villa-visible-gameplay.json` 和对应截图。浏览器窗口和本地服务器保留运行。

## 原生对照

使用项目设置在本机 D3D12 下采集同分辨率的室内、厨房、客厅视角。`villa-distance-fields-project-final-capture.json` 确认 2241 个静态网格组件均有距离场，591 个独立网格，118 盏灯；项目变量包含距离场 AO/阴影开启、Lumen/VSM 关闭、纹理池 1000 MiB、抗锯齿设置 4。

本机编辑器进程专用显存约 1.6–1.93 GiB，数据见 `villa-distance-fields-project-final-system.json`。这是编辑器的 SM6 路径；Web 使用 SM5 桌面后端，两者的引擎基础开销和功能能力不同，不能将差值全部归因于资源泄漏。

## 兼容补齐

按原设置运行需要补齐此前被配置覆盖掩盖的路径：静态体积光照贴图的真实存储格式、Water 全局着色器的多采样反射和裁剪值、运动模糊存储格式及 NaN 检查、半透明光照体初始化、合法的空同队列屏障、插件资源挂载，以及项目指定的 Enhanced Input 类。Enhanced Input 从匹配的安装引擎复制到隔离构建目录并静态编入，输入配置继续使用项目原文件。

后端纠正了 `GSupportsVolumeTextureRendering` 的默认真值，明确区分 3D 纹理计算读写与尚不支持的分层光栅输出；与 Cook 的几何着色器/顶点层输出能力保持一致。这是能力声明修复，没有设置 `r.TranslucencyLightingVolume=0` 等覆盖。体积光照的计算清零资源仍按引擎路径创建。当前 Web 后端仍有该能力限制，不能把 Cook 成功等同于所有高级效果均支持。
