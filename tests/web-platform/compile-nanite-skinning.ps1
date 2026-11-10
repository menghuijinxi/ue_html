param([string]$Engine = 'D:/UE_5.8', [string]$FixtureDirectory = '', [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskOutput = Join-Path $PSScriptRoot 'results/nanite-skinning'
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskSavedTint = $env:WEBGPU_TINT_DIR
$taskSavedIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
$taskSavedEngine = $env:UE_ENGINE_ROOT
function Get-TaskAudit([string]$File) {
    return @{file=[IO.Path]::GetFullPath($File); sha256=(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
try {
    if (-not $FixtureDirectory) { throw 'A workspace fixture directory is required for the four skeletal assets' }
    $FixtureDirectory = [IO.Path]::GetFullPath($FixtureDirectory)
    if (-not $FixtureDirectory.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Skeletal fixture output must stay inside the workspace'
    }
    New-Item -ItemType Directory -Path $taskOutput,$FixtureDirectory -Force | Out-Null
    $taskProcess.ProcessorAffinity = 3
    $env:UE_ENGINE_ROOT = Join-Path $Engine 'Engine'
    & node (Join-Path $PSScriptRoot 'prepare-web-cook-shaders.cjs') *> "$taskOutput/prepare.log"
    if ($LASTEXITCODE -ne 0) { throw 'Skeletal shader preparation failed' }
    $taskSourceNames = @(
        'tests/web-platform/compile-nanite-skinning.ps1',
        'tests/web-platform/prepare-web-cook-shaders.cjs',
        'tests/ue-shader-host/Source/UEShaderHost/UEShaderHost.Build.cs',
        'tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteSkinningProbe.cpp',
        'tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteProgrammableProbe.cpp',
        'tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteMaterialProbe.cpp',
        'tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp',
        'reference-engine/Engine/Source/Runtime/Engine/Private/Nanite/NaniteWebVertexFactory.cpp',
        'reference-engine/Engine/Source/Runtime/Renderer/Private/Nanite/NaniteWebProgrammableRaster.cpp',
        'reference-engine/Engine/Shaders/Private/Nanite/WebNaniteProgrammableRaster.usf',
        'reference-engine/Engine/Shaders/Private/Nanite/WebNaniteVertexFactory.ush',
        'reference-engine/Engine/Shaders/Private/Nanite/NaniteVertexDeformation.ush',
        'reference-engine/Engine/Shaders/Private/Nanite/NaniteAttributeDecode.ush'
    )
    $taskSources = @($taskSourceNames | ForEach-Object { Get-TaskAudit (Join-Path $taskRoot $_) })
    if (-not $SkipBuild) {
        & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development `
            "-Project=$taskProject" -Module=UEShaderHost -WaitMutex -NoHotReloadFromIDE -NoUBA -NoUbaLocal -MaxParallelActions=1 *> "$taskOutput/build.log"
        if ($LASTEXITCODE -ne 0) { throw 'Skeletal shader host build failed' }
    }
    $env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
    $taskHost = Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe'
    & node (Join-Path $PSScriptRoot 'activate-native-nanite-builder.cjs') (Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine') *> "$taskOutput/builder-activation.log"
    if ($LASTEXITCODE -ne 0) { throw 'Skeletal Nanite builder activation failed' }
    & $taskHost $taskProject -run=WebShaderProbe -WebNaniteSkinningWeld "-Output=$taskOutput/weld.json" -nullrhi -unattended -nop4 -nosplash -nosound "-abslog=$taskOutput/weld-native.log" *> "$taskOutput/weld-console.log"
    if ($LASTEXITCODE -ne 0) { throw 'Skeletal weld verification failed' }
    $taskJobs = @(
        @{name='fixture'; flag='WebNaniteSkinningProbe'; extra=@("-FixtureDirectory=$FixtureDirectory")},
        @{name='material-output'; flag='WebNaniteSkinningMaterials'; extra=@()},
        @{name='basepass-output'; flag='WebNaniteSkinningBasePass'; extra=@()}
    )
    $taskLogs = @('weld.json','weld-native.log','weld-console.log','builder-activation.log' | ForEach-Object { Get-TaskAudit (Join-Path $taskOutput $_) })
    foreach ($taskJob in $taskJobs) {
        $taskDestination = Join-Path $taskOutput $taskJob.name
        New-Item -ItemType Directory -Path $taskDestination -Force | Out-Null
        $env:WEBGPU_INTERMEDIATE_DIR = Join-Path $taskDestination 'conversion'
        $taskArguments = @('-run=WebShaderProbe', "-$($taskJob.flag)", '-WebGPUCook', '-WebShaderMetadataValidate',
            "-Output=$taskDestination", '-nullrhi', '-unattended', '-nop4', '-nosplash', '-nosound',
            "-abslog=$taskDestination/compiler.log") + $taskJob.extra
        & $taskHost $taskProject @taskArguments *> "$taskDestination/console.log"
        if ($LASTEXITCODE -ne 0) { throw "Skeletal verification failed: $($taskJob.name)" }
        if (Select-String -LiteralPath "$taskDestination/compiler.log" -Pattern 'Error:|Ensure condition failed|Fatal error' -Quiet) {
            throw "Skeletal verification logged an error: $($taskJob.name)"
        }
        $taskLogs += Get-TaskAudit "$taskDestination/compiler.log"
        $taskLogs += Get-TaskAudit "$taskDestination/console.log"
    }
    $taskFixtures = @(0..3 | ForEach-Object {
        $taskFilename = if ($_ -eq 0) { 'fixture.json' } else { "fixture-$_.json" }
        Get-Content -LiteralPath (Join-Path $taskOutput "fixture/$taskFilename") -Raw | ConvertFrom-Json
    })
    foreach ($taskIndex in 0..3) {
        $taskFixture = $taskFixtures[$taskIndex]
        if (-not $taskFixture.pass -or $taskFixture.bones -ne 2 -or $taskFixture.hierarchyBoneIndices -le 0 -or
            $taskFixture.streaming -ne ($taskIndex -in @(1,3)) -or
            -not $taskFixture.builderVersion.EndsWith('_SKINNING_WELD_2')) { throw "Invalid skeletal fixture $taskIndex" }
    }
    $taskMaterials = Get-Content -LiteralPath "$taskOutput/material-output/materials.json" -Raw | ConvertFrom-Json
    $taskBasePass = Get-Content -LiteralPath "$taskOutput/basepass-output/basepass.json" -Raw | ConvertFrom-Json
    if (-not $taskMaterials.pass -or $taskMaterials.cases.Count -ne 20 -or
        -not $taskBasePass.pass -or $taskBasePass.cases.Count -ne 10) { throw 'Incomplete skeletal shader permutations' }
    foreach ($taskCase in @($taskMaterials.cases) + @($taskBasePass.cases)) {
        if (-not $taskCase.preprocessed -or -not $taskCase.compiled -or $taskCase.errors.Count) { throw 'Invalid skeletal shader result' }
    }
    foreach ($taskSource in $taskSources) {
        if ((Get-TaskAudit $taskSource.file).sha256 -ne $taskSource.sha256) { throw "Input changed: $($taskSource.file)" }
    }
    $taskAssetNames = @('NaniteSkinPlane','NaniteSkinSkeleton','NaniteSkinMaterial') +
        @(1..4 | ForEach-Object { "NaniteSkinMaterial$_" }) +
        @('NaniteSkinStreamingPlane','NaniteSkinResidentPlane','NaniteSkinStreamingPlaneB' | ForEach-Object { $_; "${_}Skeleton" })
    $taskSources += @('tests/web-platform/activate-native-nanite-builder.cjs',
        'tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteSkinningWeldProbe.cpp',
        'reference-engine/Engine/Source/Developer/NaniteBuilder/Private/NaniteSkinningWeld.h' | ForEach-Object { Get-TaskAudit (Join-Path $taskRoot $_) })
    @{pass=$true; sources=$taskSources; fixtures=$taskFixtures; materials=$taskMaterials; basepass=$taskBasePass;
        builder=Get-TaskAudit (Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine/Binaries/Win64/UnrealEditor-NaniteBuilder.dll');
        builderBuild=Get-TaskAudit (Join-Path $PSScriptRoot 'results/native-nanitebuilder-build-results.json');
        binary=Get-TaskAudit (Join-Path $taskRoot 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll');
        logs=$taskLogs;
        assets=@($taskAssetNames | ForEach-Object { Get-TaskAudit (Join-Path $FixtureDirectory "$_.uasset") });
        sourceGeometry=@('skin-source-triangles.bin','skin-streaming-source-triangles.bin' | ForEach-Object { Get-TaskAudit (Join-Path $taskOutput "fixture/$_") })
    } | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath "$taskOutput/verified.json" -Encoding utf8
} finally {
    $taskProcess.ProcessorAffinity = $taskAffinity
    $env:WEBGPU_TINT_DIR = $taskSavedTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskSavedIntermediate
    $env:UE_ENGINE_ROOT = $taskSavedEngine
}
