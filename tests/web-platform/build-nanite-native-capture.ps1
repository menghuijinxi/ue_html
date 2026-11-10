param([string]$Engine = 'D:/UE_5.8')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
& node (Join-Path $PSScriptRoot 'prepare-nanite-native-capture.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Native capture preparation failed.' }
$taskPreparationFile = Join-Path $PSScriptRoot 'results/nanite-native-capture-prepare.json'
$taskPreparation = Get-Content -LiteralPath $taskPreparationFile -Raw | ConvertFrom-Json
$taskLog = Join-Path $PSScriptRoot 'results/nanite-native-capture-build.log'
function Get-TaskAudit([string]$File) {
    @{file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File).Hash.ToLowerInvariant()}
}
$taskProcess = Get-Process -Id $PID
$taskSavedAffinity = $taskProcess.ProcessorAffinity
try {
    $taskProcess.ProcessorAffinity = 3
    & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') NativeNaniteCaptureEditor Win64 Development `
        "-Project=$($taskPreparation.project)" -WaitMutex -NoHotReloadFromIDE -NoUBA -NoUbaLocal -MaxParallelActions=1 *> $taskLog
    if ($LASTEXITCODE -ne 0) { throw "Native capture build failed: $taskLog" }
} finally { $taskProcess.ProcessorAffinity = $taskSavedAffinity }
foreach ($taskItem in @($taskPreparation.sources) + @($taskPreparation.generated) + @($taskPreparation.configs)) {
    if ((Get-TaskAudit $taskItem.file).sha256 -ne $taskItem.sha256) { throw "Native capture input changed: $($taskItem.file)" }
}
$taskBinary = Join-Path (Split-Path -Parent $taskPreparation.project) 'Binaries/Win64/UnrealEditor-NativeNaniteCapture.dll'
$taskManifest = Join-Path (Split-Path -Parent $taskBinary) 'UnrealEditor.modules'
$taskModules = Get-Content -LiteralPath $taskManifest -Raw | ConvertFrom-Json
$taskEngineManifest = Join-Path $Engine 'Engine/Binaries/Win64/UnrealEditor.modules'
$taskEngineModules = Get-Content -LiteralPath $taskEngineManifest -Raw | ConvertFrom-Json
if ($taskModules.BuildId -ne $taskEngineModules.BuildId -or
    $taskModules.Modules.NativeNaniteCapture -ne [IO.Path]::GetFileName($taskBinary)) {
    throw 'Native capture module manifest does not match the installed engine and binary.'
}
@{pass = $true; source = Get-TaskAudit $PSCommandPath; preparation = Get-TaskAudit $taskPreparationFile;
    log = Get-TaskAudit $taskLog; binary = Get-TaskAudit $taskBinary;
    manifest = Get-TaskAudit $taskManifest; engineManifest = Get-TaskAudit $taskEngineManifest} | ConvertTo-Json -Depth 8 |
    Set-Content (Join-Path $PSScriptRoot 'results/nanite-native-capture-build.json') -Encoding utf8
