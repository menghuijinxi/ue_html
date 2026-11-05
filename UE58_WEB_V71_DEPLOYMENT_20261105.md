# v71 调度对照包本地部署

日期：2026-11-05。

来源为用户下载的 `E:\BaiduNetdiskDownload\villa-scheduling-latest-v71.zip`，压缩文件 1,412,457,918 字节，展开后 17 个文件、3,453,807,046 字节。部署到独立目录 `tests/web-platform/build/villa-scheduling-latest-v71`，使用现有 8765 服务，无需运行压缩包附带的 `start.cmd` 或 `serve.py`。

解压前检查归档根目录、目标路径及重复条目，拒绝越界、额外路径流和符号链接；目标原先不存在。包内文件保持原样，现有测试版本不受影响，没有重新 Cook、编译引擎或改变项目画质。

## 测试入口

- [包自带对比页](http://127.0.0.1:8765/build/villa-scheduling-latest-v71/comparison.html)
- [关闭 Game 本地调度](http://127.0.0.1:8765/build/villa-scheduling-latest-v71/index.html?occlusion=history&clock=owner&rhiwake=priority)
- [开启 Game 本地调度](http://127.0.0.1:8765/build/villa-scheduling-latest-v71/index.html?occlusion=history&clock=local&rhiwake=priority)

两个主入口均显式保留遮挡历史和 RHI priority 唤醒，只改变 `clock`。每次只运行一个页面，等待启动预热结束后，保持相同窗口、分辨率、视角和移动路线比较。

**本压缩包为 Lumen 关闭版**。包内 `package-info.json` 标注资源基线为 `villa-lumen-off-current-mimalloc-v59`，复用既有 Cook。它与此前 Lumen 开启的四组包属于不同基线，不能把两者的帧率差值直接归因于调度。

包自带元数据标注外围提交 `5b3db645c2fb1c4b28ea3b6c2a9f37ffdcc35400`、引擎提交 `93f9ea35a8be0444bb821deedb488a8dd8752e33`；这些是包的来源声明，本轮不重新编译验证其来源。

## 验证

`probe-web-scheduling-package.cjs` 核对归档 SHA-256、包内清单所列十个核心文件的完整 SHA-256 与大小、对比页 HTTP 状态和跨源隔离响应头。随后用两个独立无界面 Edge profile 分别检查实际时钟、遮挡历史、RHI 唤醒、Lumen 关闭状态、相同画质配置、鼠标转向及截图像素；完成后再次校验文件未被改变。

验证通过：核心文件与清单一致，对比页 HTTP 200、COOP / COEP 正确。两个入口实际时钟分别为 owner / local，遮挡历史均开启，RHI 实际使用 priority，GI / 反射均为 0，AA 均为 4。实际鼠标转向、截图像素检查通过，开启版截图人工查看正常，未捕获运行或 GPU 校验错误。两次运行画质配置相同，部署文件复验未发生改动，测试浏览器均已关闭。

归档 SHA-256：`9672535d1505b733065223e2a009232fd2253c86c1ebd51b3d9e1a89bba3270b`。

```powershell
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node tests/web-platform/probe-web-scheduling-package.cjs --folder=villa-scheduling-latest-v71 --tag=v71-import-20261105 "--archive=E:\BaiduNetdiskDownload\villa-scheduling-latest-v71.zip"
```

记录路径为 `tests/web-platform/results/v71-import-20261105*`，通过后的可携带证据为 `tests/web-platform/evidence/v71-import-20261105.json`。测试 profile 位于 C 盘临时目录 `ue-web-import-profiles`；重复验证须使用新标签。

本轮仅验证下载包完整性、本地部署和功能启动，不测定两台设备的性能差异，不恢复画面抖动排查。
