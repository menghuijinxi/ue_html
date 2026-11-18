# 别墅 1% Low 与打包优化遗漏调查（2026-11-15）

原测试页面已恢复调试信息：

http://127.0.0.1:8775/build/villa-presentation-performance-20261115/index.html

左上角显示 FPS、近 5 秒 1% Low、帧时间曲线、P99、最长帧、超过 50/100 毫秒的帧数和管线预热未命中数，可导出逐帧数据。预热未命中计数增加表示当前视角使用了采集记录之外的管线；API 调用时间不包含浏览器 GPU 进程中全部异步编译时间。

## 已确认的原因

1. **打包流程混合了画质和后端优化。** 按原项目设置打包时跳过了 `applyAcceptedDefaults`，连同 15 个后端效率选项一起跳过。上一轮已将它们放入 CVar 构造默认值，项目显式配置仍可覆盖。本轮又发现网页命令回放临时数组复用默认值遗漏，已恢复；正式测试中 94,597 次回放只分配 1 次，复用 94,596 次。这个计数证明分配减少，不能单独当作帧率收益。
2. **预热仅覆盖启动画面。** 旧包首次漫游新增 6 次管线未命中。浏览器跟踪直接记录到两次 DXC 编译约 354.7 和 238.1 毫秒，对应 GPU 管线创建约 412.7 和 264.4 毫秒，并使提交队列等待。这是大幅拉低首次路线 1% Low 的已确认原因。本轮补采室内移动、转向、旋转三条各 20 秒的实际路线；记录从 320 条管线增加到 331 条，新包两段正式测试的未命中数均为 0。
3. **首次资源流送仍会同步等待。** 补齐预热后，普通测量仍有一帧约 113 毫秒。随后单独的 CPU 跟踪捕获到同类停顿：`FTexture2DStreamIn_IO_AsyncReallocate` → `RHICreateTextureInitializer` → `emscripten_proxy_sync`，一次采样窗口中约 117.9 毫秒在等待；游戏线程随后卡在 `FRenderCommandFence::Wait`。该跟踪没有超过 20 毫秒的 DXC/管线创建事件。已定位到纹理重分配和资源所属线程之间的同步链路，尚未验证这部分的修复，也不能将全部等待直接算作磁盘读取或 GPU 执行时间。

缓存设备覆盖了原来的原型观察函数，导致部分真实的编译未命中未进入调试导出。本轮同时补上实际缓存未命中的事件回传，已预热命中不重复记为编译。

## 同条件测量

RTX 4090、驱动 621.24、Edge、1280×720、DPR=1。前后包 WASM、启动脚本、Cook 内容、项目配置相同；普通时间推进，每次首次路线 20 秒，随后重复路线 20 秒。没有 CPU/GPU 跟踪器或逐绘制 GPU 包装，保留全部长帧。

| 测量 | 平均提交 FPS | 1% Low FPS | P99 | 最长帧 | >100 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 修改前首次路线 | 26.69 | 5.09 | 83.34 ms | 466.09 ms | 3 |
| 修改后首次路线 | 28.35 | 14.11 | 53.29 ms | 113.29 ms | 1 |
| 修改前重复路线 | 30.57 | 15.44 | 53.23 ms | 97.61 ms | 0 |
| 修改后重复路线 | 30.46 | 16.93 | 50.44 ms | 90.30 ms | 0 |

本轮可确认的是首次移动时的编译尖峰明显减少。平均帧率仍约 28–30 FPS，重复路线基本未提高，不能宣称已恢复历史 50 多 FPS，也没有在 RTX 3070 上验证。当前工作线程 CPU 校准约 283–287 毫秒，上一轮正式测试约 228–234 毫秒，运行条件有差异；这不构成全部帧率差的解释。此前历史包还存在 GI、反射、虚拟阴影设置差异，不能直接归因于 Nanite。

## 防止再次遗漏

- 普通项目和模板打包统一生成 `optimization-contract.json`：核对 17 个 Web 后端默认值、已构建源码哈希、真正参与构建的覆盖源码和 WASM 身份。补齐 TSR 源文件的构建审计条目；本次重新构建通过，447 个对象，636 个源码审计输入，WASM 哈希未变。
- 浏览器采集时读回 10 个原生优化开关，并检查命令回放复用状态。缺失或实际值不符就失败。项目显式覆盖被保留并作为期望值核验，整个项目配置包不追加画质覆盖。
- 别墅预热必须完成指定三条路线；只有启动画面、路线未完成、WASM/内容/配置/启动参数/分辨率不匹配的记录不能作为正式发布记录。所有发布入口更新并校验当前宿主与 worker 哈希。

原项目 1632 个审计输入未变，三份项目 INI 逐字节一致，Cook 内容和整个配置包与原展示版相同。Lumen、虚拟阴影、TSR、距离场、纹理池均按原项目设置。剩余纹理同步等待需要继续从资源创建和线程调度路径处理。

## 复现与验证

```powershell
node tests/web-platform/set-web-performance-hud.cjs --folder=villa-presentation-performance-20261115 --audit-current-build
node tests/web-platform/verify-web-release-defaults.cjs
node tests/web-platform/verify-web-pipeline-prewarm.cjs
node tests/web-platform/verify-web-optimization-contract.cjs
node tests/web-platform/verify-web-live-performance.cjs --unit-only
node tests/web-platform/diagnostics/diagnose-villa-low-frames.cjs --tag=新的结果标签 --seconds=20
```

`--trace` 用于 GPU 编译归因，`--cpu-trace` 用于线程采样；这两种模式的帧率不用于性能验收。复测标签只接受小写英文、数字和连字符。原始跟踪文件保存在 results，体积较大。

完整审计与数据：`tests/web-platform/evidence/villa-low-frames-20261115.json`。汇总命令：`node tests/web-platform/diagnostics/summarize-villa-low-frames.cjs`。
