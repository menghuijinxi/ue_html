param(
    [string]$Engine = 'H:/UE_5.8',
    [ValidateSet('prepare', 'capture')][string]$Mode = 'capture',
    [int]$Width = 1920,
    [int]$Height = 1080,
    [int]$Warmup = 240,
    [int]$Samples = 240,
    [double]$FixedEV100 = -1,
    [string]$View = 'all',
    [string]$CasesFile,
    [switch]$NoDistanceFieldResources,
    [string]$Report = 'baseline'
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskResults = Join-Path $PSScriptRoot 'results'
$taskProject = Join-Path $PSScriptRoot 'build/projects/villa-distance-fields/TriplexHouseVilla.uproject'
if ($Report -notmatch '^[a-z0-9-]+$') { throw 'Invalid report name.' }
if ($Mode -eq 'prepare') {
    & 'C:/Program Files/nodejs/node.exe' (Join-Path $PSScriptRoot 'prepare-web-project.cjs') `
        '--project=H:/TriplexHouseVilla/TriplexHouseVilla.uproject' '--id=villa-distance-fields' '--texture-size=0'
    if ($LASTEXITCODE -ne 0) { throw 'Distance-field comparison project preparation failed.' }
    & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development `
        "-Project=$taskRoot/tests/ue-shader-host/UEShaderHost.uproject" `
        -WaitMutex -NoHotReloadFromIDE -NoUBA -MaxParallelActions=4 *> "$taskResults/villa-distance-fields-build.log"
    if ($LASTEXITCODE -ne 0) { throw 'Distance-field comparison module build failed.' }
    return
}
if (-not (Test-Path -LiteralPath $taskProject)) { throw 'Run -Mode prepare first.' }
$taskViews = @(
    @{name = 'interior'; x = -175; y = -80; z = 160; pitch = -5; yaw = 50; fov = 90},
    @{name = 'kitchen'; x = -175; y = -80; z = 160; pitch = -5; yaw = 230; fov = 90},
    @{name = 'living'; x = -20; y = 200; z = 130; pitch = 12; yaw = -35; fov = 90}
)
if ($View -ne 'all') {
    $taskViews = @($taskViews | Where-Object { $_.name -eq $View })
    if ($taskViews.Count -ne 1) { throw 'Unknown comparison view.' }
}
$taskModes = @(
    @{name = 'both'; ao = 1; shadows = 1},
    @{name = 'off'; ao = 0; shadows = 0},
    @{name = 'ao'; ao = 1; shadows = 0},
    @{name = 'shadows'; ao = 0; shadows = 1},
    @{name = 'restore'; ao = 1; shadows = 1}
)
if ($NoDistanceFieldResources) {
    $taskModes = @(@{name = 'off'; ao = 0; shadows = 0},
        @{name = 'restore'; ao = 0; shadows = 0})
}
$taskCases = @()
foreach ($taskFixed in @($true, $false)) {
    foreach ($taskView in $taskViews) {
        foreach ($taskMode in $taskModes) {
            $taskCase = @{}
            foreach ($taskKey in $taskView.Keys) { $taskCase[$taskKey] = $taskView[$taskKey] }
            $taskCase.name = "$($taskView.name)-$(if ($taskFixed) { 'fixed' } else { 'auto' })-$($taskMode.name)"
            $taskCase.ao = $taskMode.ao
            $taskCase.shadows = $taskMode.shadows
            $taskCase.fixedExposure = $taskFixed
            $taskCase.ev100 = $FixedEV100
            $taskCases += $taskCase
        }
    }
}
$taskOutput = Join-Path $taskResults "villa-distance-fields-$Report"
$taskInput = "$taskOutput-input.json"
if ($CasesFile) {
    $taskCases = @(Get-Content -LiteralPath $CasesFile -Raw | ConvertFrom-Json)
    if ($taskCases.Count -eq 0) { throw 'Empty comparison cases.' }
}
@{map = '/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla'; output = $taskOutput;
    width = $Width; height = $Height; warmup = $Warmup; samples = $Samples; cases = $taskCases} |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $taskInput -Encoding utf8
$taskArguments = @(
    $taskProject, '/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla',
    "-WebDistanceFieldComparison=$taskInput", "-abslog=$taskOutput.log",
    '-RenderOffscreen', '-NoSplash', '-NoSound', '-NoLoadingScreen', '-unattended', '-nop4',
    '-windowed', "-ResX=$Width", "-ResY=$Height", '-ForceRes', '-NoThrottleCPU', '-d3d12', '-sm5',
    '-csvGpuStats', '-ini:Engine:[SystemSettings]:r.GPUCsvStatsEnabled=1',
    '-ini:Engine:[SystemSettings]:r.ProfileGPU.ShowUI=0',
    "-ini:Engine:[SystemSettings]:r.GenerateMeshDistanceFields=$(if ($NoDistanceFieldResources) { 0 } else { 1 })",
    '-ini:Engine:[SystemSettings]:r.DistanceFields.SupportEvenIfHardwareRayTracingSupported=1',
    '-ini:Engine:[SystemSettings]:r.RayTracing=0',
    '-ini:Engine:[SystemSettings]:r.DynamicGlobalIlluminationMethod=0',
    '-ini:Engine:[SystemSettings]:r.ReflectionMethod=0',
    '-ini:Engine:[SystemSettings]:r.Shadow.Virtual.Enable=0',
    '-ini:Engine:[SystemSettings]:r.ScreenPercentage=100',
    '-ini:Engine:[SystemSettings]:r.ScreenPercentage.Default.Desktop.Mode=0',
    '-ini:Engine:[SystemSettings]:r.DynamicRes.OperationMode=0',
    '-ini:Engine:[SystemSettings]:r.Streaming.PoolSize=512',
    '-ini:Engine:[SystemSettings]:r.VSync=0',
    '-ini:Engine:[SystemSettings]:t.MaxFPS=0',
    '-ini:EditorPerProjectUserSettings:[/Script/UnrealEd.EditorPerformanceSettings]:bThrottleCPUWhenNotForeground=False'
)
$taskStarted = Get-Date
$taskProcess = Start-Process -FilePath (Join-Path $Engine 'Engine/Binaries/Win64/UnrealEditor.exe') `
    -ArgumentList $taskArguments -WindowStyle Hidden -PassThru
Write-Output "Distance-field comparison PID: $($taskProcess.Id); log: $taskOutput.log"
$taskMemory = @()
while (-not $taskProcess.HasExited) {
    $taskMemory += @{utc = (Get-Date).ToUniversalTime().ToString('o'); values = @(
        & nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits)}
    if (((Get-Date) - $taskStarted).TotalSeconds -gt 900) {
        Stop-Process -Id $taskProcess.Id
        throw "Distance-field comparison timed out: $taskOutput.log"
    }
    $taskProcess.WaitForExit(2000) | Out-Null
}
@{started = $taskStarted.ToUniversalTime().ToString('o'); exitCode = $taskProcess.ExitCode;
    gpu = $taskMemory; note = 'Whole-adapter usage includes other applications.'} |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$taskOutput-system.json" -Encoding utf8
if ($taskProcess.ExitCode -ne 0) { throw "Distance-field comparison failed: $taskOutput.log" }
if (-not (Test-Path -LiteralPath "$taskOutput-capture.json") -or
    (Get-Item -LiteralPath "$taskOutput-capture.json").LastWriteTime -lt $taskStarted) {
    throw "Missing or stale distance-field comparison report: $taskOutput"
}
Write-Output "Distance-field comparison complete: $taskOutput-capture.json"
