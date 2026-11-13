$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
trap { Write-Host ('清理停止：' + $_.Exception.Message) -ForegroundColor Red; exit 1 }
$taskMode = $env:UE_HTML_TEST_CLEANUP_MODE
if ($taskMode -and $taskMode -notin @('--preview','--execute')) { throw '支持 --preview 预览，--execute 执行；双击可交互执行。' }
$taskRoot = 'G:\UE_HTML\ue_html\tests\web-platform'
$taskProfileParent = Join-Path $taskRoot 'results\browser-profiles'
$taskFailedNames = @('nanite-pack-programmable-20261112','nanite-pack-programmable-content-20261112','nanite-pack-material-20261112','nanite-pack-material-content-20261112','nanite-pack-fixture-20261112','nanite-pack-fixture-content-20261112')
$taskTargets = @(
__FIXED_TARGETS__
)
if ($taskTargets.Count -ne 82 -or @($taskTargets.Path | Select-Object -Unique).Count -ne 82) { throw '固定清单数量有误。' }
function Get-TaskState([string]$taskPath) {
    $taskResolved = [IO.Path]::GetFullPath($taskPath).TrimEnd('\')
    $taskParent = [IO.Path]::GetDirectoryName($taskResolved)
    $taskName = [IO.Path]::GetFileName($taskResolved)
    if (-not $taskResolved.StartsWith($taskRoot + '\',[StringComparison]::OrdinalIgnoreCase) -or
        ($taskParent -ne $taskProfileParent -and -not ($taskParent -eq (Join-Path $taskRoot 'build') -and $taskName -in $taskFailedNames))) { throw ('拒绝清单外路径：' + $taskResolved) }
    if ($taskResolved -notin $taskTargets.Path) { throw '目标不在固定清单中。' }
    $taskItem = Get-Item -LiteralPath $taskResolved -Force
    if (-not $taskItem.PSIsContainer) { throw '目标不是目录。' }
    $taskAncestor = $taskItem
    while ($null -ne $taskAncestor) {
        if ($taskAncestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('路径包含链接：' + $taskAncestor.FullName) }
        $taskAncestor = $taskAncestor.Parent
    }
    $taskStack = [Collections.Generic.Stack[IO.FileSystemInfo]]::new()
    $taskStack.Push($taskItem)
    [long]$taskBytes=0; [long]$taskFiles=0; [long]$taskLatest=0
    while ($taskStack.Count) {
        $taskCurrent=$taskStack.Pop(); $taskCurrent.Refresh()
        if ($taskCurrent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('包含链接：' + $taskCurrent.FullName) }
        $taskStamp=([DateTimeOffset]$taskCurrent.LastWriteTimeUtc).ToUnixTimeMilliseconds()
        $taskLatest=[math]::Max($taskLatest,$taskStamp)
        if ($taskCurrent -is [IO.DirectoryInfo]) { foreach ($taskChild in $taskCurrent.EnumerateFileSystemInfos()) { $taskStack.Push($taskChild) } }
        else { $taskBytes += $taskCurrent.Length; $taskFiles++ }
    }
    [pscustomobject]@{Bytes=$taskBytes;Files=$taskFiles;LastWrite=$taskLatest}
}
function Assert-TaskInactive([string]$taskPath) {
    $taskActive=@(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match '^(msedge|chrome|firefox)(\.exe)?$' -and $_.CommandLine -and
        $_.CommandLine.Replace('/','\').IndexOf($taskPath,[StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    if ($taskActive.Count) { throw '目录被浏览器使用，本次跳过。' }
}
Write-Host '旧自动测试缓存清理（2026-11-13，固定 82 项）'
Write-Host '保留源码、原始场景、最新测试包、Cook、测试报告与证据。'
$taskReady=[Collections.Generic.List[object]]::new(); $taskSkipped=[Collections.Generic.List[string]]::new()
foreach ($taskEntry in $taskTargets) {
    if (-not (Test-Path -LiteralPath $taskEntry.Path)) { $taskSkipped.Add('不存在，跳过：'+$taskEntry.Path); continue }
    try {
        $taskState=Get-TaskState $taskEntry.Path
        if ($taskState.Bytes -ne $taskEntry.Bytes -or $taskState.Files -ne $taskEntry.Files -or $taskState.LastWrite -gt $taskEntry.LastWrite) { throw '清单生成后内容有变化。' }
        Assert-TaskInactive $taskEntry.Path
        $taskReady.Add($taskEntry)
    } catch { $taskSkipped.Add('跳过：'+$taskEntry.Path+'；'+$_.Exception.Message) }
}
foreach ($taskEntry in $taskReady) { Write-Host ('{0,8:N3} GiB  {1}' -f ($taskEntry.Bytes/1GB),$taskEntry.Path) }
foreach ($taskMessage in $taskSkipped) { Write-Host $taskMessage -ForegroundColor Yellow }
[long]$taskTotalBytes=0
foreach ($taskEntry in $taskReady) { $taskTotalBytes += $taskEntry.Bytes }
Write-Host ('可清理 {0} 项，逻辑大小 {1:N2} GiB（硬链接可能重复计数）。' -f $taskReady.Count,($taskTotalBytes/1GB))
if ($taskMode -eq '--preview') { Write-Host '仅预览，没有删除文件。'; exit 0 }
if (-not $taskReady.Count) { Write-Host '没有可清理的目录。'; exit 0 }
if ($taskMode -ne '--execute' -and (Read-Host '输入 DELETE 执行，其他输入取消') -cne 'DELETE') { Write-Host '已取消。'; exit 0 }
$taskLog=Join-Path ([IO.Path]::GetDirectoryName($env:UE_HTML_TEST_CLEANUP_SELF)) ('cleanup-old-tests-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff')+'.json')
[long]$taskFreeBefore=([IO.DriveInfo]::new('G:\')).AvailableFreeSpace
$taskDeleted=[Collections.Generic.List[object]]::new(); $taskFailed=[Collections.Generic.List[string]]::new()
foreach ($taskEntry in $taskReady) {
    try {
        Assert-TaskInactive $taskEntry.Path
        $taskState=Get-TaskState $taskEntry.Path
        if ($taskState.Bytes -ne $taskEntry.Bytes -or $taskState.Files -ne $taskEntry.Files -or $taskState.LastWrite -gt $taskEntry.LastWrite) { throw '执行前内容有变化。' }
        Remove-Item -LiteralPath $taskEntry.Path -Recurse -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $taskEntry.Path) { throw '删除后目录仍存在。' }
        $taskDeleted.Add($taskEntry)
        Write-Host ('已删除 [{0}/{1}] {2}' -f $taskDeleted.Count,$taskReady.Count,$taskEntry.Path)
    } catch { $taskMessage=$taskEntry.Path+'；'+$_.Exception.Message; $taskFailed.Add($taskMessage); Write-Host ('未完整删除：'+$taskMessage) -ForegroundColor Yellow }
}
[long]$taskFreeAfter=([IO.DriveInfo]::new('G:\')).AvailableFreeSpace
[pscustomobject]@{Date=[DateTimeOffset]::Now.ToString('o');Deleted=@($taskDeleted);Failed=@($taskFailed);Skipped=@($taskSkipped);FreeBefore=$taskFreeBefore;FreeAfter=$taskFreeAfter} |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $taskLog -Encoding UTF8
Write-Host ('完成：删除 {0} 项，失败 {1} 项；G 盘 {2:N2}→{3:N2} GiB，实际增加 {4:N2} GiB。' -f $taskDeleted.Count,$taskFailed.Count,($taskFreeBefore/1GB),($taskFreeAfter/1GB),(($taskFreeAfter-$taskFreeBefore)/1GB))
Write-Host ('日志：'+$taskLog)
if ($taskFailed.Count) { exit 1 }
exit 0
