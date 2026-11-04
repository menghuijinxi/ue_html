param(
    [string]$Engine = 'D:/UE_5.8',
    [string]$Project = 'G:/UE_HTML/TriplexHouseVilla/TriplexHouseVilla.uproject',
    [string]$Tag = 'threading-native',
    [int]$WarmupFrames = 2400,
    [int]$MeasureFrames = 2400,
    [string]$Modes = 'full,single,single,full',
    [switch]$Packaged
)
$ErrorActionPreference = 'Stop'
if ($Tag -notmatch '^[a-z0-9-]+$') { throw 'Invalid tag' }
if (Get-Process UnrealEditor,TriplexHouseVilla -ErrorAction SilentlyContinue) { throw 'A native project is already running' }
$taskResults = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'results'))
$taskConfig = Join-Path (Split-Path $Project) 'Config'
$taskBefore = @(Get-ChildItem $taskConfig -Recurse -File | Get-FileHash | Select-Object Path,Hash)
$taskRuns = @()
$taskIndex = 0
foreach ($taskMode in $Modes.Split(',')) {
    if ($taskMode -notin @('full','render-serial','single')) { throw 'Invalid mode' }
    $taskIndex++
    $taskPrefix = Join-Path $taskResults "$Tag-$taskIndex-$taskMode"
    if (Test-Path -LiteralPath "$taskPrefix-launch.json") { throw "Capture already exists: $taskPrefix" }
    $taskCommands = [Collections.Generic.List[string]]::new()
    foreach ($taskQuery in @('r.ScreenPercentage', 'r.AntiAliasingMethod', 'r.VSync', 't.MaxFPS',
        'r.DynamicRes.OperationMode', 'r.RHIThread.Enable', 'r.RHICmd.Bypass', 'r.RHICmd.ParallelTranslate.Enable',
        'r.ScreenPercentage.Default.Desktop.Mode', 'LogLoc')) {
        $taskCommands.Add("${WarmupFrames}:$taskQuery")
    }
    $taskCommands.Add("$($WarmupFrames + $MeasureFrames + 10):shot filename=$($taskPrefix.Replace('\','/')).png -nosuffix")
    $taskFrames = $WarmupFrames + $MeasureFrames + 120
    $taskArgs = @('/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla', '-game', '-d3d12',
        '-RenderOffscreen', '-windowed', '-ResX=2289', '-ResY=1287', '-ForceRes', '-unattended',
        '-nosplash', '-nosound', '-nop4', '-NoThrottleCPU', '-traceautostart=0',
        '-ini:Engine:[SystemSettings]:r.pso.EnableAsyncCacheConsolidation=0',
        "-csvCaptureFrames=$taskFrames", '-csvCompression=0', '-ExitAfterCsvProfiling',
        "-abslog=`"$taskPrefix.log`"", "-csvExecCmds=`"$($taskCommands -join ',')`"")
    if ($taskMode -eq 'render-serial') { $taskArgs += @('-norenderthread','-norhithread') }
    if ($taskMode -eq 'single') { $taskArgs += @('-onethread','-nothreading','-norhithread') }
    $taskExe = Join-Path $Engine 'Engine/Binaries/Win64/UnrealEditor.exe'
    if ($Packaged) { $taskExe = Join-Path $PSScriptRoot 'build/villa-native-pso-v1/Windows/TriplexHouseVilla/Binaries/Win64/TriplexHouseVilla.exe' }
    else { $taskArgs = @("`"$Project`"") + $taskArgs }
    $taskProcess = Start-Process -FilePath $taskExe -WorkingDirectory (Split-Path $taskExe) -ArgumentList $taskArgs -WindowStyle Hidden -PassThru
    $taskRun = [ordered]@{mode=$taskMode;index=$taskIndex;pid=$taskProcess.Id;arguments=$taskArgs;
        started=(Get-Date).ToString('o');warmupFrames=$WarmupFrames;measureFrames=$MeasureFrames;csvFrames=$taskFrames;exe=$taskExe;packaged=[bool]$Packaged}
    $taskRun | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$taskPrefix-launch.json" -Encoding UTF8
    Write-Output "Native $taskIndex $taskMode PID $($taskProcess.Id)"
    $taskDeadline = (Get-Date).AddMinutes(8)
    while (-not $taskProcess.WaitForExit(2000)) {
        if ((Get-Date) -gt $taskDeadline) { Stop-Process -Id $taskProcess.Id; throw 'Native threading capture timed out' }
    }
    $taskProcess.WaitForExit()
    $taskRun.exitCode = $taskProcess.ExitCode
    $taskLog = Get-Content -LiteralPath "$taskPrefix.log" -Raw
    $taskCsvMatch = [regex]::Match($taskLog, 'Writing CSV to file\s*:\s*([^\r\n]+)')
    if ($null -eq $taskRun.exitCode -and $taskLog -match 'RequestExitWithStatus\(0, 0, CsvProfiler.ExitAfterCsvProfiling\)') {
        $taskRun.exitCode = 0
        $taskRun.exitCodeEvidence = 'CSV profiler requested successful native exit; Start-Process returned no exit code'
    }
    $taskRun.lateExitFailure = $taskRun.exitCode -eq 777003 -and $taskCsvMatch.Success -and
        $taskLog -match 'RequestExitWithStatus\(0, 0, CsvProfiler.ExitAfterCsvProfiling\)' -and
        $taskLog -match 'Log file closed' -and $taskLog -notmatch 'Fatal error:|Unhandled Exception:|Critical error:'
    if (($taskRun.exitCode -ne 0 -and -not $taskRun.lateExitFailure) -or -not $taskCsvMatch.Success) {
        throw "Native $taskMode failed (exit $($taskRun.exitCode), CSV $($taskCsvMatch.Success)): $taskPrefix.log"
    }
    $taskCsvPath = $taskCsvMatch.Groups[1].Value.Trim()
    if (-not [IO.Path]::IsPathRooted($taskCsvPath)) { $taskCsvPath = [IO.Path]::GetFullPath((Join-Path (Split-Path $taskExe) $taskCsvPath)) }
    Copy-Item -LiteralPath $taskCsvPath -Destination "$taskPrefix.csv"
    if (-not (Test-Path -LiteralPath "$taskPrefix.png")) { throw 'Native screenshot missing' }
    $taskRun.csv = "$taskPrefix.csv"
    $taskRun.log = "$taskPrefix.log"
    $taskRun.screenshot = "$taskPrefix.png"
    $taskRuns += $taskRun
    [ordered]@{runs=$taskRuns;pass=$false} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskResults "$Tag.json") -Encoding UTF8
}
$taskAfter = @(Get-ChildItem $taskConfig -Recurse -File | Get-FileHash | Select-Object Path,Hash)
if (Compare-Object $taskBefore $taskAfter -Property Path,Hash) { throw 'Project Config changed during capture' }
[ordered]@{runs=$taskRuns;pass=$true;configUnchanged=$true;configBefore=$taskBefore;configAfter=$taskAfter;
    note='Same project/default spawn and D3D12, no renderer quality changes. PSO cache async consolidation disabled in ALL modes, matching current Web; UE 5.8 asserts without it under -nothreading. Separate process for each mode. See runs.packaged for cooked Development versus editor -game.'} |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskResults "$Tag.json") -Encoding UTF8
