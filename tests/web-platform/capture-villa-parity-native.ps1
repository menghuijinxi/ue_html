param(
    [Parameter(Mandatory=$true)][string]$Tag,
    [int]$MeasureFrames = 6000,
    [switch]$Effects,
    [switch]$SM5,
    [switch]$CSM,
    [switch]$NoPresentMon
)
$ErrorActionPreference = 'Stop'
if ($Tag -notmatch '^[a-z0-9-]+$') { throw 'Invalid tag' }
if ($MeasureFrames -lt 300 -or $MeasureFrames -gt 12000) { throw 'Invalid measurement frame count' }
if (Get-Process TriplexHouseVilla,UnrealEditor -ErrorAction SilentlyContinue) { throw 'Native game already running' }
$taskPrefix = (Join-Path $PSScriptRoot "results/$Tag").Replace('\','/')
if (Test-Path "$taskPrefix-launch.json") { throw 'Use a fresh tag' }
$taskExe = Join-Path $PSScriptRoot 'build/villa-native-pso-v1/Windows/TriplexHouseVilla/Binaries/Win64/TriplexHouseVilla.exe'
Copy-Item -LiteralPath $PSCommandPath -Destination "$taskPrefix-source.ps1"
$taskSourceHash = (Get-FileHash -LiteralPath "$taskPrefix-source.ps1" -Algorithm SHA256).Hash.ToLowerInvariant()
$taskExeHash = (Get-FileHash -LiteralPath $taskExe -Algorithm SHA256).Hash.ToLowerInvariant()
$taskCommands = [Collections.Generic.List[string]]::new()
$taskSettings = @('t.MaxFPS 0','r.VSync 0','r.DynamicRes.OperationMode 0','r.ScreenPercentage 100',
    'r.AntiAliasingMethod 4','r.DynamicGlobalIlluminationMethod 0','r.ReflectionMethod 0',
    'r.MotionBlurQuality 4','r.OneFrameThreadLag 1','r.Streaming.PoolSize 1000')
if ($CSM) { $taskSettings += 'r.Shadow.CSMCaching 1' }
$taskCases = @(@{name='baseline'; commands=@()})
if ($Effects) { $taskCases += @(
    @{name='no-tlv';commands=@('r.TranslucencyLightingVolume 0')},
    @{name='no-shadows';commands=@('r.TranslucencyLightingVolume 1','r.ShadowQuality 0')},
    @{name='no-dfao';commands=@('r.ShadowQuality 5','r.DistanceFieldAO 0')},
    @{name='no-aa';commands=@('r.DistanceFieldAO 1','r.AntiAliasingMethod 0')},
    @{name='baseline-repeat';commands=@('r.AntiAliasingMethod 4')}) }
$taskFrame = 2400
$taskPhases = @()
foreach ($taskCase in $taskCases) {
    foreach ($taskCommand in $taskCase.commands) { $taskCommands.Add("${taskFrame}:$taskCommand") }
    $taskPhases += @{name=$taskCase.name;start=$taskFrame+600;end=$taskFrame+600+$MeasureFrames;commands=$taskCase.commands}
    $taskFrame += 600+$MeasureFrames
}
foreach ($taskQuery in @('LogLoc','r.ScreenPercentage','r.AntiAliasingMethod','r.ShadowQuality','r.Shadow.CSMCaching','r.MotionBlurQuality','r.DynamicGlobalIlluminationMethod','r.ReflectionMethod','r.VSync','t.MaxFPS','r.OneFrameThreadLag','r.FinishCurrentFrame','r.TranslucencyLightingVolume','r.RayTracing')) { $taskCommands.Add("2300:$taskQuery") }
$taskCommands.Add("2350:shot filename=$taskPrefix.png -nosuffix")
$taskArgs = @('-d3d12','-windowed','-ResX=1280','-ResY=720','-ForceRes','-unattended','-nosplash','-nosound','-NoThrottleCPU',
    '-traceautostart=0',"-ExecCmds=`"$($taskSettings -join ',')`"",
    '-ini:Engine:[/Script/Engine.Engine]:bSmoothFrameRate=False',
    "-csvCaptureFrames=$($taskFrame+30)",'-csvCompression=0','-csvGpuStats','-ExitAfterCsvProfiling',
    "-abslog=`"$taskPrefix.log`"","-csvExecCmds=`"$($taskCommands -join ',')`"")
if ($SM5) { $taskArgs += @('-sm5','-ini:Engine:[SystemSettings]:r.RayTracing=0') }
# Visible interactive game is required for the presentation capture.
$taskProcess = Start-Process $taskExe -WorkingDirectory (Split-Path $taskExe) -ArgumentList $taskArgs -WindowStyle Normal -PassThru
$taskPresent = Join-Path $PSScriptRoot '../../.tools/presentmon/PresentMon-2.3.0-x64.exe'
$taskPM = $null
if (-not $NoPresentMon) {
    $taskPM = Start-Process $taskPresent -ArgumentList @('--process_id',$taskProcess.Id,'--session_name',"villa-$Tag",'--output_file',"$taskPrefix-present.csv",'--no_console_stats','--terminate_on_proc_exit') -WindowStyle Hidden -PassThru -RedirectStandardError "$taskPrefix-present.err" -RedirectStandardOutput "$taskPrefix-present.log"
}
@{exe=$taskExe;exeSha256=$taskExeHash;source="$taskPrefix-source.ps1";sourceSha256=$taskSourceHash;pid=$taskProcess.Id;
    arguments=$taskArgs;phases=$taskPhases;started=(Get-Date).ToString('o');presentMon=$taskPM.Id;
    visible=$true;resolution=@(1280,720)} | ConvertTo-Json -Depth 8 | Set-Content "$taskPrefix-launch.json" -Encoding utf8
Write-Output "Native parity PID $($taskProcess.Id)"
$taskStart = Get-Date
try {
    while (-not $taskProcess.WaitForExit(2000)) {
        if (((Get-Date)-$taskStart).TotalMinutes -gt 12) { Stop-Process -Id $taskProcess.Id; throw 'Capture timed out' }
    }
    $taskLog = Get-Content "$taskPrefix.log" -Raw
    if ($taskLog -match 'Fatal error:|Unhandled Exception:|Critical error:') { throw 'Native runtime failed; retain the capture for diagnosis' }
    $taskMatch = [regex]::Match($taskLog,'Writing CSV to file\s*:\s*([^\r\n]+)')
    if (-not $taskMatch.Success) { throw 'CSV not completed' }
    $taskCsv = $taskMatch.Groups[1].Value.Trim()
    if (-not [IO.Path]::IsPathRooted($taskCsv)) { $taskCsv = Join-Path (Split-Path $taskExe) $taskCsv }
    Copy-Item -LiteralPath $taskCsv -Destination "$taskPrefix.csv"
} finally {
    if ($taskPM -and -not $taskPM.WaitForExit(3000)) {
        & $taskPresent --session_name "villa-$Tag" --terminate_existing_session
        if (-not $taskPM.WaitForExit(10000)) { Stop-Process -Id $taskPM.Id }
    }
}
$taskLateExitFailure = $taskProcess.ExitCode -eq 777003 -and $taskLog -match 'Log file closed' -and $taskLog -match 'CsvProfiler.ExitAfterCsvProfiling'
@{exitCode=$taskProcess.ExitCode;lateExitFailure=$taskLateExitFailure;cleanExit=($taskProcess.ExitCode -eq 0);
    performanceAccepted=$false;physicalPresentationValidated=$false;csv="$taskPrefix.csv";completed=(Get-Date).ToString('o');
    presentError=(Get-Content "$taskPrefix-present.err" -Raw -ErrorAction SilentlyContinue)} | ConvertTo-Json | Set-Content "$taskPrefix-complete.json" -Encoding utf8
if ($taskProcess.ExitCode -ne 0 -and -not $taskLateExitFailure) { throw 'Unrecognized native exit failure' }
Write-Output "Native parity complete: $taskPrefix.csv"
