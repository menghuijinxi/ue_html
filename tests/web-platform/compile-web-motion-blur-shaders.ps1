param([string]$Engine = 'D:/UE_5.8')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskOutput = Join-Path $PSScriptRoot 'results/nanite-motion-blur-shaders'
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskTint = $env:WEBGPU_TINT_DIR
$taskIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
try {
    New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
    $taskProcess.ProcessorAffinity = 3
    & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development `
        "-Project=$taskProject" -Module=WebGPUShaderFormat -WaitMutex -NoHotReloadFromIDE -NoUBA -NoUbaLocal -MaxParallelActions=1 *> "$taskOutput/build.log"
    if ($LASTEXITCODE -ne 0) { throw 'Motion blur shader format build failed' }
    $env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
    $env:WEBGPU_INTERMEDIATE_DIR = Join-Path $taskOutput ('conversion-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    & (Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe') $taskProject `
        -run=WebShaderProbe -WebNaniteHierarchyProbe -SupplementShaderTypes=FMotionBlurVelocityFlattenCS `
        -WebShaderMetadataValidate -WebGPUCook "-Output=$taskOutput" -nullrhi -unattended -nop4 -nosplash -nosound `
        "-abslog=$taskOutput/compiler.log" *> "$taskOutput/console.log"
    if ($LASTEXITCODE -ne 0) { throw 'Motion blur shader compilation failed' }
    & node (Join-Path $PSScriptRoot 'verify-motion-blur-storage-formats.cjs') $env:WEBGPU_INTERMEDIATE_DIR
    if ($LASTEXITCODE -ne 0) { throw 'Motion blur browser pipeline validation failed' }
} finally {
    $taskProcess.ProcessorAffinity = $taskAffinity
    $env:WEBGPU_TINT_DIR = $taskTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskIntermediate
}
