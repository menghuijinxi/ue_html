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
$taskCutoff = [DateTimeOffset]::Parse('2026-11-11T14:25:23.332Z').UtcDateTime
$taskMode = $env:UE_HTML_TEST_CLEANUP_MODE
if ($taskMode -and $taskMode -ne '--preview') {
    throw '支持的参数只有 --preview（仅预览）；双击批处理可执行清理。'
}
$taskPreview = $taskMode -eq '--preview'

# 固定清单：191 个旧测试缓存、缓存归档和失败交付副本。
# 保留当前包、关闭 Nanite 的测试包、11 月 7 日旧版、源码、Cook 及证据。
$taskRelativeTargets = @(
    'browser-profiles\allocator-contract-v43-final'
    'browser-profiles\allocator-contract-v43-final-v2'
    'browser-profiles\allocator-contract-v43-validation'
    'browser-profiles\allocator-contract-v43-validation-v2'
    'browser-profiles\binding-tlv-v60-correctness-20261104'
    'browser-profiles\binding-tlv-v61-correctness-20261104'
    'browser-profiles\binding-tlv-v61-correctness-final-20261104'
    'browser-profiles\binding-tlv-v61-steady-images-20261104'
    'browser-profiles\bridge-extras-equivalence-0-legacy-both'
    'browser-profiles\bridge-extras-equivalence-0-legacy-groups'
    'browser-profiles\bridge-extras-equivalence-0-legacy-states'
    'browser-profiles\bridge-extras-equivalence-v2-0-legacy-both'
    'browser-profiles\bridge-extras-equivalence-v2-0-legacy-groups'
    'browser-profiles\bridge-extras-equivalence-v2-0-legacy-states'
    'browser-profiles\bridge-extras-equivalence-v2-0-original'
    'browser-profiles\bridge-extras-preflight-0-legacy-groups'
    'browser-profiles\bridge-extras-preflight-0-original'
    'browser-profiles\bridge-extras-shared-final-0-legacy-both'
    'browser-profiles\bridge-extras-shared-final-0-original'
    'browser-profiles\bridge-extras-shared-final-1-legacy-both'
    'browser-profiles\bridge-extras-shared-final-1-original'
    'browser-profiles\bridge-extras-shared-final-2-legacy-both'
    'browser-profiles\bridge-extras-shared-final-2-original'
    'browser-profiles\bridge-import-audit-v36'
    'browser-profiles\bridge-import-audit-v37-all'
    'browser-profiles\bridge-import-audit-v37-baseline'
    'browser-profiles\buffer-lifecycle-v59-20261104'
    'browser-profiles\buffer-lifecycle-v62-diagnostic-20261104'
    'browser-profiles\buffer-lifecycle-v62-final-20261104'
    'browser-profiles\buffer-lifecycle-v62-images-20261104'
    'browser-profiles\capture-villa'
    'browser-profiles\compile-options'
    'browser-profiles\cpu-villa'
    'browser-profiles\draw-api-backend-diagnostic'
    'browser-profiles\draw-api-final-0-js'
    'browser-profiles\draw-api-final-0-wasm'
    'browser-profiles\draw-api-final-1-js'
    'browser-profiles\draw-api-final-1-wasm'
    'browser-profiles\draw-api-final-2-js'
    'browser-profiles\draw-api-final-2-wasm'
    'browser-profiles\draw-api-inspect-gpu'
    'browser-profiles\draw-api-preflight-js-0-js'
    'browser-profiles\draw-api-preflight-jspi-0-wasm'
    'browser-profiles\draw-api-preflight-jspi2-0-wasm'
    'browser-profiles\draw-api-preflight-jspi3-0-wasm'
    'browser-profiles\draw-api-preflight-wasm-0-wasm'
    'browser-profiles\draw-api-release-v1-0-js'
    'browser-profiles\draw-api-release-v1-0-wasm'
    'browser-profiles\draw-api-release-v1-1-js'
    'browser-profiles\draw-api-release-v1-1-wasm'
    'browser-profiles\draw-api-release-v1-2-js'
    'browser-profiles\draw-api-release-v1-2-wasm'
    'browser-profiles\draw-api-release-v2-0-js'
    'browser-profiles\draw-api-release-v2-0-wasm'
    'browser-profiles\draw-api-release-v2-1-js'
    'browser-profiles\draw-api-release-v2-1-wasm'
    'browser-profiles\draw-api-release-v2-2-js'
    'browser-profiles\draw-api-release-v2-2-wasm'
    'browser-profiles\draw-bridge-ablation-v1-0-js'
    'browser-profiles\draw-bridge-ablation-v1-0-map-table'
    'browser-profiles\draw-bridge-ablation-v1-0-number-map'
    'browser-profiles\draw-bridge-ablation-v1-0-number-unchecked'
    'browser-profiles\draw-bridge-ablation-v1-0-object-table'
    'browser-profiles\draw-bridge-ablation-v1-0-original'
    'browser-profiles\draw-bridge-ablation-v1-1-js'
    'browser-profiles\draw-bridge-ablation-v1-1-map-table'
    'browser-profiles\draw-bridge-ablation-v1-1-number-map'
    'browser-profiles\draw-bridge-ablation-v1-1-number-unchecked'
    'browser-profiles\draw-bridge-ablation-v1-1-object-table'
    'browser-profiles\draw-bridge-ablation-v1-1-original'
    'browser-profiles\draw-bridge-api-equivalence-0-baseline'
    'browser-profiles\draw-bridge-api-equivalence-0-original'
    'browser-profiles\draw-bridge-api-equivalence-v2-0-baseline'
    'browser-profiles\draw-bridge-api-equivalence-v2-0-original'
    'browser-profiles\draw-bridge-f64-v1-0-js'
    'browser-profiles\draw-bridge-f64-v1-0-original'
    'browser-profiles\draw-bridge-f64-v1-1-js'
    'browser-profiles\draw-bridge-f64-v1-1-original'
    'browser-profiles\draw-bridge-final-0-baseline'
    'browser-profiles\draw-bridge-final-0-js'
    'browser-profiles\draw-bridge-final-0-original'
    'browser-profiles\draw-bridge-final-1-baseline'
    'browser-profiles\draw-bridge-final-1-js'
    'browser-profiles\draw-bridge-final-1-original'
    'browser-profiles\draw-bridge-final-2-baseline'
    'browser-profiles\draw-bridge-final-2-js'
    'browser-profiles\draw-bridge-final-2-original'
    'browser-profiles\draw-bridge-final-v2-0-baseline'
    'browser-profiles\draw-bridge-final-v2-0-js'
    'browser-profiles\draw-bridge-final-v2-0-original'
    'browser-profiles\draw-bridge-final-v2-1-baseline'
    'browser-profiles\draw-bridge-final-v2-1-js'
    'browser-profiles\draw-bridge-final-v2-1-original'
    'browser-profiles\draw-bridge-final-v2-2-baseline'
    'browser-profiles\draw-bridge-final-v2-2-js'
    'browser-profiles\draw-bridge-final-v2-2-original'
    'browser-profiles\draw-bridge-profile'
    'browser-profiles\draw-bridge-stream-v1-0-js'
    'browser-profiles\draw-bridge-stream-v1-0-original'
    'browser-profiles\draw-bridge-stream-v1-1-js'
    'browser-profiles\draw-bridge-stream-v1-1-original'
    'browser-profiles\draw-bridge-stream-v2-0-js'
    'browser-profiles\draw-bridge-stream-v2-0-original'
    'browser-profiles\draw-bridge-stream-v2-1-js'
    'browser-profiles\draw-bridge-stream-v2-1-original'
    'browser-profiles\draw-bridge-stream-v3-0-js'
    'browser-profiles\draw-bridge-stream-v3-0-original'
    'browser-profiles\draw-bridge-stream-v3-1-js'
    'browser-profiles\draw-bridge-stream-v3-1-original'
    'browser-profiles\draw-bridge-stream-verified-0-js'
    'browser-profiles\draw-bridge-stream-verified-0-original'
    'browser-profiles\draw-bridge-stream-verified-1-js'
    'browser-profiles\draw-bridge-stream-verified-1-original'
    'browser-profiles\final-link-render-diagnosis-v1-villa-bridge-extras-v38'
    'browser-profiles\final-link-render-diagnosis-v2-villa-bridge-extras-v38'
    'browser-profiles\final-link-render-diagnosis-v3-villa-bridge-extras-v38'
    'browser-profiles\final-link-render-diagnosis-v3-villa-final-link-o2-v39'
    'browser-profiles\final-link-shadow-cache-v1-villa-final-link-o2-v39'
    'browser-profiles\frame-scheduler'
    'browser-profiles\frame-scheduling'
    'browser-profiles\gameplay-binding-skips-v48-validate-0'
    'browser-profiles\gameplay-lumen-off-v59-dlmalloc-native-0'
    'browser-profiles\gameplay-native-metadata-v55-validate-0'
    'browser-profiles\gameplay-native-metadata-v57-native-validation-0'
    'browser-profiles\gameplay-native-metadata-v57-reference-0'
    'browser-profiles\gameplay-rhi-hotspots-v49-validate-0'
    'browser-profiles\gameplay-rhi-hotspots-v51-validate-0'
    'browser-profiles\gameplay-rhi-hotspots-v52-reboot-validate-0'
    'browser-profiles\lumen-off-v58-views'
    'browser-profiles\lumen-off-v59-pass-diagnostic-villa-lumen-off-current-mimalloc-v59'
    'browser-profiles\lumen-off-v59-pass-diagnostic-villa-native-metadata-v57'
    'browser-profiles\lumen-off-v59-views'
    'browser-profiles\memory-lumen-off-v59-no-lumen'
    'browser-profiles\motion-route-pilot'
    'browser-profiles\mouse-turn-checks'
    'browser-profiles\mouse-turn-validation'
    'browser-profiles\native-metadata-v57-normal'
    'browser-profiles\native-metadata-v57-pso'
    'browser-profiles\occlusion-history'
    'browser-profiles\parity-address32-compute-window-20261106'
    'browser-profiles\periodic-input-checks'
    'browser-profiles\periodic-stall-checks'
    'browser-profiles\pso-real-full-cache256-v29'
    'browser-profiles\pso-real-full-v29'
    'browser-profiles\pso-real-subset-v29'
    'browser-profiles\rhi-isolation-final-0-js'
    'browser-profiles\rhi-isolation-final-0-scalar'
    'browser-profiles\rhi-isolation-final-0-simd'
    'browser-profiles\rhi-isolation-final-1-js'
    'browser-profiles\rhi-isolation-final-1-scalar'
    'browser-profiles\rhi-isolation-final-1-simd'
    'browser-profiles\rhi-isolation-final-2-js'
    'browser-profiles\rhi-isolation-final-2-scalar'
    'browser-profiles\rhi-isolation-final-2-simd'
    'browser-profiles\rhi-isolation-js-preflight-0-js'
    'browser-profiles\rhi-isolation-preflight-v1-0-scalar'
    'browser-profiles\rhi-isolation-preflight-v2-0-scalar'
    'browser-profiles\rhi-isolation-preflight-v3-0-scalar'
    'browser-profiles\rhi-isolation-simd-preflight-final-0-simd'
    'browser-profiles\rhi-stalls'
    'browser-profiles\runtime-pso'
    'browser-profiles\runtime-pso-cache-control'
    'browser-profiles\runtime-pso-small-default'
    'browser-profiles\same-shader-dump'
    'browser-profiles\same-shader-timing'
    'browser-profiles\scheduling-motion-pso'
    'browser-profiles\stutters'
    'browser-profiles\threading-ab'
    'browser-profiles\turning-shadow-clear-validation'
    'browser-profiles\villa-allocator-no-proxy-v44-views'
    'browser-profiles\villa-binding-skips-v48-views'
    'browser-profiles\villa-bridge-extras-v38-views'
    'browser-profiles\villa-browser-metrics-v47-metrics-v3'
    'browser-profiles\villa-browser-metrics-v47-views'
    'browser-profiles\villa-browser-metrics-v47-views-v2'
    'browser-profiles\villa-browser-metrics-v47-views-v4'
    'browser-profiles\villa-command-stream-v36-view-check'
    'browser-profiles\villa-command-stream-v36-views'
    'browser-profiles\villa-final-link-o1-v40-views'
    'browser-profiles\villa-mimalloc-no-proxy-v45-views'
    'browser-profiles\villa-mimalloc-proxy-v43-views'
    'browser-profiles\villa-mimalloc-proxy-v43-views-v2'
    'browser-profiles\villa-mimalloc-proxy-v43-views-v3'
    'browser-profiles\villa-native-metadata-v55-views'
    'browser-profiles\villa-native-metadata-v57-views'
    'browser-profiles\villa-o2-keep-names-v42-views'
    'browser-profiles\villa-rhi-hotspots-v51-views'
    'browser-profiles\villa-rhi-hotspots-v52-reboot-views'
    'browser-profiles\villa-simd-v41-views'
    'browser-profile-archives\memory-addressing-20261106'
    'nanite-release-20261111-launcher-failed'
)

function Get-OldDirectoryStats {
    param([string]$taskPath)

    $taskDirectory = Get-Item -LiteralPath $taskPath -Force
    if (-not $taskDirectory.PSIsContainer) { throw '目标不是目录' }
    $taskResolved = [IO.Path]::GetFullPath($taskDirectory.FullName)
    $taskRelativeCheck = $taskResolved.Substring($taskRoot.Length).TrimStart('\')
    if (-not $taskResolved.StartsWith($taskRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $taskRelativeCheck -notin $taskRelativeTargets) { throw '路径不在固定清单内' }
    $taskAncestor = $taskDirectory
    while ($null -ne $taskAncestor) {
        if ($taskAncestor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw ('路径包含链接或目录联接：' + $taskAncestor.FullName)
        }
        $taskAncestor = $taskAncestor.Parent
    }
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
            throw ('清单生成后有更新：' + $taskCurrent.FullName)
        }
        foreach ($taskChild in $taskCurrent.EnumerateFileSystemInfos()) {
            if ($taskChild.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw ('包含链接或目录联接：' + $taskChild.FullName)
            }
            if ($taskChild.LastWriteTimeUtc -ge $taskCutoff) {
                throw ('清单生成后有更新：' + $taskChild.FullName)
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

if (@($taskRelativeTargets | Select-Object -Unique).Count -ne 191) {
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

Write-Host '旧测试缓存清理（2026-11-11 固定清单，单文件批处理）'
Write-Host ('根目录：' + $taskRoot)
Write-Host '正在核对目录大小、修改时间及链接……'
$taskReady = [Collections.Generic.List[object]]::new()
$taskSkipped = [Collections.Generic.List[string]]::new()
foreach ($taskRelative in $taskRelativeTargets) {
    if ($taskRelative -notmatch '^(browser-profiles\\[a-z0-9-]+|browser-profile-archives\\[a-z0-9-]+|nanite-release-20261111-launcher-failed)$') {
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
    '仅处理 2026-11-11 固定清单内、清单生成前更新的目录。'
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
        $taskLive = @(Get-CimInstance Win32_Process | Where-Object {
            $_.Name -match '^(msedge|chrome|firefox)(\.exe)?$' -and $_.CommandLine -and
            $_.CommandLine.IndexOf($taskEntry.Path, [StringComparison]::OrdinalIgnoreCase) -ge 0
        })
        if ($taskLive.Count -gt 0) { throw '目录正在被测试浏览器使用，本次跳过' }
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
