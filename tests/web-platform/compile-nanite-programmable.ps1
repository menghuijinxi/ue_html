param([string]$Engine = 'D:/UE_5.8', [string]$FixtureDirectory = '', [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskOutput = Join-Path $PSScriptRoot 'results/nanite-programmable'
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskTint = $env:WEBGPU_TINT_DIR
$taskIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
$taskEngine = $env:UE_ENGINE_ROOT
function Get-TaskAudit([string]$File) {
    return @{file=[IO.Path]::GetFullPath($File);sha256=(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
try {
    New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
    $taskProcess.ProcessorAffinity = 3
    $env:UE_ENGINE_ROOT = Join-Path $Engine 'Engine'
    & node (Join-Path $PSScriptRoot 'prepare-web-cook-shaders.cjs') *> "$taskOutput/prepare.log"
    if ($LASTEXITCODE -ne 0) { throw 'Nanite material shader preparation failed' }
    if (-not $SkipBuild) {
    & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development `
        "-Project=$taskProject" -Module=UEShaderHost -WaitMutex -NoHotReloadFromIDE -NoUBA -NoUbaLocal -MaxParallelActions=1 *> "$taskOutput/build.log"
    if ($LASTEXITCODE -ne 0) { throw 'Nanite material shader host build failed' }
    }
    $env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
    $env:WEBGPU_INTERMEDIATE_DIR = Join-Path $taskOutput 'conversion'
    $taskExtra = @()
    if ($FixtureDirectory) { $taskExtra += "-FixtureDirectory=$([IO.Path]::GetFullPath($FixtureDirectory))" }
    & (Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe') $taskProject `
        -run=WebShaderProbe -WebNaniteProgrammableProbe -WebShaderMetadataValidate -WebGPUCook "-Output=$taskOutput" `
        -nullrhi -unattended -nop4 -nosplash -nosound "-abslog=$taskOutput/compiler.log" @taskExtra *> "$taskOutput/console.log"
    if ($LASTEXITCODE -ne 0) { throw 'Nanite material graph compilation failed' }
    $taskReport = Get-Content -LiteralPath "$taskOutput/verified.json" -Raw | ConvertFrom-Json
    if (-not $taskReport.pass) { throw 'Programmable permutations did not all compile' }
    $taskSources = @('tests/web-platform/compile-nanite-programmable.ps1',
        'tests/web-platform/prepare-web-cook-shaders.cjs',
        'tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteProgrammableProbe.cpp',
        'tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp',
        'reference-engine/Engine/Source/Runtime/Renderer/Private/Nanite/NaniteWebProgrammableRaster.cpp',
        'reference-engine/Engine/Shaders/Private/Nanite/WebNaniteProgrammableRaster.usf') | ForEach-Object { Get-TaskAudit (Join-Path $taskRoot $_) }
    $taskReport | Add-Member sources $taskSources
    $taskReport | Add-Member binary (Get-TaskAudit (Join-Path $taskRoot 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll'))
    $taskReport | Add-Member logs (@('compiler.log','console.log') | ForEach-Object { Get-TaskAudit (Join-Path $taskOutput $_) })
    $taskReport | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath "$taskOutput/verified.json" -Encoding utf8
} finally {
    $taskProcess.ProcessorAffinity = $taskAffinity
    $env:WEBGPU_TINT_DIR = $taskTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskIntermediate
    $env:UE_ENGINE_ROOT = $taskEngine
}
