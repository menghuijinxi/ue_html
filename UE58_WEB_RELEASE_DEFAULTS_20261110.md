# 桌面 Web 发布默认项（2026-11-10）

## 查到的遗漏入口

- `villa-lumen-vt-20261110-v3` 已含多页缓存锁修复，worker 与源码 SHA-256 相同；不是这项代码再次丢失。
- v3 的宿主已有固定分辨率 DPI 修正，但固定分辨率原来只由对照包设置 `fixedRenderSize`。仅传 `-ResX/-ResY/-ForceRes` 的入口没有自动接入，已用浏览器回归测试复现。
- 通用项目包此前要求手工指定预热记录，默认示例关卡打包仍通过性能配置加回 `-WebPSOPrecacheTest`。对照转包也可能继承旧缓存 worker。这些都允许后续构建再次漏带优化。

## 统一流程

`tests/web-platform/web-release-defaults.cjs` 负责普通桌面线程包的最后收尾：

1. 使用当前宿主、引擎 worker、内容缓存 worker、实际管线预热脚本，并校验包内字节与版本 URL 的哈希。替换时先写新文件再重命名，避免覆盖通过硬链接复用的历史包。
2. 固定尺寸（显式 `fixedRenderSize` 或 `-ForceRes` 配合 `-ResX/-ResY`）按物理像素传递，DPR 固定为 1。自适应仍使用 CSS 尺寸乘一次 DPR。冲突或不完整的固定尺寸参数直接报错，鼠标及滚轮坐标沿用相同规则。
3. 默认移除旧推测式预热。自动查找已成功采集且没有 CVar 覆盖的记录，核对 WASM、运行时 JS、内容、配置、启动参数和固定尺寸，验证捕获清单与入口页面未改变。
4. 没有匹配记录时，自动保存独立采集快照、启动随机空闲端口的本地服务和 Edge，记录场景实际建立的管线；进入场景后再观察 120 帧。预热并发为 2，由正式引擎接管同一个设备。
5. 采集失败直接使打包失败，不静默切回旧预热。未收录的新视角管线仍正常按需创建，不能把启动采集当作覆盖整个项目的证明。

已接入：`package-web-project.cjs`、`package-web-default-template.cjs`、
`package-villa-engine-comparison.cjs`、`package-villa-prewarm.cjs`，
以及 `package-villa-parity-candidate.cjs --accepted-defaults`。
独立实验、移动和 Trace 入口不作为这条正式桌面发布流程。
工作区 `AGENTS.md` 也要求后续新增正常发布入口调用同一流程。

## 后续打包

通用项目不再需要记住 `--pipeline-corpus`：

```powershell
node tests/web-platform/package-web-project.cjs --project=triplex-virtual --desktop --threads --distance-fields --output-folder=triplex-next
node tests/web-platform/package-web-default-template.cjs --desktop --threads --output-folder=template-next
```

引擎及 Cook 仍须先通过原有构建校验；本次只修改网页宿主和发布流程，无需重新编译相同的 WASM。
新二进制、配置、场景入口不匹配旧记录时会自动采集。自动采集使用本机 Playwright 和支持 WebGPU 的 Edge；
优先使用项目依赖或 `NODE_PATH`，也支持当前工作区已有的用户目录 Codex Node 依赖。
没有采集环境且没有匹配记录时，发布会失败并说明原因。
采集快照保存在 `build/auto-prewarm-*`，结果保存在 `results/villa-startup-auto-prewarm-*`，
保留它们便于复用和审计；清理后会自动重新采集。

`--refresh-prewarm` 强制重新采集；`--pipeline-corpus=...` 可指定已验证记录。
`--capture-prewarm` 和 `--legacy-precache` 仅用于显式诊断，报告的 `releaseReady` 为 false。

## 回归验证

- `verify-web-release-defaults.cjs`：自动复用、配置/入口/尺寸变更后的重新采集、旧 worker 拦截、硬链接隔离、采集失败阻止发布和显式诊断模式。
- `verify-web-prewarm-packaging.cjs`、`verify-web-pipeline-prewarm.cjs`：内容匹配、描述符、布局、常量、设备隔离与编译失败处理。
- `verify-web-fixed-render-size.cjs`：DPR 1 / 1.5 / 2，自适应、显式固定尺寸、仅命令行固定尺寸，含缩放后的鼠标及滚轮坐标；先看到命令行模式失败，修复后九组通过。
- `verify-web-content-multitab.cjs`：缓存命中共享读、同时冷启动只下载一次、使用中损坏缓存不排队阻塞、下载失败后释放锁、关闭页后释放读租约，五组通过。
- `verify-web-input-bridge.cjs`、`verify-web-frame-credits.cjs`：输入与帧时钟回归通过。

第一次完整双页观测中，两页均成功启动、第二页零下载且等待锁为零；
随后持续按住前进键的“30 秒内推进 60 帧”步骤超时，无设备丢失或管线创建失败。
保留原始 `villa-multitab-release-defaults-edge-20261110` 失败记录。
后续观测将移动改为短按，仍要求实际推进 60 帧，记录耗时并给双场景 90 秒观察窗口；
它验证运行能继续，不作为双开帧率达标的证据。

## 最终别墅包

`build/villa-lumen-vt-20261110-v5` 由普通项目打包命令生成，没有传入预热选项，
自动复用 326 条描述符（321 个模块，实际预建 319 条去重管线）。
WASM、运行时 JS、配置和 `content.bin` 与 v3 的 SHA-256 完全一致。
15 项源码审计及 13 项发布产物校验通过。本轮没有修改参考引擎、安装目录或原始项目。

最终 Edge 双页测试 `villa-multitab-release-defaults-edge-final-20261110` 通过：
第二页在第一页保持打开时命中两个本地资源、下载数为 0；两页各保有共享读租约，
等待锁为 0，均可继续推进至少 60 帧。关闭第一页后刷新第二页仍零下载，
约 14.1 秒进入场景。双开时第二页启动约 50.9 秒，帧推进明显变慢；
本次只证明没有被资源锁阻塞，不能据此宣称双开性能已经优化。

Chrome 单页 `villa-startup-release-defaults-chrome-20261110` 两轮为 17.524 / 12.605 秒，
每轮进入场景后实际移动和转向 10 秒，均无 GPU、设备丢失或管线创建失败；
已测路线预热遗漏为 0。浏览器无 CPU 核心限制，使用原有屏幕外测试窗口。
这不是与旧包同条件重复采样的性能对照，不作普遍提速比例承诺。

双页实际 CSS 为 1280×720、DPR 1.5，输出 1920×1080；
TSR 内部尺寸 1400×788 是另一层渲染比例，不能误认为 DPI 重复放大。
运行时 GI、反射、虚拟阴影和虚拟纹理开关均为 1，VT/VSM 活动路径均为 true。
本次没有改变资产，实际 VT 资产覆盖仍沿用此前报告的边界；不把开关值当作新 VT 资产验收。

另用 `package-villa-prewarm.cjs --refresh-prewarm` 验证自动采集完整分支，
执行时清掉 `NODE_PATH`，由脚本发现本机依赖。生成
`villa-defaults-autocapture-final-20261110`（303 个模块、311 条描述符），
随后 Edge 无诊断包装启动约 16.651 秒，确认预热设备被引擎接管并实际命中，
移动和转向 10 秒无错误。这份仅启动时采集的记录在移动时有 9 次正常按需创建，
因此交付 v5 仍使用范围更广的已有 326 条记录。

机器可读摘要与报告哈希见
`tests/web-platform/evidence/desktop-release-defaults-20261110.json`。
默认示例关卡入口已接入共享收尾函数，本轮未重新 Cook 或运行该示例关卡；
完整场景浏览器验证使用用户指定的别墅工程。
