# 间接绘制复用退化排查

2026-11-13，用户运行六个历史实包后反馈：从③间接绘制复用开始出现流畅度退化。
已知良好节点为② `2abb246` / 引擎 `0239f495b4`，首个退化节点为③
`410778f` / 引擎 `231b20bb08`。这使范围收窄到模板与绑定复用，
不应再把后续页同步、Lumen 或 TSR 改动当作首次退化原因。

## 分项页面

入口：`http://127.0.0.1:8765/villa-indirect-isolation-live.html#adaptive`

| 模式 | 运行时 | 复用开关 | 包目录 |
| --- | --- | --- | --- |
| ② 正式自适应基线 | 历史节点② | 尚无此功能 | `villa-git-adaptive-20261113` |
| ③ 复用全关 | 历史节点③ | 0 | `villa-indirect-disabled-20261113` |
| ③ 仅命令模板 | 历史节点③ | 1 | `villa-indirect-templates-20261113` |
| ③ 仅绑定复用 | 历史节点③ | 3 | `villa-indirect-bindings-20261113` |
| ③ 全部开启原版 | 历史节点③ | 2 | `villa-git-indirect-20261113` |

③各档共享相同的 WASM、JS、Cook、启动参数及原生输入。新包只改变
`r.WebGPU.IndirectDrawReuse`，各自经过统一发布收尾和匹配当前配置的实际管线采集，
不修改任何原始包。固定输出、内部尺寸、TSR、Lumen、VT、VSM 和自适应阴影采样保持一致。
页面一次运行一个场景，切换保留玩家位置和方向，重新累计近五秒统计。

## 待验证假设

1. 命令模板增加 CPU 开销。模板命中仍需计算几何哈希、查询缓存、整理八个顶点槽偏移，
   帧末还要扫描缓存；预测仅模板档也会退化，全关和仅绑定档可恢复。
2. 绑定复用的快路径没有稳定收益。尝试复用时先检查资源，不能复用时又进入常规绑定准备；
   预测仅绑定档会退化，仅模板和全关档可恢复。
3. 关闭开关仍保留公共路径变化。新增资源版本更新、绘制状态记录及编译布局不都由开关
   排除；预测③全关依然落后于②，届时需要从②源码逐项加入变更进一步检查。

以上是可证伪的假设，不是已确认原因。是否恢复流畅由用户继续操作对照确认，
自动浏览器检查只负责验证包身份、开关、预热、渲染状态和输入。

## 发布默认值

普通发布的 `web-accepted-defaults.cjs` 将本项设为 0，保留 VSM 自适应采样和
其他未被本次实包二分定位为首次退化来源的默认项。历史对照包不随默认值改动而重写。
关闭开关是防止继续默认带入退化组合的临时处理，不等于已经证明③完全恢复②的表现。

`verify-web-release-defaults.cjs` 检查最终发布 INI 中最后生效值为 0，
并用继承了旧值 2 的输入验证覆盖行为。它不声称测试到了真实场景中的 Low 帧退化。

## 本轮验证

三个新包均通过正式发布校验，各自安装了 312 个模块、320 条实际管线的匹配记录；
对三个包的解码后配置逐项比较，确认唯一设置差异为复用开关。
②、③四档共五个选项均通过预热采用、原生键盘移动、鼠标转向、切换视角保持、
桌面及窄屏布局检查。运行计数确认全关时两类命中为零，仅模板和仅绑定互不启用对方路径。
输出均为 `1920×1080`，内部均为 `1400×788`，抗锯齿 TSR，Lumen GI/反射、VT、VSM 均开启，
页面及 GPU 错误为零。默认值回归测试修改前失败，改为 0 后通过，继承旧值的覆盖也通过。

证据摘要：`tests/web-platform/evidence/indirect-isolation-20261113.json`。
本轮没有复现可用于判定流畅度的自动 Low 帧差距，尚未确认模板或绑定哪条路径导致退化。

## 复现

```powershell
node tests/web-platform/package-villa-indirect-isolation.cjs
node tests/web-platform/verify-web-release-defaults.cjs
node tests/web-platform/verify-villa-git-history.cjs indirect-isolation-browser-20261113 --page=villa-indirect-isolation-live.html --modes=adaptive,disabled,templates,bindings,combined --profile=indirect-isolation-20261113
```

打包报告与默认值回归日志位于 `tests/web-platform/results/indirect-isolation-20261113/`，
浏览器操作报告与截图位于命令指定的 `results` 目录内。所有产物、采集及临时文件留在项目内。
