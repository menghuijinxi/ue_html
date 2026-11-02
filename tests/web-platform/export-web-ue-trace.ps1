param(
    [Parameter(Mandatory=$true)][string]$Trace,
    [string]$Engine = 'D:/UE_5.8',
    [ValidateSet('web', 'native')][string]$Backend = 'web',
    [switch]$PsoOnly
)
$ErrorActionPreference = 'Stop'
$taskTrace = (Resolve-Path -LiteralPath $Trace).Path.Replace('\', '/')
$taskPrefix = $taskTrace -replace '\.utrace$', ''
if ($taskPrefix -eq $taskTrace) { throw 'Expected a saved .utrace file.' }
$taskCommands = "$taskPrefix.export.rsp"
$taskTimerFilter = if ($PsoOnly) { ' -timers="WebPSO_*,WebGPU_*,FEngineLoop::Tick,*RenderThread*"' } else { '' }
@(
    "TimingInsights.ExportThreads `"$taskPrefix.threads.csv`""
    "TimingInsights.ExportTimers `"$taskPrefix.timers.csv`""
    "TimingInsights.ExportTimingEvents `"$taskPrefix.events.csv`"$taskTimerFilter -columns=`"ThreadId,ThreadName,TimerId,TimerName,StartTime,EndTime,Duration,Depth`""
    "TimingInsights.ExportTimerStatistics `"$taskPrefix.statistics.csv`""
) | Set-Content -LiteralPath $taskCommands -Encoding utf8
$taskArguments = @("-OpenTraceFile=`"$taskTrace`"", '-AutoQuit', '-NoUI',
    "-ExecOnAnalysisCompleteCmd=`"@=$taskCommands`"", "-ABSLOG=`"$taskPrefix.insights.log`"")
$taskProcess = Start-Process -FilePath (Join-Path $Engine 'Engine/Binaries/Win64/UnrealInsights.exe') `
    -ArgumentList $taskArguments -WindowStyle Hidden -PassThru
$taskDeadline = (Get-Date).AddMinutes(3)
while (-not $taskProcess.WaitForExit(1000)) {
    if ((Get-Date) -gt $taskDeadline) { Stop-Process -Id $taskProcess.Id; throw 'Insights analysis timed out.' }
}
if ($taskProcess.ExitCode -ne 0) { throw "Insights exited with code $($taskProcess.ExitCode)." }
foreach ($taskSuffix in @('threads', 'timers', 'events', 'statistics')) {
    if (-not (Test-Path -LiteralPath "$taskPrefix.$taskSuffix.csv")) { throw "Missing Insights export: $taskSuffix" }
}
& node (Join-Path $PSScriptRoot 'verify-web-ue-trace.cjs') $taskTrace "--backend=$Backend"
if ($LASTEXITCODE -ne 0) { throw 'Native Insights event validation failed.' }
