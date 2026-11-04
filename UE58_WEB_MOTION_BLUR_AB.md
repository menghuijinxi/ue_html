# 网页动态模糊与 Lumen 对照测试

日期：2026-11-04。

用户要求两轮手动对照：第一轮关闭 Lumen 并限制 10 FPS，保留动态模糊；第二轮保留 Lumen，只关闭动态模糊。

## 测试入口

| 组别 | Lumen GI / 反射 | 动态模糊 | 帧率限制 | 入口 |
| --- | --- | --- | --- | --- |
| A | 关闭 | 保留原设置 | 10 FPS | http://127.0.0.1:8765/build/triplex-motion-no-lumen-10fps-20261104-v2/index.html |
| B | 保留原设置 | 关闭 | 原设置 | http://127.0.0.1:8765/build/triplex-motion-no-motion-blur-20261104-v2/index.html |

先测试 A，再在同一个浏览器标签中导航到 B，避免同时运行两个关卡。使用相近的移动速度和转向幅度，观察是否仍然出现重度模糊与清晰帧交替、画面跳动。两组继续使用 TSR，未改动玩家、输入或鼠标灵敏度。

基线为 `triplex-project-lumen-shadows-fixed-20261104`。两组共用相同的阴影修复版 WASM、引擎 JS 和 Cook 场景资源。修改的配置文件为各组自己的副本，不写入项目或基线包。

A 的启动覆盖：

```ini
[SystemSettings]
r.DynamicGlobalIlluminationMethod=0
r.ReflectionMethod=0
r.Lumen.DiffuseIndirect.Allow=0
r.Lumen.Reflections.Allow=0
t.MaxFPS=10
```

B 的唯一启动覆盖：

```ini
[SystemSettings]
r.MotionBlurQuality=0
```

## 10 FPS 的实际执行

第一次仅写入 `t.MaxFPS=10` 时，日志确认该设置被读取，但实测仍为 38.80 提交 FPS，中位间隔 19.59 ms，未达到测试要求。失败记录保留在 `tests/web-platform/results/motion-blur-ab-20261104-runtime.json`；尚未定位该运行包中设置未持续生效的具体原因。

因此 A 的独立 `web-engine-worker.js` 副本另外限制 owner 的 RAF 回调。游戏线程已有的帧桥接从该 owner 获取回调，间隔至少约 100 ms；仿真继续采用真实经过时间。该限制不是固定仿真时间步，也不通过重复帧或改动 HUD 数字模拟 10 FPS。B 和基线保留原始帧调度。

只有 A 的 worker 副本、A/B 的配置与浏览器标题发生变化。A 的 HTML 同步更新 worker 内容摘要，所有文件的 `asset-versions.json` 重新生成。共享的大文件仅建立只读用途的硬链接，所有待编辑文件均单独创建。

## 自动验证

`package-web-motion-blur-ab.cjs` 校验完整基线文件摘要，并逐个校验派生包的未修改资源。`probe-web-motion-blur-ab.cjs` 在独立 Edge 进程中依次运行基线、A、B，通过真实鼠标转向、真实视图配置、RHI 提交时间和 WebGPU 资源绑定检查设置。动态模糊输出检查包括已池化纹理的绑定，避免只看纹理创建次数。

本机测试使用 1280×720、DPR 1；浏览器和 GPU 进程采用此前驱动编译器诊断所用的 CPU 掩码 `0xffff0000`。该掩码仅适用于本机，不应直接套用到其他电脑。此轮不是性能基准。

| 检查 | 基线 | A | B |
| --- | ---: | ---: | ---: |
| 真实视图 GI / 反射方法 | 1 / 1 | 0 / 0 | 1 / 1 |
| AA 方法 | 4 | 4 | 4 |
| `MotionBlur.SceneColor` 创建次数 | 1 | 1 | 0 |
| `MotionBlur.SceneColor` compute 绑定次数 | 556 | 496 | 0 |
| Lumen 屏幕探针深度纹理创建次数 | 2 | 0 | 2 |
| 页面 / GPU 错误 / 设备丢失 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |

A 采集 66 个提交点、65 个间隔，经过 6741.32 ms，平均 9.642 FPS，中位间隔 100.27 ms。转向采集包含一次 291.09 ms 长间隔；限速通过不代表已经消除长帧或视觉抖动。随后截图时 HUD 显示 10.0 FPS、页面观察 10.0 FPS。

两组场景截图已检查为正常显示。B 没有动态模糊输出分配或绑定，Lumen 仍然创建屏幕探针；不是通过关闭 TSR 或 Lumen 实现无模糊。

结果：

- `tests/web-platform/results/motion-blur-ab-20261104-v2-package.json`
- `tests/web-platform/results/motion-blur-ab-20261104-v2-runtime.json`
- `tests/web-platform/evidence/motion-blur-ab-20261104.json`

复现时使用新的标签，保留此前包与证据：

```powershell
node tests/web-platform/package-web-motion-blur-ab.cjs --tag=20261104-recheck
node tests/web-platform/probe-web-motion-blur-ab.cjs --tag=20261104-recheck
```

需预先设置带有 Playwright 和 pngjs 的 `NODE_PATH`，并使用已有的 8765 本地服务器。手动启动 A 的示例：

```powershell
& tests/web-platform/start-web-preview.ps1 -Folder triplex-motion-no-lumen-10fps-20261104-v2 -AffinityMask 4294901760
```

## 手动对照结果

2026-11-04，用户依次完成同一浏览器窗口中的两轮测试：

- A：关闭 Lumen、保留动态模糊、实际限制 10 FPS，无明显抖动。切换前页面 HUD 的提交与观察帧率均为 10 FPS。
- B：开启 Lumen、关闭动态模糊、保留原帧率设置，无明显抖动。

结合原先 Lumen 与动态模糊同时开启时的剧烈抖动，当前复现条件已经收敛到开启 Lumen 时的动态模糊路径。低帧率本身在 A 的条件下没有复现该现象；B 保留 TSR 和 Lumen，关闭动态模糊即可消除用户观察到的明显抖动。两组帧率条件不同，这些结果尚不能区分具体是运动矢量、模糊时间尺度、历史帧数据还是其他调度关联问题。

浏览器当前停留在 B，作为继续查看场景的临时测试配置。本轮完成对照与结果记录，未修改引擎动态模糊实现，也未把关闭效果作为最终修复。
