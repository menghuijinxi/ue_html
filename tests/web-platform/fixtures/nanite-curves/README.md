# Nanite 曲线原生资源与独立验证工具

在 `tests/web-platform` 执行 `node prepare-nanite-curves-fixtures.cjs`，把本目录内容和当前原生 shader 插件复制到可写的 `results/nanite-curves`。生成的项目、中间产物与报告均留在 results；安装引擎不修改。源 shader、顶点工厂和可编程光栅直接来自正式引擎及已准备的 Cook host，不依赖早期草稿。

生产构建准备好后，按顺序运行：

1. `results/nanite-curves/run-native-integration.ps1`：依次构建原生 Builder、RenderCore、Renderer，刷新骨骼/组合回归、真实 Groom 与 66 个材质排列，重新 Cook 和 stage。
2. 上述管线已包含 `run-fixtures.ps1 -Production` 的 29 个独立 Builder 输入、`run-shaders.ps1 -Production` 及两组 GPU 输入准备；覆盖实际 256 点编码与交错材质。单独修复后可只重跑受影响步骤。原生构建、普通骨骼/组合及 Groom 已通过时，`-ResumeAfterGroom` 从 Groom 独立参考继续；最终收集器仍重新检查每项源码和产物哈希。
3. `verify-vectorvm-web.ps1` 对新增 Niagara 依赖所用的真实 Web 运算与桌面 VectorVM 作逐位对照，包括全部半精度编码、舍入边界和非对齐读写，执行 wasm64 及带地址/未定义行为检查的 wasm32。它与正式构建使用相同的规范化 Emscripten 配置路径，避免 SDK 因路径斜杠差异清空共享缓存。
4. `results/nanite-curves/run-gpu-checks.ps1`：顺序检查原生转码、独立解码、叶簇及祖先包围盒、LOD/ribbon、非均匀尺度和 wave 端点/编号。
5. 完成正式 WASM 构建和打包后，运行 `probe-nanite-curves.cjs` 的普通、`--long-curves`、`--streaming-asset` 三种模式；`probe-nanite-curves-streaming.cjs` 运行普通及 `--budget`。每种模式再以 `--scalar-visibility` 验证兼容原子路径，所有 GPU/浏览器测试顺序执行。
6. `node verify-nanite-curves-oracle.cjs` 检查独立参考能拒绝覆盖、深度、材质、变形、速度和流送错误。
7. `capture-nanite-curves-native.ps1` 和 `node verify-nanite-curves-native.cjs` 对三种资产各七个固定视角执行原生 SM6 对照，直接读取深度与 GBuffer，核对实际矩阵、变换、AA 和抖动。必须等前述原生任务退出后顺序运行。
8. 同包普通骨骼、组合网格回归全部通过并归档后，`node collect-nanite-curves-evidence.cjs` 生成包含原始回读、独立输入和失败记录的分段 gzip 证据。

完整 WASM、native pipeline 和独立 GPU 检查通过后，`run-nanite-curves-acceptance.ps1` 统一执行正式构建导入、打包、步骤 5～8。`-StartAt` 可从已修复的失败阶段继续，最终收集仍要求每份报告来自同一个包且源码/产物哈希一致。原生 pipeline 的 `-ResumeAfterShaders` 从单/多材质 Cook 参考及上传器继续；单材质参考每次以当前解码 shader 重建，不能沿用早期通过记录中的旧哈希。

上传器已验证、仅 Cook 失败时，`fixtures/nanite-curves/run-native-integration.ps1 -ResumeCook` 重新校验原生曲线证据后继续 Cook/stage。HairStrands 毛囊遮罩的无穷裁剪坐标会使 Tint 崩溃；`node verify-hair-follicle-web.cjs` 用保存的生产 SPIR-V 复现旧错误，再执行实际 VS/PS 的两种 UV 排列、四个通道及无效根节点剔除。完整 Cook 仍须单独通过。`capture-nanite-curves-native.ps1 -Preflight` 可独立检查原生场景的渲染/读回，结果只放在 native-preflight，不能代替浏览器派生的 21 视角验收。

`failure-native-curves/NaniteRasterizer.usf` 是保留的旧实现，仅供端点和可见性编号的负向验证，不得复制回正式引擎。真实 Groom 的 authored 256 点经过原生导入截断和采样后为 128 点；直接 Builder 的两项 256 点用例单独覆盖完整编码容量。原生 Groom Nanite 自身不支持绑定/模拟，不把普通 strands 功能算作 Nanite 功能。

生成器显式将两组资产的模拟、变形和 Niagara 求解器设为空。仅关闭默认 `EnableSimulation` 不足以避免模拟依赖：原生 `UpdatePhysicsSystems` 仍会按默认 AngularSprings 在加载时引用 StableSpringsSystem。报告和收集器检查这两个显式状态，Niagara 模块仍保留。此前误带入的模拟 shader 原始失败保存在 `failure-niagara-isnan`；有限值分类已补齐并有独立 GPU 检查，但后续 `OpMemoryBarrier` 转换仍未兼容，不能把该模拟算作已通过。

仅有生成器、编译或独立 kernel 通过不能代表真实组件验收通过；必须保留实际 browser 报告、同包普通骨骼/组合回归、原生画面对照及最终完整场景验收。
