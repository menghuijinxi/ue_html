param(
    [string]$Engine = 'D:/UE_5.8',
    [string]$Label = 'villa-native-pso-v1',
    [string]$PackageLabel = 'villa-native-pso-v1',
    [int]$Runs = 3,
    [int]$Frames = 1800,
    [int]$StartRun = 0,
    [int]$WarmupRuns = 1,
    [int]$PrecompileThreads = 0
)
$ErrorActionPreference = 'Stop'
if ($Label -notmatch '^[a-zA-Z0-9_-]+$' -or $PackageLabel -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid label.' }
if ($Runs -lt 1 -or $StartRun -lt 0 -or $StartRun -ge $Runs -or $Frames -lt 600 -or $PrecompileThreads -lt 0) { throw 'Invalid run range, frame count or thread cap.' }
if (Get-Process UnrealEditor,TriplexHouseVilla -ErrorAction SilentlyContinue) { throw 'Close the existing native project before capture.' }
$taskRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$taskStage = Join-Path $taskRoot "build/$PackageLabel/Windows"
$taskExe = Join-Path $taskStage 'TriplexHouseVilla/Binaries/Win64/TriplexHouseVilla.exe'
if (-not (Test-Path -LiteralPath $taskExe)) { throw "Missing packaged game: $taskExe" }
$taskConfig = 'G:/UE_HTML/TriplexHouseVilla/Config'
$taskBefore = @(Get-ChildItem -LiteralPath $taskConfig -Recurse -File | Get-FileHash -Algorithm SHA256 | Select-Object Path,Hash)
for ($taskRun = $StartRun; $taskRun -lt $Runs; $taskRun++) {
    $taskPrefix = (Join-Path $taskRoot "results/$Label-run$taskRun").Replace('\','/')
    if (Test-Path -LiteralPath "$taskPrefix-launch.json") { throw "Capture already exists: $taskPrefix" }
    $taskCommands = @()
    foreach ($taskQuery in @('r.PSOPrecaching','r.PSOPrecache.GlobalShaders','r.PSOPrecache.Resources',
        'r.PSOPrecache.Components','r.PSOPrecache.KeepInMemoryUntilUsed',
        'r.pso.PrecompileThreadPoolPercentOfHardwareThreads','r.pso.PrecompileThreadPoolSize','r.pso.PrecompileThreadPoolSizeMin','r.pso.PrecompileThreadPoolSizeMax',
        'D3D12.PSO.DiskCache','D3D12.PSO.DriverOptimizedDiskCache',
        'r.AntiAliasingMethod','r.ScreenPercentage','r.RayTracing','r.GenerateMeshDistanceFields',
        'r.DistanceFieldAO','r.DistanceFieldShadowing','r.DynamicGlobalIlluminationMethod',
        'r.ReflectionMethod','r.Shadow.Virtual.Enable','r.Streaming.PoolSize','LogLoc')) {
        $taskCommands += "300:$taskQuery"
    }
    $taskCommands += "300:shot filename=$taskPrefix.png -nosuffix"
    $taskEnvironment = [ordered]@{
        time=(Get-Date).ToString('o')
        cpu=@(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors)
        gpu=if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
            @(& nvidia-smi --query-gpu=name,driver_version,utilization.gpu,memory.used --format=csv,noheader 2>$null)
        } else { @() }
        processes=@(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 ProcessName,Id,CPU,WorkingSet64)
    }
    $taskEnvironment | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$taskPrefix-environment.json" -Encoding UTF8
    $taskArgs = @('-d3d12','-RenderOffscreen','-windowed','-ResX=2290','-ResY=1288','-ForceRes',
        '-unattended','-nosplash','-nosound','-nop4','-NoThrottleCPU','-statnamedevents',
        '-trace=cpu,frame,bookmark,log',"-tracefile=`"$taskPrefix.utrace`"",
        "-csvCaptureFrames=$Frames",'-csvCompression=0','-csvCategories=PSO,PSOPrecacheCompiling',
        '-ExitAfterCsvProfiling',"-abslog=`"$taskPrefix.log`"","-csvExecCmds=`"$($taskCommands -join ',')`"")
    if ($PrecompileThreads -gt 0) {
        # Diagnostic scheduling cap only; never writes project Config or changes rendering features.
        $taskArgs += "-ini:Engine:[SystemSettings]:r.pso.PrecompileThreadPoolSizeMax=$PrecompileThreads"
        if ($PrecompileThreads -eq 1) { $taskArgs += '-ini:Engine:[SystemSettings]:r.pso.PrecompileThreadPoolSizeMin=1' }
    }
    $taskStarted = Get-Date
    $taskProcess = Start-Process -FilePath $taskExe -WorkingDirectory (Split-Path $taskExe) -ArgumentList $taskArgs -WindowStyle Hidden -PassThru
    [ordered]@{started=$taskStarted.ToString('o');pid=$taskProcess.Id;run=$taskRun;
        warmup=($taskRun -lt $WarmupRuns);precompileThreadCap=$PrecompileThreads;executable=$taskExe;arguments=$taskArgs;configBefore=$taskBefore;
        note='Cooked Development game, original project renderer settings; all existing caches retained.'} |
        ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$taskPrefix-launch.json" -Encoding UTF8
    Write-Output "Native PSO capture run $taskRun PID $($taskProcess.Id)"
    while (-not $taskProcess.WaitForExit(2000)) {
        if (((Get-Date) - $taskStarted).TotalMinutes -gt 5) {
            Stop-Process -Id $taskProcess.Id
            throw "Capture timed out: $taskPrefix.log"
        }
    }
    $taskProcess.Refresh()
    $taskAfter = @(Get-ChildItem -LiteralPath $taskConfig -Recurse -File | Get-FileHash -Algorithm SHA256 | Select-Object Path,Hash)
    $taskChanged = @(Compare-Object $taskBefore $taskAfter -Property Path,Hash)
    if ($taskChanged.Count) { throw 'Project Config changed during capture.' }
    $taskLog = Get-Content -LiteralPath "$taskPrefix.log" -Raw
    # UE can fail in its crash-reporting thread after the log has already closed.
    # Preserve that failure explicitly; it must not be mistaken for a clean exit.
    $taskLateExitFailure = $taskProcess.ExitCode -eq 777003 -and $taskLog -match 'Log file closed' -and $taskLog -match 'Game engine shut down'
    if ($taskProcess.ExitCode -ne 0 -and -not $taskLateExitFailure) { throw "Native run $taskRun failed ($($taskProcess.ExitCode)): $taskPrefix.log" }
    $taskCsvMatch = [regex]::Match($taskLog, 'Writing CSV to file\s*:\s*([^\r\n]+)')
    if (-not $taskCsvMatch.Success) { throw 'Native run did not complete CSV capture.' }
    $taskCsvPath = $taskCsvMatch.Groups[1].Value.Trim()
    if (-not [IO.Path]::IsPathRooted($taskCsvPath)) { $taskCsvPath = Join-Path (Split-Path $taskExe) $taskCsvPath }
    Copy-Item -LiteralPath $taskCsvPath -Destination "$taskPrefix.csv"
    if (-not (Test-Path -LiteralPath "$taskPrefix.utrace")) { throw 'Native startup trace missing.' }
    if (-not (Test-Path -LiteralPath "$taskPrefix.png")) { throw 'Native scene screenshot missing.' }
    [ordered]@{completed=(Get-Date).ToString('o');exitCode=$taskProcess.ExitCode;configUnchanged=$true;lateExitFailure=$taskLateExitFailure;
        durationSeconds=((Get-Date)-$taskStarted).TotalSeconds;trace="$taskPrefix.utrace"} |
        ConvertTo-Json | Set-Content -LiteralPath "$taskPrefix-complete.json" -Encoding UTF8
    $taskRsp = "$taskPrefix.export.rsp"
    @("TimingInsights.ExportThreads `"$taskPrefix.threads.csv`"",
      "TimingInsights.ExportTimers `"$taskPrefix.timers.csv`"",
      "TimingInsights.ExportTimerStatistics `"$taskPrefix.statistics.csv`"",
      "TimingInsights.ExportTimingEvents `"$taskPrefix.events.csv`" -timers=`"PSOPrecache:*,Priority:*,Create time,*PipelineState*,FEngineLoop::Init,FEngineLoop::Tick,*LoadMap*,*PSO*`" -columns=`"ThreadId,ThreadName,TimerId,TimerName,StartTime,EndTime,Duration,Depth`"") |
        Set-Content -LiteralPath $taskRsp -Encoding UTF8
    $taskExport = Start-Process -FilePath (Join-Path $Engine 'Engine/Binaries/Win64/UnrealInsights.exe') -WindowStyle Hidden -PassThru -ArgumentList @(
        "-OpenTraceFile=`"$taskPrefix.utrace`"",'-AutoQuit','-NoUI',"-ExecOnAnalysisCompleteCmd=`"@=$taskRsp`"","-ABSLOG=`"$taskPrefix.insights.log`"")
    while (-not $taskExport.WaitForExit(1000)) {
        if (((Get-Date)-$taskStarted).TotalMinutes -gt 8) { Stop-Process -Id $taskExport.Id; throw 'Insights export timed out.' }
    }
    if ($taskExport.ExitCode -ne 0 -or -not (Test-Path -LiteralPath "$taskPrefix.events.csv")) { throw 'Insights export failed.' }
    Write-Output "Native run $taskRun complete and exported."
}
