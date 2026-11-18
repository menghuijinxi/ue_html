param([string]$Engine = 'D:/UE_5.8')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskOutput = Join-Path $PSScriptRoot 'results/nanite-runtime-shader-supplement'
$taskHost = Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine'
$taskTypes = @('TPageTableUpdateVS<false>', 'TPageTableUpdateVS<true>',
    'TPageTableUpdatePS<PF_R16_UINT>', 'TPageTableUpdatePS<PF_R16G16_UINT>', 'TPageTableUpdatePS<PF_R16G16B16A16_UINT>',
    'TPageTableUpdatePS<PF_R32_UINT>', 'TPageTableUpdatePS<PF_R32G32_UINT>', 'TPageTableUpdatePS<PF_R32G32B32A32_UINT>')
$taskTypes += @('BaseColor', 'BaseColor_Normal_Specular', 'BaseColor_Normal_Roughness',
    'BaseColor_Normal_Specular_YCoCg', 'BaseColor_Normal_Specular_Mask_YCoCg', 'Mask4', 'Displacement') |
    ForEach-Object { "FShader_VirtualTextureCompress_CS< ERuntimeVirtualTextureMaterialType::$_ >" }
$taskTypes += 'FShader_VirtualTextureCopy_VS'
$taskTypes += @('BaseColor', 'BaseColor_Normal_Specular', 'BaseColor_Normal_Specular_YCoCg',
    'BaseColor_Normal_Specular_Mask_YCoCg', 'Mask4', 'WorldHeight') |
    ForEach-Object { "FShader_VirtualTextureCopy_PS< ERuntimeVirtualTextureMaterialType::$_ >" }
$taskTypes += @('FTranslucentLightingInjectBatchCS', 'FClearTranslucentLightingVolumeCS', 'FWebSimpleLightTranslucentLightingInjectCS')
$taskTypes += @('FBuildFeedbackHashTableIndirectArgsCS', 'FBuildFeedbackHashTableCS', 'FCompactFeedbackHashTableCS')
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskTint = $env:WEBGPU_TINT_DIR
$taskIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
function Get-TaskAudit([string]$File) {
    return @{file=[IO.Path]::GetFullPath($File);sha256=(Get-FileHash -LiteralPath $File).Hash.ToLowerInvariant()}
}
try {
    New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
    $taskProcess.ProcessorAffinity = 3
    # Shader parameter structs must come from the same Renderer sources as the
    # Web runtime. Refresh only this isolated host dependency, breaking its old
    # hardlink before copying; never overwrite an installed or shared DLL.
    $taskRendererReportFile = Join-Path $PSScriptRoot 'results/native-renderer-build-results.json'
    $taskRenderer = Get-Content -LiteralPath $taskRendererReportFile -Raw | ConvertFrom-Json
    if (-not $taskRenderer.pass -or -not $taskRenderer.installedInputsUnmodified) { throw 'Rebuild the native Renderer host first' }
    $taskInstalledRenderer = [IO.Path]::GetFullPath((Join-Path $Engine 'Engine/Binaries/Win64/UnrealEditor-Renderer.dll'))
    if (-not ($taskRenderer.installedInputs | Where-Object { [IO.Path]::GetFullPath($_.file) -eq $taskInstalledRenderer })) { throw 'Native Renderer report belongs to a different engine installation' }
    foreach ($taskInput in @($taskRenderer.sourceFiles) + @($taskRenderer.products) + @($taskRenderer.installedInputs)) {
        if ((Get-TaskAudit $taskInput.file).sha256 -ne $taskInput.sha256) { throw "Stale native Renderer input: $($taskInput.file)" }
    }
    $taskRendererDLL = $taskRenderer.products | Where-Object { [IO.Path]::GetFileName($_.file) -eq 'UnrealEditor-Renderer.dll' }
    $taskDestination = Join-Path $taskHost 'Binaries/Win64/UnrealEditor-Renderer.dll'
    & node -e 'const fs=require("fs"),path=require("path"),a=require("assert/strict");const [src,dst]=process.argv.slice(1);a.equal(fs.realpathSync(path.dirname(dst)).toLowerCase(),path.resolve(path.dirname(dst)).toLowerCase());a.equal(fs.realpathSync(dst).toLowerCase(),path.resolve(dst).toLowerCase());if(!fs.readFileSync(src).equals(fs.readFileSync(dst))){fs.unlinkSync(dst);fs.copyFileSync(src,dst);}' $taskRendererDLL.file $taskDestination
    if ($LASTEXITCODE -ne 0) { throw 'Native Renderer refresh failed' }
    $env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
    $env:WEBGPU_INTERMEDIATE_DIR = Join-Path $taskOutput 'conversion'
    $taskBaselineManifest = Join-Path $PSScriptRoot 'build/villa-default-20261107/content-files.json'
    $taskBaselineArchive = Join-Path $taskOutput 'baseline-global-shaders.bin'
    & node -e 'const fs=require("fs"),path=require("path"),a=require("assert/strict"),crypto=require("crypto");const [m,out]=process.argv.slice(1),v=JSON.parse(fs.readFileSync(m,"utf8")),f=v.files.find(f=>f.path==="/Engine/GlobalShaderCache-SP_WEBGPU_SM5.bin");a(f);const b=Buffer.alloc(f.size),fd=fs.openSync(path.join(path.dirname(m),v.pack.url),"r");try{a.equal(fs.readSync(fd,b,0,f.size,f.offset),f.size);}finally{fs.closeSync(fd);}a.equal(crypto.createHash("sha256").update(b).digest("hex"),f.sha256);fs.writeFileSync(out,b);' $taskBaselineManifest $taskBaselineArchive
    if ($LASTEXITCODE -ne 0) { throw 'Baseline global shader archive extraction failed' }
    $taskInputs = @($PSCommandPath, $taskRendererReportFile, $taskBaselineManifest, $taskBaselineArchive,
        (Join-Path $taskRoot 'tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteHierarchyProbe.cpp'),
        (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Renderer/Private/VT/VirtualTextureSpace.cpp'),
        (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Renderer/Private/VT/RuntimeVirtualTextureRender.cpp'),
        (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Renderer/Private/TranslucentLighting.cpp'),
        (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Renderer/Private/GPUFeedbackCompaction.cpp'),
        (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Renderer/Private/GPUFeedbackCompaction.h'),
        (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp'),
        (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/RenderCore/Public/WebShaderPlatform.h')) |
        ForEach-Object {Get-TaskAudit $_}
    $taskInputs += Get-ChildItem -LiteralPath (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps') -Recurse -File |
        ForEach-Object {Get-TaskAudit $_.FullName}
    $taskInputs += @($taskRenderer.sourceFiles) + @($taskRenderer.products) + @($taskRenderer.installedInputs) + @($taskRenderer.log)
    & (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-Cmd.exe') (Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject') `
        -run=WebShaderProbe -WebNaniteHierarchyProbe "-SupplementShaderTypes=$($taskTypes -join ',')" `
        "-SupplementBaseline=$taskBaselineArchive" -WebShaderMetadataValidate -WebGPUCook "-Output=$taskOutput" -nullrhi -unattended -nop4 -nosplash -nosound `
        "-abslog=$taskOutput/compiler.log" *> "$taskOutput/console.log"
    if ($LASTEXITCODE -ne 0) { throw 'Runtime shader supplement compilation failed' }
    $taskLog = Get-Content -LiteralPath "$taskOutput/compiler.log" -Raw
    if ($taskLog -match 'Ensure condition failed|Assertion failed|Fatal error|has unbound parameters') { throw 'Runtime shader supplement failed UE metadata validation' }
    foreach ($taskType in $taskTypes) {
        $taskPermutationCount = if ($taskType.StartsWith('FShader_VirtualTextureCompress_CS')) { 8 }
            elseif ($taskType -eq 'FTranslucentLightingInjectBatchCS') { 16 }
            elseif ($taskType -like '*FeedbackHashTable*') { 2 } else { 1 }
        for ($taskPermutation = 0; $taskPermutation -lt $taskPermutationCount; ++$taskPermutation) {
            if (-not $taskLog.Contains("WEB_SHADER_SUPPLEMENT type=$taskType permutation=$taskPermutation")) { throw "Missing compiled type $taskType permutation $taskPermutation" }
        }
    }
    foreach ($taskInput in $taskInputs) {
        if ((Get-TaskAudit $taskInput.file).sha256 -ne $taskInput.sha256) { throw "Input changed: $($taskInput.file)" }
    }
    $taskPermutations = @([regex]::Matches($taskLog, 'WEB_SHADER_SUPPLEMENT type=(.+) permutation=(\d+)') | ForEach-Object {
        @{type=$_.Groups[1].Value;permutation=[int]$_.Groups[2].Value}
    })
    if (-not ($taskPermutations | Where-Object type -eq 'FVirtualShadowMapProjectionCompositeFromMaskBitsPS')) { throw 'Missing required VSM shader' }
    @{pass=$true; explicitTypes=$taskTypes; types=@($taskPermutations.type | Sort-Object -Unique); permutations=$taskPermutations; sources=$taskInputs;
        archiveSections=[BitConverter]::ToInt32([IO.File]::ReadAllBytes("$taskOutput/supplement-global-shaders.bin"),0);
        archive=(Get-TaskAudit "$taskOutput/supplement-global-shaders.bin");
        logs=@('compiler.log','console.log') | ForEach-Object {Get-TaskAudit (Join-Path $taskOutput $_)};
        binaries=@((Join-Path $taskRoot 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll'),
            (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-Renderer.dll'),
            (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-RenderCore.dll'),
            (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPUShaderFormat.dll'),
            (Join-Path $env:WEBGPU_TINT_DIR 'tint.exe'), (Join-Path $env:WEBGPU_TINT_DIR 'tint_info.exe')) | ForEach-Object {Get-TaskAudit $_};
        shaderInputs=Get-ChildItem -LiteralPath (Join-Path $taskRoot '.tools/ue58-web-cook-shaders') -Recurse -File | ForEach-Object {Get-TaskAudit $_.FullName}
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath "$taskOutput/verified.json" -Encoding utf8
} finally {
    $taskProcess.ProcessorAffinity = $taskAffinity
    $env:WEBGPU_TINT_DIR = $taskTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskIntermediate
}
