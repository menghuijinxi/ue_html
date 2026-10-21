param(
    [string]$Engine = 'H:/UE_5.8',
    [ValidateRange(1, 16)][int]$MaxParallelActions = 1,
    [switch]$SkipHostPreparation
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskHost = Join-Path $taskRoot '.tools/ue58-web-build-host/Engine'
$taskUbt = Join-Path $taskHost 'Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll'
$taskDotnet = Join-Path $Engine 'Engine/Binaries/ThirdParty/DotNet/10.0/win-x64/dotnet.exe'
if (-not (Test-Path -LiteralPath $taskUbt)) { throw 'Run build-web-ubt.ps1 to prepare the isolated Web UBT first.' }
& (Join-Path $PSScriptRoot 'build-web-blake3.ps1')
& (Join-Path $PSScriptRoot 'build-web-libpng.ps1')
if (-not $SkipHostPreparation) { & (Join-Path $PSScriptRoot 'prepare-web-core-host.ps1') -Engine $Engine }
$taskPlatforms = Join-Path $taskHost 'Platforms'
$taskWeb = Join-Path $taskPlatforms 'Web'
foreach ($taskDirectory in @($taskPlatforms, $taskWeb)) {
    New-Item -ItemType Directory -Path $taskDirectory -Force | Out-Null
    if ((Get-Item -LiteralPath $taskDirectory).LinkType) { throw 'Build-host platform directories must be local.' }
}
foreach ($taskPart in @('Config', 'Source')) {
    Copy-Item -LiteralPath (Join-Path $taskRoot "reference-engine/Engine/Platforms/Web/$taskPart") -Destination $taskWeb -Recurse -Force
}
$taskConfigDirectory = Join-Path $taskHost 'Saved/UnrealBuildTool'
New-Item -ItemType Directory -Path $taskConfigDirectory -Force | Out-Null
if ((Get-Item -LiteralPath $taskConfigDirectory).LinkType) { throw 'Build-host UBT configuration must be local.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'WebEngine.BuildConfiguration.xml') -Destination (Join-Path $taskConfigDirectory 'BuildConfiguration.xml') -Force
# Newly discovered platform rule subclasses do not always invalidate an existing target makefile.
$taskMakefile = [IO.Path]::GetFullPath((Join-Path $taskRoot 'tests/ue-web-smoke/Intermediate/Build/Web/wasm64/UEWebEngine/Development/Makefile.bin'))
if (-not $taskMakefile.StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected target makefile path.' }
Remove-Item -LiteralPath $taskMakefile -Force -ErrorAction SilentlyContinue
$taskResults = Join-Path $PSScriptRoot 'results'
New-Item -ItemType Directory -Path $taskResults -Force | Out-Null
$taskLog = Join-Path $taskResults ("web-engine-full-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$taskReportFile = Join-Path $taskResults 'web-engine-full-build-results.json'
$taskSdkBefore = $env:WEB_EMSDK_ROOT
$taskConfigBefore = $env:EM_CONFIG
$taskProcess = Get-Process -Id $PID
$taskAffinityBefore = $taskProcess.ProcessorAffinity
$taskReport = [ordered]@{
    date = (Get-Date -Format o)
    architecture = 'wasm64'
    maxParallelActions = $MaxParallelActions
    pass = $false
    buildSucceeded = $false
    fullBuildAttempted = $true
    engineLoopBrowserTickVerified = $false
    completeBrowserUERuntime = $false
    completeUEScene = $false
}
function Get-TaskAudit([string]$File) {
    return @{ file = $File; sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
}
try {
    $taskWorkerThreads = [Math]::Min([Environment]::ProcessorCount, [Math]::Max(2, $MaxParallelActions * 2))
    $taskWorkerMask = [long]([Math]::Pow(2, [Math]::Min(32, $taskWorkerThreads)) - 1)
    $taskProcess.ProcessorAffinity = [IntPtr]($taskAffinityBefore.ToInt64() -band $taskWorkerMask)
    $env:WEB_EMSDK_ROOT = Join-Path $taskRoot '.tools/emsdk'
    # Emscripten keys its shared cache by the literal LLVM_ROOT expanded from this path.
    $env:EM_CONFIG = (Join-Path $env:WEB_EMSDK_ROOT '.emscripten').Replace('\', '/')
    $taskArguments = @($taskUbt, 'UEWebEngine', 'Web', 'Development',
        "-Project=$(Join-Path $taskRoot 'tests/ue-web-smoke/UEWebSmoke.uproject')",
        '-NoUBA', "-MaxParallelActions=$MaxParallelActions", '-NoUBTMakefiles')
    Write-Output "Building the full Engine Target. Log: $taskLog"
    & $taskDotnet @taskArguments *> $taskLog
    $taskExit = $LASTEXITCODE
    $taskText = Get-Content -LiteralPath $taskLog -Raw
    $taskReport.exitCode = $taskExit
    $taskReport.buildSucceeded = $taskExit -eq 0 -and $taskText.Contains('Result: Succeeded')
    $taskReport.products = @()
    if ($taskReport.buildSucceeded) {
        $taskReport.products = @('UEWebEngine.js', 'UEWebEngine.wasm', 'UEWebEngine.target') | ForEach-Object {
            Get-TaskAudit (Join-Path $taskRoot "tests/ue-web-smoke/Binaries/Web/$_")
        }
    }
    $taskReport.pass = $taskReport.buildSucceeded
    $taskReport.fullLinkAttempted = $taskText -match '\] Web [Ll]ink '
    if ($taskReport.fullLinkAttempted) {
        $taskLinkResponse = Join-Path $taskRoot 'tests/ue-web-smoke/Intermediate/Build/Web/wasm64/UEWebEngine/Development/UEWebEngine.js.rsp'
        $taskLinkResponseCopy = "$taskLog.link.rsp"
        Copy-Item -LiteralPath $taskLinkResponse -Destination $taskLinkResponseCopy -Force
        $taskReport.linkResponse = Get-TaskAudit $taskLinkResponseCopy
    }
    $taskReport.compilerErrors = @([regex]::Matches($taskText, '(?m)^.*(?:fatal )?error:.*$') | ForEach-Object { $_.Value.Trim() } | Select-Object -Unique)
    $taskReport.actionsStarted = @([regex]::Matches($taskText, '(?m)^\[\d+/\d+\].*$') | ForEach-Object { $_.Value.Trim() })
    $taskReport.log = Get-TaskAudit $taskLog
    $taskVerbose = Join-Path $taskHost 'Programs/UnrealBuildTool/Log.txt'
    if (Test-Path -LiteralPath $taskVerbose) {
        $taskVerboseCopy = "$taskLog.ubt.txt"
        Copy-Item -LiteralPath $taskVerbose -Destination $taskVerboseCopy -Force
        $taskReport.ubtLog = Get-TaskAudit $taskVerboseCopy
        $taskReport.failedProcesses = @(Select-String -LiteralPath $taskVerboseCopy -Pattern 'Exited with error code' | ForEach-Object { $_.Line.Trim() })
    }
    $taskReport.ubt = Get-TaskAudit $taskUbt
    $taskFiles = @($PSCommandPath, (Join-Path $PSScriptRoot 'WebEngine.BuildConfiguration.xml'),
        (Join-Path $PSScriptRoot 'prepare-web-core-host.ps1'))
    $taskBlakeBuild = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'results/web-blake3-build-results.json') | ConvertFrom-Json
    if (-not $taskBlakeBuild.pass) { throw 'Portable BLAKE3 archive must build successfully' }
    $taskFiles += @($taskBlakeBuild.sourceFiles | ForEach-Object { $_.file })
    $taskPngBuild = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'results/web-libpng-build-results.json') | ConvertFrom-Json
    if (-not $taskPngBuild.pass) { throw 'Portable libPNG archive must build successfully' }
    $taskFiles += @($taskPngBuild.sourceFiles | ForEach-Object { $_.file })
    foreach ($taskOnlineOverlay in @('ICMP/Private/UDPPing.cpp', 'BuildPatchServices/Private/Installer/Verifier.cpp')) {
        $taskFiles += Join-Path $taskRoot "reference-engine/Engine/Source/Runtime/Online/$taskOnlineOverlay"
        $taskFiles += Join-Path $taskHost "Source/Runtime/Online/$taskOnlineOverlay"
    }
    $taskFiles += @(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'reference-engine/Engine/Platforms/Web') -File -Recurse | ForEach-Object { $_.FullName })
    $taskFiles += @(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'tests/ue-web-smoke/Source') -File -Recurse | ForEach-Object { $_.FullName })
    $taskFiles += @(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private') -File |
        Where-Object { $_.Name -in @('WebGPUDynamicRHI.cpp', 'WebGPUDynamicRHI.h', 'WebGPUUnsupportedRHI.h',
            'WebGPUTransitions.cpp', 'WebGPUBufferLock.cpp', 'WebGPUBreadcrumbs.cpp', 'WebGPUViewport.cpp') } |
        ForEach-Object { $_.FullName })
    $taskFiles += @(Get-ChildItem -LiteralPath (Join-Path $taskRoot '.tools/emdawnwebgpu-v20261009.190412/emdawnwebgpu_pkg') -File -Recurse |
        Where-Object { $_.Extension -in @('.py', '.cpp', '.h', '.js') } | ForEach-Object { $_.FullName })
    $taskFiles += Join-Path $taskHost 'Source/Runtime/Engine/Private/GameEngine.cpp'
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Engine/Private/SceneTexturesConfig.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/Engine/Private/SceneTexturesConfig.cpp'
    $taskFiles += @(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Experimental/ChaosCore') -File -Recurse | ForEach-Object { $_.FullName })
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Core/Public/Math/UnrealMathFPU.h'
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Core/Private/GenericPlatform/GenericPlatformProcess.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/Core/Private/GenericPlatform/GenericPlatformProcess.cpp'
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Engine/Private/Shader/Preshader2.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/Engine/Private/Shader/Preshader2.cpp'
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Engine/Private/SparseVolumeTexture/SparseVolumeTextureData.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/Engine/Private/SparseVolumeTexture/SparseVolumeTextureData.cpp'
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
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/MovieSceneTracks/Private/Sections/MovieSceneSkeletalAnimationSection.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/MovieSceneTracks/Private/Sections/MovieSceneSkeletalAnimationSection.cpp'
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/RenderCore/Private/ShaderLibrary/ShaderCodeArchive.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/RenderCore/Private/ShaderLibrary/ShaderCodeArchive.cpp'
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Renderer/Private/SceneCulling/SceneCullingRenderer.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/Renderer/Private/SceneCulling/SceneCullingRenderer.cpp'
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Renderer/Private/FXRenderingUtils.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/Renderer/Private/FXRenderingUtils.cpp'
    foreach ($taskShaderOverlay in @('RenderCore/Private/Shader.cpp', 'RenderCore/Private/RenderUtils.cpp',
        'RenderCore/Public/WebShaderPlatform.h', 'Engine/Private/SkeletalRenderGPUSkin.cpp',
        'Renderer/Private/LightGridInjection.cpp', 'Renderer/Private/MobileFogRendering.cpp',
        'Renderer/Private/MobileBasePassRendering.cpp', 'Renderer/Private/MobileShadingRenderer.cpp',
        'Renderer/Private/PostProcess/PostProcessMobile.cpp',
        'Renderer/Private/PostProcess/PostProcessCombineLUTs.cpp',
        'Renderer/Private/SkyAtmosphereRendering.cpp', 'Renderer/Private/SkyPassRendering.cpp')) {
        $taskFiles += Join-Path $taskRoot "reference-engine/Engine/Source/Runtime/$taskShaderOverlay"
        $taskFiles += Join-Path $taskHost "Source/Runtime/$taskShaderOverlay"
    }
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/SignalProcessing/Private/FloatArrayMath.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/SignalProcessing/Private/FloatArrayMath.cpp'
    foreach ($taskSlateSource in @('PreprocessedFontGeometry.cpp', 'SlateSdfGenerator.cpp', 'FontCache.cpp')) {
        $taskFiles += Join-Path $taskRoot "reference-engine/Engine/Source/Runtime/SlateCore/Private/Fonts/$taskSlateSource"
        $taskFiles += Join-Path $taskHost "Source/Runtime/SlateCore/Private/Fonts/$taskSlateSource"
    }
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Slate/Private/Framework/Animation/AttributeInterpolator.cpp'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/Slate/Private/Framework/Animation/AttributeInterpolator.cpp'
    $taskFiles += Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Slate/Public/Framework/Text/Web/WebPlatformTextField.h'
    $taskFiles += Join-Path $taskHost 'Source/Runtime/Slate/Public/Framework/Text/Web/WebPlatformTextField.h'
    foreach ($taskSlateUiSource in @('SlateApplication.cpp', 'SlateUser.cpp')) {
        $taskFiles += Join-Path $taskRoot "reference-engine/Engine/Source/Runtime/Slate/Private/Framework/Application/$taskSlateUiSource"
        $taskFiles += Join-Path $taskHost "Source/Runtime/Slate/Private/Framework/Application/$taskSlateUiSource"
    }
    $taskReport.sourceFiles = @($taskFiles | ForEach-Object { Get-TaskAudit $_ })
    $taskReport.boundary = 'Full normal UBT Engine Target attempt, using target 5.8.3 Core/TraceLog/ApplicationCore/CoreUObject/Launch/ChaosCore and selected target files in local installed-source Engine, MovieSceneTracks, RenderCore, Renderer, SignalProcessing, SlateCore, Slate, ICMP and BuildPatchServices copies with installed 5.8.0 dependencies. BLAKE3 1.3.1 and libPNG 1.6.44 portable archives use target third-party sources. The source audit lists each target overlay. Web excludes Slate font SDF generation, nonlinear attribute easing, native UDP probes and threaded patch verification but retains font data serialization, linear easing, synchronous patch verification and forced UMG/Slate dependencies. A successful compile/link still does not verify browser initialization, Engine ticking, WebGPU rendering, Cook or a scene. Action counts are not feature completion percentages.'
} catch {
    $taskReport.failure = $_.Exception.Message
    throw
} finally {
    $env:WEB_EMSDK_ROOT = $taskSdkBefore
    $env:EM_CONFIG = $taskConfigBefore
    $taskProcess.ProcessorAffinity = $taskAffinityBefore
    $taskReport | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $taskReportFile -Encoding utf8
}
Write-Output ([pscustomobject]$taskReport | Select-Object pass, buildSucceeded, exitCode, fullLinkAttempted, compilerErrors, failedProcesses, log | ConvertTo-Json -Depth 5)
if (-not $taskReport.buildSucceeded) { throw "Full Engine Target build failed; see $taskLog" }
