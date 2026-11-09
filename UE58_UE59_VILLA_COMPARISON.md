# 别墅手动流畅度对照

入口：`http://127.0.0.1:8766/villa-engine-comparison.html#ours`。
顶部切换 UE 5.8 v71 与 UE 5.9 官方版。切换会移除前一个 iframe 及其运行时，
每次从同一关卡出生点开始。比较时只保留这一张场景页面。

## 对齐条件

配置源是 `tests/web-platform/villa-engine-comparison.json`。
两边均使用桌面 WebGPU、固定 1920×1080 画布、100% 渲染比例、Epic 各项质量、
TAA、软件 Lumen GI、496 MiB 纹理池；关闭 Lumen 反射、硬件光追、
Nanite、VSM、动态分辨率、运动模糊和 UE VSync，`t.MaxFPS=0`。
页面只对固定画布进行 CSS 缩放，窗口尺寸和系统 DPI 不改变渲染像素数量。

这是新设定的共同配置。此前官方普通链接会自动选择 Medium，
不能把那一页记录的 119.6 FPS 当成本页官方版本的测量值。
浏览器呈现节奏与两种运行时各自的队列控制仍然存在。

## 构建来源

- 我们：本机保留的 `villa-scheduling-latest-v71` 运行时，
  WASM SHA-256 `88f09cc19f6694495d0c73c45394a52ce2ac369450674b14c0b9aeffda38171a`。
  配套使用 `triplex-project-lumen-shadows-fixed-20261104` 的 Lumen Cook；
  加入 `desktop-accepted-20261107` 性能设置、页面帧预算 3 和直接游戏线程输入。
  生成包为 `build/villa-ue59-comparison-20261109-v3`。
- 官方：已完成构建的 Epic UE 5.9，
  提交 `589a52b5abcf7b0ee0e2fd9de58b4d2872672f21`，通过启动参数覆盖共同设置；
  官方引擎源码、WASM 和 Cook 文件没有修改。

本机已没有 `villa-default-20261107` 和它的验收二进制。
因此这里明确标为 v71，不能声称原样恢复了 11 月 7 日验收版本，
也没有重新编译当前参考引擎源码。引擎版本、着色器生成、Cook 和调度实现不同；
主要画质参数和视角对齐不等于全部内部算法或逐像素结果相同。

## 服务与复现

8765 是已有的 `serve.cjs`，8900 是官方 `serve.py --net none`。
新增 `serve-villa-engine-comparison.cjs` 只监听 `127.0.0.1:8766`：
普通路径转发到 8765，`/official/` 转发到 8900。
它原样传递压缩、Range 和隔离响应头，使两种运行时可在同一隔离来源下加载。
没有放宽官方 CORP 限制，也没有向局域网公开服务器。

独立打包入口：

```powershell
node tests/web-platform/package-villa-engine-comparison.cjs
```

脚本先验证历史包和运行时摘要，拒绝覆盖已存在的输出。
只对不改写的 Cook 文件使用硬链接，配置、运行时及 HTML 均为独立副本。

浏览器验证：

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/verify-villa-engine-comparison.cjs --tag=20261109-final
```

验证包括真实 Chrome 出图、隔离状态、画布/内部尺寸、运行时主要设置、
官方控制台实际 CVar、键盘移动、场景截图、移动尺寸布局及页内版本切换。
完整输出留在 `tests/web-platform/results/villa-engine-comparison-20261109-final/`。
这轮提供手动对照入口，没有发布新的 FPS 排名或端到端输入延迟结论。

## 调试边界

准备阶段发现旧 Lumen Cook 与 11 月 6 日 VT 运行时不兼容；改用配套 VT Cook 后，
曾出现 D3D12 管线创建/设备丢失，受限核心下又暴露纹理原子视图断言。
这些失败记录保留在 `20261109-a`、`20261109-b`、`20261109-c`、
`20261109-ecores` 的结果中，没有把失败包作为最终入口。

最终 v71 组合已在默认 CPU 调度下完成两种引擎的出图和移动验证，
`20261109-proxy` 记录双方通过且无页面/GPU 校验错误。
之前的受限核心诊断不用于最终页面，也不据一次通过宣称宿主间歇故障已修复。
官方原有的未构建静态光照与纹理池超预算提示仍保留。
