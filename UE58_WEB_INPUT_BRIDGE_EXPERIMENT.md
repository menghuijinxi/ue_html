# Web 输入直连实验

日期：2026-11-05。承接 `UE58_WEB_MOTION_BLUR_INVESTIGATION.md`，按用户要求修改输入桥接并测试。

## 修改与测试范围

新增显式启用的 `direct-game-thread` 实验路径：

- 页面创建 MessageChannel，RHI owner 在初始化时把其中一个端口移交给 Game Thread。
- 此后的输入批次与确认消息直接经过页面和 Game Thread，不再逐批绕行 RHI owner。
- 页面微任务发送输入，不再额外等待页面 RAF；游戏帧本身的 RAF 完全保留。
- 保留单批在途背压、256 个待发事件上限、连续鼠标位移合并和焦点丢失时的按键释放；不把积压改成无限队列。
- 输入确认表示已经调用原生入口、加入 GT 队列，不代表 `PumpMessages` 已消费或画面已呈现。时间记录区分发送、入队和确认。

`web-engine-host.js` 将原队列封装为同一桥接类，未显式启用直连的包继续使用 owner 转发和页面 RAF。新旧实验包均启用相同的有限诊断记录。

`reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js` 增加端口接收器。为避免重建整个引擎引入其他变量，实验打包器从该源码获取原函数，仅替换现有运行时 JS 中的 `WebThreadBridge` 函数；两组使用同一份新 JS，只选择不同的输入模式。这不是一次完整的 UBT 构建验收。

配置、Cook 资源、WASM、TSR、Lumen、动态模糊、鼠标灵敏度和游戏帧调度均保持基线设置，未限制 10 FPS。多 GB 不变资源只做硬链接，修改文件独立创建，并重新生成完整资源摘要。

## 结果

两次独立进程复测均完成：

| 轮次 | 旧桥接 VelocityScale.X 最小 / 中位 / 最大 | 直连桥接最小 / 中位 / 最大 |
| --- | ---: | ---: |
| r1 | 16.58 / 183.50 / 3543.98 | 16.93 / 184.54 / 3591.78 |
| r2 | 17.17 / 176.57 / 3809.54 | 18.34 / 180.30 / 3665.35 |

r2 在完成 90 个预热帧后清空输入诊断，避免将初始化阶段的队列等待与转向输入混合：

| r2 检查 | 旧桥接 | 直连 |
| --- | ---: | ---: |
| 发送 / 确认批次 | 82 / 82 | 83 / 83 |
| 确认往返中位数 / P95 | 1.77 / 22.02 ms | 0.64 / 6.26 ms |
| 页面排队中位数 / 最大值 | 0.040 / 3.045 ms | 0.010 / 0.075 ms |
| 速度展开样本数 | 223 | 222 |
| 相机重投影矩阵非平凡的样本数 | 116 | 143 |
| 上述运动样本中 VelocityScale.X > 500 的个数 | 63 | 61 |
| GI / 反射 / AA | 1 / 1 / 4 | 1 / 1 / 4 |
| 页面错误 / GPU 错误 / 设备丢失 | 0 / 0 / 0 | 0 / 0 / 0 |

运动样本的筛选只是 `abs(ClipToPrevClip[12]) + abs(ClipToPrevClip[13]) > 0.00001`，用来确认尖峰不只发生在静止帧，不是完整速度纹理分析。500 是此次统计门槛，不是引擎合法值上限。

**直连确实改善了这轮输入送达延迟，但两次都未消除速度缩放尖峰。** 这削弱了“RHI owner 转发阻塞或页面 RAF 等待是主因”的假设。不能据此排除输入采样与 GT 消费帧不匹配：原生队列仍由原来的 `PumpMessages` 消费，本次也未改变或直接观测 CPU DeltaRealTime 与渲染参数快照。

结果更支持继续检查游戏帧计时、相机上一帧变换与渲染视图所用时间的对应关系。未读取最终速度纹理和动态画面模糊半径，也没有用户对直连版的主观验收，不能把数值测试通过表述成抖动已修复。

## 验证与证据

- 真实 MessagePort 与当前 `WebWorkerCanvas.js` 处理器的握手、直接入队、事件顺序、鼠标释放、位移合并、错误序号确认、背压和溢出释放测试通过。
- 两轮真实 Edge 转向测试共 903 个速度展开样本；r2 的两张停止转向后截图已检查，场景正常显示。
- 打包器校验原包全部资源摘要，并校验两组未修改资源相同；参考引擎 JS 与派生运行时语法检查通过。
- 原始结果：`tests/web-platform/results/motion-blur-inputs-20261105-input-direct-r1.json`、`motion-blur-inputs-20261105-input-direct-r2.json`。
- 打包结果：`tests/web-platform/results/input-bridge-20261105-package.json`。
- 可版本化摘要：`tests/web-platform/evidence/input-bridge-experiment-20261105.json`。

实验环境延续此前的 1280x720、DPR 1 和本机浏览器 / GPU CPU 掩码 `0xffff0000`。自动化鼠标事件和参数观察都有额外开销；本轮不是性能基准或端到端输入延迟测量。

## 手动入口

- 直连版：http://127.0.0.1:8765/build/triplex-input-direct-20261105/index.html
- 旧桥接对照：http://127.0.0.1:8765/build/triplex-input-owner-20261105/index.html

建议在同一个浏览器标签中切换，使用相近的移动和转向操作，避免两个关卡同时运行产生额外负载。两组均保留 Lumen 与动态模糊，未更换原来关闭动态模糊的 B 包。

复验使用新的标签，保留既有包和取证：

```powershell
node tests/web-platform/verify-web-input-bridge.cjs
node tests/web-platform/package-web-input-bridge.cjs --tag=20261105-recheck
node tests/web-platform/probe-web-motion-blur-inputs.cjs --tag=20261105-recheck-r1 --input-bridge-tag=20261105-recheck
```

浏览器脚本需要预先设置包含 Playwright 的 `NODE_PATH`，并运行 8765 本地服务器。直连仍是实验选项，未推广为默认输入路径；安装目录 `H:/UE_5.8` 未修改。

参考引擎对应本地提交：`3764d5d828`。外围源码、测试及证据由工作区根仓库单独提交，均不推送远程。
