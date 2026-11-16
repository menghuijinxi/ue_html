# 测试产物与源码提交

源码仓库保留实现代码、着色器、构建和测试脚本、文档，以及可读的验证摘要。原始截图、逐像素 GPU 回读、CPU/GPU 跟踪、失败现场和压缩归档写入 `tests/web-platform/evidence/`，该目录中的新增文件由 `.gitignore` 排除。

测试数据仍可用于本地复查。精简摘要位于 `tests/web-platform/validation-summaries/`，包含原始报告的 SHA-256、大小、原始提交、验证结论和可用统计。省略的数据使用 `$omitted` 显式标识；摘要不代表重新运行或重新验收，原始报告中的失败及边界必须保留。既有远程基线中已经跟踪的证据文件继续保留。

生成摘要：

```powershell
node tests/web-platform/summarize-validation-evidence.cjs --baseline=origin/master
```

2026-11-16 撤销了 `html_nanite` 未推送历史中新增的大量原始归档。原始提交另有本地备份分支，原始文件仍保存在本地，并额外备份至：

`C:/Users/wap80/.cache/ue-html-backups/html_nanite-before-artifact-cleanup-20261116`

该备份的 `manifest.json` 记录每个文件的大小、SHA-256 和原始 Git 对象。清理只改写未推送主仓库分支中的归档记录；引擎仓库的源码提交不受影响。
