param([string]$Engine = 'D:/UE_5.8', [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskOutput = Join-Path $PSScriptRoot 'results/nanite-multimaterial'
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskTint = $env:WEBGPU_TINT_DIR
$taskIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
$taskEngineRoot = $env:UE_ENGINE_ROOT
function Get-TaskAudit([string]$File) {
    return @{file=[IO.Path]::GetFullPath($File);sha256=(Get-FileHash -LiteralPath $File).Hash.ToLowerInvariant()}
}
try {
    $taskProcess.ProcessorAffinity = 3
    $env:UE_ENGINE_ROOT = Join-Path $Engine 'Engine'
    if (-not $SkipBuild) { & (Join-Path $PSScriptRoot 'compile-nanite-hierarchy.ps1') -Engine $Engine }
    New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
    $env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
    $env:WEBGPU_INTERMEDIATE_DIR = Join-Path $taskOutput 'conversion'
    & (Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe') $taskProject `
        -run=WebShaderProbe -WebNaniteAssetProbe -WebNaniteMultiMaterial -WebNaniteCookRoundTrip -WebNaniteCookData -WebGPUCook `
        -TargetPlatform=Web -ddpi:Web:bIsEnabled=false "-Output=$taskOutput" -nullrhi -unattended -nop4 -nosplash -nosound `
        "-abslog=$taskOutput/compiler.log" *> "$taskOutput/console.log"
    if ($LASTEXITCODE -ne 0) { throw 'Multi-material Nanite build/Cook roundtrip failed' }
    & node (Join-Path $PSScriptRoot 'verify-web-nanite-asset.cjs') $taskOutput msedge
    if ($LASTEXITCODE -ne 0) { throw 'Multi-material WebGPU transcode/decode failed' }
    $taskAsset = Get-Content (Join-Path $taskOutput 'asset.json') -Raw | ConvertFrom-Json
    if (-not $taskAsset.multiMaterial -or $taskAsset.numRootPages -ne 1) { throw 'Expected a single real multi-material Nanite root page' }
    @{pass=$true; sources=@($PSCommandPath,
        (Join-Path $taskRoot 'tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteAssetProbe.cpp')) | ForEach-Object {Get-TaskAudit $_};
        binary=(Get-TaskAudit (Join-Path $taskRoot 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll'));
        products=@('asset.json','resources.cooked.bin','source-triangles.bin','source-materials.bin','browser-results.json','compiler.log') |
            ForEach-Object {Get-TaskAudit (Join-Path $taskOutput $_)}
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskOutput 'fixture.json') -Encoding utf8
} finally {
    $taskProcess.ProcessorAffinity = $taskAffinity
    $env:WEBGPU_TINT_DIR = $taskTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskIntermediate
    $env:UE_ENGINE_ROOT = $taskEngineRoot
}
