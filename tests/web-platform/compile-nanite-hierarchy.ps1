param([string]$Engine = 'D:/UE_5.8')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskOutput = Join-Path $PSScriptRoot 'results/nanite-hierarchy-shaders'
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskSavedTint = $env:WEBGPU_TINT_DIR
$taskSavedIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
$taskSavedEngine = $env:UE_ENGINE_ROOT
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
function Get-TaskAudit([string]$File) {
    return @{file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
try {
    $taskProcess.ProcessorAffinity = 3
    $env:UE_ENGINE_ROOT = Join-Path $Engine 'Engine'
    & node (Join-Path $PSScriptRoot 'prepare-web-cook-shaders.cjs') *> "$taskOutput/prepare.log"
    if ($LASTEXITCODE -ne 0) { throw 'Shader preparation failed' }
    $taskInputs = @(
        'reference-engine/Engine/Source/Runtime/Engine/Private/Nanite/NaniteWebHierarchy.cpp',
        'reference-engine/Engine/Shaders/Private/Nanite/WebNaniteHierarchy.usf',
        'reference-engine/Engine/Shaders/Private/Nanite/NaniteDataDecode.ush',
        'reference-engine/Engine/Shaders/Shared/NaniteDefinitions.h',
        'tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteHierarchyProbe.cpp',
        'tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp',
        'tests/ue-shader-host/Source/UEShaderHost/UEShaderHost.Build.cs',
        'tests/ue-shader-host/UEShaderHost.uproject',
        'tests/web-platform/compile-nanite-hierarchy.ps1',
        'tests/web-platform/prepare-web-cook-shaders.cjs'
    ) | ForEach-Object { Get-TaskAudit (Join-Path $taskRoot $_) }
    & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development `
        "-Project=$taskProject" -Module=UEShaderHost -WaitMutex -NoHotReloadFromIDE -NoUBA -NoUbaLocal -MaxParallelActions=1 *> "$taskOutput/build.log"
    if ($LASTEXITCODE -ne 0) { throw 'Hierarchy shader host build failed' }
    $env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
    $env:WEBGPU_INTERMEDIATE_DIR = Join-Path $taskOutput 'conversion'
    & (Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe') $taskProject `
        -run=WebShaderProbe -WebNaniteHierarchyProbe -WebShaderMetadataValidate -WebGPUCook "-Output=$taskOutput" `
        -nullrhi -unattended -nop4 -nosplash -nosound "-abslog=$taskOutput/compiler.log" *> "$taskOutput/console.log"
    if ($LASTEXITCODE -ne 0) { throw 'Hierarchy shader compilation failed' }
    foreach ($taskInput in $taskInputs) {
        if ((Get-TaskAudit $taskInput.file).sha256 -ne $taskInput.sha256) { throw "Input changed: $($taskInput.file)" }
    }
    @{pass = $true; sources = $taskInputs;
        archive = Get-TaskAudit (Join-Path $taskOutput 'hierarchy-global-shaders.bin');
        binary = Get-TaskAudit (Join-Path $taskRoot 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll');
        logs = @('build.log', 'compiler.log') | ForEach-Object { Get-TaskAudit (Join-Path $taskOutput $_) };
        shaderInputs = Get-ChildItem -LiteralPath (Join-Path $taskRoot '.tools/ue58-web-cook-shaders') -Recurse -File | ForEach-Object { Get-TaskAudit $_.FullName };
        compiler = @('tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPUShaderFormat.dll',
            '.tools/dawn-v20261009.190412/bin/tint.exe', '.tools/dawn-v20261009.190412/bin/tint_info.exe') |
            ForEach-Object { Get-TaskAudit (Join-Path $taskRoot $_) }
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskOutput 'verified.json') -Encoding utf8
} finally {
    $taskProcess.ProcessorAffinity = $taskAffinity
    $env:WEBGPU_TINT_DIR = $taskSavedTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskSavedIntermediate
    $env:UE_ENGINE_ROOT = $taskSavedEngine
    Write-Output "Hierarchy shader results: $taskOutput"
}
