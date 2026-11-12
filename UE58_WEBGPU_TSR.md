# WebGPU TSR 兼容

日期：2026-11-02。
参考引擎提交：`061234ef2`。本文 `results/` 路径均相对于 `tests/web-platform/`。

2026-11-12 更新：新增按实际设备额度选择的 32x32 卷积排列，保留 16x16 回退。
本页以下为初版兼容记录；最新实现、性能和限制见
[Lumen 与 TSR 热点优化](UE58_WEB_LUMEN_TSR_HOTSPOTS.md)。

## 实现

`SP_WEBGPU_SM5` 声明支持 Gen5 Temporal AA。项目选择 `r.AntiAliasingMethod=4` 时，渲染器可进入 UE 原有 TSR 通道。ES3.1 能力不变。

- Web 使用 UE 的 FP32、LDS 路径，显式覆盖 Vulkan 编译环境遗留的 wave 能力宏。没有关闭历史重建、历史拒绝、抗闪烁、细线检测或运动模糊来绕过转换。
- 将最近遮挡深度的纹理原子操作改为结构化缓冲原子操作；清理、散射与历史读取采用相同索引，越界访问显式排除。RDG 跟踪缓冲依赖。
- 初版卷积工作组使用 16x16，适配 WebGPU 默认 256 个 invocation 的额度；CPU 派发数量同步调整，保留原来的 halo。当前版本额外提供按实际额度选择的 32x32 排列。
- 工作组投票先归约到原子变量，再写入普通共享变量，以 barrier / 整数读取 / barrier 广播结果，让 Tint 生成可验证的一致控制流。
- 无穷大参与的符号和阈值计算改用有限数学表达式，避免 Tint 对无穷大模块常量的内部断言。
- 存储纹理声明匹配实际格式和访问方式。权重松弛、细线检测的中间掩码保留读写权限。历史颜色 R11G11B10 / RGBA16F、最终输出及正交视图的速度格式使用独立排列。
- 空间边缘分析以四次 texel 读取完成双线性插值，保留深度采样的插值行为，避免将不可过滤的深度绑定与过滤采样器组合。
- RHI 将 TSR 使用的 `SceneVelocityTexture` 识别为不可过滤的速度纹理，匹配其实际 texel 读取及浏览器格式能力。
- RHI 申请每通道最多 8 张存储纹理，受适配器实际额度限制；TSR RejectShading 最多写入 7 张，不能沿用浏览器默认开放的 4 张额度。
- 共享的运动模糊速度归约在 Web 上使用完整工作组同步，避免假定 Vulkan 的 subgroup 执行与内存可见性。

格式替换保留数值范围与精度，但会增加部分中间资源占用：

| 资源 | 原生格式 | Web 格式 |
| --- | --- | --- |
| History guide | RGB10A2，支持 alpha 时 RGBA16F | RGBA16F |
| 最近深度 | R16F / RG16F / RG32F | RG32F |
| 整数掩码 | R8 UINT | R32 UINT |
| 空间抗锯齿中间结果 | RG8 UINT | RG32 UINT |
| 深度散射原子 | R32 UINT 纹理数组 | 相同 uint32 布局的结构化缓冲 |

历史颜色仍遵循 `r.TSR.History.R11G11B10`，历史分辨率仍遵循项目及 Scalability 设置，没有为了 Web 强制降低它们。正交输出格式有编译分支，运行验收使用别墅的透视相机。

## 构建与验证

使用独立的参考源码、Web 编译覆盖和本地 Cook 主机；不修改安装目录 `H:/UE_5.8`。原生 Cook Renderer 使用此前解决 MSVC 内部错误的主机禁优化参数；浏览器 Renderer 继续使用优化编译。

针对性着色器回放复现过无穷大常量断言、屏障一致性失败、错误的只写存储声明以及 subgroup 一致性失败，修正后分别通过。

最终构建与产物：

- 原生 RenderCore / Renderer 构建通过，安装目录输入摘要未变。Renderer 日志为 `results/native-renderer-20261102-124516.log`。
- Web 完整链接和 WASM 结构检查通过，日志为 `results/web-engine-full-thread-20261102-132546.log`。Renderer 响应文件仍为 `-O2`；WASM SHA256 为 `c9f97d60b7f47fb35e5d4cba4fbbc94120c69fc51d5397e61d46966f180488ff`。
- 最终 Cook 使用 `-UseProjectSettings`，退出码 0，0 错误、14 警告，5,159 个产物，共 3,596,914,775 字节。清单包含 12 类 TSR 着色器、109 个排列。日志为 `results/web-project-triplex-project-desktop-cook-20261102-132137.log`。
- Stage 5,157 个文件，资源包 3,342,213,294 字节；Package 通过，11 个文件共 3,527,457,522 字节，`useProjectSettings=true`、`textureCompression=Project`。
- 原项目 1,633 个输入文件摘要未变。新包的 DefaultEngine.ini、DefaultGame.ini、DefaultInput.ini 与原项目逐字节相同。

入口：`http://127.0.0.1:8765/build/triplex-project-tsr-distance-fields-threads/index.html`。旧 TAA 入口保留，避免覆盖对照产物。

浏览器检查脚本为 `tests/web-platform/probe-web-tsr.cjs`。它从 Cook 转换产物中取得入口名，包括 DDC 命中任务的历史转换记录，观察真正的 compute dispatch，验证视图 AA=4、移动后的历史更新、窗口缩放及画面非空。另在独立测试进程中检查 TAA 切回 TSR，将输入屏幕比例改为 66%，并切换 RGBA16F 历史，检查超分辨率和另一历史格式。测试用覆盖不会写入项目配置或包默认值。

Edge 浏览器结果：

- `results/web-tsr-villa-20261102.json` 通过。默认输入与输出为 1280x720，实际 AA=4，八个 TSR 通道均有真实派发，测试结束时各累计 350 次。
- 默认历史颜色为 R11G11B10，历史纹理 2560x1440x4，保留原 Scalability 的 200% 历史分辨率。切换 RGBA16F 历史也通过。
- 960x540 缩放及恢复、TAA 切回 TSR、约 122 cm 移动后的历史更新均通过。66% 屏幕比例时实际输入 845x476、输出 1280x720，仍执行 TSR ResolveHistory。
- 页面及 GPU 错误为 0；最终截图 44,389 种颜色，非黑像素约 87.9%，并人工检查场景截图。
- `results/project-gameplay-tsr-project-settings-20261102.json` 使用默认项目设置，通过 30 秒连续移动、转向及缩放。第 2 帧推进至第 1,666 帧，最大移动约 155 cm、转向约 47 度，错误为 0，Game / Render / RHI 线程检查通过，设置覆盖列表为空。

这些结果来自本机 Edge、NVIDIA Ampere 适配器。没有将短时检查外推为所有浏览器或长时间运行均稳定。

一次较早的完整 Cook 在收尾时发生约 138 万亿字节的异常分配；当时仍有约 36.75 GiB 空闲物理内存。保持代码与配置不变重跑成功，后续修复采样后的 Cook 也成功，根因尚未定位。未忽略该错误或将失败产物标记为通过。

本次目标是 TSR 功能兼容。尚不能据此认定 Web 与原生逐像素相同、性能相同，或用户此前暂停调查的随机崩溃已经解决。
