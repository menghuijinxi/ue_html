$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskDirectory = Join-Path $PSScriptRoot 'results/nanite-native-material-diagnostic'
New-Item -ItemType Directory -Path $taskDirectory -Force | Out-Null
$taskBrowserDirectory = Join-Path $PSScriptRoot 'results/nanite-full-scene-native'
$taskBrowser = Get-Content (Join-Path $taskBrowserDirectory 'packed.json') -Raw | ConvertFrom-Json
$taskBrowserSettingsFile = Join-Path $taskBrowserDirectory 'browser-settings.json'
$taskBrowserSettings = Get-Content -LiteralPath $taskBrowserSettingsFile -Raw | ConvertFrom-Json
if (-not $taskBrowserSettings.pass -or $taskBrowserSettings.package.sha256 -ne $taskBrowser.package.sha256) { throw 'Current browser render settings are required.' }
if (-not $taskBrowser.pass -or $taskBrowser.views.Count -ne 3) { throw 'Three browser views must pass first.' }
$taskSourceHash = (Get-FileHash -LiteralPath $PSCommandPath).Hash
$taskInput = Join-Path $taskDirectory 'native-input.json'
$taskPrefix = Join-Path $taskDirectory 'native'
$taskBuildFile = Join-Path $PSScriptRoot 'results/nanite-native-capture-build.json'
$taskBuild = Get-Content -LiteralPath $taskBuildFile -Raw | ConvertFrom-Json
if (-not $taskBuild.pass) { throw 'Build the isolated native capture module first.' }
$taskPreparation = Get-Content -LiteralPath $taskBuild.preparation.file -Raw | ConvertFrom-Json
$taskConversionFile = Join-Path $PSScriptRoot 'results/nanite-full-scene-conversion-verified.json'
$taskConversion = Get-Content -LiteralPath $taskConversionFile -Raw | ConvertFrom-Json
if (-not $taskConversion.pass) { throw 'Verified converted scene required.' }
foreach ($taskItem in @($taskBuild.source, $taskBuild.preparation, $taskBuild.log, $taskBuild.binary, $taskBuild.manifest, $taskBuild.engineManifest) +
    @($taskPreparation.sources) + @($taskPreparation.generated) + @($taskPreparation.configs)) {
    if ((Get-FileHash -LiteralPath $taskItem.file).Hash.ToLowerInvariant() -ne $taskItem.sha256) { throw "Stale native capture input: $($taskItem.file)" }
}
$taskProject = $taskPreparation.project
$taskMap = '/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla'
$taskViews = @()
foreach ($taskView in @($taskBrowser.views[1])) {
    $taskCamera = $taskView.camera
    $taskProjection = $taskView.tests[0].view
    if ($taskProjection.projectionX -le 0 -or $taskProjection.projectionY -le 0) { throw 'Actual browser projection required.' }
    foreach ($taskEnabled in @(1)) {
        $taskStep = 1 + ($taskViews.Count % 3)
        $taskViews += @{name = "$($taskView.index)-$taskStep"; x = $taskCamera[0]; y = $taskCamera[1]; z = $taskCamera[2];
            pitch = $taskCamera[3]; yaw = $taskCamera[4]; fov = $taskProjection.horizontalFOV; nanite = [bool]$taskEnabled}
    }
}
@{width = 1280; height = 720; output = $taskPrefix; map = $taskMap; views = $taskViews} |
    ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskInput -Encoding utf8
$taskLog = Join-Path $taskDirectory 'native.log'
$taskHost = Join-Path $taskRoot '.tools/ue58-web-cook-host/Engine/Binaries/Win64/UnrealEditor.exe'
$taskHostManifest = Join-Path (Split-Path -Parent $taskHost) 'UnrealEditor.modules'
$taskModules = Get-Content -LiteralPath $taskBuild.manifest.file -Raw | ConvertFrom-Json
$taskHostModules = Get-Content -LiteralPath $taskHostManifest -Raw | ConvertFrom-Json
if ($taskModules.BuildId -ne $taskHostModules.BuildId) { throw 'Capture module and host build IDs differ.' }
$taskArguments = @($taskProject, $taskMap, "-WebNativeComparison=$taskInput", '-WebNativeNaniteComparison', "-abslog=$taskLog",
    '-d3d12', '-sm6', '-RenderOffscreen', '-NoSplash', '-NoSound', '-NoLoadingScreen', '-unattended', '-nop4',
    '-windowed', '-ResX=1280', '-ResY=720', '-ForceRes', '-NoThrottleCPU', '-corelimit=2',
    '-ini:Engine:[SystemSettings]:r.ScreenPercentage=100', '-ini:Engine:[SystemSettings]:r.DynamicRes.OperationMode=0',
    '-ini:Engine:[SystemSettings]:r.TemporalAA.Debug.OverrideTemporalIndex=0',
    '-ini:Engine:[SystemSettings]:r.Test.FreezeTemporalSequences=1',
    '-ini:Engine:[SystemSettings]:Slate.bAllowThrottling=0',
    "-ini:Engine:[SystemSettings]:r.AntiAliasingMethod=$($taskBrowserSettings.settings.lighting.antiAliasing)",
    '-ini:EditorPerProjectUserSettings:[/Script/UnrealEd.EditorPerformanceSettings]:bThrottleCPUWhenNotForeground=False',
    '-ini:EditorPerProjectUserSettings:[/Script/UnrealEd.EditorLoadingSavingSettings]:bAutoSaveEnable=False')
@{pass = $false; status = 'capture-in-progress'; started = (Get-Date).ToString('o')} |
    ConvertTo-Json | Set-Content (Join-Path $taskDirectory 'native-results.json') -Encoding utf8
$taskStart = Get-Date
$taskParent = Get-Process -Id $PID
$taskSavedAffinity = $taskParent.ProcessorAffinity
try {
    $taskParent.ProcessorAffinity = [IntPtr]3
    $taskChild = Start-Process -FilePath $taskHost -ArgumentList ($taskArguments | ForEach-Object { '"' + $_ + '"' }) `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput "$taskLog.console.txt" -RedirectStandardError "$taskLog.stderr.txt"
} finally { $taskParent.ProcessorAffinity = $taskSavedAffinity }
while (-not $taskChild.WaitForExit(250)) {
    if ((Get-Date) - $taskStart -gt [TimeSpan]::FromMinutes(20)) { Stop-Process -Id $taskChild.Id; throw 'Native full-scene capture timed out.' }
}
if ($taskChild.ExitCode -ne 0) { throw "Native full-scene capture failed: $taskLog" }
if ((Get-FileHash -LiteralPath $PSCommandPath).Hash -ne $taskSourceHash) { throw 'Capture script changed during execution.' }
foreach ($taskItem in @($taskConversion.originalFiles) + @($taskConversion.convertedFiles)) {
    if ((Get-FileHash -LiteralPath $taskItem.file).Hash.ToLowerInvariant() -ne $taskItem.sha256) { throw "Scene changed during capture: $($taskItem.file)" }
}
function Get-TaskAudit([string]$File) {
    @{file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File).Hash.ToLowerInvariant()}
}
$taskCaptures = @()
foreach ($taskView in $taskViews) {
    $taskPNG = "$taskPrefix-$($taskView.name).png"
    $taskMetadata = Get-Content "$taskPNG.json" -Raw | ConvertFrom-Json
    $taskIndex = [int]$taskView.name.Split('-')[0]
    $taskBrowserView = $taskBrowser.views[$taskIndex].tests[0]
    if ((Get-Item $taskPNG).LastWriteTime -lt $taskStart -or $taskMetadata.width -ne 1280 -or
        $taskMetadata.height -ne 720 -or $taskMetadata.featureLevel -ne 4 -or
        -not $taskMetadata.temporalSequencesFrozen -or $taskMetadata.stability[-1].stableSamples -lt 3 -or
        $taskMetadata.stability[-1].warmupFrames -lt 600 -or
        $taskMetadata.naniteAssetComponents -ne $taskBrowserView.assets.Count -or
        [Math]::Abs($taskMetadata.projectionX - $taskBrowserView.view.projectionX) -gt 0.00001 -or
        [Math]::Abs($taskMetadata.projectionY - $taskBrowserView.view.projectionY) -gt 0.00001) {
        throw "Native full-scene metadata does not match the browser: $taskPNG"
    }
    if (($taskView.nanite -and $taskMetadata.naniteSceneProxies -lt $taskBrowserView.registered) -or
        (-not $taskView.nanite -and $taskMetadata.naniteSceneProxies -ne 0)) {
        throw "Native Nanite/fallback proxies were not exercised: $taskPNG"
    }
    $taskPhases = @()
    foreach ($taskPhase in 0..3) {
        $taskChecks = @($taskMetadata.stability | Where-Object { $_.phase -eq $taskPhase })
        if ($taskChecks.Count -lt 4 -or $taskChecks[-1].stableSamples -lt 3) { throw 'Native AO phase is not stable.' }
        if ($taskChecks[-1].antiAliasingMethod -ne $taskBrowserSettings.settings.lighting.antiAliasing -or
            [Math]::Abs($taskChecks[-1].jitterX - $taskBrowserView.view.jitterX) -gt 0.0000001 -or
            [Math]::Abs($taskChecks[-1].jitterY - $taskBrowserView.view.jitterY) -gt 0.0000001) {
            throw 'The actual native anti-aliasing method and projection jitter must match the browser.'
        }
        $taskPhaseImage = @($taskMetadata.phaseImages | Where-Object { $_.phase -eq $taskPhase })
        if ($taskPhaseImage.Count -ne 1) { throw 'Every native AO phase must have one capture.' }
        $taskPhases += @{phase = $taskPhase; image = Get-TaskAudit $taskPhaseImage[0].file}
    }
    $taskCaptures += @{image = Get-TaskAudit $taskPNG; metadata = Get-TaskAudit "$taskPNG.json"; values = $taskMetadata; phases = $taskPhases}
}
@{pass = $true; arguments = $taskArguments; input = Get-TaskAudit $taskInput; log = Get-TaskAudit $taskLog;
    source = Get-TaskAudit $PSCommandPath; host = Get-TaskAudit $taskHost; browser = Get-TaskAudit (Join-Path $taskBrowserDirectory 'packed.json');
    browserSettings = Get-TaskAudit $taskBrowserSettingsFile;
    project = Get-TaskAudit $taskProject; conversion = Get-TaskAudit $taskConversionFile;
    producer = Get-TaskAudit "$taskRoot/tests/ue-shader-host/Source/UEShaderHost/Private/WebNativeComparison.cpp";
    binary = Get-TaskAudit $taskBuild.binary.file; build = Get-TaskAudit $taskBuildFile; hostManifest = Get-TaskAudit $taskHostManifest;
    captures = $taskCaptures; boundary = 'Diagnostic only: capture actual material mip bias and Nanite material overrides.'} |
    ConvertTo-Json -Depth 12 | Set-Content (Join-Path $taskDirectory 'native-results.json') -Encoding utf8
Write-Output 'Native SM6 full-scene Nanite and fallback captures verified.'
