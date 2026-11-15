# 别墅展示测试版（2026-11-15）

入口：http://127.0.0.1:8765/build/villa-presentation-20261115/index.html
输出：tests/web-platform/build/villa-presentation-20261115

基于 villa-project-settings-20261115 生成独立展示包，仅在入口页隐藏左上角性能调试面板。场景、引擎、内容清单、项目配置的 SHA-256 与原包一致。统一发布收尾流程复用匹配的实际管线预热记录并校验当前 worker。

生成命令：node tests/web-platform/package-villa-presentation.cjs
可用 --source=<包名>、--output=<新包名> 指定来源与输出；已有输出不会覆盖。

Edge 1280×720、DPR=1 的启动与 8 秒移动验证通过，无页面或 GPU 错误，实际预热数据已采用。截图已目视确认左上角无调试面板；原项目的 Lumen GI、反射、虚拟阴影、距离场保持开启。

证据：tests/web-platform/evidence/villa-presentation-20261115.json
截图：tests/web-platform/results/villa-startup-presentation-20261115/0-ours.png

沿用原测试包的验证边界，未新增长期稳定性、音频或原生硬件光追画质验收。本地提交，不推送。
