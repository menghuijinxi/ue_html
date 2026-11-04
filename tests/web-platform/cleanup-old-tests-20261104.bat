@echo off
setlocal
set "UE_HTML_TEST_CLEANUP_SELF=%~f0"
set "UE_HTML_TEST_CLEANUP_MODE=%~1"
powershell.exe -NoLogo -NoProfile -Command "$ErrorActionPreference='Stop'; $taskText=[IO.File]::ReadAllText($env:UE_HTML_TEST_CLEANUP_SELF,[Text.Encoding]::UTF8); $taskMarker='# === POWERSHELL BODY ==='; $taskOffset=$taskText.LastIndexOf($taskMarker); if($taskOffset -lt 0){throw 'Missing cleanup script body'}; & ([ScriptBlock]::Create($taskText.Substring($taskOffset+$taskMarker.Length)))"
set "UE_HTML_TEST_CLEANUP_EXIT=%errorlevel%"
if /I not "%~1"=="--preview" pause
exit /b %UE_HTML_TEST_CLEANUP_EXIT%

# === POWERSHELL BODY ===
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
trap {
    Write-Host ('清理停止：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}

$taskRoot = 'G:\UE_HTML\ue_html\tests\web-platform\build'
$taskProfilesRoot = Join-Path $taskRoot 'browser-profiles'
$taskCutoff = [DateTimeOffset]::Parse('2026-11-03T00:00:00+08:00').UtcDateTime
$taskMode = $env:UE_HTML_TEST_CLEANUP_MODE
if ($taskMode -and $taskMode -ne '--preview') {
    throw '支持的参数只有 --preview（仅预览）；双击批处理可执行清理。'
}
$taskPreview = $taskMode -eq '--preview'

# 固定清单：77 个旧测试浏览器目录、63 个旧 villa 测试包。
# 保留 v47、v52，以及 2026-11-03 起更新的版本、Cook 资源和测试报告。
$taskRelativeTargets = @(
    'browser-profiles\capture-villa'
    'browser-profiles\cpu-villa'
    'browser-profiles\gameplay-binding-groups-v1-validation-0'
    'browser-profiles\gameplay-binding-groups-v3-validation-0'
    'browser-profiles\gameplay-binding-groups-v4-normal-0'
    'browser-profiles\gameplay-binding-groups-v4-validation-0'
    'browser-profiles\gameplay-cpu-final-0'
    'browser-profiles\gameplay-cpu-final-1'
    'browser-profiles\gameplay-crash-before-0'
    'browser-profiles\gameplay-crash-fixed-0'
    'browser-profiles\gameplay-crash-fixed-1'
    'browser-profiles\gameplay-crash-fixed-2'
    'browser-profiles\gameplay-crash-fixed-user-surface-0'
    'browser-profiles\gameplay-dx-binding-final-0'
    'browser-profiles\gameplay-dx-binding-final-1'
    'browser-profiles\gameplay-dx-binding-v2-validate-0'
    'browser-profiles\gameplay-dx-binding-v3-validate-0'
    'browser-profiles\gameplay-dx-binding-validate-0'
    'browser-profiles\gameplay-gpuscene-first-0'
    'browser-profiles\gameplay-gpuscene-gameplay-v5-0'
    'browser-profiles\gameplay-gpuscene-gameplay-v5-1'
    'browser-profiles\gameplay-gpuscene-stack-0'
    'browser-profiles\gameplay-gpuscene-startup-v2-0'
    'browser-profiles\gameplay-gpuscene-startup-v3-0'
    'browser-profiles\gameplay-gpuscene-startup-v4-0'
    'browser-profiles\gameplay-manual-fetch-0'
    'browser-profiles\gameplay-manual-fetch-final-0'
    'browser-profiles\gameplay-manual-fetch-validation-0'
    'browser-profiles\gameplay-parallel-recording-default-v3-0'
    'browser-profiles\gameplay-parallel-recording-default-v4-0'
    'browser-profiles\gameplay-parallel-recording-opt-in-v3-0'
    'browser-profiles\gameplay-parallel-recording-opt-in-v4-0'
    'browser-profiles\gameplay-parallel-recording-v1-0'
    'browser-profiles\gameplay-parallel-recording-v2-0'
    'browser-profiles\gameplay-parallel-recording-validation-v2-0'
    'browser-profiles\gameplay-resource-tables-normal-v2-0'
    'browser-profiles\gameplay-resource-tables-normal-v3-0'
    'browser-profiles\gameplay-resource-tables-v1-0'
    'browser-profiles\gameplay-resource-tables-validation-v3-0'
    'browser-profiles\gameplay-rhi-adaptation-v2-0'
    'browser-profiles\gameplay-rhi-adaptation-v2-1'
    'browser-profiles\gameplay-rhi-final-0'
    'browser-profiles\gameplay-rhi-final-1'
    'browser-profiles\gameplay-rhi-first-0'
    'browser-profiles\gameplay-rhi-second-0'
    'browser-profiles\gameplay-rhi-stable-0'
    'browser-profiles\gameplay-rhi-stable-1'
    'browser-profiles\gameplay-rhi-third-0'
    'browser-profiles\gameplay-webgpu-bundles-v3-0'
    'browser-profiles\gameplay-webgpu-research-final-0'
    'browser-profiles\gameplay-webgpu-research-final-1'
    'browser-profiles\gameplay-webgpu-state-snapshot-final-0'
    'browser-profiles\hzb-quick'
    'browser-profiles\hzb-quick-v2'
    'browser-profiles\hzb-quick-v3'
    'browser-profiles\hzb-submit-flush-check'
    'browser-profiles\idle-20261101-instance-hzb'
    'browser-profiles\idle-20261101-pso-precache'
    'browser-profiles\idle-20261101-rdg-ledger'
    'browser-profiles\idle-20261101-traditional-hzb'
    'browser-profiles\instance-hzb-abba'
    'browser-profiles\live-fps'
    'browser-profiles\memory-cpu-final'
    'browser-profiles\memory-default-retirement-fixed'
    'browser-profiles\memory-observer-smoke'
    'browser-profiles\memory-rhi-stable'
    'browser-profiles\memory-villa-project-fixed'
    'browser-profiles\performance-villa'
    'browser-profiles\pso-api-v1'
    'browser-profiles\pso-api-v2'
    'browser-profiles\pso-api-v3'
    'browser-profiles\pso-api-v3-disk-off'
    'browser-profiles\pso-precache-check'
    'browser-profiles\rdg-ledger-verified'
    'browser-profiles\rdg-resource-ledger'
    'browser-profiles\tsr-pso-reuse-v17'
    'browser-profiles\ue-trace'
    'villa-webgpu-uploads'
    'villa-webgpu-layout'
    'villa-webgpu-bundles-v3'
    'villa-webgpu-bundles-v2'
    'villa-webgpu-bundles'
    'villa-startup-trace-v22'
    'villa-startup-trace-v21'
    'villa-rhi-adaptation-v2'
    'villa-rhi-adaptation-candidate'
    'villa-resource-tables-candidate'
    'villa-render-rhi-candidate'
    'villa-render-diagnostics'
    'villa-pso-runtime-trace-v20'
    'villa-pso-runtime-bind-v19'
    'villa-pso-reuse-v17-tsr-on'
    'villa-pso-reuse-v17-tsr-off'
    'villa-pso-reuse-v16-taa-check'
    'villa-pso-reuse-v15-taa-check'
    'villa-pso-probe'
    'villa-pso-off-v6'
    'villa-pso-off-v5'
    'villa-pso-off-v4'
    'villa-pso-off-v3'
    'villa-pso-off-v2'
    'villa-pso-off-v1'
    'villa-pso-concurrency-v18-default'
    'villa-pso-concurrency-v18-c2'
    'villa-pso-async-v9'
    'villa-pso-async-v8'
    'villa-pso-async-v7'
    'villa-pso-async-v6'
    'villa-pso-async-v5'
    'villa-pso-async-v4'
    'villa-pso-async-v3'
    'villa-pso-async-v2'
    'villa-pso-async-v14'
    'villa-pso-async-v13'
    'villa-pso-async-v12'
    'villa-pso-async-v11'
    'villa-pso-async-v10'
    'villa-pso-async-v1'
    'villa-parallel-recording-opt-in'
    'villa-parallel-recording-default'
    'villa-parallel-recording-candidate'
    'villa-manual-vertex-fetch-final'
    'villa-manual-vertex-fetch'
    'villa-live-fps-v3'
    'villa-live-fps-v2'
    'villa-live-fps'
    'villa-insights-candidate'
    'villa-hzb-probe-v4'
    'villa-hzb-probe-v3'
    'villa-hzb-probe-v2'
    'villa-hzb-probe'
    'villa-gpuscene-candidate'
    'villa-dx-binding-v3'
    'villa-dx-binding-v2'
    'villa-dx-binding-candidate'
    'villa-cpu-baseline'
    'villa-binding-groups-v4'
    'villa-binding-groups-v3'
    'villa-binding-groups-v1'
    'villa-before-render-threads'
)

function Get-OldDirectoryStats {
    param([string]$taskPath)

    $taskDirectory = Get-Item -LiteralPath $taskPath -Force
    if (-not $taskDirectory.PSIsContainer) { throw '目标不是目录' }
    $taskStack = [Collections.Generic.Stack[IO.DirectoryInfo]]::new()
    $taskStack.Push($taskDirectory)
    [long]$taskBytes = 0
    [long]$taskFiles = 0
    while ($taskStack.Count -gt 0) {
        $taskCurrent = $taskStack.Pop()
        $taskCurrent.Refresh()
        if ($taskCurrent.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw ('包含链接或目录联接：' + $taskCurrent.FullName)
        }
        if ($taskCurrent.LastWriteTimeUtc -ge $taskCutoff) {
            throw ('2026-11-03 起有更新：' + $taskCurrent.FullName)
        }
        foreach ($taskChild in $taskCurrent.EnumerateFileSystemInfos()) {
            if ($taskChild.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw ('包含链接或目录联接：' + $taskChild.FullName)
            }
            if ($taskChild.LastWriteTimeUtc -ge $taskCutoff) {
                throw ('2026-11-03 起有更新：' + $taskChild.FullName)
            }
            if ($taskChild -is [IO.DirectoryInfo]) {
                $taskStack.Push($taskChild)
            } else {
                $taskBytes += $taskChild.Length
                $taskFiles++
            }
        }
    }
    [PSCustomObject]@{ Bytes = $taskBytes; Files = $taskFiles }
}

if (@($taskRelativeTargets | Select-Object -Unique).Count -ne 140) {
    throw '固定清单数量或唯一性校验失败'
}
$taskRootItem = Get-Item -LiteralPath $taskRoot -Force
if (-not $taskRootItem.PSIsContainer) { throw '构建根目录不存在' }
$taskAncestor = $taskRootItem
while ($null -ne $taskAncestor) {
    if ($taskAncestor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw ('构建路径包含链接或目录联接：' + $taskAncestor.FullName)
    }
    $taskAncestor = $taskAncestor.Parent
}
$taskProfilesItem = Get-Item -LiteralPath $taskProfilesRoot -Force
if ($taskProfilesItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw '测试浏览器根目录是链接或目录联接'
}
$taskActiveBrowsers = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^(msedge|chrome|firefox)(\.exe)?$' -and
    $_.CommandLine -match 'G:[/\\]UE_HTML[/\\]ue_html[/\\]tests[/\\]web-platform[/\\]build[/\\]browser-profiles'
})
if (-not $taskPreview -and $taskActiveBrowsers.Count -gt 0) {
    throw '检测到项目测试浏览器仍在运行，请关闭后重新运行批处理'
}

Write-Host '旧测试产物清理（固定清单，截止 2026-11-03 00:00，香港时间）'
Write-Host ('根目录：' + $taskRoot)
Write-Host '正在核对目录大小、修改时间及链接……'
$taskReady = [Collections.Generic.List[object]]::new()
$taskSkipped = [Collections.Generic.List[string]]::new()
foreach ($taskRelative in $taskRelativeTargets) {
    if ($taskRelative -notmatch '^(villa-[a-z0-9-]+|browser-profiles\\[a-z0-9-]+)$') {
        throw ('清单路径不符合范围：' + $taskRelative)
    }
    if ($taskRelative -in @('villa-rhi-hotspots-v52', 'villa-browser-metrics-v47')) {
        throw '清单包含需要保留的版本'
    }
    $taskPath = [IO.Path]::GetFullPath((Join-Path $taskRoot $taskRelative))
    if (-not $taskPath.StartsWith($taskRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw ('清单路径超出构建目录：' + $taskPath)
    }
    if (-not (Test-Path -LiteralPath $taskPath)) {
        $taskSkipped.Add('不存在，跳过：' + $taskPath)
        continue
    }
    try {
        $taskStats = Get-OldDirectoryStats -taskPath $taskPath
        $taskReady.Add([PSCustomObject]@{
            Path = $taskPath
            Bytes = $taskStats.Bytes
            Files = $taskStats.Files
        })
    } catch {
        $taskSkipped.Add('跳过：' + $taskPath + '；' + $_.Exception.Message)
    }
}

foreach ($taskEntry in $taskReady) {
    Write-Host ('{0,8:N3} GiB  {1}' -f ($taskEntry.Bytes / 1GB), $taskEntry.Path)
}
foreach ($taskMessage in $taskSkipped) { Write-Host $taskMessage -ForegroundColor Yellow }
[long]$taskTotalBytes = 0
foreach ($taskEntry in $taskReady) { $taskTotalBytes += $taskEntry.Bytes }
Write-Host ''
Write-Host ('本次可清理 {0} 个目录，文件逻辑大小共 {1:N2} GiB；跳过 {2} 个目录。' -f $taskReady.Count, ($taskTotalBytes / 1GB), $taskSkipped.Count)
if ($taskPreview) {
    Write-Host '仅预览，没有删除任何文件。'
    exit 0
}
if ($taskReady.Count -eq 0) {
    Write-Host '没有可清理的旧目录。'
    exit 0
}
Write-Host '将永久删除上方列出的目录。'
$taskAnswer = Read-Host '输入 DELETE 后回车执行；其他输入取消'
if ($taskAnswer -cne 'DELETE') {
    Write-Host '已取消，没有删除任何文件。'
    exit 0
}

$taskLogPath = Join-Path ([IO.Path]::GetDirectoryName($env:UE_HTML_TEST_CLEANUP_SELF)) ('cleanup-old-tests-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.log')
@(
    '旧测试产物清理日志'
    ('开始时间：' + [DateTimeOffset]::Now.ToString('o'))
    ('构建根目录：' + $taskRoot)
    '仅处理固定清单内、2026-11-03 00:00 +08:00 之前更新的目录。'
) | Set-Content -LiteralPath $taskLogPath -Encoding UTF8
foreach ($taskMessage in $taskSkipped) {
    Add-Content -LiteralPath $taskLogPath -Value $taskMessage -Encoding UTF8
}
$taskDrive = [IO.DriveInfo]::new('G:\')
[long]$taskFreeBefore = $taskDrive.AvailableFreeSpace
[long]$taskDeletedBytes = 0
$taskDeletedCount = 0
$taskFailedCount = 0
$taskIndex = 0
foreach ($taskEntry in $taskReady) {
    $taskIndex++
    Write-Host ('[{0}/{1}] {2}' -f $taskIndex, $taskReady.Count, $taskEntry.Path)
    try {
        # 删除前再次检查；扫描后新写入的目录会被跳过。
        $taskCurrentStats = Get-OldDirectoryStats -taskPath $taskEntry.Path
        if ($taskCurrentStats.Bytes -ne $taskEntry.Bytes -or $taskCurrentStats.Files -ne $taskEntry.Files) {
            throw '目录内容在预览后变化，本次跳过'
        }
        Remove-Item -LiteralPath $taskEntry.Path -Recurse -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $taskEntry.Path) { throw '删除后目录仍然存在' }
        $taskDeletedCount++
        $taskDeletedBytes += $taskEntry.Bytes
        Add-Content -LiteralPath $taskLogPath -Value ('已删除：' + $taskEntry.Path) -Encoding UTF8
    } catch {
        $taskFailedCount++
        $taskMessage = '未完整删除：' + $taskEntry.Path + '；' + $_.Exception.Message
        Write-Host $taskMessage -ForegroundColor Yellow
        Add-Content -LiteralPath $taskLogPath -Value $taskMessage -Encoding UTF8
    }
}
[long]$taskFreeAfter = ([IO.DriveInfo]::new('G:\')).AvailableFreeSpace
$taskSummary = '完成：删除 {0} 个目录，失败或执行前变化 {1} 个，预先跳过 {2} 个；已删除文件逻辑大小 {3:N2} GiB，磁盘可用空间增加 {4:N2} GiB。' -f $taskDeletedCount, $taskFailedCount, $taskSkipped.Count, ($taskDeletedBytes / 1GB), (($taskFreeAfter - $taskFreeBefore) / 1GB)
Add-Content -LiteralPath $taskLogPath -Value $taskSummary -Encoding UTF8
Write-Host $taskSummary
Write-Host ('日志：' + $taskLogPath)
if ($taskFailedCount -gt 0) { exit 1 }
exit 0
