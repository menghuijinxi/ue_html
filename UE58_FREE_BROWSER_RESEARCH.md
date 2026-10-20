# UE 5.8 浏览器运行：免费方案专项调研

后续已扩展至 20 项平台、图形、Shader 和运行时参考，详见 [源码移植参考报告](H:/ue_html/UE58_PORTING_REFERENCES.md)。当前建议采用多项目组合参考，UnrealWasm 只作为 UE 5.8 接口对照；下文保留前一轮筛选记录。

日期：2026-10-13。

筛选条件：浏览器在用户设备上执行场景；不使用像素流；不购买商业 Web SDK。

## 结论

**本次未找到已验证、可直接给 UE 5.8.3 使用的成熟免费完整引擎网页打包方案。**

找到了两个值得进一步验证的免费源码项目：

| 项目 | 路线 | 与 UE 5.8 的关系 | 当前判断 |
| --- | --- | --- | --- |
| SamG-Coder / UnrealWasm | UE C++ 编译到 Wasm64，新增 WebGPU RHI | 作者基于 UE 5.8.2 做集成 | 最接近原始引擎移植目标，但完整场景尚未跑通 |
| H-XX-D / ue5-html5-exporter | 场景转 glTF，支持的蓝图节点转 JSON，在 Three.js 中运行 | 文档要求 UE 5.3+，给出 UE 5.8 打包示例 | 可先验证场景导出，但属于 Beta，存在行为和画面转换 |

两者的自行编写代码采用 MIT 许可。这里只把它们列为免费源码候选，没有把“可获取代码”等同于“成熟可交付”。[F1][F2]

你的 `html` 分支实际版本为 **5.8.3**，提交为 `396c9f059903aed5fec78ecd3d437a40c6415368`。版本证据已通过 Git 读取，源树尚未发现完整 HTML5 / WebGPU 平台。

## 1. UnrealWasm：完整引擎移植方向

仓库：<https://github.com/SamG-Coder/UnrealWasm>

本次实际读取的提交：`5171ceb67bed9b8e257cd769f44711ae7b8cb7ee`。

作者说明基于 UE **5.8.2**；项目提供 UBT 平台/工具链、Wasm64 支持、WebGPU RHI 和 Shader 编译集成。[F1]

重要边界：

- 作者在 2026-10-05 发布暂停开发快照。
- 完整游戏尚未链接并在浏览器执行，完整场景 Cook 尚未完成。
- 已有 Shader / WebGPU 测试不能替代整个 UE 场景的运行证据。
- `docs/STATUS.md` 明确说动态 RHI 集成尚未完成。
- 全量 Lumen、Nanite 和完整浏览器场景尚未得到验证。[F1]

**用途：免费 UE5 原生 Web 平台的研发参考，不能当作现成打包器。**

其独立代码为 MIT，UE 引擎和外部依赖需按项目的 THIRD_PARTY 说明单独准备。[F1]

如果坚持保留 UE 5.8 运行时，应在独立试验分支上，评估其平台和 RHI 代码接入你的 5.8.3 引擎所需的工作。

## 2. ue5-html5-exporter：场景与部分蓝图转换方向

仓库：<https://github.com/H-XX-D/ue5-html5-exporter>

本次实际读取的提交：`88aa261eb5141ce53568734c5bfba46f7a9ae832`。

许可：MIT。插件版本：`0.3.69`，`IsBetaVersion=true`。

它通过 UE glTF 导出器输出场景，把支持的蓝图图表转成 JSON，浏览器用 Three.js 和自带的蓝图解释器运行。普通导出产物可用静态网站服务器托管。[F2]

需要注意：

- 支持的蓝图是子集，不能假设任意蓝图都能运行。
- 普通场景导出与其可选 Discord / 在线服务功能应分别评估。
- UE 的复杂材质、Chaos、GAS、UMG、Niagara 和自定义 C++ 等行为需要检查转换边界。
- 仓库提供兼容性检查与报告，适合先扫描真实项目，再判断适配量。
- 文档写 UE 5.3+，并给出 UE 5.8 打包命令；本次没有实测 UE 5.8.3 编译和场景导出。[F2]

**用途：希望尽快免费把场景和较简单交互放到网页时，优先做小场景验证。** 它产生的是转换后的网页应用，原有 UE 渲染和运行行为需要逐项验收。

## 3. 免费 UE4 HTML5 项目

### SpeculativeCoder / UnrealEngine-HTML5-ES3

<https://github.com/SpeculativeCoder/UnrealEngine-HTML5-ES3>

项目提供 UE 4.27.2 + WebGL2 和 UE 4.24.3 + WebGL1 的构建说明及样例，使用 Emscripten。作者说明自己的修改免费可用；它没有直接提供 UE 5.8 支持。[F3]

### ufna / UE-HTML5

<https://github.com/ufna/UE-HTML5>

公开开发跟踪支持范围仍是 UE 4.24 和 4.27；路线图中的 UE5 研究尚未完成。[F4]

**用途：参考平台初始化、文件系统、输入和打包机制。** 将其移植到 5.8.3 需要处理新版本平台接口、第三方库和渲染系统，不能通过简单复制平台目录完成。

## 4. 商业厂商的免费计划

SimplyStream 定价页确实有免费计划，首页也称客户端 WebGPU 渲染不按分钟收费。不能仅因厂商商业化就认定它一定收费。[F5]

但本次核对发现：

- 免费计划的新引擎版本更新有延迟，不能直接推定包含所需 5.8.3。
- 已拉取的 `5.8` 引擎快照实际标识为 5.8.1。
- 核心 WebGPU 模块是专有预编译对象。
- 默认网页模板和部署代码包含供应商平台启动、资源和部署集成。

因此，本次没有确认“5.8.3 可用、长期免费、自建部署无强制付费服务”的完整路径，不将它作为已满足条件的主方案。前两项分别来自定价资料和 Git 版本文件；模块交付形式来自构建文档，其余来自平台模板与部署源码。[F5][F6]

## 5. 对这个分支的建议

如果目标是**UE 5.8 运行时在浏览器执行**，按后续多项目参考和接入设计建立自己的 Web 平台；UnrealWasm 仅作为附近版本的接口参考。先证明：

1. 5.8.3 的基础 C++ 游戏可以编译并链接为 WASM。
2. 平台文件系统能读取最小 Cook 产物，启动 GameInstance 和 World。
3. WebGPU RHI 能绘制一个真实 UE 场景，并稳定执行输入和 Tick。
4. 再验证材质、音频、物理、网页 UI 消息桥和实际项目插件。按 2026-10-14 的用户澄清，产品 UI 使用原生网页界面，保留引擎 UMG 依赖；遇到 UMG 网页兼容问题时优先局部禁编译或降级，不追求完整适配或彻底剔除模块。

首轮不以 Lumen / Nanite 为验收目标，避免基础启动与高级渲染问题混在一起。

如果目标是**场景和较简单交互先在网页可用**，选择 ue5-html5-exporter，在独立小项目里编译插件、检查蓝图兼容性、导出场景，并比较网页与 UE 的实际行为。它有机会减少引擎移植工作，但要接受转换结果的限制。

本次是方向调研和源码核对，尚未编译这两个项目，也没有打包或运行用户真实场景。

## 来源和本地材料

- [F1] UnrealWasm README 与状态：<https://github.com/SamG-Coder/UnrealWasm>；<https://github.com/SamG-Coder/UnrealWasm/blob/main/docs/STATUS.md>
- [F2] 导出器 README、MIT 许可、插件描述和适配边界：<https://github.com/H-XX-D/ue5-html5-exporter>
- [F3] SpeculativeCoder HTML5 项目：<https://github.com/SpeculativeCoder/UnrealEngine-HTML5-ES3>
- [F4] ufna HTML5 开发跟踪：<https://github.com/ufna/UE-HTML5>
- [F5] SimplyStream 定价：<https://simplystream.com/pricing>
- [F6] SimplyStream SDK 文档：<https://simplystream.com/docs/build-guides>

本地已浅克隆并稀疏检出两个新项目的 README、许可及关键状态文件：

- `H:\ue_html\reference-unrealwasm`
- `H:\ue_html\reference-html5-exporter`

未安装 SDK 或第三方依赖，未修改引擎或插件源码，未产生或推送 Git 提交。
