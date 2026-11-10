# 关闭 Lumen 的别墅对照

入口：`http://127.0.0.1:8766/villa-engine-comparison.html?lighting=off#ours`。
顶部标为“Lumen 关闭”，可切换我们的 UE 5.8 v71 与官方 UE 5.9。
切换会卸载前一个场景；测试时只保留一个场景页面，避免多个实例争用资源。
原 Lumen 入口不带 `lighting=off`，继续使用原来的包和配置。

## 配置

`tests/web-platform/villa-engine-comparison-no-lumen.json` 与原配置仅三项不同：

| 参数 | Lumen 入口 | 本入口 |
| --- | --- | --- |
| `r.DynamicGlobalIlluminationMethod` | 1 | 0 |
| `r.Lumen.DiffuseIndirect.Allow` | 1 | 0 |
| `r.ReflectionMethod` | 1 | 0 |

两边都保持 `r.Lumen.Reflections.Allow=0`、`r.Lumen.HardwareRayTracing=0`，
不改为 SSGI 或 SSR。固定 1920×1080、100% 渲染比例、TAA、Epic 质量、
496 MiB 纹理池、阴影、距离场 AO 和雾等其他设置沿用原对照。
保持 `t.MaxFPS=0`、`r.VSync=0`，保留 FPS 与 1% Low 显示。
浏览器和显示刷新节奏仍可能限制帧率。

关闭 Lumen 能减轻相关渲染负载，也会改变 CPU 侧的渲染工作量。
本入口比较的是无 Lumen 配置的整体表现，不是纯 CPU 基准：
阴影、AO、后处理等仍使用 GPU。没有测得 GPU 已脱离瓶颈前，
不能把 FPS 差距直接当作 CPU 性能倍率；本次不发布性能排名。
没有烘焙新的间接光，关闭 Lumen 后的照明变化属于此配置的预期差异。

## 构建

这是已有运行时和 Cook 的独立配置包，不是重编译或重新 Cook。
我们的包复用 `villa-prewarm-20261110-v4` 的二进制和资源，
包含多标签页缓存锁修复；最终目录为 `villa-no-lumen-20261110-v1`。
官方使用 `ue59-official-villa-20261109/no-lumen-20261110` 独立目录，
启动参数注入相同设置；引擎源码和二进制不变。
不写入 `H:/UE_5.8`，本轮缓存、录制和临时文件均在 H 盘。

两边为无 Lumen 配置单独录制实际 PSO，并启用各自的管线预热。
录制只覆盖出生点和短距离移动，不保证任意路线都不发生首次编译。
官方安装工具通过临时文件替换更新新目录的预热包与清单，
不会改写硬链接所指向的原 Lumen 包。
根目录额外的 `comparison-no-lumen-files.json` 仅用于官方服务的路径允许清单。

## 验证结果

Chrome、Edge 均在默认 CPU 调度、DPR=1.5 下通过两个版本的实际出图、
画布/场景尺寸、帧统计、PSO、移动、页内切换和 390×844 布局检查；
运行中改变 DPR 后，我们仍保持 1920×1080。页面与 GPU 校验错误为 0。
官方控制台读回的全部 24 项共同设置与配置一致；我们的运行时读回 GI=0、
反射方法=0，启动日志确认 Lumen GI 开关为 0。

我们的录制包含 195 条描述，按完整描述去重后准备 191 条管线，
两次验收出生点均记录 245 次命中、0 次未命中。
官方准备 159 条管线，出生点 render/compute 合计 168 次命中、0 次未命中。
这些数量反映各自实现和录制覆盖，不是相同工作量或性能倍率。

摘要及文件哈希：`tests/web-platform/evidence/villa-no-lumen-20261110.json`。
截图和原始日志：`tests/web-platform/results/villa-engine-comparison-20261110-no-lumen-{chrome,edge}/`。
原官方包的 75 个文件逐一核对未变；新目录只替换预热包和缓存清单。
首次官方录制因服务允许清单未包含子目录而返回 404，补齐后重新录制通过，
失败输出保留在 `results/ue59-no-lumen-20261110-capture/`。
之前的原生 GPU/编译器间歇崩溃根因仍未确认修复。

## 复现

输出目录不可覆盖；重复制作应先更新配置中的版本目录和录制 tag。

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/package-villa-no-lumen.cjs
node tests/web-platform/probe-villa-startup.cjs --tag=20261110-no-lumen-capture --lighting=off --engine=ours --folder=villa-no-lumen-capture-20261110-v1 --capture --rounds=1 --motion-seconds=20
node tests/web-platform/package-villa-prewarm.cjs --tag=villa-no-lumen-20261110-v1 --source=villa-no-lumen-capture-20261110-v1 --corpus=tests/web-platform/results/villa-startup-20261110-no-lumen-capture/0-corpus.json
node tests/web-platform/capture-ue59-no-lumen.cjs --tag=20261110-capture-v2
$uePython='E:/UE59WebBenchmark/emsdk-6.0.10/python/3.13.3_64bit/python.exe'
$prewarmTool='E:/UE59WebBenchmark/engine-5.9/Engine/Platforms/Wasm/Build/Tools/web/prewarm_pack.py'
$stage='H:/ue_html/tests/web-platform/build/ue59-official-villa-20261109/no-lumen-20261110'
$capture='H:/ue_html/tests/web-platform/results/ue59-no-lumen-20261110-capture-v2'
& $uePython $prewarmTool pack "$capture/webgpu-capture.json" --stage $stage --out "$capture/pack" --after-ready 30
& $uePython $prewarmTool install "$capture/pack/WebGPUPrewarm-SF_WEBGPU_SM5.json" --stage $stage
node tests/web-platform/verify-villa-engine-comparison.cjs --lighting=off --dpr=1.5 --tag=20261110-no-lumen-chrome
node tests/web-platform/verify-villa-engine-comparison.cjs --lighting=off --dpr=1.5 --browser=msedge --tag=20261110-no-lumen-edge
```
