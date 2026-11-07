param(
    [string]$Engine = 'H:/UE_5.8',
    [Parameter(Mandatory=$true)][string]$CookedAsset,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskHost = Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine'
$taskOutput = Join-Path $PSScriptRoot ('results/nanite-uploader/' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$taskAsset = (Resolve-Path -LiteralPath $CookedAsset).Path
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskPreviousEngine = $env:UE_ENGINE_ROOT
$taskPreviousTint = $env:WEBGPU_TINT_DIR
$taskPreviousIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
$taskBuildStamp = Join-Path $PSScriptRoot 'results/nanite-uploader-build.json'
function Get-TaskAudit([string]$File) {
    return @{file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
try {
    $taskProcess.ProcessorAffinity = 3
    $env:UE_ENGINE_ROOT = Join-Path $Engine 'Engine'
    & node (Join-Path $PSScriptRoot 'prepare-nanite-uploader-probe.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Uploader probe preparation failed' }
    $taskPlugin = Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader'
    $taskBuildInputs = @('WebGPUShader.uplugin', 'Source/WebGPURHI/WebGPURHI.Build.cs',
        'Source/WebGPURHI/Private/WebGPUNaniteUploaderProbe.cpp', 'Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp',
        'Source/WebGPURHI/Private/WebGPUDynamicRHI.h', 'Source/WebGPURHI/Private/WebGPURHIProbe.cpp',
        'Source/WebGPURHI/Private/WebGPUGlobalScope.cpp', 'Source/WebGPURHI/Private/WebGPUGlobalScope.h',
        'Intermediate/NaniteUploaderProbe/NaniteStreamingPageUploader.cpp',
        'Intermediate/NaniteUploaderProbe/NaniteStreamingPageUploader.h') | ForEach-Object { Get-TaskAudit (Join-Path $taskPlugin $_) }
    if (-not $SkipBuild) {
        & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development `
            "-Project=$taskProject" -Module=WebGPURHI -WaitMutex -NoHotReloadFromIDE -NoUBA -NoUbaLocal -MaxParallelActions=1 *> "$taskOutput/build.log"
        if ($LASTEXITCODE -ne 0) { throw 'Uploader module build failed' }
        foreach ($taskInput in $taskBuildInputs) {
            if ((Get-TaskAudit $taskInput.file).sha256 -ne $taskInput.sha256) { throw "Input changed during build: $($taskInput.file)" }
        }
        @{pass = $true; inputs = $taskBuildInputs;
            binary = Get-TaskAudit (Join-Path $taskPlugin 'Binaries/Win64/UnrealEditor-WebGPURHI.dll');
            log = Get-TaskAudit (Join-Path $taskOutput 'build.log')} |
            ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskBuildStamp -Encoding utf8
    }
    $taskBuilt = Get-Content -LiteralPath $taskBuildStamp -Raw | ConvertFrom-Json
    if (-not $taskBuilt.pass) { throw 'Uploader build stamp missing' }
    foreach ($taskInput in @($taskBuilt.inputs) + @($taskBuilt.binary, $taskBuilt.log)) {
        if ((Get-TaskAudit $taskInput.file).sha256 -ne $taskInput.sha256) { throw "Rebuild the uploader probe: $($taskInput.file)" }
    }
    Copy-Item -LiteralPath $taskBuildStamp -Destination (Join-Path $taskOutput 'build.json')
    $env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
    $env:WEBGPU_INTERMEDIATE_DIR = Join-Path $taskOutput 'conversion'
    & (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-Cmd.exe') $taskProject `
        -run=WebShaderProbe -WebRHIProbe -WebNaniteUploaderRHIProbe -WebShaderMetadataValidate -WebGPUCook `
        "-WebShaderDirectory=$taskAsset" "-WebMaterialShaderDirectory=$taskAsset" "-Output=$taskOutput" `
        -nullrhi -unattended -nop4 -nosplash -nosound "-abslog=$taskOutput/rhi.log" *> "$taskOutput/console.log"
    if ($LASTEXITCODE -ne 0) { throw "Nanite uploader execution failed: $taskOutput/rhi.log" }
    & node (Join-Path $PSScriptRoot 'verify-nanite-uploader.cjs') $taskOutput $taskAsset
    if ($LASTEXITCODE -ne 0) { throw 'Nanite uploader output verification failed' }
} finally {
    $taskProcess.ProcessorAffinity = $taskAffinity
    $env:UE_ENGINE_ROOT = $taskPreviousEngine
    $env:WEBGPU_TINT_DIR = $taskPreviousTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskPreviousIntermediate
    Write-Output "Nanite uploader results: $taskOutput"
}
