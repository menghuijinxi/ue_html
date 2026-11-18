param([switch]$Preview)
$ErrorActionPreference = 'Stop'
$taskBuildRoot = 'G:\UE_HTML\ue_html\tests\web-platform\build'
$taskPlan = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'cleanup-test-cache-20261111.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ([IO.Path]::GetFullPath($taskPlan.buildRoot) -ne $taskBuildRoot) { throw '清单构建根目录不匹配。' }
$taskAllowedParents = @((Join-Path $taskBuildRoot 'browser-profiles'), (Join-Path $taskBuildRoot 'browser-profile-archives'))
$taskFailedCopy = Join-Path $taskBuildRoot 'nanite-release-20261111-launcher-failed'
function Get-TaskDirectoryState([string]$LiteralPath) {
    $taskAncestor = $LiteralPath
    while ($taskAncestor) {
        if (((Get-Item -LiteralPath $taskAncestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '祖先路径包含链接，跳过。' }
        $taskAncestor = [IO.Path]::GetDirectoryName($taskAncestor)
    }
    $taskPending = New-Object 'Collections.Generic.Stack[string]'
    $taskPending.Push($LiteralPath)
    $taskBytes = [long]0; $taskFiles = 0; $taskNewest = [double]0
    while ($taskPending.Count -gt 0) {
        $taskItem = Get-Item -LiteralPath $taskPending.Pop() -Force
        if (($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '目录包含链接，跳过。' }
        $taskStamp = ([DateTimeOffset]$taskItem.LastWriteTimeUtc).ToUnixTimeMilliseconds()
        $taskNewest = [math]::Max($taskNewest, $taskStamp)
        if ($taskItem.PSIsContainer) {
            foreach ($taskChild in $taskItem.GetFileSystemInfos()) { $taskPending.Push($taskChild.FullName) }
        } else { $taskBytes += $taskItem.Length; $taskFiles++ }
    }
    return [pscustomobject]@{ bytes = $taskBytes; files = $taskFiles; lastWrite = $taskNewest }
}
$taskReady = @()
foreach ($taskTarget in $taskPlan.targets) {
    # Validate the canonical absolute path before any recursive operation.
    $taskPath = [IO.Path]::GetFullPath([string]$taskTarget.path).TrimEnd('\')
    $taskParent = [IO.Path]::GetDirectoryName($taskPath)
    if ($taskAllowedParents -notcontains $taskParent -and $taskPath -ne $taskFailedCopy) { throw "拒绝清单外路径：$taskPath" }
    if (!(Test-Path -LiteralPath $taskPath)) { continue }
    try {
        $taskState = Get-TaskDirectoryState $taskPath
        if ($taskState.bytes -ne $taskTarget.bytes -or $taskState.files -ne $taskTarget.files -or $taskState.lastWrite -gt ([double]$taskTarget.lastWrite + 1)) { throw '清单生成后目录有变化，跳过。' }
        $taskReady += [pscustomobject]@{ path = $taskPath; bytes = $taskState.bytes }
    } catch { Write-Host "跳过 $taskPath：$($_.Exception.Message)" -ForegroundColor Yellow }
}
$taskReady | ForEach-Object { Write-Host ('{0,9:N3} GiB  {1}' -f ($_.bytes / 1GB), $_.path) }
$taskTotal = ($taskReady | Measure-Object -Property bytes -Sum).Sum
Write-Host ("共 {0} 个目录，逻辑大小 {1:N2} GiB。" -f $taskReady.Count, ($taskTotal / 1GB))
if ($Preview) { Write-Host '仅预览，未删除任何文件。'; exit 0 }
if (!$taskReady.Count) { Write-Host '没有可清理的目录。'; exit 0 }
if ((Read-Host '核对以上清单，输入 DELETE 执行删除，其他输入取消') -cne 'DELETE') { Write-Host '已取消。'; exit 0 }
$taskFreeBefore = (Get-PSDrive -Name G).Free
$taskFailures = 0
foreach ($taskTarget in $taskReady) {
    try {
        $taskActive = @(Get-CimInstance Win32_Process -Filter "name='msedge.exe' OR name='chrome.exe'" | Where-Object {
            $_.CommandLine -and $_.CommandLine.IndexOf($taskTarget.path, [StringComparison]::OrdinalIgnoreCase) -ge 0
        })
        if ($taskActive.Count) { throw '仍被测试浏览器使用，跳过。' }
        # Recheck after the user's review, before the native PowerShell removal.
        $taskState = Get-TaskDirectoryState $taskTarget.path
        $taskOriginal = $taskPlan.targets | Where-Object { $_.path -eq $taskTarget.path }
        if ($taskState.bytes -ne $taskOriginal.bytes -or $taskState.files -ne $taskOriginal.files -or $taskState.lastWrite -gt ([double]$taskOriginal.lastWrite + 1)) { throw '预览后目录有变化，跳过。' }
        Remove-Item -LiteralPath $taskTarget.path -Recurse -Force -ErrorAction Stop
        Write-Host "已清理 $($taskTarget.path)"
    } catch { $taskFailures++; Write-Host "未清理 $($taskTarget.path)：$($_.Exception.Message)" -ForegroundColor Yellow }
}
$taskFreeAfter = (Get-PSDrive -Name G).Free
Write-Host ('G 盘可用空间：{0:N2} -> {1:N2} GiB，增加 {2:N2} GiB。' -f ($taskFreeBefore/1GB), ($taskFreeAfter/1GB), (($taskFreeAfter-$taskFreeBefore)/1GB))
Write-Host "跳过或失败：$taskFailures 项。"
