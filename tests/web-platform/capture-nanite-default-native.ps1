param([string]$Engine = 'D:/UE_5.8')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskSourceHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
$taskDirectory = Join-Path $PSScriptRoot 'results/nanite-automatic-scene'
@{pass = $false; status = 'capture-in-progress'; started = (Get-Date).ToString('o')} |
    ConvertTo-Json | Set-Content (Join-Path $taskDirectory 'native-results.json') -Encoding utf8
$taskBrowser = Get-Content (Join-Path $taskDirectory 'packed.json') -Raw | ConvertFrom-Json
if (-not $taskBrowser.pass) { throw 'Automatic browser scene acceptance must pass first.' }
$taskCamera = $taskBrowser.samples.camera
$taskRenderView = $taskBrowser.tests[0].view
if (-not $taskRenderView -or $taskRenderView.projectionX -le 0) { throw 'Actual browser render projection is required.' }
$taskInput = Join-Path $taskDirectory 'native-input.json'
$taskPrefix = Join-Path $taskDirectory 'native'
$taskViews = @(1, 0 | ForEach-Object {
    @{name = $(if ($_ -eq 1) { 'nanite' } else { 'fallback' }); x = $taskCamera.x; y = $taskCamera.y;
      z = $taskCamera.z; pitch = $taskCamera.pitch; yaw = $taskCamera.yaw; fov = $taskRenderView.horizontalFOV;
      dense = $true; nanite = [bool]$_}
})
@{width = 1280; height = 720; output = $taskPrefix; samples = $taskBrowser.samples.samples; views = $taskViews} |
    ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskInput -Encoding utf8
$taskLog = Join-Path $taskDirectory 'native.log'
$taskHost = Join-Path $taskRoot '.tools/ue58-web-cook-host/Engine/Binaries/Win64/UnrealEditor.exe'
if (-not (Test-Path $taskHost)) { throw 'Prepare the isolated Cook host first; installed shaders must stay unchanged.' }
$taskArguments = @(
    "$taskRoot/tests/ue-shader-host/UEShaderHost.uproject", '/Engine/Maps/Templates/Template_Default',
    "-WebNativeComparison=$taskInput", '-WebNativeNaniteComparison', "-abslog=$taskLog",
    '-d3d12', '-sm6', '-RenderOffscreen', '-NoSplash', '-NoSound', '-NoLoadingScreen', '-unattended', '-nop4',
    '-windowed', '-ResX=1280', '-ResY=720', '-ForceRes', '-NoThrottleCPU', '-corelimit=2',
    '-ini:EditorPerProjectUserSettings:[/Script/UnrealEd.EditorPerformanceSettings]:bThrottleCPUWhenNotForeground=False'
)
$taskProfile = Join-Path $PSScriptRoot 'cook-profiles/DefaultTemplateDesktopEngine.ini'
$taskArguments += @(Get-Content $taskProfile | Where-Object { $_ -match '^(r\.|landscape\.)[a-zA-Z0-9.]*=' } |
    ForEach-Object { "-ini:Engine:[SystemSettings]:$_" })
$taskStart = Get-Date
$taskParent = Get-Process -Id $PID
$taskSavedAffinity = $taskParent.ProcessorAffinity
try {
    $taskParent.ProcessorAffinity = [IntPtr]3
    $taskChild = Start-Process -FilePath $taskHost -ArgumentList ($taskArguments | ForEach-Object { '"' + $_ + '"' }) `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput "$taskLog.console.txt" -RedirectStandardError "$taskLog.stderr.txt"
} finally { $taskParent.ProcessorAffinity = $taskSavedAffinity }
while (-not $taskChild.WaitForExit(250)) {
    if ((Get-Date) - $taskStart -gt [TimeSpan]::FromMinutes(15)) { Stop-Process -Id $taskChild.Id; throw 'Native capture timed out.' }
}
if ($taskChild.ExitCode -ne 0) { throw "Native Nanite capture failed: $taskLog" }
if ((Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash -ne $taskSourceHash) { throw 'Capture script changed during execution.' }
function Get-TaskAudit([string]$File) {
    @{file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$taskCaptures = @()
foreach ($taskView in $taskViews) {
    $taskPNG = "$taskPrefix-$($taskView.name).png"
    $taskMetadata = Get-Content "$taskPNG.json" -Raw | ConvertFrom-Json
    if ((Get-Item $taskPNG).LastWriteTime -lt $taskStart -or $taskMetadata.width -ne 1280 -or
        $taskMetadata.height -ne 720 -or $taskMetadata.featureLevel -ne 4 -or $taskMetadata.samples -ne 8 -or
        $taskMetadata.naniteSamples -ne $(if ($taskView.nanite) { 8 } else { 0 }) -or
        [Math]::Abs($taskMetadata.projectionX - $taskRenderView.projectionX) -gt 0.00001 -or
        [Math]::Abs($taskMetadata.projectionY - $taskRenderView.projectionY) -gt 0.00001) {
        throw "Native capture did not exercise the requested real Nanite/fallback path: $taskPNG"
    }
    $taskCaptures += @{image = Get-TaskAudit $taskPNG; metadata = Get-TaskAudit "$taskPNG.json"; values = $taskMetadata}
}
@{pass = $true; arguments = $taskArguments; input = Get-TaskAudit $taskInput; log = Get-TaskAudit $taskLog; source = Get-TaskAudit $PSCommandPath;
  profile = Get-TaskAudit $taskProfile; host = Get-TaskAudit $taskHost;
  producer = Get-TaskAudit "$taskRoot/tests/ue-shader-host/Source/UEShaderHost/Private/WebNativeComparison.cpp";
  binary = Get-TaskAudit "$taskRoot/tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll";
  captures = $taskCaptures} | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $taskDirectory 'native-results.json') -Encoding utf8
Write-Output 'Native SM6 Nanite and fallback viewport captures verified.'
