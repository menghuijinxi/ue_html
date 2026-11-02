# DXC 启动故障诊断

这些脚本用于复现编译器故障，不改变独立包、UE 渲染设置或系统配置。报告和转储写入被 Git 忽略的 `results`，不提交引擎生成的着色器及二进制。

## 浏览器管线回放

先启动 `node tests/web-platform/serve.cjs`，并设置工作区 Playwright 的 `NODE_PATH`。已有默认关卡独立包时执行：

```powershell
node tests/web-platform/probe-web-pipeline-compile.cjs --capture --mode=sync --runs=20 --report=normal
node tests/web-platform/probe-web-pipeline-compile.cjs --mode=async-serial --runs=20 --report=serial
```

首次记录真实设备请求、WGSL、绑定组布局、管线布局及渲染/计算管线描述。随后在空白同源页面重建这些对象，不加载 UE、资源包或场景，不提交绘制命令。每次回放使用独立浏览器进程和临时配置，检查设备丢失、编译错误及完成数量。`sync` 表示调用同步创建 API；该 API 的返回不表示 GPU 进程已完成编译。`async-serial` 逐条等待实际编译完成，`async-parallel` 同时等待所有编译。

`--only=107,139` 可选择快照中的管线 ID；这些 ID 只适用于对应快照，不能当作固定着色器名称。`--browser=Edge` 切换浏览器，`--report=` 保留独立报告。回放成功只证明记录的管线可以编译，不证明场景渲染、交互或长期稳定。

## 独立 DXC 回放

从 Dawn 获取实际 HLSL 和 DXIL 中的目标版本，避免把浏览器使用的 Shader Model 6.8 错测成 6.0：

```powershell
node tests/web-platform/probe-web-pipeline-compile.cjs --mode=async-serial --runs=1 --dump-hlsl --report=compiler
node tests/web-platform/diagnostics/extract-dawn-hlsl.cjs --log=tests/web-platform/results/web-default-pipeline-hlsl-compiler-0.log
& ./tests/web-platform/diagnostics/probe-dxc-host.ps1 -Name default -Rounds 100
& ./tests/web-platform/diagnostics/probe-dxc-host.ps1 -Name restricted -Rounds 100 -AffinityMask 4294901760
```

`--dump-hlsl` 只给本次测试浏览器传 Dawn 调试开关，会改变时序，不能拿该次通过证明普通启动稳定。提取器同时读取实际 shader profile、入口、编译标志及 SHA-256；遇到当前原生诊断程序不支持的编译标志会拒绝继续。`--log` 也支持既有 Playwright `DEBUG=pw:browser` 日志。

原生脚本使用 VS 14.34、工作区 DXC 头文件编译 `dxc-batch.cpp`，通过 `IDxcCompiler3` 连续编译。默认 DLL 为工作区内 Chrome DXC 的诊断副本，也可用 `-CompilerPath` 指向另一份 DLL；只读取原 DLL，不替换浏览器或安装引擎。`-NewCompiler` 每次新建编译器实例，`-FileIndex` 只测一个输入，`-TimeoutSeconds` 设置整批时间上限。超时会结束脚本自己启动的测试进程并记录失败；整批超时本身不能证明某条编译调用卡死。

CPU 掩码仅应用于原生子进程，且在加载编译器前生效。报告记录系统 CPU 拓扑、选中核心、线程数采样、退出码和输入/程序/来源哈希。`4294901760` 是本机逻辑核心 16–31，不能直接套用到其他机器；应先查看报告的 `cpuSets`。不同 `-Name` 保留各自可执行文件及日志，避免后续构建破坏先前证据。

浏览器受限核心对照可从限制了 `ProcessorAffinity` 的 Node 子进程启动原探针。此类报告必须标明测试条件，并与默认调度报告分开保存。例如为该子进程设置 `UE_WEB_TEST_HOST_CONDITION=diagnostic CPU affinity 0xffff0000`，使用 `--report=cpu-affinity`。该环境变量只记录条件，不设置 CPU 掩码。

## 当前边界

2026-11-02 的 TLV 别墅在普通可见 Edge 启动时再次复现 DXC 原生崩溃；当前 Edge 的 DLL 脱离浏览器和 UE 编译也在默认调度及逻辑核心 0–15 下失败。逻辑核心 16–31 下，1590 次独立编译、三轮完整场景启动/刷新/缩放及 60 秒交互通过，仍不能据此认定 CPU 损坏或普通启动已修复。证据见根目录 `UE58_BROWSER_CRASH_DIAGNOSIS.md`。

本机需要临时查看原画质包时，可运行 `start-web-browser.ps1 -AffinityMask 4294901760`。它新开独立配置的浏览器，在创建进程前设置亲和性并恢复启动器自身设置；不修改系统或现有浏览器。掩码必须根据本机拓扑确认，不应套用到其他机器。默认打开 TLV 别墅，可用 `-Browser Chrome`、`-Url` 选择其他入口。默认不开调试端口，只有显式 `-DebugPort` 才开启本机 CDP。

生命周期探针可用 `--width`、`--height`、`--dpr` 匹配用户窗口；自定义输出目录使用 `--package-report=` 指向实际打包报告。通过 `UE_WEB_TEST_HOST_CONDITION` 记录诊断调度条件。该字段不设置亲和性；应由启动它的独立子进程先设置，并与默认调度报告分开保存。

2026-10-22 已在没有 UE 的管线回放和独立 DXC 中复现失败；串行编译与每次新建编译器都未排除问题。限制核心曾使回放和完整效果对照通过，但默认调度也存在长循环通过的反例，尚不能认定 CPU 损坏或认定编译器并发是根因。正常浏览器的启动稳定性仍未修复，需要继续做独立机器对照或主机稳定性诊断；不要通过关闭高度雾、云或抗锯齿掩盖故障。
