# 2026-11-10 别墅 Lumen、VT、VSM 重打包

**交付更正：原包漏接 11 月 9 日实际管线预热优化，用户正常启动发生设备丢失。**
下文为原包历史记录，不能作为正常启动稳定性结论。
修复入口为 `http://127.0.0.1:8765/build/villa-lumen-vt-20261110-v3/index.html`，
原因、重复启动验证及新的打包流程见 [启动回归修复](UE58_VILLA_STARTUP_REGRESSION_20261110.md)。

测试工程：`H:/TriplexHouseVilla/TriplexHouseVilla.uproject`。
隔离副本：`tests/web-platform/build/projects/triplex-virtual`。
目标入口：`http://127.0.0.1:8765/build/villa-lumen-vt-20261110/index.html`。

源码基线为外围仓库 `50740cc`、引擎仓库 `aecd84763d`，另包含本轮兼容修复。
引擎修复提交：`06b08ff55dc`。
使用桌面 SM5、多线程运行时和当前默认性能配置，保留工程渲染设置。

## 设置

| 项目 | 工程有效值 |
| --- | --- |
| Lumen 全局光照 | `r.DynamicGlobalIlluminationMethod=1` |
| Lumen 反射 | `r.ReflectionMethod=1` |
| 距离场 | `r.GenerateMeshDistanceFields=True` |
| 虚拟阴影 | `r.Shadow.Virtual.Enable=1` |
| 虚拟纹理支持 | UE 5.8 默认 `r.VirtualTextures=1` |
| 原生硬件光追开关 | `r.RayTracing=False`；Web 使用软件距离场 Lumen |

VT 全局支持与资产级 `VirtualTextureStreaming` 分别记录；开启支持不会自动转换工程贴图。

## 构建修复

1. `prepare-web-project.cjs` 生成的宿主模块仍使用 `Default` 加载阶段，
   与已增加全局着色器注册的 `UEShaderHost` 不一致，触发
   `!AreShaderTypesInitialized()` 断言。改为 `PostConfigInit`，与宿主工程对齐。
   `verify-web-project-preparation.cjs` 在修改前失败、修改后通过，同时核验原始工程不变、
   渲染配置原样保留。
2. 天空光准备仍启动安装目录的引擎，提前注册的新着色器在其 Shader 目录中不存在，
   报错缺少 `/Engine/Private/Nanite/WebNaniteGBuffer.usf`。
   改用已准备好的隔离 Cook 宿主执行原生 D3D12 天空光采集，并审计所用可执行文件。
   新天空光数据与 2026-11-06 版本逐字节一致，SHA-256 为
   `0f2bf861eb50b0b3e5be8bc96b16ae3c319caaf0ebc4a687e92fa9b3ff0c8a3c`。
3. 首次完整 Cook 和打包通过后，浏览器在全局着色器核验时发现
   `FTranscodePageToGPU_CS` 缺失。安装版 Engine 的该类型仍受完整 Nanite 支持条件限制，
   与 Web 运行时已启用的 32 线程转码排列不一致。
   在 RenderCore 的现有 Web Cook 适配层按具名 `GROUP_SIZE` 维度对齐该类型，
   仅作用于编辑器的 Web 目标；转换器补齐与 Web 运行时一致的 Wave Operations 编译标志。
   普通运行时增量构建同时同步 `Shader.cpp`，保证构建源与参考源码一致。
4. 当前默认性能配置开启 PSO 预热。VSM 投影在专用 PSO 尚未就绪时切换到桌面通用
   着色器，连带创建未使用的毛发默认 `PF_R16G16_UINT` SRV，在 Web 触发断言。
   Web 仍提交预热请求，在派发时等待专用投影 PSO；其他平台保留原回退。
   未放宽 RHI 格式校验，也未关闭预热、VSM 或 Lumen。
   RHI 错误信息增加资源名称、格式和使用标记，保留失败报告用于定位。

## 验证结果

隔离 RenderCore、Renderer、多线程 Wasm 构建通过；Wasm 完整链接含 421 个对象，
本轮重新编译 57 个单元。六项 Lumen 着色器预检通过；配置检查通过 10 个 Lumen 用例、
12 项虚拟资源断言。

最终 Cook 为 `20261110-155234`，0 错误、16 警告；Stage 包含 5163 个文件，
最终打包 11 个文件，共 3,640,331,288 字节。原工程 1633 个文件的哈希全部保持不变。

Edge `157.0.4341.42`，1280×720，实际运行 2418 帧；出生点、室内、厨房、客厅及
返回出生点五视角检查通过，没有 WebGPU 验证错误或设备丢失。运行时 GI、反射、距离场、
VT、VSM 均为 1；VT/VSM 路径为活动状态。观测到 53191 次 ScreenProbe GI 派发、
9670 次 ReflectionTrace 派发及真实 VSM 物理页池与原子同步。
PSO 预热仍开启，结束时待处理数为 0。

与既有原生同机位截图对照，柜门、窗户玻璃的最大色度差分别为
0.000875、0.000990，均低于 0.02 阈值；本次没有出现此前明显偏蓝的问题。

边界：运行时虚拟纹理资产数和资源数均为 0，本关卡验证了 VT 开关及兼容启动，
未覆盖实际虚拟纹理贴图的分页流送。五视角与玻璃区域检查不代表整场景桌面画质验收。
预热日志仍包含不支持的候选管线拒绝信息；实际渲染管线和 GPU 验证检查通过。
首次运行需要下载并缓存约 3.64 GB 资源，画面出现前还会进行管线准备。

精简证据见 `tests/web-platform/evidence/villa-lumen-vt-20261110.json`；
完整浏览器报告为 `tests/web-platform/results/villa-lumen-vt-20261110-final.json`，
玻璃报告为同目录 `villa-lumen-vt-20261110-glass.json`。截图采用同名前缀。

## 复现

在仓库根目录执行，Cook 保留原工程设置，构建产物使用独立发布目录：

```powershell
(Get-Process -Id $PID).ProcessorAffinity = [IntPtr]4294901760
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/prepare-web-project.cjs --project=H:/TriplexHouseVilla/TriplexHouseVilla.uproject --id=triplex-virtual --project-settings
tests/web-platform/build-native-rendercore.ps1 -Module RenderCore -MaxParallelActions 4 -HostProcessorAffinity 4294901760
tests/web-platform/build-native-rendercore.ps1 -Module Renderer -MaxParallelActions 4 -HostProcessorAffinity 4294901760
tests/web-platform/build-web-engine.ps1 -Threads -SkipHostPreparation -StandaloneCompiles -MaxParallelActions 4
tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-SM5 -Scene Project -Project H:/ue_html/tests/web-platform/build/projects/triplex-virtual/TriplexHouseVilla.uproject -Map /Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla -UseProjectSettings -ReportId triplex-virtual -StopOnShaderError -HostProcessorAffinity 4294901760
node tests/web-platform/stage-web-engine.cjs --project=triplex-virtual --desktop
node tests/web-platform/package-web-project.cjs --project=triplex-virtual --desktop --threads --distance-fields --output-folder=villa-lumen-vt-20261110 --legacy-precache
node tests/web-platform/probe-web-virtual-scene.cjs --folder=villa-lumen-vt-20261110 --tag=villa-lumen-vt-20261110-final --require-lumen --require-precache --lumen-input=tests/web-platform/build/web-project-triplex-virtual-desktop-cook/20261110-140727/ShaderConversion --package-report=tests/web-platform/results/web-project-triplex-virtual-distance-fields-threads-package-results.json
```

`probe-web-virtual-scene.cjs` 新增 `--require-lumen`，同时检查运行时配置、
真实 ScreenProbe GI 与 ReflectionTrace 计算管线的直接或间接派发。
`--lumen-input` 接受逗号分隔的实际 Cook `ShaderConversion` 目录；
复用 DDC 时需包括保存对应转换元数据的历史 Cook 目录。
`--package-report` 将自定义目录与正确的打包报告关联。
`--require-precache` 要求实际运行时 PSO 预热仍处于开启状态，用于覆盖本次 VSM 回退故障。
原有 VT/VSM 状态、物理阴影页池、原子同步、五视角非空截图和 GPU 错误检查继续执行。
