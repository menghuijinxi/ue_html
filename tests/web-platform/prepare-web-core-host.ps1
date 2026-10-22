param([string]$Engine = 'H:/UE_5.8')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskHost = Join-Path $taskRoot '.tools/ue58-web-build-host/Engine'
$taskSource = Join-Path $taskHost 'Source'
$taskOriginalSource = [IO.Path]::GetFullPath((Join-Path $Engine 'Engine/Source'))
$taskUht = Join-Path $taskHost 'Programs/UnrealHeaderTool'
New-Item -ItemType Directory -Path $taskUht -Force | Out-Null
if ((Get-Item -LiteralPath $taskUht).LinkType) { throw 'Build-host UHT directory must be local' }
Copy-Item -LiteralPath (Join-Path $Engine 'Engine/Programs/UnrealHeaderTool/Config') -Destination $taskUht -Recurse -Force
$taskShaders = Join-Path $taskHost 'Shaders'
$taskOriginalShaders = [IO.Path]::GetFullPath((Join-Path $Engine 'Engine/Shaders'))
if (-not (Test-Path -LiteralPath $taskShaders)) {
    New-Item -ItemType Junction -Path $taskShaders -Target $taskOriginalShaders | Out-Null
} else {
    $taskShadersItem = Get-Item -LiteralPath $taskShaders
    if ($taskShadersItem.LinkType -ne 'Junction' -or
        [IO.Path]::GetFullPath($taskShadersItem.Target) -ne $taskOriginalShaders) {
        throw 'Unexpected build-host Shaders link'
    }
}
$taskHostBinaries = Join-Path $taskHost 'Binaries'
New-Item -ItemType Directory -Path $taskHostBinaries -Force | Out-Null
if ((Get-Item -LiteralPath $taskHostBinaries).LinkType) { throw 'Build-host Binaries must be local' }
$taskThirdPartyBinaries = Join-Path $taskHostBinaries 'ThirdParty'
New-Item -ItemType Directory -Path $taskThirdPartyBinaries -Force | Out-Null
if ((Get-Item -LiteralPath $taskThirdPartyBinaries).LinkType) { throw 'Build-host ThirdParty binaries must be local' }
$taskDotnetLink = Join-Path $taskThirdPartyBinaries 'DotNet'
$taskOriginalDotnet = [IO.Path]::GetFullPath((Join-Path $Engine 'Engine/Binaries/ThirdParty/DotNet'))
if (-not (Test-Path -LiteralPath $taskDotnetLink)) {
    New-Item -ItemType Junction -Path $taskDotnetLink -Target $taskOriginalDotnet | Out-Null
} else {
    $taskDotnetItem = Get-Item -LiteralPath $taskDotnetLink
    if ($taskDotnetItem.LinkType -ne 'Junction' -or
        [IO.Path]::GetFullPath($taskDotnetItem.Target) -ne $taskOriginalDotnet) {
        throw 'Unexpected build-host DotNet runtime link'
    }
}
if (Test-Path -LiteralPath $taskSource) {
    $taskItem = Get-Item -LiteralPath $taskSource
    if ($taskItem.LinkType) {
        if ($taskItem.LinkType -ne 'Junction' -or
            [IO.Path]::GetFullPath($taskItem.Target) -ne $taskOriginalSource -or
            -not [IO.Path]::GetFullPath($taskSource).StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unexpected build-host Source link; refusing to replace it'
        }
        Remove-Item -LiteralPath $taskSource
    }
}
New-Item -ItemType Directory -Path $taskSource -Force | Out-Null
foreach ($taskPart in Get-ChildItem -LiteralPath $taskOriginalSource) {
    if ($taskPart.Name -in @('Runtime', 'ThirdParty')) { continue }
    $taskDestination = Join-Path $taskSource $taskPart.Name
    if (-not (Test-Path -LiteralPath $taskDestination)) {
        if ($taskPart.PSIsContainer) {
            New-Item -ItemType Junction -Path $taskDestination -Target $taskPart.FullName | Out-Null
        } else {
            Copy-Item -LiteralPath $taskPart.FullName -Destination $taskDestination
        }
    }
}
$taskThirdParty = Join-Path $taskSource 'ThirdParty'
if (Test-Path -LiteralPath $taskThirdParty) {
    $taskThirdPartyItem = Get-Item -LiteralPath $taskThirdParty
    if ($taskThirdPartyItem.LinkType) {
        $taskExpected = [IO.Path]::GetFullPath((Join-Path $taskOriginalSource 'ThirdParty'))
        if ($taskThirdPartyItem.LinkType -ne 'Junction' -or
            [IO.Path]::GetFullPath($taskThirdPartyItem.Target) -ne $taskExpected -or
            -not [IO.Path]::GetFullPath($taskThirdParty).StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unexpected build-host ThirdParty link; refusing to replace it'
        }
        Remove-Item -LiteralPath $taskThirdParty
    }
}
New-Item -ItemType Directory -Path $taskThirdParty -Force | Out-Null
foreach ($taskPart in Get-ChildItem -LiteralPath (Join-Path $taskOriginalSource 'ThirdParty')) {
    if ($taskPart.Name -eq 'AtomicQueue') { continue }
    $taskDestination = Join-Path $taskThirdParty $taskPart.Name
    if (-not (Test-Path -LiteralPath $taskDestination)) {
        if ($taskPart.PSIsContainer) {
            New-Item -ItemType Junction -Path $taskDestination -Target $taskPart.FullName | Out-Null
        } else {
            Copy-Item -LiteralPath $taskPart.FullName -Destination $taskDestination
        }
    }
}
$taskAtomicQueue = Join-Path $taskThirdParty 'AtomicQueue'
New-Item -ItemType Directory -Path $taskAtomicQueue -Force | Out-Null
if ((Get-Item -LiteralPath $taskAtomicQueue).LinkType) { throw 'Build-host AtomicQueue must be local' }
foreach ($taskPart in Get-ChildItem -LiteralPath (Join-Path $taskRoot 'reference-engine/Engine/Source/ThirdParty/AtomicQueue')) {
    Copy-Item -LiteralPath $taskPart.FullName -Destination $taskAtomicQueue -Recurse -Force
}
$taskRuntime = Join-Path $taskSource 'Runtime'
New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null
if ((Get-Item -LiteralPath $taskRuntime).LinkType) { throw 'Build-host Runtime must be local' }
foreach ($taskModule in Get-ChildItem -LiteralPath (Join-Path $taskOriginalSource 'Runtime') -Directory) {
    if ($taskModule.Name -in @('Core', 'TraceLog', 'ApplicationCore', 'CoreUObject', 'Launch', 'Experimental', 'Online', 'Engine', 'MovieSceneTracks', 'RenderCore', 'Renderer', 'Landscape', 'SignalProcessing', 'SlateCore', 'Slate')) { continue }
    $taskDestination = Join-Path $taskRuntime $taskModule.Name
    if (-not (Test-Path -LiteralPath $taskDestination)) {
        New-Item -ItemType Junction -Path $taskDestination -Target $taskModule.FullName | Out-Null
    }
}
$taskExperimental = Join-Path $taskRuntime 'Experimental'
$taskOriginalExperimental = [IO.Path]::GetFullPath((Join-Path $taskOriginalSource 'Runtime/Experimental'))
if (Test-Path -LiteralPath $taskExperimental) {
    $taskExperimentalItem = Get-Item -LiteralPath $taskExperimental
    if ($taskExperimentalItem.LinkType) {
        if ($taskExperimentalItem.LinkType -ne 'Junction' -or
            [IO.Path]::GetFullPath($taskExperimentalItem.Target) -ne $taskOriginalExperimental -or
            -not [IO.Path]::GetFullPath($taskExperimental).StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unexpected build-host Experimental link; refusing to replace it'
        }
        Remove-Item -LiteralPath $taskExperimental
    }
}
New-Item -ItemType Directory -Path $taskExperimental -Force | Out-Null
foreach ($taskModule in Get-ChildItem -LiteralPath $taskOriginalExperimental -Directory) {
    if ($taskModule.Name -in @('ChaosCore', 'GeometryCollectionEngine')) { continue }
    $taskDestination = Join-Path $taskExperimental $taskModule.Name
    if (-not (Test-Path -LiteralPath $taskDestination)) {
        New-Item -ItemType Junction -Path $taskDestination -Target $taskModule.FullName | Out-Null
    }
}
foreach ($taskModuleName in @('Core', 'TraceLog', 'ApplicationCore', 'CoreUObject', 'Launch', 'Experimental/ChaosCore')) {
    $taskModulePath = Join-Path $taskRuntime $taskModuleName
    if (Test-Path -LiteralPath $taskModulePath) {
        $taskModuleItem = Get-Item -LiteralPath $taskModulePath
        if ($taskModuleItem.LinkType) {
            $taskExpected = [IO.Path]::GetFullPath((Join-Path $taskOriginalSource "Runtime/$taskModuleName"))
            if ($taskModuleItem.LinkType -ne 'Junction' -or
                [IO.Path]::GetFullPath($taskModuleItem.Target) -ne $taskExpected -or
                -not [IO.Path]::GetFullPath($taskModulePath).StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) {
                throw "Unexpected build-host $taskModuleName link; refusing to replace it"
            }
            Remove-Item -LiteralPath $taskModulePath
        }
    }
    New-Item -ItemType Directory -Path $taskModulePath -Force | Out-Null
    foreach ($taskPart in Get-ChildItem -LiteralPath (Join-Path $taskRoot "reference-engine/Engine/Source/Runtime/$taskModuleName")) {
        Copy-Item -LiteralPath $taskPart.FullName -Destination $taskModulePath -Recurse -Force
    }
}
$taskGeometryModule = Join-Path $taskExperimental 'GeometryCollectionEngine'
$taskOriginalGeometryModule = [IO.Path]::GetFullPath((Join-Path $taskOriginalExperimental 'GeometryCollectionEngine'))
if (Test-Path -LiteralPath $taskGeometryModule) {
    $taskGeometryItem = Get-Item -LiteralPath $taskGeometryModule
    if ($taskGeometryItem.LinkType) {
        if ($taskGeometryItem.LinkType -ne 'Junction' -or
            [IO.Path]::GetFullPath($taskGeometryItem.Target) -ne $taskOriginalGeometryModule -or
            -not [IO.Path]::GetFullPath($taskGeometryModule).StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unexpected build-host GeometryCollectionEngine link; refusing to replace it'
        }
        Remove-Item -LiteralPath $taskGeometryModule
    }
}
New-Item -ItemType Directory -Path $taskGeometryModule -Force | Out-Null
foreach ($taskPart in Get-ChildItem -LiteralPath $taskOriginalGeometryModule) {
    Copy-Item -LiteralPath $taskPart.FullName -Destination $taskGeometryModule -Recurse -Force
}
$taskLevelSetActor = 'Private/GeometryCollection/GeometryCollectionRenderLevelSetActor.cpp'
Copy-Item -LiteralPath (Join-Path $taskRoot "reference-engine/Engine/Source/Runtime/Experimental/GeometryCollectionEngine/$taskLevelSetActor") -Destination (Join-Path $taskGeometryModule $taskLevelSetActor) -Force
$taskEngineModule = Join-Path $taskRuntime 'Engine'
$taskOriginalEngineModule = [IO.Path]::GetFullPath((Join-Path $taskOriginalSource 'Runtime/Engine'))
if (Test-Path -LiteralPath $taskEngineModule) {
    $taskEngineModuleItem = Get-Item -LiteralPath $taskEngineModule
    if ($taskEngineModuleItem.LinkType) {
        if ($taskEngineModuleItem.LinkType -ne 'Junction' -or
            [IO.Path]::GetFullPath($taskEngineModuleItem.Target) -ne $taskOriginalEngineModule -or
            -not [IO.Path]::GetFullPath($taskEngineModule).StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unexpected build-host Engine module link; refusing to replace it'
        }
        Remove-Item -LiteralPath $taskEngineModule
    }
}
New-Item -ItemType Directory -Path $taskEngineModule -Force | Out-Null
foreach ($taskPart in Get-ChildItem -LiteralPath $taskOriginalEngineModule) {
    Copy-Item -LiteralPath $taskPart.FullName -Destination $taskEngineModule -Recurse -Force
}
foreach ($taskEngineSource in @('Private/Shader/Preshader2.cpp', 'Private/SparseVolumeTexture/SparseVolumeTextureData.cpp',
    'Private/VolumeTexture.cpp', 'Private/Rendering/Texture3DResource.cpp', 'Private/Materials/MaterialExpressions.cpp',
    'Private/UnrealEngine.cpp', 'Private/SceneTexturesConfig.cpp',
    'Private/Materials/MeshMaterialShader.cpp',
    'Private/SparseVolumeTexture/SparseVolumeTextureUpload.cpp',
    'Private/GPUSort.cpp', 'Private/GPUBitonicSort.cpp', 'Private/GPUSortManager.cpp',
    'Public/FXSystem.h', 'Private/Particles/ParticleGpuSimulation.cpp', 'Private/Particles/ParticleCurveTexture.cpp',
    'Private/VectorFieldVisualization.cpp',
    'Private/GeometryCacheVertexFactory.cpp', 'Private/InstancedStaticMesh.cpp', 'Private/Particles/ParticleVertexFactory.cpp',
    'Private/PrimitiveUniformShaderParameters.cpp', 'Private/PositionVertexBuffer.cpp', 'Private/Rendering/StaticMeshVertexBuffer.cpp',
    'Private/SkeletalRenderGPUSkin.cpp')) {
    Copy-Item -LiteralPath (Join-Path $taskRoot "reference-engine/Engine/Source/Runtime/Engine/$taskEngineSource") -Destination (Join-Path $taskEngineModule $taskEngineSource) -Force
}
$taskTracksModule = Join-Path $taskRuntime 'MovieSceneTracks'
$taskOriginalTracksModule = [IO.Path]::GetFullPath((Join-Path $taskOriginalSource 'Runtime/MovieSceneTracks'))
if (Test-Path -LiteralPath $taskTracksModule) {
    $taskTracksItem = Get-Item -LiteralPath $taskTracksModule
    if ($taskTracksItem.LinkType) {
        if ($taskTracksItem.LinkType -ne 'Junction' -or
            [IO.Path]::GetFullPath($taskTracksItem.Target) -ne $taskOriginalTracksModule -or
            -not [IO.Path]::GetFullPath($taskTracksModule).StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unexpected build-host MovieSceneTracks link; refusing to replace it'
        }
        Remove-Item -LiteralPath $taskTracksModule
    }
}
New-Item -ItemType Directory -Path $taskTracksModule -Force | Out-Null
foreach ($taskPart in Get-ChildItem -LiteralPath $taskOriginalTracksModule) {
    Copy-Item -LiteralPath $taskPart.FullName -Destination $taskTracksModule -Recurse -Force
}
$taskAnimationSection = 'Private/Sections/MovieSceneSkeletalAnimationSection.cpp'
Copy-Item -LiteralPath (Join-Path $taskRoot "reference-engine/Engine/Source/Runtime/MovieSceneTracks/$taskAnimationSection") -Destination (Join-Path $taskTracksModule $taskAnimationSection) -Force
$taskRenderModule = Join-Path $taskRuntime 'RenderCore'
$taskOriginalRenderModule = [IO.Path]::GetFullPath((Join-Path $taskOriginalSource 'Runtime/RenderCore'))
if (Test-Path -LiteralPath $taskRenderModule) {
    $taskRenderItem = Get-Item -LiteralPath $taskRenderModule
    if ($taskRenderItem.LinkType) {
        if ($taskRenderItem.LinkType -ne 'Junction' -or
            [IO.Path]::GetFullPath($taskRenderItem.Target) -ne $taskOriginalRenderModule -or
            -not [IO.Path]::GetFullPath($taskRenderModule).StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unexpected build-host RenderCore link; refusing to replace it'
        }
        Remove-Item -LiteralPath $taskRenderModule
    }
}
New-Item -ItemType Directory -Path $taskRenderModule -Force | Out-Null
foreach ($taskPart in Get-ChildItem -LiteralPath $taskOriginalRenderModule) {
    Copy-Item -LiteralPath $taskPart.FullName -Destination $taskRenderModule -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Core/Private/FileCache/FileCache.cpp') -Destination (Join-Path $taskRuntime 'Core/Private/FileCache/FileCache.cpp') -Force
$taskShaderArchive = 'Private/ShaderLibrary/ShaderCodeArchive.cpp'
Copy-Item -LiteralPath (Join-Path $taskRoot "reference-engine/Engine/Source/Runtime/RenderCore/$taskShaderArchive") -Destination (Join-Path $taskRenderModule $taskShaderArchive) -Force
foreach ($taskShaderOverlay in @('Private/Shader.cpp', 'Private/RenderUtils.cpp', 'Private/GPUDebugCrashUtils.cpp',
    'Private/ResolveShader.cpp', 'Private/VertexFactory.cpp', 'Public/WebShaderPlatform.h')) {
    Copy-Item -LiteralPath (Join-Path $taskRoot "reference-engine/Engine/Source/Runtime/RenderCore/$taskShaderOverlay") -Destination (Join-Path $taskRenderModule $taskShaderOverlay) -Force
}
$taskRendererModule = Join-Path $taskRuntime 'Renderer'
$taskOriginalRendererModule = [IO.Path]::GetFullPath((Join-Path $taskOriginalSource 'Runtime/Renderer'))
if (Test-Path -LiteralPath $taskRendererModule) {
    $taskRendererItem = Get-Item -LiteralPath $taskRendererModule
    if ($taskRendererItem.LinkType) {
        if ($taskRendererItem.LinkType -ne 'Junction' -or
            [IO.Path]::GetFullPath($taskRendererItem.Target) -ne $taskOriginalRendererModule -or
            -not [IO.Path]::GetFullPath($taskRendererModule).StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unexpected build-host Renderer link; refusing to replace it'
        }
        Remove-Item -LiteralPath $taskRendererModule
    }
}
New-Item -ItemType Directory -Path $taskRendererModule -Force | Out-Null
foreach ($taskPart in Get-ChildItem -LiteralPath $taskOriginalRendererModule) {
    Copy-Item -LiteralPath $taskPart.FullName -Destination $taskRendererModule -Recurse -Force
}
$taskSceneCulling = 'Private/SceneCulling/SceneCullingRenderer.cpp'
Copy-Item -LiteralPath (Join-Path $taskRoot "reference-engine/Engine/Source/Runtime/Renderer/$taskSceneCulling") -Destination (Join-Path $taskRendererModule $taskSceneCulling) -Force
Copy-Item -LiteralPath (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Renderer/Private/FXRenderingUtils.cpp') -Destination (Join-Path $taskRendererModule 'Private/FXRenderingUtils.cpp') -Force
foreach ($taskRendererOverlay in @('Private/LightGridInjection.cpp', 'Private/MobileFogRendering.cpp', 'Private/ShaderPrint.cpp',
    'Private/SystemTextures.cpp', 'Private/MobileBasePassRendering.cpp',
    'Private/HairStrands/RenderCurveSceneExtension.cpp',
    'Private/Nanite/NaniteMaterialsSceneExtension.cpp', 'Private/Nanite/NaniteOwnershipVisibilitySceneExtension.cpp',
    'Private/Skinning/SkinningSceneExtension.cpp', 'Private/GPUScene.cpp', 'Private/ViewData.cpp',
    'Private/VirtualShadowMaps/VirtualShadowMapCacheManager.cpp',
    'Private/OIT/OIT.cpp',
    'Private/PostProcess/SubpixelMorphologicalAA.cpp', 'Private/PostProcess/PostProcessing.cpp',
    'Private/PostProcess/PostProcessMobile.cpp', 'Private/PostProcess/PostProcessCombineLUTs.cpp',
    'Private/SkyAtmosphereRendering.cpp', 'Private/SkyPassRendering.cpp', 'Private/VolumetricCloudRendering.cpp',
    'Private/VolumetricRenderTarget.cpp', 'Private/ScreenPass.cpp',
    'Private/VisualizeLightShape.cpp', 'Private/PostProcess/PostProcessVisualizeHDR.cpp',
    'Private/PostProcess/PostProcessCompositePrimitivesCommon.cpp', 'Private/PostProcess/PostProcessCompositePrimitivesCommon.h',
    'Private/PostProcess/PostProcessCompositeDebugPrimitives.cpp', 'Private/PostProcess/PostProcessCompositeEditorPrimitives.cpp',
    'Private/PostProcess/PostProcessHMD.cpp',
    'Private/IESTextureManager.cpp',
    'Private/SceneOcclusion.cpp', 'Private/SceneVisibility.cpp', 'Private/RendererScene.cpp', 'Private/MobileShadingRenderer.cpp',
    'Private/VT/VirtualTextureSpace.cpp',
    'Private/ShadowRendering.cpp', 'Private/ShadowSetup.cpp', 'Private/ShadowDepthRendering.cpp',
    'Private/SceneTextureReductions.cpp', 'Private/CapsuleShadowRendering.cpp', 'Private/CapsuleShadowRendering.h',
    'Private/DepthCopy.cpp', 'Private/DepthCopy.h', 'Private/SceneRendering.cpp', 'Private/SceneTextures.cpp',
    'Private/PostProcess/PostProcessTonemap.cpp', 'Public/HdrCustomResolveShaders.h',
    'Private/LocalFogVolumeRendering.cpp', 'Private/VolumetricFog.cpp', 'Private/GenerateConservativeDepthBuffer.cpp',
    'Private/VolumetricFogLightFunction.cpp', 'Private/VolumetricFogVoxelization.cpp')) {
    Copy-Item -LiteralPath (Join-Path $taskRoot "reference-engine/Engine/Source/Runtime/Renderer/$taskRendererOverlay") -Destination (Join-Path $taskRendererModule $taskRendererOverlay) -Force
}
$taskLandscapeModule = Join-Path $taskRuntime 'Landscape'
$taskOriginalLandscapeModule = [IO.Path]::GetFullPath((Join-Path $taskOriginalSource 'Runtime/Landscape'))
if (Test-Path -LiteralPath $taskLandscapeModule) {
    $taskLandscapeItem = Get-Item -LiteralPath $taskLandscapeModule
    if ($taskLandscapeItem.LinkType) {
        if ($taskLandscapeItem.LinkType -ne 'Junction' -or
            [IO.Path]::GetFullPath($taskLandscapeItem.Target) -ne $taskOriginalLandscapeModule -or
            -not [IO.Path]::GetFullPath($taskLandscapeModule).StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unexpected build-host Landscape link; refusing to replace it'
        }
        Remove-Item -LiteralPath $taskLandscapeModule
    }
}
New-Item -ItemType Directory -Path $taskLandscapeModule -Force | Out-Null
foreach ($taskPart in Get-ChildItem -LiteralPath $taskOriginalLandscapeModule) {
    Copy-Item -LiteralPath $taskPart.FullName -Destination $taskLandscapeModule -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Landscape/Private/Landscape.cpp') -Destination (Join-Path $taskLandscapeModule 'Private/Landscape.cpp') -Force
$taskSignalModule = Join-Path $taskRuntime 'SignalProcessing'
$taskOriginalSignalModule = [IO.Path]::GetFullPath((Join-Path $taskOriginalSource 'Runtime/SignalProcessing'))
if (Test-Path -LiteralPath $taskSignalModule) {
    $taskSignalItem = Get-Item -LiteralPath $taskSignalModule
    if ($taskSignalItem.LinkType) {
        if ($taskSignalItem.LinkType -ne 'Junction' -or
            [IO.Path]::GetFullPath($taskSignalItem.Target) -ne $taskOriginalSignalModule -or
            -not [IO.Path]::GetFullPath($taskSignalModule).StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unexpected build-host SignalProcessing link; refusing to replace it'
        }
        Remove-Item -LiteralPath $taskSignalModule
    }
}
New-Item -ItemType Directory -Path $taskSignalModule -Force | Out-Null
foreach ($taskPart in Get-ChildItem -LiteralPath $taskOriginalSignalModule) {
    Copy-Item -LiteralPath $taskPart.FullName -Destination $taskSignalModule -Recurse -Force
}
$taskFloatArrayMath = 'Private/FloatArrayMath.cpp'
Copy-Item -LiteralPath (Join-Path $taskRoot "reference-engine/Engine/Source/Runtime/SignalProcessing/$taskFloatArrayMath") -Destination (Join-Path $taskSignalModule $taskFloatArrayMath) -Force
$taskSlateModule = Join-Path $taskRuntime 'SlateCore'
$taskOriginalSlateModule = [IO.Path]::GetFullPath((Join-Path $taskOriginalSource 'Runtime/SlateCore'))
if (Test-Path -LiteralPath $taskSlateModule) {
    $taskSlateItem = Get-Item -LiteralPath $taskSlateModule
    if ($taskSlateItem.LinkType) {
        if ($taskSlateItem.LinkType -ne 'Junction' -or
            [IO.Path]::GetFullPath($taskSlateItem.Target) -ne $taskOriginalSlateModule -or
            -not [IO.Path]::GetFullPath($taskSlateModule).StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unexpected build-host SlateCore link; refusing to replace it'
        }
        Remove-Item -LiteralPath $taskSlateModule
    }
}
New-Item -ItemType Directory -Path $taskSlateModule -Force | Out-Null
foreach ($taskPart in Get-ChildItem -LiteralPath $taskOriginalSlateModule) {
    Copy-Item -LiteralPath $taskPart.FullName -Destination $taskSlateModule -Recurse -Force
}
foreach ($taskSlateSource in @('PreprocessedFontGeometry.cpp', 'SlateSdfGenerator.cpp', 'FontCache.cpp')) {
    $taskSlateRelative = "Private/Fonts/$taskSlateSource"
    Copy-Item -LiteralPath (Join-Path $taskRoot "reference-engine/Engine/Source/Runtime/SlateCore/$taskSlateRelative") -Destination (Join-Path $taskSlateModule $taskSlateRelative) -Force
}
$taskSlateUiModule = Join-Path $taskRuntime 'Slate'
$taskOriginalSlateUiModule = [IO.Path]::GetFullPath((Join-Path $taskOriginalSource 'Runtime/Slate'))
if (Test-Path -LiteralPath $taskSlateUiModule) {
    $taskSlateUiItem = Get-Item -LiteralPath $taskSlateUiModule
    if ($taskSlateUiItem.LinkType) {
        if ($taskSlateUiItem.LinkType -ne 'Junction' -or
            [IO.Path]::GetFullPath($taskSlateUiItem.Target) -ne $taskOriginalSlateUiModule -or
            -not [IO.Path]::GetFullPath($taskSlateUiModule).StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unexpected build-host Slate link; refusing to replace it'
        }
        Remove-Item -LiteralPath $taskSlateUiModule
    }
}
New-Item -ItemType Directory -Path $taskSlateUiModule -Force | Out-Null
foreach ($taskPart in Get-ChildItem -LiteralPath $taskOriginalSlateUiModule) {
    Copy-Item -LiteralPath $taskPart.FullName -Destination $taskSlateUiModule -Recurse -Force
}
foreach ($taskSlateUiSource in @('Private/Framework/Animation/AttributeInterpolator.cpp', 'Public/Framework/Text/Web/WebPlatformTextField.h',
    'Private/Framework/Application/SlateApplication.cpp', 'Private/Framework/Application/SlateUser.cpp')) {
    $taskSlateUiDestination = Join-Path $taskSlateUiModule $taskSlateUiSource
    New-Item -ItemType Directory -Path (Split-Path $taskSlateUiDestination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskRoot "reference-engine/Engine/Source/Runtime/Slate/$taskSlateUiSource") -Destination $taskSlateUiDestination -Force
}
$taskOnline = Join-Path $taskRuntime 'Online'
$taskOriginalOnline = [IO.Path]::GetFullPath((Join-Path $taskOriginalSource 'Runtime/Online'))
if (Test-Path -LiteralPath $taskOnline) {
    $taskOnlineItem = Get-Item -LiteralPath $taskOnline
    if ($taskOnlineItem.LinkType) {
        if ($taskOnlineItem.LinkType -ne 'Junction' -or
            [IO.Path]::GetFullPath($taskOnlineItem.Target) -ne $taskOriginalOnline -or
            -not [IO.Path]::GetFullPath($taskOnline).StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unexpected build-host Online link; refusing to replace it'
        }
        Remove-Item -LiteralPath $taskOnline
    }
}
New-Item -ItemType Directory -Path $taskOnline -Force | Out-Null
foreach ($taskOnlineModule in Get-ChildItem -LiteralPath $taskOriginalOnline -Directory) {
    $taskOnlineDestination = Join-Path $taskOnline $taskOnlineModule.Name
    if ($taskOnlineModule.Name -notin @('ICMP', 'BuildPatchServices')) {
        if (-not (Test-Path -LiteralPath $taskOnlineDestination)) {
            New-Item -ItemType Junction -Path $taskOnlineDestination -Target $taskOnlineModule.FullName | Out-Null
        }
        continue
    }
    New-Item -ItemType Directory -Path $taskOnlineDestination -Force | Out-Null
    if ((Get-Item -LiteralPath $taskOnlineDestination).LinkType) { throw 'Online overlays must be local copies' }
    foreach ($taskOnlinePart in Get-ChildItem -LiteralPath $taskOnlineModule.FullName) {
        Copy-Item -LiteralPath $taskOnlinePart.FullName -Destination $taskOnlineDestination -Recurse -Force
    }
}
foreach ($taskOnlineOverlay in @('ICMP/Private/UDPPing.cpp', 'BuildPatchServices/Private/Installer/Verifier.cpp')) {
    Copy-Item -LiteralPath (Join-Path $taskRoot "reference-engine/Engine/Source/Runtime/Online/$taskOnlineOverlay") -Destination (Join-Path $taskOnline $taskOnlineOverlay) -Force
}
Write-Output 'P3_WEB_CORE_HOST target branch modules copied; local installed-source Engine, MovieSceneTracks, RenderCore, Renderer, Landscape, SignalProcessing, SlateCore, Slate, ICMP and BuildPatchServices copies overlay only the selected target files.'
