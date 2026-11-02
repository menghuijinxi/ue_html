param(
    [string]$Engine = 'D:/UE_5.8',
    [string]$Project = 'G:/UE_HTML/TriplexHouseVilla/TriplexHouseVilla.uproject',
    [string]$Label = 'native-villa-trace'
)
$ErrorActionPreference = 'Stop'
if ($Label -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Label must be a simple filename.' }
if (Get-Process UnrealEditor,TriplexHouseVilla -ErrorAction SilentlyContinue) { throw 'Close the existing native project before tracing.' }
$taskResults = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'results'))
New-Item -ItemType Directory -Path $taskResults -Force | Out-Null
$taskPrefix = (Join-Path $taskResults $Label).Replace('\','/')
if (Test-Path -LiteralPath "$taskPrefix-launch.json") { throw 'Trace label already exists.' }
$taskBefore = @(Get-ChildItem (Join-Path (Split-Path $Project) 'Config') -Recurse -File | Get-FileHash | Select-Object Path,Hash)
$taskCommands = [Collections.Generic.List[string]]::new()
foreach ($taskQuery in @('r.ScreenPercentage.Default', 'r.ScreenPercentage.Default.Desktop.Mode', 'r.ScreenPercentage.Auto.PixelCountMultiplier', 'LogLoc')) {
    $taskCommands.Add("300:$taskQuery")
}
# Trace capture is separate from the normal FPS experiment. Enable channels individually
# because commas already delimit csvExecCmds commands.
foreach ($taskPair in @(@(2400, 'on'), @(3300, 'off'))) {
    $taskFrame = [int]$taskPair[0]
    $taskState = $taskPair[1]
    if ($taskState -eq 'off') { $taskCommands.Add("$($taskFrame - 300):r.RHICmd.ParallelTranslate.Enable 0") }
    $taskCommands.Add("${taskFrame}:Trace.File $taskPrefix-$taskState.utrace cpu")
    foreach ($taskChannel in @('frame', 'gpu', 'task', 'rhicommands', 'bookmark', 'log')) {
        $taskCommands.Add("${taskFrame}:Trace.Enable $taskChannel")
    }
    $taskCommands.Add("${taskFrame}:Trace.Status")
    $taskCommands.Add("$($taskFrame + 180):Trace.Stop")
}
$taskCommands.Add('3800:r.RHICmd.ParallelTranslate.Enable 1')
$taskCommands.Add('3800:LogLoc')
# A one-frame GPU profile also records viewport/pass dimensions and native pass costs.
$taskCommands.Add('3890:r.ProfileGPU.ShowUI 0')
$taskCommands.Add('3900:profilegpu')
$taskArgs = @("`"$Project`"", '/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla', '-game', '-d3d12',
    '-RenderOffscreen', '-windowed', '-ResX=2289', '-ResY=1287', '-ForceRes', '-unattended', '-nosplash',
    '-nosound', '-nop4', '-NoThrottleCPU', '-traceautostart=0', '-statnamedevents',
    '-csvCaptureFrames=4200', '-csvCompression=0', '-ExitAfterCsvProfiling',
    "-abslog=`"$taskPrefix.log`"", "-csvExecCmds=`"$($taskCommands -join ',')`"")
$taskProcess = Start-Process -FilePath (Join-Path $Engine 'Engine/Binaries/Win64/UnrealEditor.exe') -ArgumentList $taskArgs -WindowStyle Hidden -PassThru
@{started=(Get-Date).ToString('o');pid=$taskProcess.Id;arguments=$taskArgs;configBefore=$taskBefore} | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath "$taskPrefix-launch.json" -Encoding UTF8
Write-Output "Native trace PID $($taskProcess.Id)"
$taskDeadline = (Get-Date).AddMinutes(5)
while (-not $taskProcess.WaitForExit(2000)) {
    if ((Get-Date) -gt $taskDeadline) { Stop-Process -Id $taskProcess.Id; throw 'Native trace timed out.' }
}
$taskProcess.Refresh()
if ($taskProcess.ExitCode -ne 0) { throw "Native trace exit $($taskProcess.ExitCode)" }
$taskAfter = @(Get-ChildItem (Join-Path (Split-Path $Project) 'Config') -Recurse -File | Get-FileHash | Select-Object Path,Hash)
if (Compare-Object $taskBefore $taskAfter -Property Path,Hash) { throw 'Project Config changed.' }
foreach ($taskState in @('on', 'off')) {
    $taskFile = "$taskPrefix-$taskState.utrace"
    if (-not (Test-Path -LiteralPath $taskFile) -or (Get-Item -LiteralPath $taskFile).Length -lt 1000) { throw "Missing trace: $taskFile" }
}
@{completed=(Get-Date).ToString('o');exitCode=$taskProcess.ExitCode;configUnchanged=$true} | ConvertTo-Json |
    Set-Content -LiteralPath "$taskPrefix-complete.json" -Encoding UTF8
Write-Output "Native traces complete: $taskPrefix-{on,off}.utrace"
