param(
    [string]$Engine = 'H:/UE_5.8',
    [ValidateSet('desktop', 'mobile')][string]$Mode = 'desktop'
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskInput = Join-Path $PSScriptRoot "results/default-shadow-native-$Mode.json"
$taskLog = Join-Path $PSScriptRoot "results/default-shadow-native-$Mode.log"
if (-not (Test-Path -LiteralPath $taskInput)) {
    throw 'Run probe-web-default-desktop.cjs for desktop, or probe-web-default-shadow-artifacts.cjs for mobile first.'
}
$taskArguments = @(
    "$taskRoot/tests/ue-shader-host/UEShaderHost.uproject",
    '/Engine/Maps/Templates/Template_Default',
    "-WebNativeComparison=$taskInput", "-abslog=$taskLog",
    '-RenderOffscreen', '-NoSplash', '-NoSound', '-NoLoadingScreen', '-unattended', '-nop4',
    '-windowed', '-ResX=1600', '-ResY=900', '-ForceRes', '-NoThrottleCPU',
    '-ini:EditorPerProjectUserSettings:[/Script/UnrealEd.EditorPerformanceSettings]:bThrottleCPUWhenNotForeground=False',
    '-ini:Engine:[SystemSettings]:r.Shadow.Virtual.Enable=0'
)
$taskArguments += @('-d3d12', '-sm5')
if ($Mode -eq 'mobile') { $taskArguments += '-WebNativeMobilePreview' }
$taskProfile = if ($Mode -eq 'desktop') { 'DefaultTemplateDesktopEngine.ini' } else { 'DefaultTemplateEngine.ini' }
$taskSettings = Get-Content (Join-Path $PSScriptRoot "cook-profiles/$taskProfile") |
    Where-Object { $_ -match '^[a-zA-Z][a-zA-Z0-9.]*=' }
$taskArguments += @($taskSettings | ForEach-Object { "-ini:Engine:[SystemSettings]:$_" })
$taskStarted = Get-Date
$taskProcess = Start-Process -FilePath (Join-Path $Engine 'Engine/Binaries/Win64/UnrealEditor.exe') `
    -ArgumentList $taskArguments -WindowStyle Hidden -PassThru
Write-Output "Native $Mode comparison PID: $($taskProcess.Id); log: $taskLog"
if (-not $taskProcess.WaitForExit(300000)) {
    Stop-Process -Id $taskProcess.Id
    throw "Native viewport capture timed out: $taskLog"
}
if ($taskProcess.ExitCode -ne 0) { throw "Native comparison failed: $taskLog" }
$taskViews = (Get-Content -LiteralPath $taskInput -Raw | ConvertFrom-Json).views
$taskFeature = if ($Mode -eq 'mobile') { 1 } else { 3 }
$taskLogText = Get-Content -LiteralPath $taskLog -Raw
$taskImages = @()
foreach ($taskView in $taskViews) {
    $taskImage = Join-Path $PSScriptRoot "results/default-shadow-native-$Mode-$($taskView.name).png"
    if (-not (Test-Path -LiteralPath $taskImage)) { throw "Missing viewport image: $taskImage" }
    if ((Get-Item -LiteralPath $taskImage).LastWriteTime -lt $taskStarted) { throw "Stale viewport image: $taskImage" }
    if ($taskLogText -notmatch "$([regex]::Escape($taskImage)) size=1600x900 feature=$taskFeature ") {
        throw "Incorrect native feature level: $taskImage"
    }
    $taskImages += @{ file = $taskImage; sha256 = (Get-FileHash -LiteralPath $taskImage -Algorithm SHA256).Hash.ToLowerInvariant() }
}
@{ pass = $true; mode = $Mode; featureLevel = $taskFeature; input = $taskInput; log = $taskLog;
    images = $taskImages } | ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath (Join-Path $PSScriptRoot "results/default-shadow-native-$Mode-results.json") -Encoding utf8
Write-Output "Native $Mode viewport comparison complete."
