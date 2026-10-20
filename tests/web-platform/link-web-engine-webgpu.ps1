param(
    [string]$Engine = 'H:/UE_5.8',
    [string]$BaselineReport,
    [string]$ModuleCompileLog = 'web-engine-webgpu-modules-20261019.log',
    [string[]]$RecompileResponses = @()
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskResults = Join-Path $PSScriptRoot 'results'
$taskHost = Join-Path $taskRoot '.tools/ue58-web-build-host/Engine'
$taskOutput = Join-Path $PSScriptRoot 'build/web-engine-webgpu'
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskLog = Join-Path $taskResults "web-engine-webgpu-link-$taskStamp.log"
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskSavedSdk = $env:WEB_EMSDK_ROOT
$taskSavedConfig = $env:EM_CONFIG
$taskReport = [ordered]@{
    date = Get-Date -Format o
    pass = $false
    architecture = 'wasm64'
    mode = 'incremental-link-diagnostic'
    fullNormalUBTBuildVerified = $false
    deviceCreationVerified = $false
    engineLoopBrowserTickVerified = $false
    completeUEScene = $false
}
function Get-TaskAudit([string]$File) {
    return @{ file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
}
try {
    $taskProcess.ProcessorAffinity = [IntPtr]3
    if (-not $BaselineReport) {
        $BaselineReport = (Get-ChildItem -LiteralPath $taskResults -Filter 'web-engine-full-build-results-before-webgpu-*.json' |
            Sort-Object Name -Descending | Select-Object -First 1).FullName
    }
    $taskBaseline = Get-Content -LiteralPath $BaselineReport -Raw | ConvertFrom-Json
    if (-not $taskBaseline.pass -or -not $taskBaseline.buildSucceeded) { throw 'A preserved successful full-build baseline is required.' }
    foreach ($taskProduct in $taskBaseline.products) {
        if ((Get-TaskAudit $taskProduct.file).sha256 -ne $taskProduct.sha256) { throw "Baseline product changed: $($taskProduct.file)" }
    }
    $taskCompileLog = Join-Path $taskResults $ModuleCompileLog
    if ((Get-Content -LiteralPath $taskCompileLog -Raw) -notmatch 'Result: Succeeded') { throw 'Current WebGPU modules must compile first.' }
    $taskReport.baselineBuildReport = Get-TaskAudit $BaselineReport
    $taskReport.moduleCompileLog = Get-TaskAudit $taskCompileLog
    New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
    $env:WEB_EMSDK_ROOT = Join-Path $taskRoot '.tools/emsdk'
    $env:EM_CONFIG = (Join-Path $env:WEB_EMSDK_ROOT '.emscripten').Replace('\', '/')
    $taskPython = Join-Path $env:WEB_EMSDK_ROOT 'python/3.13.3_64bit/python.exe'
    $taskCompiler = Join-Path $env:WEB_EMSDK_ROOT 'upstream/emscripten/em++.py'
    $taskReport.recompiledObjects = @()
    foreach ($taskCompileResponse in $RecompileResponses) {
        $taskCompileResponse = [IO.Path]::GetFullPath($taskCompileResponse)
        if (-not $taskCompileResponse.StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Diagnostic compile responses must be inside this workspace.'
        }
        $taskCompileArguments = @(Get-Content -LiteralPath $taskCompileResponse)
        if ($taskCompileArguments[0] -ne '-c' -or $taskCompileArguments[2] -ne '-o' -or
            '-m64' -notin $taskCompileArguments) { throw 'Expected a generated wasm64 C++ response.' }
        $taskCompileOutput = $taskCompileArguments[3].Trim('"')
        if (-not [IO.Path]::GetFullPath($taskCompileOutput).StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Diagnostic compile output must stay inside this workspace.'
        }
        $taskCompileOutputLog = "$taskLog.$([IO.Path]::GetFileName($taskCompileOutput)).compile.log"
        Write-Output "Compiling selected UBT response: $taskCompileResponse"
        & $taskPython $taskCompiler "@$taskCompileResponse" *> $taskCompileOutputLog
        $taskCompileExit = $LASTEXITCODE
        if ($taskCompileExit -ne 0) { throw "Selected compile failed: $taskCompileOutputLog" }
        $taskReport.recompiledObjects += @{
            exitCode = $taskCompileExit
            response = Get-TaskAudit $taskCompileResponse
            source = Get-TaskAudit $taskCompileArguments[1].Trim('"')
            product = Get-TaskAudit $taskCompileOutput
            log = Get-TaskAudit $taskCompileOutputLog
        }
    }
    $taskOriginalResponse = Join-Path $taskRoot 'tests/ue-web-smoke/Intermediate/Build/Web/wasm64/UEWebEngine/Development/UEWebEngine.js.rsp'
    $taskArguments = @(Get-Content -LiteralPath $taskOriginalResponse)
    if ($taskArguments[0] -ne '-o') { throw 'Unexpected UBT linker response layout.' }
    $taskReport.generatedLinkResponse = Get-TaskAudit $taskOriginalResponse
    $taskReport.linkInputs = @($taskArguments | Where-Object { $_ -match '^".*\.(o|a)"$' } |
        ForEach-Object { Get-TaskAudit $_.Trim('"') })
    if ($taskReport.linkInputs.Count -lt 300) { throw 'Expected the full Engine link input set.' }
    foreach ($taskCompiled in $taskReport.recompiledObjects) {
        if ($taskCompiled.product.file -notin $taskReport.linkInputs.file) {
            throw "Recompiled output is not a current link input: $($taskCompiled.product.file)"
        }
    }
    $taskArguments[1] = '"' + (Join-Path $taskOutput 'UEWebEngine.js').Replace('\', '/') + '"'
    $taskStringViewABI = Join-Path $taskRoot 'reference-engine/Engine/Platforms/Web/Build/WebGPUStringViewABI.js'
    $taskUpstreamPort = (Join-Path $taskRoot '.tools/emdawnwebgpu-v20261009.190412/emdawnwebgpu_pkg/emdawnwebgpu.port.py').Replace('\', '/')
    $taskWebPort = (Join-Path $taskRoot 'reference-engine/Engine/Platforms/Web/Build/emdawnwebgpu-ue.port.py').Replace('\', '/')
    $taskArguments = @($taskArguments | ForEach-Object { $_.Replace($taskUpstreamPort, $taskWebPort) })
    if (($taskArguments -join "`n") -notmatch [regex]::Escape($taskWebPort)) {
        throw 'The Engine response must use the audited Emdawn port with the string-view ABI fix.'
    }
    $taskReport.stringViewABI = Get-TaskAudit $taskStringViewABI
    $taskReport.emdawnPort = Get-TaskAudit $taskWebPort
    $taskResponse = "$taskLog.rsp"
    $taskArguments | Set-Content -LiteralPath $taskResponse -Encoding utf8NoBOM
    $taskReport.linkResponse = Get-TaskAudit $taskResponse
    Write-Output "Linking diagnostic Engine from existing objects and newly compiled WebGPU modules: $taskLog"
    & $taskPython $taskCompiler "@$taskResponse" *> $taskLog
    $taskReport.exitCode = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw "Diagnostic link failed: $taskLog" }
    $taskReport.products = @('UEWebEngine.js', 'UEWebEngine.wasm') | ForEach-Object { Get-TaskAudit (Join-Path $taskOutput $_) }
    $taskFiles = @($PSCommandPath, (Join-Path $taskHost 'Source/Runtime/Engine/Private/GameEngine.cpp'),
        (Join-Path $taskRoot 'tests/ue-web-smoke/Intermediate/Build/Web/wasm64/UEWebEngine/Development/BuildSettings/Gen/RHIStaticShaderPlatformNames.gen.cpp'))
    foreach ($taskWindowSource in @(
        'Platforms/Web/Source/Runtime/ApplicationCore/Private/Web/WebApplication.cpp',
        'Platforms/Web/Source/Runtime/Core/Public/Web/WebPlatformProperties.h')) {
        $taskFiles += Join-Path $taskRoot "reference-engine/Engine/$taskWindowSource"
        $taskFiles += Join-Path $taskHost $taskWindowSource
    }
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Core/Private/FileCache/FileCache.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/Core/Private/FileCache/FileCache.cpp'
    $taskLevelSetActor = 'Runtime/Experimental/GeometryCollectionEngine/Private/GeometryCollection/GeometryCollectionRenderLevelSetActor.cpp'
    $taskFiles += Join-Path $taskRoot "reference-engine/Engine/Source/$taskLevelSetActor"
    $taskFiles += Join-Path $taskHost "Source/$taskLevelSetActor"
    $taskFiles += Join-Path $Engine "Engine/Source/$taskLevelSetActor"
    $taskFiles += Join-Path $taskRoot 'tests/web-platform/prepare-web-core-host.ps1'
    foreach ($taskMaterialSymbolSource in @('Private/Materials/MaterialShared.cpp', 'Public/MaterialShared.h')) {
        $taskFiles += Join-Path $Engine "Engine/Source/Runtime/Engine/$taskMaterialSymbolSource"
        $taskFiles += Join-Path $taskHost "Source/Runtime/Engine/$taskMaterialSymbolSource"
    }
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Engine/Private/GeometryCacheVertexFactory.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/Engine/Private/GeometryCacheVertexFactory.cpp'
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Engine/Private/InstancedStaticMesh.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/Engine/Private/InstancedStaticMesh.cpp'
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Engine/Private/Particles/ParticleVertexFactory.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/Engine/Private/Particles/ParticleVertexFactory.cpp'
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Engine/Private/PrimitiveUniformShaderParameters.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/Engine/Private/PrimitiveUniformShaderParameters.cpp'
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Engine/Private/PositionVertexBuffer.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/Engine/Private/PositionVertexBuffer.cpp'
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Engine/Private/Rendering/StaticMeshVertexBuffer.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/Engine/Private/Rendering/StaticMeshVertexBuffer.cpp'
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Renderer/Private/FXRenderingUtils.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/Renderer/Private/FXRenderingUtils.cpp'
    foreach ($taskShaderOverlay in @('RenderCore/Private/Shader.cpp', 'RenderCore/Private/RenderUtils.cpp',
        'Engine/Private/UnrealEngine.cpp',
        'Engine/Private/SparseVolumeTexture/SparseVolumeTextureUpload.cpp',
        'Engine/Private/GPUSort.cpp', 'Engine/Private/GPUBitonicSort.cpp', 'Engine/Private/GPUSortManager.cpp',
        'Engine/Public/FXSystem.h', 'Engine/Private/Particles/ParticleGpuSimulation.cpp',
        'Engine/Private/Particles/ParticleCurveTexture.cpp', 'Engine/Private/VectorFieldVisualization.cpp',
        'RenderCore/Private/GPUDebugCrashUtils.cpp', 'Renderer/Private/ShaderPrint.cpp',
        'RenderCore/Public/WebShaderPlatform.h', 'RenderCore/Private/VertexFactory.cpp',
        'Engine/Private/Materials/MeshMaterialShader.cpp', 'Engine/Private/SkeletalRenderGPUSkin.cpp',
        'Renderer/Private/GenerateConservativeDepthBuffer.cpp',
        'Renderer/Private/SceneTextureReductions.cpp',
        'Renderer/Private/OIT/OIT.cpp',
        'Renderer/Private/PostProcess/SubpixelMorphologicalAA.cpp', 'Renderer/Private/PostProcess/PostProcessing.cpp',
        'Renderer/Private/PostProcess/PostProcessMobile.cpp',
        'Renderer/Private/SkyAtmosphereRendering.cpp',
        'Renderer/Private/VisualizeLightShape.cpp', 'Renderer/Private/PostProcess/PostProcessVisualizeHDR.cpp',
        'Renderer/Private/PostProcess/PostProcessCompositePrimitivesCommon.cpp', 'Renderer/Private/PostProcess/PostProcessCompositePrimitivesCommon.h',
        'Renderer/Private/PostProcess/PostProcessCompositeDebugPrimitives.cpp', 'Renderer/Private/PostProcess/PostProcessCompositeEditorPrimitives.cpp',
        'Renderer/Private/PostProcess/PostProcessHMD.cpp',
        'Renderer/Private/IESTextureManager.cpp', 'Landscape/Private/Landscape.cpp',
        'Renderer/Private/SceneOcclusion.cpp', 'Renderer/Private/SceneVisibility.cpp', 'Renderer/Private/RendererScene.cpp',
        'Renderer/Private/VT/VirtualTextureSpace.cpp',
        'Renderer/Private/ShadowRendering.cpp', 'Renderer/Private/ShadowSetup.cpp',
        'Renderer/Private/ShadowDepthRendering.cpp',
        'Renderer/Private/CapsuleShadowRendering.cpp', 'Renderer/Private/CapsuleShadowRendering.h',
        'RenderCore/Private/ResolveShader.cpp', 'Renderer/Private/DepthCopy.cpp', 'Renderer/Private/DepthCopy.h',
        'Renderer/Private/SceneRendering.cpp', 'Renderer/Private/SceneTextures.cpp', 'Renderer/Private/SystemTextures.cpp', 'Renderer/Private/PostProcess/PostProcessTonemap.cpp',
        'Renderer/Public/HdrCustomResolveShaders.h',
        'Renderer/Private/LocalFogVolumeRendering.cpp', 'Renderer/Private/VolumetricFog.cpp',
        'Renderer/Private/VolumetricFogLightFunction.cpp', 'Renderer/Private/VolumetricFogVoxelization.cpp',
        'Renderer/Private/LightGridInjection.cpp', 'Renderer/Private/MobileFogRendering.cpp',
        'Renderer/Private/MobileBasePassRendering.cpp',
        'Renderer/Private/HairStrands/RenderCurveSceneExtension.cpp',
        'Renderer/Private/Nanite/NaniteMaterialsSceneExtension.cpp',
        'Renderer/Private/Nanite/NaniteOwnershipVisibilitySceneExtension.cpp',
        'Renderer/Private/Skinning/SkinningSceneExtension.cpp', 'Renderer/Private/GPUScene.cpp',
        'Renderer/Private/ViewData.cpp', 'Renderer/Private/VirtualShadowMaps/VirtualShadowMapCacheManager.cpp')) {
        $taskFiles += Join-Path $taskRoot "reference-engine/Engine/Source/Runtime/$taskShaderOverlay"
        $taskFiles += Join-Path $taskHost "Source/Runtime/$taskShaderOverlay"
    }
    foreach ($taskOITConsumer in @('PrimitiveSceneInfo.cpp', 'MobileShadingRenderer.cpp', 'DeferredShadingRenderer.cpp')) {
        $taskFiles += Join-Path $Engine "Engine/Source/Runtime/Renderer/Private/$taskOITConsumer"
        $taskFiles += Join-Path $taskHost "Source/Runtime/Renderer/Private/$taskOITConsumer"
    }
    foreach ($taskExposureConsumer in @('PostProcess/PostProcessEyeAdaptation.cpp', 'PostProcess/PostProcessMobile.h')) {
        $taskFiles += Join-Path $Engine "Engine/Source/Runtime/Renderer/Private/$taskExposureConsumer"
        $taskFiles += Join-Path $taskHost "Source/Runtime/Renderer/Private/$taskExposureConsumer"
    }
    foreach ($taskSkyConsumer in @('SceneVisibility.cpp', 'ReflectionEnvironmentRealTimeCapture.cpp', 'SkyAtmosphereRendering.h')) {
        $taskFiles += Join-Path $Engine "Engine/Source/Runtime/Renderer/Private/$taskSkyConsumer"
        $taskFiles += Join-Path $taskHost "Source/Runtime/Renderer/Private/$taskSkyConsumer"
    }
    foreach ($taskDebugConsumer in @('VisualizeLightShape.h', 'PostProcess/PostProcessVisualizeHDR.h')) {
        $taskFiles += Join-Path $Engine "Engine/Source/Runtime/Renderer/Private/$taskDebugConsumer"
        $taskFiles += Join-Path $taskHost "Source/Runtime/Renderer/Private/$taskDebugConsumer"
    }
    foreach ($taskSparseConsumer in @('Private/SparseVolumeTexture/SparseVolumeTextureStreamingManager.cpp',
        'Private/SparseVolumeTexture/SparseVolumeTextureUpload.h')) {
        $taskFiles += Join-Path $Engine "Engine/Source/Runtime/Engine/$taskSparseConsumer"
        $taskFiles += Join-Path $taskHost "Source/Runtime/Engine/$taskSparseConsumer"
    }
    foreach ($taskSortConsumer in @('Public/GPUSort.h', 'Public/GPUBitonicSort.h',
        'Public/GPUSortManager.h', 'Private/Particles/ParticleGpuSimulation.cpp')) {
        $taskFiles += Join-Path $Engine "Engine/Source/Runtime/Engine/$taskSortConsumer"
        $taskFiles += Join-Path $taskHost "Source/Runtime/Engine/$taskSortConsumer"
    }
    foreach ($taskCompositeConsumer in @('Private/PostProcess/PostProcessCompositeDebugPrimitives.h',
        'Private/PostProcess/PostProcessCompositeEditorPrimitives.h', 'Public/PostProcess/PostProcessHMD.h')) {
        $taskFiles += Join-Path $Engine "Engine/Source/Runtime/Renderer/$taskCompositeConsumer"
        $taskFiles += Join-Path $taskHost "Source/Runtime/Renderer/$taskCompositeConsumer"
    }
    foreach ($taskLandscapeIESConsumer in @('Landscape/Classes/Landscape.h', 'Renderer/Private/IESTextureManager.h')) {
        $taskFiles += Join-Path $Engine "Engine/Source/Runtime/$taskLandscapeIESConsumer"
        $taskFiles += Join-Path $taskHost "Source/Runtime/$taskLandscapeIESConsumer"
    }
    foreach ($taskOcclusionConsumer in @('SceneViewOcclusionHistory.h', 'SceneVisibilityPrivate.h',
        'MobileShadingRenderer.cpp', 'MobileBasePassRendering.cpp')) {
        $taskFiles += Join-Path $Engine "Engine/Source/Runtime/Renderer/Private/$taskOcclusionConsumer"
        $taskFiles += Join-Path $taskHost "Source/Runtime/Renderer/Private/$taskOcclusionConsumer"
    }
    foreach ($taskVTConsumer in @('VT/VirtualTextureSpace.h', 'VT/VirtualTextureSystem.cpp',
        'VT/RuntimeVirtualTextureSceneExtension.cpp')) {
        $taskFiles += Join-Path $Engine "Engine/Source/Runtime/Renderer/Private/$taskVTConsumer"
        $taskFiles += Join-Path $taskHost "Source/Runtime/Renderer/Private/$taskVTConsumer"
    }
    foreach ($taskParticleConsumer in @('Private/Particles/FXSystem.cpp', 'Private/Particles/ParticleModules.cpp',
        'Private/Particles/ParticleCurveTexture.h', 'Private/Particles/FXSystemPrivate.h')) {
        $taskFiles += Join-Path $Engine "Engine/Source/Runtime/Engine/$taskParticleConsumer"
        $taskFiles += Join-Path $taskHost "Source/Runtime/Engine/$taskParticleConsumer"
    }
    foreach ($taskShadowCopyConsumer in @('Engine/Public/ScreenRendering.h', 'Engine/Private/ScreenRendering.cpp',
        'Renderer/Private/ShadowRendering.h')) {
        $taskFiles += Join-Path $Engine "Engine/Source/Runtime/$taskShadowCopyConsumer"
        $taskFiles += Join-Path $taskHost "Source/Runtime/$taskShadowCopyConsumer"
    }
    $taskFiles += Join-Path $Engine 'Engine/Source/Runtime/RenderCore/Public/RenderUtils.h'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/RenderCore/Public/RenderUtils.h'
    foreach ($taskGlintInput in @('Substrate/Glint/GlintShadingLUTs.cpp', 'Substrate/Glint/GlintShadingLUTs.h')) {
        $taskFiles += Join-Path $Engine "Engine/Source/Runtime/Renderer/Private/$taskGlintInput"
        $taskFiles += Join-Path $taskHost "Source/Runtime/Renderer/Private/$taskGlintInput"
    }
    foreach ($taskDepthInput in @('GenerateConservativeDepthBuffer.cpp', 'GenerateConservativeDepthBuffer.h')) {
        $taskFiles += Join-Path $Engine "Engine/Source/Runtime/Renderer/Private/$taskDepthInput"
        $taskFiles += Join-Path $taskHost "Source/Runtime/Renderer/Private/$taskDepthInput"
    }
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Renderer/Private/MobileShadingRenderer.cpp'
    foreach ($taskDirectory in @('reference-engine/Engine/Platforms/Web', 'tests/ue-web-smoke/Source')) {
        $taskFiles += Get-ChildItem -LiteralPath (Join-Path $taskRoot $taskDirectory) -File -Recurse | ForEach-Object { $_.FullName }
    }
    foreach ($taskName in @('WebGPUDynamicRHI.cpp', 'WebGPUDynamicRHI.h', 'WebGPUUnsupportedRHI.h',
        'WebGPUTransitions.cpp', 'WebGPUBufferLock.cpp', 'WebGPUBreadcrumbs.cpp', 'WebGPUViewport.cpp')) {
        $taskFiles += Join-Path $taskRoot "tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/$taskName"
    }
    $taskFiles += Get-ChildItem -LiteralPath (Join-Path $taskRoot '.tools/emdawnwebgpu-v20261009.190412/emdawnwebgpu_pkg') -File -Recurse |
        Where-Object { $_.Extension -in @('.py', '.cpp', '.h', '.js') } | ForEach-Object { $_.FullName }
    $taskReport.sourceFiles = @($taskFiles | ForEach-Object { Get-TaskAudit $_ })
    $taskReport.ubt = Get-TaskAudit (Join-Path $taskHost 'Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll')
    $taskReport.pass = $true
    $taskReport.boundary = 'Diagnostic full Engine link using the current UBT-generated response, existing previously compiled Engine objects and freshly compiled WebGPU/BuildSettings/RHI/entry modules. This is not a successful fresh full normal UBT build. The preserved complete build baseline and every current link input are hashed. Mixed 5.8.3 target sources and installed 5.8.0 dependencies; no device creation, Engine boot, shader Cook or rendering is implied.'
} catch {
    $taskReport.failure = $_.ToString()
    throw
} finally {
    if (Test-Path -LiteralPath $taskLog) { $taskReport.log = Get-TaskAudit $taskLog }
    $taskReport | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $taskResults 'web-engine-webgpu-link-results.json') -Encoding utf8
    $env:WEB_EMSDK_ROOT = $taskSavedSdk
    $env:EM_CONFIG = $taskSavedConfig
    $taskProcess.ProcessorAffinity = $taskAffinity
}
Write-Output ([pscustomobject]$taskReport | Select-Object pass, mode, fullNormalUBTBuildVerified, exitCode, failure, log | ConvertTo-Json -Depth 4)
