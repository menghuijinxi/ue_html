# VSM 自适应采样默认启用

2026-11-12，用户实际测试自适应诊断页后确认效果影响不大，同意应用。
现在普通 WebGPU SM5 Cook 默认编译自适应投影，桌面线程发布默认设置
`r.Shadow.Virtual.SMRT.AdaptiveRayCount=1`。无需实验参数或网页内存替换。

正式测试包：`http://127.0.0.1:8765/build/villa-vsm-adaptive-20261112/index.html`。
原诊断页和旧对照包继续保留各自的历史版本。

## 实现

- 方向光、局部灯光和投影组合沿用 UE 的 SMRT 自适应提前退出，使用活跃 lane
  的 subgroup vote；Tint 仍拒绝非一致控制流中的 workgroup barrier。
- 编译键加入 `VSMAdaptive1`，投影任务加入 `WebVSMAdaptiveVersion=1`，
  避免复用没有自适应分支的旧缓存。其余任务保留原有缓存。
- 每个投影 payload 同时保存完整采样 WGSL 及其独立绑定元数据；RHI 根据实际设备
  subgroups 能力选取。读取前校验 Compact Binary，再执行原有格式和绑定检查。
- 编译器、Cook 报告和项目/默认关卡打包入口记录 `cooked-with-fallback`；
  worker 镜像实际模块计数 `__webVSMAdaptiveSampling`。
- 新包仍经 `web-release-defaults.cjs` 收尾。新 WASM、content、配置哈希和启动参数
  匹配实采 corpus，采集失败禁止作为正式包发布。
- 共享发布参数新增 `--render-size=1920x1080`，使用物理像素及固定 DPR=1 的宿主路径。
  此参数也会参与预热匹配，不能套用另一尺寸的记录。

## 本次验证

原生 ShaderFormat 构建、线程运行时重新编译和完整场景 Cook/Stage/Package 成功。
Cook 保留工程设置，Lumen GI/反射、虚拟纹理、虚拟阴影和 TSR 均实际启用。

`FVirtualShadowMapProjectionCS` 全部 170 个可编译 permutation 通过，
每个均携带独立的完整采样版本。Edge 中未申请 subgroups 的真实 GPUDevice
校验全部 170 个回退模块，无编译错误；同设备拒绝自适应模块作为负对照。
384 lane 的 GPU 测试覆盖全遮挡、全未遮挡、混合遮挡、部分活跃 lane 和关闭自适应。

正式包从当前 Cook 采集 312 个实际使用模块、320 条管线。
浏览器无着色器替换验证 DPR 1.5 和 1：

- 两个实际 VSM 投影模块选中自适应版本，完整采样模块计数为 0。
- 内部渲染 1400×788、输出和 canvas 1920×1080、抗锯齿为 TSR。
- 原生 WASD 移动约 122～124 厘米，右键拖动转向约 39 度。
- 每轮执行 12 秒转向和 12 秒移动；预热已采用，最终命中 365 / 355，未命中均为 0。
- 两轮均无 GPU 错误，截图检查为非空场景。

发布默认值、预热包装、精确管线缓存、HTTP 版本缓存、多页资源共享读取锁和
Tint 正负例回归检查通过。本轮实测用于功能验收，不将 HUD 的瞬时 FPS/Low
作为新的受控提速比例。此前诊断实验的性能对照仍保留在原文档。

## 兼容边界

完整采样回退针对 VSM 投影模块，不意味着现有整个桌面场景已经兼容无 subgroups
的硬件。屏蔽 subgroups 的整场景测试在旧有非 VSM 波运算模块提前创建时失败；
正式预热里共有 13 个使用 subgroups 的模块，其中 11 个与优化前包源码相同，
另外两个是本次 VSM 投影。此次不扩展其他渲染功能的设备兼容范围，
也不发布该失败采集或将它当成回退预热记录。

回退模块已通过真实无 subgroups GPUDevice 编译，但没有在无该特性的物理硬件上
验收整场景。点光跨面、动态遮挡与全部复杂运动的长期视觉覆盖仍需后续补充；
用户已接受当前场景中自适应产生的少量白点。此前偶发启动设备错误不在本次修复范围。

## 复现入口

```powershell
& tests/web-platform/build-tint-nanite.ps1
& tests/web-platform/build-web-material-host.ps1
node tests/web-platform/prepare-web-cook-shaders.cjs
& tests/web-platform/probe-web-virtual-resources.ps1 `
  -ShaderTypes FVirtualShadowMapProjectionCS -AllPermutations

& tests/web-platform/build-web-engine.ps1 `
  -Threads -StandaloneCompiles -MaxParallelActions 4 -SkipHostPreparation
& tests/web-platform/cook-web-engine.ps1 -Mode WebGPU-SM5 -Scene Project `
  -Project H:/ue_html/tests/web-platform/build/projects/triplex-virtual/TriplexHouseVilla.uproject `
  -Map /Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla `
  -UseProjectSettings -ReportId triplex-virtual -StopOnShaderError -SkipBuild
node tests/web-platform/stage-web-engine.cjs --project=triplex-virtual --desktop
node tests/web-platform/package-web-project.cjs --project=triplex-virtual `
  --desktop --threads --distance-fields --render-size=1920x1080

node tests/web-platform/verify-vsm-adaptive-release.cjs `
  <package-folder> <new-result-tag> <all-permutation-probe-folder>
```

正式打包没有匹配记录时会自动浏览器采集。显式 `--capture-prewarm` 仅产生诊断采集包，
之后必须通过同一正式收尾入口发布。本次 Cook 和两个新包的实际大文件存放在
`C:/ue-web-cook-adaptive`、`C:/ue-web-packages`；工作区 build 下使用目录联接提供服务，
避免耗尽 H 盘空间。证据摘要为
`tests/web-platform/evidence/vsm-adaptive-release-20261112.json`。
