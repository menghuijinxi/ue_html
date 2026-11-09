param([string]$Engine = 'D:/UE_5.8')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskOutput = Join-Path $PSScriptRoot 'results/nanite-composition-shaders'
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskTint = $env:WEBGPU_TINT_DIR
$taskIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
$taskEngine = $env:UE_ENGINE_ROOT
function Get-TaskAudit([string]$File) { return @{file=[IO.Path]::GetFullPath($File);sha256=(Get-FileHash -LiteralPath $File).Hash.ToLowerInvariant()} }
try {
    New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
    $taskProcess.ProcessorAffinity = 3
    $env:UE_ENGINE_ROOT = Join-Path $Engine 'Engine'
    & node (Join-Path $PSScriptRoot 'prepare-web-cook-shaders.cjs') *> "$taskOutput/prepare.log"
    if ($LASTEXITCODE -ne 0) { throw 'Composition shader preparation failed' }
    & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development `
        "-Project=$taskProject" -Module=UEShaderHost -WaitMutex -NoHotReloadFromIDE -NoUBA -NoUbaLocal -MaxParallelActions=1 *> "$taskOutput/build.log"
    if ($LASTEXITCODE -ne 0) { throw 'Composition shader host build failed' }
    $env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
    $env:WEBGPU_INTERMEDIATE_DIR = Join-Path $taskOutput 'conversion'
    & (Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe') $taskProject `
        -run=WebShaderProbe -WebNaniteHierarchyProbe -WebShaderMetadataValidate -WebGPUCook "-Output=$taskOutput" `
        '-SupplementShaderTypes=FWebNaniteCompositionPS,FWebNaniteCompositionStencilPS,FWebNaniteCompositionSnapshotCS' `
        -nullrhi -unattended -nop4 -nosplash -nosound "-abslog=$taskOutput/compiler.log" *> "$taskOutput/console.log"
    if ($LASTEXITCODE -ne 0) { throw 'Composition shader compilation failed' }
    @{pass=$true; sources=@('tests/web-platform/compile-nanite-composition.ps1',
        'tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteMaterialProbe.cpp',
        'reference-engine/Engine/Source/Runtime/Renderer/Private/Nanite/NaniteWebComposition.cpp',
        'reference-engine/Engine/Shaders/Private/Nanite/WebNaniteComposition.usf') | ForEach-Object { Get-TaskAudit (Join-Path $taskRoot $_) };
        binary=Get-TaskAudit (Join-Path $taskRoot 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll');
        archive=Get-TaskAudit (Join-Path $taskOutput 'supplement-global-shaders.bin');
        logs=@('build.log','compiler.log') | ForEach-Object { Get-TaskAudit (Join-Path $taskOutput $_) }
    } | ConvertTo-Json -Depth 8 | Set-Content "$taskOutput/verified.json" -Encoding utf8
} finally {
    $taskProcess.ProcessorAffinity = $taskAffinity
    $env:WEBGPU_TINT_DIR = $taskTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskIntermediate
    $env:UE_ENGINE_ROOT = $taskEngine
}
