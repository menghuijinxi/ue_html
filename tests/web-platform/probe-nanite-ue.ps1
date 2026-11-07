param(
    [string]$Engine = 'H:/UE_5.8',
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskEditor = Join-Path $taskRoot '.tools/ue58-web-cook-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe'
$taskOutput = Join-Path $PSScriptRoot 'results/nanite-ue-shader'
$taskRHIOutput = Join-Path $PSScriptRoot 'results/nanite-ue-rhi'
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskPreviousTint = $env:WEBGPU_TINT_DIR
$taskPreviousIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
try {
    # Match the stable host probe configuration on this workstation.
    $taskProcess.ProcessorAffinity = 3
    if (-not $SkipBuild) {
        & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development `
            "-Project=$taskProject" -Module=WebGPUShaderFormat -Module=WebGPURHI -Module=UEShaderHost `
            -WaitMutex -NoHotReloadFromIDE -NoUBA -NoUbaLocal -MaxParallelActions=1
        if ($LASTEXITCODE -ne 0) { throw 'Nanite shader host build failed.' }
        & node (Join-Path $PSScriptRoot 'build-worker-module.cjs')
        if ($LASTEXITCODE -ne 0) { throw 'Nanite ShaderCompileWorker module build failed.' }
    }
    & node (Join-Path $PSScriptRoot 'prepare-web-cook-shaders.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Shader overlay preparation failed.' }
    $env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
    $env:WEBGPU_INTERMEDIATE_DIR = Join-Path $taskOutput 'conversion'
    & $taskEditor $taskProject -run=WebShaderProbe -WebNaniteVisibilityProbe "-Output=$taskOutput" `
        -nullrhi -unattended -nop4 -nosplash -nosound "-abslog=$taskOutput/compiler.log"
    if ($LASTEXITCODE -ne 0) { throw 'Real UE Nanite visibility shader compilation failed.' }
    & $taskEditor $taskProject -run=WebShaderProbe -WebRHIProbe -WebNaniteVisibilityRHIProbe `
        -WebShaderMetadataValidate "-WebShaderDirectory=$taskOutput" "-WebMaterialShaderDirectory=$taskOutput" `
        "-Output=$taskRHIOutput" -nullrhi -unattended -nop4 -nosplash -nosound "-abslog=$taskRHIOutput/rhi.log"
    if ($LASTEXITCODE -ne 0) { throw 'UE RHI Nanite visibility verification failed.' }
    & node (Join-Path $PSScriptRoot 'verify-web-nanite-visibility.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Chrome/Edge Nanite visibility verification failed.' }
} finally {
    $taskProcess.ProcessorAffinity = $taskAffinity
    $env:WEBGPU_TINT_DIR = $taskPreviousTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskPreviousIntermediate
}
