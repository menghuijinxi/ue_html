# 别墅移动崩溃修复

用户诊断：`ue-startup-diagnostics-2026-10-31T03-46-04-973Z.json`。正式包：`triplex-project-distance-fields-threads`。保持项目配置与原 Cook 资源，只重新编译并打包 Web 运行时。

## 原因

用户报告在第 5 帧的角色速度绘制中断言：`GPUSkinPassThroughVFLooseParameters_PreviousPositionBuffer` 为空，调用链为 `RenderVelocities → SubmitMeshDrawCommandsRange → CreateGroups → ResolveBinding`。

`FGPUSkinPassthroughVertexFactory::InitRHI` 将默认位置、上一帧位置和预蒙皮切线绑定到 `GNullVertexBuffer.VertexBufferSRV`。原来的 `-WebMinimalStartup` 兼容分支认为关闭手动顶点抓取后这个 SRV 不会使用，直接返回空引用。角色的速度绘制仍会反射并绑定上一帧位置，所以启动后立即操作可以进入这条遗漏路径。按原玩家出生点、1533×812 CSS 窗口和 DPR 1.21，从第 2 帧开始操作，旧包在第 4 帧复现相同断言。

## 修复

Web RHI 为这个精确识别的全局 12 字节零顶点缓冲创建真实的 float32 SRV，匹配上一帧位置的标量存储布局。缓冲内容和原来的 `FrameNumber` 分支不变；有效的动画历史仍使用实际上一帧位置缓冲。检查原描述、范围、资源类型、反射格式及访问状态，保留绑定失败断言。Win64 启动探针的历史行为不变。

没有关闭角色、Skin Cache、速度绘制、运动模糊、距离场或其他项目功能，也没有用吞掉断言的方式继续绘制。原项目 1632 个输入文件哈希再次核对，无改动。

## 验证

`probe-web-project-gameplay.cjs` 使用真实 WASD、空格和鼠标右键转向；从第 2 帧开始操作，周期性改变浏览器窗口尺寸，不调用测试相机 RPC，也不覆盖渲染设置。每轮检查引擎持续推进、真实位移超过 50 cm、转向超过 10°、默认位置 SRV 创建成功，并收集页面异常、UE 断言、WebGPU 错误和诊断。

修复前结果：`tests/web-platform/results/project-gameplay-crash-before.json`，第 4 帧出现与用户第 5 帧一致的空资源断言。

修复后结果：`tests/web-platform/results/project-gameplay-crash-fixed.json`，三个独立浏览器配置目录分别全新启动，从第 2 帧开始操作，每轮持续约 93 秒，分别推进至第 280、277、239 帧。三轮均通过，最大真实位移约 154 cm、转向约 31.5°，UE 断言、页面异常、WebGPU 错误均为 0。距离场及其他运行时设置与原项目一致。

补充可见 Edge 测试：`tests/web-platform/results/project-gameplay-crash-fixed-user-surface.json`。采用 1899×1068 CSS 窗口和 DPR 1.21，实际输出画布 2298×1293，与用户诊断的 2297×1292 接近；连续操作约 32 秒并多次缩放，推进至第 180 帧，所有检查通过。此轮空格键跨至少两个引擎帧保持，避免只发送瞬时按键事件。截图已经人工检查，渲染正常。

正式多线程运行时通过正常 UBT 编译、链接、WASM 校验及打包源文件/产物哈希检查，Cook 资源和配置不变。网页地址仍为 `http://127.0.0.1:8765/build/triplex-project-distance-fields-threads/index.html`；已有标签页需要重新加载，才会使用带新哈希的 JS/WASM。验证范围为出生点附近的连续实际操作及启动/缩放路径，未将此结果视为整张地图的长期漫游稳定性结论。

复现最终测试：

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-project-gameplay.cjs --tag=crash-fixed-user-surface --runs=1 --seconds=30 --width=1899 --height=1068 --dpr=1.21 --visible
```
