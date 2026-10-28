param([string]$Engine = 'H:/UE_5.8')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskResults = Join-Path $PSScriptRoot 'results'
$taskLayout = Get-Content "$taskResults/villa-material-lab-layout.json" -Raw | ConvertFrom-Json
$taskOutput = Join-Path $taskResults 'villa-material-lab-native'
$taskInput = Join-Path $taskResults 'villa-material-lab-native-input.json'
$taskViews = @(@{name = 'overview'; x = $taskLayout.camera[0]; y = $taskLayout.camera[1];
    z = $taskLayout.camera[2]; pitch = $taskLayout.camera[3]; yaw = $taskLayout.camera[4]; fov = 90})
foreach ($taskSample in $taskLayout.samples) {
    $taskView = $taskSample.detailCamera
    $taskViews += @{name = $taskSample.id; x = $taskView[0]; y = $taskView[1]; z = $taskView[2];
        pitch = $taskView[3]; yaw = $taskView[4]; fov = 90}
}
@{map = $taskLayout.map; output = $taskOutput; views = $taskViews} | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath $taskInput -Encoding utf8
$taskLog = Join-Path $taskResults 'villa-material-lab-native.log'
$taskArguments = @(
    "$taskRoot/tests/web-platform/build/projects/villa-material-lab/TriplexHouseVilla.uproject",
    $taskLayout.map, "-WebNativeComparison=$taskInput", "-abslog=$taskLog",
    '-RenderOffscreen', '-NoSplash', '-NoSound', '-NoLoadingScreen', '-unattended', '-nop4',
    '-windowed', '-ResX=1600', '-ResY=900', '-ForceRes', '-NoThrottleCPU', '-d3d12', '-sm5',
    '-ini:EditorPerProjectUserSettings:[/Script/UnrealEd.EditorPerformanceSettings]:bThrottleCPUWhenNotForeground=False'
)
$taskArguments += @(Get-Content (Join-Path $PSScriptRoot 'cook-profiles/DefaultTemplateDesktopEngine.ini') |
    Where-Object { $_ -match '^(r\.|landscape\.)[a-zA-Z0-9.]*=' } |
    ForEach-Object { "-ini:Engine:[SystemSettings]:$_" })
$taskStarted = Get-Date
$taskProcess = Start-Process -FilePath (Join-Path $Engine 'Engine/Binaries/Win64/UnrealEditor.exe') `
    -ArgumentList $taskArguments -WindowStyle Hidden -PassThru
Write-Output "Villa material lab native capture PID: $($taskProcess.Id)"
while (-not $taskProcess.HasExited) {
    if (((Get-Date) - $taskStarted).TotalSeconds -gt 300) {
        Stop-Process -Id $taskProcess.Id
        throw "Native material capture timed out: $taskLog"
    }
    $taskProcess.WaitForExit(1000) | Out-Null
}
if ($taskProcess.ExitCode -ne 0) { throw "Native material capture failed: $taskLog" }
$taskImages = @($taskViews | ForEach-Object {
    $taskFile = "$taskOutput-$($_.name).png"
    if (-not (Test-Path -LiteralPath $taskFile) -or (Get-Item -LiteralPath $taskFile).LastWriteTime -lt $taskStarted) {
        throw "Missing or stale native image: $taskFile"
    }
    @{file = $taskFile; sha256 = (Get-FileHash -LiteralPath $taskFile).Hash.ToLowerInvariant()}
})
@{pass = $true; images = $taskImages; input = $taskInput; log = $taskLog;
    boundary = 'Actual editor viewport with the Web rendering profile and matching cameras. Cloud time is frozen;
    screenshots are comparison evidence, not proof of pixel parity.'} | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath "$taskResults/villa-material-lab-native-results.json" -Encoding utf8
Write-Output "Native material comparison complete: $($taskImages.Count) views."
