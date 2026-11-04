# WebGPU Lumen 浴室镜面诊断

日期：2026-11-04。状态：**复现并确认当前反射路径存在能力差距，桌面镜面效果未达标，尚未修复渲染效果**。

用户提供的网页和编辑器截图显示：网页镜中的暖气架细杆、墙砖和马桶轮廓缺失或模糊。仅有 `r.ReflectionMethod=1`、着色器通过编译或场景能运行，不足以验收反射正确性。

## 同机位对照

使用原项目设置的隔离副本 `build/projects/triplex-project-lumen`、同一浴室镜子，固定相机 `(-620, 0, 160)`、Pitch/Yaw 为 0、FOV 90；这是可复现机位，不声称与用户截图相机完全一致。三方均为 1280×720、TSR 和自动曝光。原生为 D3D12 SM6，Web 为桌面 SM5 路径。原生预热 240 帧再采样 60 帧；Web 设置相机后另预热至少 120 帧。

| 条件 | 诊断覆盖 | 镜面观察 |
| --- | --- | --- |
| 原生项目模式 | 无覆盖；项目 RayTracing=1、LightingMode=2 | 暖气架细杆、墙砖等细节保留 |
| 原生完整软件 Lumen | 仅 `r.Lumen.HardwareRayTracing=0` | 重现 Web 的模糊块状反射和细节缺失 |
| Web 软件 Lumen | 无画质覆盖，使用阴影修复后的包 | 与原生完整软件模式接近 |
| 原生混合模式 | 仅 `r.Lumen.Reflections.HardwareRayTracing=0`，保留硬件 GI | 镜面接近黑色，不能作为有效的软件基线 |

项目配置和 `H:/UE_5.8` 安装目录未编辑。Web 使用 `triplex-project-lumen-shadows-fixed-20261104`，未替换发布包。

镜面 ROI 为 `(605, 225, 420, 235)`，避开镜框和明亮灯条。平均误差是 0～255 范围内 RGB 通道绝对差；“明显变化”指单像素平均通道差大于 16。

| 比较 | 平均误差 | 明显变化像素 |
| --- | --- | --- |
| Web 对原生完整软件模式 | 1.927 | 1.640% |
| Web 对原生项目模式 | 12.314 | 19.167% |
| 两次独立 Web 启动 | 0.902 | 0.016% |
| Web 关闭反射对基线 | 47.506 | 97.572% |
| Web 恢复反射对基线 | 1.826 | 1.732% |

墙面和水盆两个非镜面区域的 Web/原生软件平均误差分别为 1.285 和 0.937。原生混合模式对原生项目的墙面/水盆误差为 0.887/0.524，镜面则为 20.371；混合模式出现近黑镜面的具体原因未定位，不能用它推导软件模式的画质。

三方镜面裁剪图位于 `tests/web-platform/results/lumen-reflections-20261104-comparison.png`，从左到右为原生项目硬件模式、原生完整软件模式、Web 软件模式。所有相机、启动参数、图像和报告 SHA256 保存在 `tests/web-platform/evidence/lumen-reflections-20261104.json`。

## 结论与边界

完整软件模式同时改变 GI 和反射的追踪路径；它在原生端重现 Web 的镜面表现，支持当前问题主要是距离场/Surface Cache 路径与项目硬件路径的能力差距。这个机位未发现必须靠 Web 专属错误才能解释的额外大幅偏差；不能据此排除其他机位的 Web 缺陷。

镜面专项仍不通过。当前脚本的局部容差为平均通道差不超过 3、明显变化比例不超过 5%；只用于可复现比较，不能代替镜中物体正确性的视觉检查。证据明确记录 `desktopReflectionParityAccepted=false`、`rendererFixApplied=false`。

后续需要验证能保持镜中几何细节的反射路径，例如针对平面镜的实时平面反射，或基于三角形的追踪方案。尚未选定或实现新方案；没有用锐化、提亮或降低原生画质来冒充修复。本轮不验收长时间运行、其他镜面/透明材质、移动端或性能。

## 复现

在工作区根目录运行，Node 的依赖路径需包含 Playwright、pngjs 和 sharp。原生和 Web 测试串行执行，避免 GPU 竞争。报告名使用新后缀以保存旧证据。

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
$taskProject='H:/ue_html/tests/web-platform/build/projects/triplex-project-lumen/TriplexHouseVilla.uproject'
foreach ($taskMode in @('Project', 'Software', 'SoftwareReflections')) {
    & tests/web-platform/capture-villa-distance-fields.ps1 -Project $taskProject `
        -UseProjectSettings -LumenTracing $taskMode `
        -CasesFile H:/ue_html/tests/web-platform/lumen-reflection-cases.json `
        -Width 1280 -Height 720 -Warmup 240 -Samples 60 -Report "mirror-$($taskMode.ToLowerInvariant())"
}
node tests/web-platform/probe-web-lumen-shadow-artifacts.cjs `
    --folder=triplex-project-lumen-shadows-fixed-20261104 --tag=mirror-repeat `
    --camera=-620,0,160,0,0 --baseline-only
node tests/web-platform/probe-web-lumen-shadow-artifacts.cjs `
    --folder=triplex-project-lumen-shadows-fixed-20261104 --tag=mirror-cycle `
    --camera=-620,0,160,0,0
node tests/web-platform/summarize-web-lumen-reflections.cjs `
    --web=tests/web-platform/results/mirror-cycle.json `
    --repeat=tests/web-platform/results/mirror-repeat.json `
    --native-software=tests/web-platform/results/villa-distance-fields-mirror-software `
    --native-project=tests/web-platform/results/villa-distance-fields-mirror-project `
    --native-reflections=tests/web-platform/results/villa-distance-fields-mirror-softwarereflections `
    --output=tests/web-platform/results/mirror-diagnosis.json
```

汇总默认检查复现、开关恢复、同软件模式及启动覆盖边界；它成功不表示桌面镜面通过。增加 `--require-desktop-parity` 会启用原生项目镜面门槛，当前实测以退出码 1 报告 `Desktop mirror parity is not met`，保留失败证据。三个原生模式正常退出、Web 两次启动和反射关闭/恢复无 GPU 错误，脚本语法与诊断参数保护检查通过；没有修改引擎渲染代码，因此没有重编译引擎。
