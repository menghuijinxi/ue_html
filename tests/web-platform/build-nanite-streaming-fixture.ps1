param([string]$Engine = 'D:/UE_5.8', [string]$FixtureDirectory = 'G:/UE_HTML/ue_html/tests/web-platform/build/projects/lumen-off-v59/Content/WebNaniteStreaming')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskOutput = Join-Path $PSScriptRoot 'results/nanite-streaming'
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskTint = $env:WEBGPU_TINT_DIR
$taskIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
$taskEngine = $env:UE_ENGINE_ROOT
try {
    New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
    $taskProcess.ProcessorAffinity = 3
    $env:UE_ENGINE_ROOT = Join-Path $Engine 'Engine'
    & node (Join-Path $PSScriptRoot 'prepare-web-cook-shaders.cjs') *> "$taskOutput/prepare.log"
    if ($LASTEXITCODE -ne 0) { throw 'Nanite streaming fixture preparation failed' }
    & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development `
        "-Project=$taskProject" -Module=UEShaderHost -WaitMutex -NoHotReloadFromIDE -NoUBA -NoUbaLocal -MaxParallelActions=1 *> "$taskOutput/build.log"
    if ($LASTEXITCODE -ne 0) { throw 'Nanite streaming fixture host build failed' }
    $env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
    $env:WEBGPU_INTERMEDIATE_DIR = Join-Path $taskOutput 'conversion'
    $taskExtra = @()
    if ($FixtureDirectory) { $taskExtra += "-FixtureDirectory=$([IO.Path]::GetFullPath($FixtureDirectory))" }
    & (Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe') $taskProject `
        -run=WebShaderProbe -WebNaniteStreamingProbe -WebShaderMetadataValidate -WebGPUCook "-Output=$taskOutput" `
        -nullrhi -unattended -nop4 -nosplash -nosound "-abslog=$taskOutput/compiler.log" @taskExtra *> "$taskOutput/console.log"
    if ($LASTEXITCODE -ne 0) { throw 'Nanite streaming fixture generation failed' }
} finally {
    $taskProcess.ProcessorAffinity = $taskAffinity
    $env:WEBGPU_TINT_DIR = $taskTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskIntermediate
    $env:UE_ENGINE_ROOT = $taskEngine
}
