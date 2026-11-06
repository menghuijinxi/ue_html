param(
    [string]$Engine = 'H:/UE_5.8',
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskEditor = Join-Path $taskRoot '.tools/ue58-web-cook-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe'
$taskOutput = Join-Path $PSScriptRoot 'results/nanite-asset'
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskPreviousTint = $env:WEBGPU_TINT_DIR
$taskPreviousIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
try {
    # Use the same workstation stability setting for UE, Tint and both browsers.
    $taskProcess.ProcessorAffinity = 3
    if (-not $SkipBuild) {
        & (Join-Path $PSScriptRoot 'build-tint-nanite.ps1')
        & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development `
            "-Project=$taskProject" -Module=WebGPUShaderFormat -Module=UEShaderHost `
            -WaitMutex -NoHotReloadFromIDE -NoUBA -NoUbaLocal -MaxParallelActions=1
        if ($LASTEXITCODE -ne 0) { throw 'Nanite asset host build failed' }
        & node (Join-Path $PSScriptRoot 'build-worker-module.cjs')
        if ($LASTEXITCODE -ne 0) { throw 'ShaderCompileWorker module build failed' }
    }
    & node (Join-Path $PSScriptRoot 'verify-tint-nanite.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Nanite converter policy verification failed' }
    & node (Join-Path $PSScriptRoot 'prepare-web-cook-shaders.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Shader overlay preparation failed' }
    $env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
    $env:WEBGPU_INTERMEDIATE_DIR = Join-Path $taskOutput 'conversion'
    & $taskEditor $taskProject -run=WebShaderProbe -WebNaniteAssetProbe "-Output=$taskOutput" `
        -nullrhi -unattended -nop4 -nosplash -nosound "-abslog=$taskOutput/compiler.log"
    if ($LASTEXITCODE -ne 0) { throw 'Nanite asset export or shader compile failed' }
    & node (Join-Path $PSScriptRoot 'verify-web-nanite-asset.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Browser Nanite asset verification failed' }
} finally {
    $taskProcess.ProcessorAffinity = $taskAffinity
    $env:WEBGPU_TINT_DIR = $taskPreviousTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskPreviousIntermediate
}
