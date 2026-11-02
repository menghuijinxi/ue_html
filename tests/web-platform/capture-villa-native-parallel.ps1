param(
    [string]$Engine = 'D:/UE_5.8',
    [string]$Project = 'G:/UE_HTML/TriplexHouseVilla/TriplexHouseVilla.uproject',
    [string]$Label = 'native-villa-parallel',
    [ValidateSet('rhi', 'draw', 'all')][string]$Suite = 'rhi',
    [int]$ResX = 2289,
    [int]$ResY = 1287,
    [int]$WarmupFrames = 2400,
    [int]$SettleFrames = 300,
    [int]$MeasureFrames = 1800
)
$ErrorActionPreference = 'Stop'
if ($Label -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Label must be a simple filename.' }
$taskResults = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'results'))
$taskProject = [IO.Path]::GetFullPath($Project)
$taskExe = Join-Path $Engine 'Engine/Binaries/Win64/UnrealEditor.exe'
$taskPrefix = Join-Path $taskResults $Label
if (Test-Path -LiteralPath "$taskPrefix-launch.json") { throw "Capture already exists: $taskPrefix" }
if ($WarmupFrames -lt 1 -or $SettleFrames -lt 1 -or $MeasureFrames -lt 1) { throw 'Frame counts must be positive.' }
if (Get-Process UnrealEditor,TriplexHouseVilla -ErrorAction SilentlyContinue) { throw 'Close the existing native project before benchmarking.' }
New-Item -ItemType Directory -Path $taskResults -Force | Out-Null
$taskConfig = Join-Path (Split-Path $taskProject) 'Config'
$taskConfigBefore = @(Get-ChildItem $taskConfig -Recurse -File | Get-FileHash -Algorithm SHA256 | Select-Object Path,Hash)
$taskCommands = [Collections.Generic.List[string]]::new()
foreach ($taskQuery in @('r.RHICmd.ParallelTranslate.Enable', 'r.ParallelShadows', 'r.ParallelShadowsNonWholeScene',
    'r.ScreenPercentage', 'r.AntiAliasingMethod', 'r.VSync', 't.MaxFPS', 'r.RayTracing',
    'r.DynamicRes.OperationMode', 'r.RHIThread.Enable', 'r.RHICmd.Bypass', 'sg.ResolutionQuality',
    'r.ParallelBasePass', 'r.ParallelPrePass', 'r.ParallelVelocity', 'r.ParallelTranslucency',
    'r.RDG.ParallelExecute', 'r.MeshDrawCommands.ParallelPassSetup', 'LogLoc')) {
    $taskCommands.Add("300:$taskQuery")
}
$taskPhases = @()
$taskFrame = $WarmupFrames
$taskExperiments = switch ($Suite) {
    'rhi' { @('translate', 'shadows', 'both') }
    'draw' { @('draw-recording', 'mesh-setup', 'combined') }
    'all' { @('translate', 'shadows', 'both', 'draw-recording', 'mesh-setup', 'combined') }
}
$taskDrawFlags = @('r.ParallelBasePass', 'r.ParallelPrePass', 'r.ParallelVelocity', 'r.ParallelTranslucency', 'r.ParallelShadows', 'r.RDG.ParallelExecute')
$taskDrawDefaults = @{ 'r.RDG.ParallelExecute' = 2 }
foreach ($taskExperiment in $taskExperiments) {
    foreach ($taskState in @('on-1', 'off-1', 'off-2', 'on-2')) {
        $taskIsDrawExperiment = $taskExperiment -in @('draw-recording', 'mesh-setup', 'combined')
        $taskEnabled = $taskState.StartsWith('on')
        $taskFlags = [ordered]@{}
        if ($taskIsDrawExperiment) {
            foreach ($taskFlag in $taskDrawFlags) {
                $taskDefault = if ($taskDrawDefaults.ContainsKey($taskFlag)) { $taskDrawDefaults[$taskFlag] } else { 1 }
                $taskFlags[$taskFlag] = if ($taskExperiment -eq 'mesh-setup' -or $taskEnabled) { $taskDefault } else { 0 }
            }
            $taskFlags['r.MeshDrawCommands.ParallelPassSetup'] = if ($taskExperiment -eq 'draw-recording' -or $taskEnabled) { 1 } else { 0 }
            $taskFlags['r.RHICmd.ParallelTranslate.Enable'] = if ($taskExperiment -ne 'combined' -or $taskEnabled) { 1 } else { 0 }
            foreach ($taskFlag in $taskFlags.Keys) { $taskCommands.Add("${taskFrame}:$taskFlag $($taskFlags[$taskFlag])") }
        }
        $taskTranslate = if ($taskExperiment -eq 'shadows' -or $taskEnabled) { 1 } else { 0 }
        $taskShadows = if ($taskExperiment -eq 'translate' -or $taskEnabled) { 1 } else { 0 }
        if (-not $taskIsDrawExperiment) {
            $taskFlags['r.RHICmd.ParallelTranslate.Enable'] = $taskTranslate
            $taskFlags['r.ParallelShadows'] = $taskShadows
            $taskCommands.Add("${taskFrame}:r.RHICmd.ParallelTranslate.Enable $taskTranslate")
            $taskCommands.Add("${taskFrame}:r.ParallelShadows $taskShadows")
        }
        $taskPhases += [ordered]@{
            experiment = $taskExperiment; state = $taskState; commandFrame = $taskFrame
            startFrame = $taskFrame + $SettleFrames; endFrameExclusive = $taskFrame + $SettleFrames + $MeasureFrames
            translate = $taskFlags['r.RHICmd.ParallelTranslate.Enable']; shadows = $taskFlags['r.ParallelShadows']; flags = $taskFlags
        }
        $taskFrame += $SettleFrames + $MeasureFrames
    }
}
# Runtime toggles only. No renderer/scalability/lighting overrides or project INI writes.
$taskCommands.Add("${taskFrame}:r.RHICmd.ParallelTranslate.Enable 1")
$taskCommands.Add("${taskFrame}:r.ParallelShadows 1")
if ($Suite -ne 'rhi') {
    foreach ($taskFlag in ($taskDrawFlags + @('r.MeshDrawCommands.ParallelPassSetup'))) {
        $taskDefault = if ($taskDrawDefaults.ContainsKey($taskFlag)) { $taskDrawDefaults[$taskFlag] } else { 1 }
        $taskCommands.Add("${taskFrame}:$taskFlag $taskDefault")
    }
}
$taskCommands.Add("${taskFrame}:LogLoc")
$taskCommands.Add("$($taskFrame + 100):stat unit")
$taskCommands.Add("$($taskFrame + 300):shot filename=$($taskPrefix.Replace('\','/')).png -nosuffix")
$taskFrames = $taskFrame + 600
$taskArgs = @(
    "`"$taskProject`"", '/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla', '-game', '-d3d12',
    '-RenderOffscreen', '-windowed', "-ResX=$ResX", "-ResY=$ResY", '-ForceRes',
    '-unattended', '-nosplash', '-nosound', '-nop4', '-NoThrottleCPU', '-traceautostart=0',
    "-csvCaptureFrames=$taskFrames", '-csvCompression=0', '-ExitAfterCsvProfiling',
    "-abslog=`"$taskPrefix.log`"", "-csvExecCmds=`"$($taskCommands -join ',')`""
)
$taskStarted = Get-Date
$taskProcess = Start-Process -FilePath $taskExe -ArgumentList $taskArgs -WindowStyle Hidden -PassThru
$taskLaunch = [ordered]@{
    started = $taskStarted.ToString('o'); pid = $taskProcess.Id; engine = $Engine; project = $taskProject
    arguments = $taskArgs; csvFrames = $taskFrames; phases = $taskPhases; configBefore = $taskConfigBefore; suite = $Suite
    outputResolution = @($ResX,$ResY); note = 'Standalone -game using installed editor; fixed default spawn, project renderer settings; not a cooked Shipping build.'
}
$taskLaunch | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath "$taskPrefix-launch.json" -Encoding UTF8
Write-Output "Native ABBA PID $($taskProcess.Id); log $taskPrefix.log"
$taskPreviousCpu = @{}
$taskLastSample = Get-Date
while (-not $taskProcess.WaitForExit(2000)) {
    $taskNow = Get-Date
    if (($taskNow - $taskStarted).TotalMinutes -gt 12) {
        Stop-Process -Id $taskProcess.Id
        throw "Native capture timed out: $taskPrefix.log"
    }
    $taskElapsed = ($taskNow - $taskLastSample).TotalSeconds
    $taskTop = @(Get-Process | ForEach-Object {
        try {
            $taskCpu = $_.TotalProcessorTime.TotalSeconds
            $taskDelta = if ($taskPreviousCpu.ContainsKey($_.Id)) { $taskCpu - $taskPreviousCpu[$_.Id] } else { 0 }
            $taskPreviousCpu[$_.Id] = $taskCpu
            if ($taskDelta -gt 0) {
                [pscustomobject]@{name=$_.ProcessName;pid=$_.Id;cpuCores=$taskDelta/$taskElapsed;workingSetMB=$_.WorkingSet64/1MB}
            }
        } catch { } # A process can exit while it is being sampled.
    } | Sort-Object cpuCores -Descending | Select-Object -First 8)
    $taskGpu = if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        (& nvidia-smi --query-gpu=name,utilization.gpu,utilization.memory,memory.used,clocks.gr,temperature.gpu --format=csv,noheader 2>$null) -join ';'
    } else { $null }
    [ordered]@{time=$taskNow.ToString('o');topCpu=$taskTop;gpu=$taskGpu} | ConvertTo-Json -Depth 5 -Compress |
        Add-Content -LiteralPath "$taskPrefix-environment.jsonl" -Encoding UTF8
    $taskLastSample = $taskNow
}
$taskProcess.Refresh()
$taskConfigAfter = @(Get-ChildItem $taskConfig -Recurse -File | Get-FileHash -Algorithm SHA256 | Select-Object Path,Hash)
$taskConfigChanged = @(Compare-Object $taskConfigBefore $taskConfigAfter -Property Path,Hash)
if ($taskConfigChanged.Count) { throw 'Project Config changed during native capture; inspect before continuing.' }
if ($taskProcess.ExitCode -ne 0) { throw "Native exit code $($taskProcess.ExitCode): $taskPrefix.log" }
$taskLog = Get-Content -LiteralPath "$taskPrefix.log" -Raw
$taskCsvMatch = [regex]::Match($taskLog, 'Writing CSV to file\s*:\s*([^\r\n]+)')
if (-not $taskCsvMatch.Success) { throw 'Native run did not finish its CSV capture.' }
$taskCsvPath = $taskCsvMatch.Groups[1].Value.Trim()
Copy-Item -LiteralPath $taskCsvPath -Destination "$taskPrefix.csv"
if (-not (Test-Path -LiteralPath "$taskPrefix.png")) { throw 'Native screenshot missing.' }
[ordered]@{
    completed=(Get-Date).ToString('o');exitCode=$taskProcess.ExitCode;configUnchanged=$true
    csv="$taskPrefix.csv";originalCsv=$taskCsvPath;log="$taskPrefix.log";screenshot="$taskPrefix.png"
} | ConvertTo-Json | Set-Content -LiteralPath "$taskPrefix-complete.json" -Encoding UTF8
Write-Output "Native ABBA complete: $taskPrefix.csv"
