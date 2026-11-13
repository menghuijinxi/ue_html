# Low 自动复现与 Git 版本定位前置检查

2026-11-13，本轮只验证自动测试能否识别用户报告的旧页与新页 Low 差距。
没有开始历史版本重编译，没有修改正式包、引擎源码或发布默认设置。

结论：当前真实鼠标转向路线尚未稳定复现明显退化，不能据此自动判定哪个
Git 版本开始变慢。自动采集成功不等于已经得到可靠的性能回归判定信号。

## 本轮结果

测试用户实际访问的两个入口：

- 旧页：`http://127.0.0.1:8765/vsm-adaptive-live.html#adaptive`
- 新页：`http://127.0.0.1:8765/villa-smoothness-live.html#off`

运行顺序为旧、新、新、旧、旧、新。每轮独立启动浏览器，先预热转向和移动各
15 秒，再恢复同一真实玩家视角，用右键拖动连续测量 60 秒。两页 canvas
显示尺寸相同，拖动路线和幅度相同；内部渲染为 1400×788，输出为 1920×1080，
TSR、Lumen GI/反射、VT 和 VSM 开启。没有交换不同版本的 runtime/Cook。

| 配对 | 执行顺序 | 旧页整段 1% Low | 新页整段 1% Low | 新页变化 |
| --- | --- | ---: | ---: | ---: |
| 1 | 旧、新 | 33.68 | 32.77 | -2.70% |
| 2 | 新、旧 | 32.07 | 32.00 | -0.23% |
| 3 | 旧、新 | 30.97 | 31.08 | +0.36% |

旧页三轮 Low 中位数为 32.07，新页为 32.00，差距约 0.23%。
各轮不重叠五秒 Low 的中位数，旧页为 36.45、36.26、35.47，
新页为 36.08、37.03、36.69；也没有稳定的新页下降方向。

本轮预先采用的操作性门槛是：至少三对、包含正反顺序，而且每对都出现
整段 Low 及五秒 Low 中位数下降至少 10%。本轮未通过此门槛。
这只是启动版本定位的门槛，不是统计显著性证明，也不表示较小退化可以忽略。

## 保留的异常与边界

第三轮新页在测量期间增加一次预热未命中，创建两个 ShaderModule 和一条
RenderPipeline。原测试的“测量期间不允许编译”断言在完整捕获 60 秒后中断。
该轮逐帧数据完整保留，后续从下一轮继续原顺序，没有重测或剔除任何已测窗口。
原失败报告保持失败状态；汇总同时记录原错误与两个测试脚本快照的哈希。

测试现在支持 `--allow-pipeline-creation`：把操作中新建管线作为实际行为记录，
不因该行为丢失性能结果。默认的严格预热检查保留，正式发布预热规则不变。
本轮尚不能把这一次创建认定为持续 Low 退化的原因。

其他五轮测量期间未创建管线。六轮无记录到的 GPU/页面错误；页面采样均处于
可见、获得焦点的状态。旧页每轮大于 50ms 的间隔为 0、2、1，新页为 2、3、3。

这些数值来自 RHI 提交间隔；同时记录了 GPU 完成间隔及页面观察统计，但都不是
显示器实际呈现时间或输入延迟。当前路线是餐厅固定位置的真实玩家转向，
未覆盖用户所有漫游路线，也没有把另一个 `#plain` 全关闭页纳入本轮六次对照。
页面采样刷新约 116～117Hz；系统同时存在虚拟显示设备和实体显示设备，
不能将此次前台测试直接视为已经匹配用户全部显示环境。

## 自动测试入口

```powershell
. ./tests/web-platform/project-output.ps1
Initialize-ProjectOutput
$env:NODE_PATH = 'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/diagnostics/benchmark-villa-release-regression.cjs `
  --tag=<new-tag> --order=old,liveoff,liveoff,old,old,liveoff `
  --phases=input --seconds=60 --retain-cooks --lean --foreground `
  --allow-pipeline-creation
node tests/web-platform/diagnostics/assess-villa-low-repeatability.cjs `
  --report=tests/web-platform/results/<new-tag>/result.json `
  --output=tests/web-platform/results/<new-tag>/repeatability.json
```

`--lean` 关闭逐帧详情及 GPU 资源对象统计，减少探针影响，保留逐帧时间、
管线创建计数和轻量状态采样。缓存保留扩容只用于诊断浏览器。
`measurementPassed` 表示数据检查通过；`usableForBisection` 才表示通过重复性门槛，
两者不能混用。所有输出位于项目内。

测试脚本的四项回归用例覆盖稳定退化、单对反例、顺序漂移、隐藏/未完成窗口，
并确认操作期间的管线创建会完整保留。

原始数据：

- `tests/web-platform/results/villa-low-repeatability-20261113/result.json`
- `tests/web-platform/results/villa-low-repeatability-continuation-20261113/result.json`
- 入库汇总：`tests/web-platform/evidence/villa-low-repeatability-20261113.json`

## 后续版本定位约束

用户提出的按 Git 版本重新构建是正确方向。取得可重复的自动退化信号后，
以实际历史源码构建并比较自适应诊断版、正式自适应版、间接绘制复用版、
页标记/镜像同步版、Lumen/TSR 版及小分块恢复版。根仓库保存 RHI、工具与默认值，
`reference-engine` 独立保存引擎修改，必须恢复对应的两个仓库状态。
每版使用匹配的 runtime、Cook、配置和实际管线记录，执行统一发布收尾校验。
仅关闭运行时开关或混合新 runtime 与旧 Cook 不能替代历史版本。

当前测试尚不能给历史提交可靠评分，根因定位及性能修复仍未完成。
