param(
    [string]$Engine = 'H:/UE_5.8',
    [ValidateSet('NullRHI-only', 'WebGPU-SM5', 'WebGPU-ES31')][string]$Mode = 'NullRHI-only',
    [ValidateSet('Minimal', 'DefaultTemplate', 'Project')][string]$Scene = 'Minimal',
    [string]$Project,
    [string]$Map,
    [string]$Profile,
    [ValidateSet('Uncompressed', 'BC')][string]$TextureCompression = 'Uncompressed',
    [switch]$CompressHDRCubemaps,
    [ValidatePattern('^[a-z0-9]+(?:-[a-z0-9]+)*$')][string]$ReportId,
    [switch]$DisableProjectSkyLight,
    [switch]$StopOnShaderError,
    [switch]$ValidateShaderJobCache,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskHost = Join-Path $taskRoot '.tools/ue58-web-platform-host/Engine'
$taskWebGPU = $Mode -ne 'NullRHI-only'
$taskES31 = $Mode -eq 'WebGPU-ES31'
if ($Scene -eq 'DefaultTemplate' -and -not $taskES31) { throw 'DefaultTemplate requires WebGPU-ES31.' }
$taskMap = if ($Scene -eq 'DefaultTemplate') { '/Engine/Maps/Templates/Template_Default' } else { '/Game/WebMinimal' }
if ($Scene -eq 'Project') {
    if (-not $taskES31 -or -not $Project -or -not $Map -or -not $Profile -or -not $ReportId) {
        throw 'Project Cook requires WebGPU-ES31, Project, Map, Profile and ReportId.'
    }
    if ($Map -notmatch '^/Game/[a-zA-Z0-9_/]+$') { throw 'Project Map must be an absolute /Game package name.' }
    $taskMap = $Map
}
if ($DisableProjectSkyLight -and $Scene -ne 'Project') { throw 'SkyLight exclusion requires Project Cook.' }
if ($TextureCompression -eq 'BC' -and -not $taskWebGPU) { throw 'BC compression requires WebGPU Cook.' }
if ($CompressHDRCubemaps -and $TextureCompression -ne 'BC') { throw 'HDR cube compression requires BC Cook.' }
$taskFormat = if ($taskES31) { 'SF_WEBGPU_ES31' } else { 'SF_WEBGPU_SM5' }
$taskShaderPlatformName = if ($taskES31) { 'SP_WEBGPU_ES31' } else { 'SP_WEBGPU_SM5' }
if ($taskWebGPU) { $taskHost = Join-Path $taskRoot '.tools/ue58-web-cook-host/Engine' }
if ($taskES31) { $taskHost = Join-Path $taskRoot '.tools/ue58-web-es31-cook-host/Engine' }
$taskHostDDPI = Join-Path $taskHost 'Platforms/Web/Config/DataDrivenPlatformInfo.ini'
$taskDDPI = Join-Path $taskRoot 'reference-engine/Engine/Platforms/Web/Config/DataDrivenPlatformInfo.ini'
if ($taskES31) { $taskDDPI = Join-Path $PSScriptRoot 'cook-profiles/WebGPU-ES31.ini' }
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
if ($Scene -eq 'Project') { $taskProject = [IO.Path]::GetFullPath($Project) }
$taskResults = Join-Path $PSScriptRoot 'results'
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskPrefix = if ($taskWebGPU) { 'web-engine-webgpu-cook' } else { 'web-engine-cook' }
if ($taskES31) { $taskPrefix = 'web-engine-webgpu-es31-cook' }
if ($Scene -eq 'DefaultTemplate') { $taskPrefix = 'web-engine-webgpu-es31-default-cook' }
if ($Scene -eq 'Project') { $taskPrefix = "web-project-$ReportId-cook" }
$taskOutput = Join-Path $PSScriptRoot "build/$taskPrefix/$taskStamp"
$taskLog = Join-Path $taskResults "$taskPrefix-$taskStamp.log"
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskPreviousTint = $env:WEBGPU_TINT_DIR
$taskPreviousIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
function Get-TaskAudit([string]$File) {
    return @{ file = $File; sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$taskReport = [ordered]@{
    date = Get-Date -Format o
    pass = $false
    mode = $Mode
    scene = $Scene
    map = $taskMap
    project = $taskProject
    projectName = [IO.Path]::GetFileNameWithoutExtension($taskProject)
    architecture = 'wasm64'
    disabledSkyLight = [bool]$DisableProjectSkyLight
    textureCompression = $TextureCompression
    compressHDRCubemaps = [bool]$CompressHDRCubemaps
    shaderFormats = @($(if ($taskWebGPU) { $taskFormat }))
    stopOnShaderError = [bool]$StopOnShaderError
    validateShaderJobCache = [bool]$ValidateShaderJobCache
    jobCacheDDCDisabled = [bool]($taskWebGPU -and $ValidateShaderJobCache)
    shaderMapDDCDisabled = [bool]($taskWebGPU -and $ValidateShaderJobCache)
    completeUEScene = $false
    sourceEngineVersion = '5.8.0-installed-host'
    targetEngineVersion = '5.8.3-source-branch'
    output = $taskOutput
}
New-Item -ItemType Directory -Path $taskResults, $taskOutput -Force | Out-Null
try {
    $taskProcess.ProcessorAffinity = [IntPtr]3
    if (-not $SkipBuild) {
        $taskBuildLog = Join-Path $taskResults "web-cook-module-build-$taskStamp.log"
        $taskModuleProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
        & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development `
            "-Project=$taskModuleProject" -WaitMutex -NoHotReloadFromIDE -NoUBA -MaxParallelActions=1 *> $taskBuildLog
        $taskReport.moduleBuildLog = Get-TaskAudit $taskBuildLog
        if ($LASTEXITCODE -ne 0) { throw "Web Cook module build failed: $taskBuildLog" }
    }
    if ($Scene -eq 'Minimal') {
        & (Join-Path $PSScriptRoot 'prepare-web-minimal-map.ps1') -Engine $Engine
        $taskReport.minimalMapPreparation = Get-TaskAudit (Join-Path $taskResults 'web-minimal-map-results.json')
        $taskReport.minimalMap = Get-TaskAudit (Join-Path $taskRoot 'tests/ue-shader-host/Content/WebMinimal.umap')
    } elseif ($Scene -eq 'DefaultTemplate') {
        $taskReport.templateMap = Get-TaskAudit (Join-Path $Engine 'Engine/Content/Maps/Templates/Template_Default.umap')
    } else {
        $taskMapFile = Join-Path (Split-Path -Parent $taskProject) ("Content/" + $taskMap.Substring(6) + '.umap')
        $taskReport.projectMap = Get-TaskAudit $taskMapFile
    }
    if ($taskWebGPU) {
        $taskPrepareLog = Join-Path $taskResults "web-cook-host-$taskStamp.log"
        $taskPrepareArguments = @((Join-Path $PSScriptRoot 'prepare-web-cook-host.cjs'))
        if ($taskES31) { $taskPrepareArguments += '--es31' }
        & node @taskPrepareArguments *> $taskPrepareLog
        if ($LASTEXITCODE -ne 0) { throw "Web Cook host preparation failed: $taskPrepareLog" }
        $taskPrepareReport = if ($taskES31) { 'web-es31-cook-host-results.json' } else { 'web-cook-host-results.json' }
        $taskPreparationSnapshot = Join-Path $taskOutput 'host-preparation-report.json'
        Copy-Item -LiteralPath (Join-Path $taskResults $taskPrepareReport) -Destination $taskPreparationSnapshot
        $taskReport.hostPreparationReport = Get-TaskAudit $taskPreparationSnapshot
        $taskReport.hostPreparationLog = Get-TaskAudit $taskPrepareLog
        $taskReport.shaderSourcesReport = Get-TaskAudit (Join-Path $taskResults 'web-cook-shader-sources.json')
    }
    # Config is an installed-engine junction; add only the isolated platform extension.
    $taskWeb = Join-Path $taskHost 'Platforms/Web'
    foreach ($taskDirectory in @((Join-Path $taskHost 'Platforms'), $taskWeb, (Join-Path $taskWeb 'Config'))) {
        New-Item -ItemType Directory -Path $taskDirectory -Force | Out-Null
        if ((Get-Item -LiteralPath $taskDirectory).LinkType) { throw "Expected local directory: $taskDirectory" }
    }
    if ($taskWebGPU) {
        Copy-Item -LiteralPath $taskDDPI -Destination $taskHostDDPI -Force
    } else {
        # The legacy sample host also registers WebGPU/47. NullRHI needs only Web's package layout.
        $taskInPlatformSection = $false
        $taskLayout = foreach ($taskLine in Get-Content -LiteralPath $taskDDPI) {
            if ($taskLine -match '^\s*\[([^\]]+)\]\s*$') {
                $taskInPlatformSection = $Matches[1] -eq 'DataDrivenPlatformInfo'
            }
            if ($taskInPlatformSection) { $taskLine }
        }
        if (-not $taskLayout -or $taskLayout -match '^\s*\[ShaderPlatform') { throw 'Invalid NullRHI platform layout.' }
        $taskLayout | Set-Content -LiteralPath $taskHostDDPI -Encoding utf8
    }
    $taskPackages = @(
        '/Engine/EngineMaterials/WorldGridMaterial',
        '/Engine/EngineMaterials/DefaultLightFunctionMaterial',
        '/Engine/EngineMaterials/DefaultDeferredDecalMaterial',
        '/Engine/EngineMaterials/DefaultPostProcessMaterial',
        '/Engine/EngineResources/DefaultTexture',
        '/Engine/EngineResources/WhiteSquareTexture',
        $taskMap
    )
    if ($Scene -eq 'DefaultTemplate') {
        $taskPackages += '/Engine/EngineMaterials/FastBlueNoise_scalar_128x128x8'
    }
    # The installed native UBT cannot validate a Web SDK. The custom module handles this cook-only path.
    $taskArguments = @($taskProject, '-run=Cook', '-TargetPlatform=Web',
        '-ddpi:Web:bIsEnabled=false',
        "-OutputDir=$taskOutput", "-PACKAGE=$($taskPackages -join '+')",
        '-SkipZenStore', '-NoDefaultMaps', '-NoGameAlwaysCook',
        '-CookProcessCount=1', '-unattended', '-nop4', '-nosplash', '-nosound',
        '-nullrhi', '-sm5', '-processaffinity=2', '-UTF8Output', "-abslog=$taskLog")
    if ($Scene -ne 'Project') { $taskArguments += '-SkipSoftReferences' }
    if ($DisableProjectSkyLight) { $taskArguments += '-WebProjectDisableSkyLightCook' }
    if ($TextureCompression -eq 'BC') { $taskArguments += '-WebTextureCompressionBC' }
    if ($CompressHDRCubemaps) { $taskArguments += '-WebCompressHDRCubemaps' }
    if ($TextureCompression -eq 'BC') {
        # Use the bundled DXT/ISPC encoders; the browser receives standard BC blocks.
        $taskArguments += '-ini:Engine:[AlternateTextureCompression]:TextureCompressionFormat='
    }
    if ($taskWebGPU) {
        $taskArguments += @('-WebGPUCook', '-noshaderworker',
            '-ini:Game:[/Script/UnrealEd.ProjectPackagingSettings]:bShareMaterialShaderCode=True',
            '-ini:Game:[/Script/UnrealEd.ProjectPackagingSettings]:bSharedMaterialNativeLibraries=False',
            '-ini:Engine:[SystemSettings]:r.ShaderDevelopmentMode=0')
        # Some native compiler helpers read the host CVar instead of the target-platform CVar.
        $taskMinimalConfig = Join-Path $taskRoot 'tests/ue-shader-host/Config/Web/WebEngine.ini'
        if ($Scene -eq 'DefaultTemplate') { $taskMinimalConfig = Join-Path $PSScriptRoot 'cook-profiles/DefaultTemplateEngine.ini' }
        if ($Scene -eq 'Project') { $taskMinimalConfig = [IO.Path]::GetFullPath($Profile) }
        $taskMinimalSettings = @(Get-Content -LiteralPath $taskMinimalConfig | Where-Object { $_ -match '^[a-zA-Z][a-zA-Z0-9.]*=' })
        if (-not $taskMinimalSettings.Count) { throw 'Minimal Web renderer settings are missing.' }
        $taskArguments += @($taskMinimalSettings | ForEach-Object { "-ini:Engine:[SystemSettings]:$_" })
        $taskReport.minimalRendererConfig = Get-TaskAudit $taskMinimalConfig
        if ($StopOnShaderError) { $taskArguments += '-WebGPUStopOnShaderError' }
        if ($ValidateShaderJobCache) {
            $taskArguments += @('-noshaderddc',
                '-ini:Engine:[SystemSettings]:r.ShaderCompiler.DebugValidateJobCache=1',
                '-ini:Engine:[SystemSettings]:r.ShaderCompiler.JobCacheDDC=0')
        }
        if ($taskES31) { $taskArguments += '-WebGPUES31Cook' }
        if ($Scene -eq 'DefaultTemplate') { $taskArguments += '-WebDefaultCloudDensityCook' }
        $env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
        $env:WEBGPU_INTERMEDIATE_DIR = Join-Path $taskOutput 'ShaderConversion'
    } else {
        $taskArguments += @('-WebNullRHICook', '-ForceDisableSaveGlobalShaders')
    }
    $taskReport.arguments = $taskArguments
    & (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-Cmd.exe') @taskArguments *> "$taskLog.console.txt"
    $taskReport.exitCode = $LASTEXITCODE
    if (Test-Path -LiteralPath $taskLog) { $taskReport.log = Get-TaskAudit $taskLog }
    if ($LASTEXITCODE -ne 0) { throw "Web Cook failed: $taskLog" }
    $taskAssets = @(Get-ChildItem -LiteralPath $taskOutput -File -Recurse |
        Where-Object { ($_.Extension -in @('.uasset', '.umap', '.uexp', '.ubulk') -or
            ($taskWebGPU -and ($_.Extension -eq '.ushaderbytecode' -or $_.Name -eq "GlobalShaderCache-$taskShaderPlatformName.bin"))) -and
            -not $_.FullName.StartsWith((Join-Path $taskOutput 'ShaderConversion'), [StringComparison]::OrdinalIgnoreCase) })
    if (-not $taskAssets.Count) { throw 'Cook produced no loose packages.' }
    if ($taskWebGPU) {
        if (-not ($taskAssets | Where-Object Name -eq "GlobalShaderCache-$taskShaderPlatformName.bin") -or
            -not ($taskAssets | Where-Object Name -eq "ShaderArchive-Global-$taskFormat-$taskShaderPlatformName.ushaderbytecode")) {
            throw 'WebGPU Cook must produce both the real Global shader map and shader code archive.'
        }
    }
    $taskReport.products = @($taskAssets | ForEach-Object { Get-TaskAudit $_.FullName })
    $taskReport.totalBytes = ($taskAssets | Measure-Object -Property Length -Sum).Sum
    $taskReport.pass = $true
} catch {
    $taskReport.failure = $_.ToString()
    throw
} finally {
    $taskReport.hostProducts = @(
        (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebCookTargetPlatform.dll'),
        (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebCookTargetPlatformSettings.dll'),
        (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-TextureFormatWebCloud.dll'),
        (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-Cmd.exe'),
        (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-BuildSettings.dll'),
        (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-RenderCore.dll'),
        (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-Renderer.dll'),
        (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-Engine.dll'),
        $taskHostDDPI
    ) | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { Get-TaskAudit $_ }
    if ($taskWebGPU) {
        $taskInventory = Join-Path $taskOutput 'ShaderConversion/inventory.json'
        if (Test-Path -LiteralPath $taskInventory) {
            $taskReport.shaderInventory = @{
                artifact = Get-TaskAudit $taskInventory
                detail = Get-Content -LiteralPath $taskInventory -Raw | ConvertFrom-Json
            }
            $taskSettings = $taskReport.shaderInventory.detail.settings
            $taskReport.minimalRendererSettingsVerified = $null -ne $taskSettings -and
                @($taskSettings.PSObject.Properties | Where-Object {
                    $null -eq $_.Value.host -or $null -eq $_.Value.target -or
                    $_.Value.host -ne $_.Value.target
                }).Count -eq 0
        }
        $taskReport.shaderFailures = @(Get-ChildItem -LiteralPath $taskOutput -Filter failure.json -File -Recurse |
            ForEach-Object { @{ diagnostic = Get-TaskAudit $_.FullName; detail = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json } })
        $taskReport.hostProducts += Get-TaskAudit (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPUShaderFormat.dll')
    }
    $taskReport.sourceFiles = @(
        (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/WebGPUShader.uplugin'),
        (Join-Path $taskRoot 'tests/ue-shader-host/Config/DefaultEditor.ini'),
        (Join-Path $taskRoot 'tests/ue-shader-host/Config/DefaultDeviceProfiles.ini'),
        (Join-Path $taskRoot 'tests/ue-shader-host/Config/DefaultEngine.ini'),
        (Join-Path $taskRoot 'tests/ue-shader-host/Config/Web/WebEngine.ini'),
        (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderHostTargetPlatform/Private/WebGPUShaderHostTargetPlatform.cpp'),
        (Join-Path $taskRoot 'reference-engine/Engine/Platforms/Web/Config/DataDrivenPlatformInfo.ini'),
        $PSCommandPath
    ) + @(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Source/TextureFormatWebCloud') -File -Recurse |
        ForEach-Object { $_.FullName }) + @(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebCookTargetPlatform') -File -Recurse |
        ForEach-Object { $_.FullName }) + @(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebCookTargetPlatformSettings') -File -Recurse |
        ForEach-Object { $_.FullName }) | ForEach-Object { Get-TaskAudit $_ }
    $taskReport.sourceFiles += @('Public/WebMinimalMapCommandlet.h', 'Private/WebMinimalMapCommandlet.cpp') |
        ForEach-Object { Get-TaskAudit (Join-Path $taskRoot "tests/ue-shader-host/Source/UEShaderHost/$_") }
    $taskReport.sourceFiles += Get-TaskAudit (Join-Path $PSScriptRoot 'prepare-web-minimal-map.ps1')
    if ($taskReport.minimalMap) { $taskReport.sourceFiles += $taskReport.minimalMap }
    if ($taskReport.templateMap) { $taskReport.sourceFiles += $taskReport.templateMap }
    if ($taskReport.projectMap) {
        $taskReport.sourceFiles += $taskReport.projectMap
        $taskReport.sourceFiles += Get-TaskAudit $taskProject
        $taskReport.sourceFiles += @(Get-ChildItem -LiteralPath (Join-Path (Split-Path -Parent $taskProject) 'Config') -File -Recurse |
            ForEach-Object { Get-TaskAudit $_.FullName })
    }
    if ($taskReport.minimalRendererConfig) { $taskReport.sourceFiles += $taskReport.minimalRendererConfig }
    if ($taskWebGPU) {
        $taskReport.sourceFiles += @(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat') -File -Recurse |
            ForEach-Object { Get-TaskAudit $_.FullName })
        $taskReport.sourceFiles += Get-TaskAudit (Join-Path $PSScriptRoot 'prepare-web-cook-host.cjs')
        $taskReport.sourceFiles += Get-TaskAudit (Join-Path $PSScriptRoot 'prepare-web-cook-shaders.cjs')
        $taskReport.nativeRenderCoreBuildReport = Get-TaskAudit (Join-Path $taskResults 'native-rendercore-build-results.json')
        $taskReport.nativeRendererBuildReport = Get-TaskAudit (Join-Path $taskResults 'native-renderer-build-results.json')
        $taskReport.sourceFiles += Get-TaskAudit (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Renderer/Private/VolumetricCloudRendering.cpp')
        $taskReport.sourceFiles += Get-TaskAudit (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Renderer/Private/VolumetricRenderTarget.cpp')
        $taskReport.sourceFiles += Get-TaskAudit (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Renderer/Private/ScreenPass.cpp')
        $taskReport.sourceFiles += Get-TaskAudit (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Renderer/Private/MobileFogRendering.cpp')
        $taskReport.sourceFiles += Get-TaskAudit (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Engine/Private/Materials/MaterialExpressions.cpp')
        $taskReport.sourceFiles += Get-TaskAudit (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/RenderCore/Private/Shader.cpp')
        $taskReport.sourceFiles += Get-TaskAudit (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp')
        $taskReport.sourceFiles += Get-TaskAudit (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/RenderCore/Public/WebShaderPlatform.h')
        $taskReport.sourceFiles += Get-TaskAudit (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/RenderCore/Private/VertexFactory.cpp')
        $taskReport.sourceFiles += Get-TaskAudit (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Engine/Private/Materials/MeshMaterialShader.cpp')
        $taskReport.sourceFiles += Get-TaskAudit (Join-Path $taskRoot 'reference-engine/Engine/Shaders/Private/DeferredDecal.usf')
        $taskReport.sourceFiles += Get-TaskAudit (Join-Path $taskRoot 'reference-engine/Engine/Shaders/Private/PostProcessTonemap.usf')
        if ($taskES31) { $taskReport.sourceFiles += Get-TaskAudit $taskDDPI }
        $taskReport.boundary = "Standard CookCommandlet for $Mode with real $taskFormat conversion and shared shader archives. Native compiler runs in-process on the isolated installed 5.8.0 host. Cook success does not verify wasm64 shader-map deserialization, WebGPURHI shader loading, Engine Tick or scene rendering; see the separate browser runtime report."
    }
    $taskReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskResults "$taskPrefix-results.json") -Encoding utf8
    $env:WEBGPU_TINT_DIR = $taskPreviousTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskPreviousIntermediate
    $taskProcess.ProcessorAffinity = $taskAffinity
}
