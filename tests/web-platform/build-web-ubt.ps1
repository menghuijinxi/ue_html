param([string]$Engine = 'H:/UE_5.8')
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build-web-blake3.ps1')
& (Join-Path $PSScriptRoot 'build-web-libpng.ps1')
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskHost = Join-Path $taskRoot '.tools/ue58-web-build-host/Engine'
$taskUbt = Join-Path $taskHost 'Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll'
$taskDotnet = Join-Path $Engine 'Engine/Binaries/ThirdParty/DotNet/10.0/win-x64/dotnet.exe'
New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'results') -Force | Out-Null
New-Item -ItemType Directory -Path $taskHost -Force | Out-Null
& (Join-Path $PSScriptRoot 'prepare-web-core-host.ps1') -Engine $Engine
foreach ($taskName in @('Config')) {
    $taskDestination = Join-Path $taskHost $taskName
    if (-not (Test-Path -LiteralPath $taskDestination)) {
        New-Item -ItemType Junction -Path $taskDestination -Target (Join-Path $Engine "Engine/$taskName") | Out-Null
    }
}
$taskBuild = Join-Path $taskHost 'Build'
if (Test-Path -LiteralPath $taskBuild) {
    $taskBuildItem = Get-Item -LiteralPath $taskBuild
    if ($taskBuildItem.LinkType) {
        if ($taskBuildItem.LinkType -ne 'Junction' -or
            [IO.Path]::GetFullPath($taskBuildItem.Target) -ne [IO.Path]::GetFullPath((Join-Path $Engine 'Engine/Build')) -or
            -not [IO.Path]::GetFullPath($taskBuild).StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unexpected build-host Build link; refusing to replace it'
        }
        Remove-Item -LiteralPath $taskBuild
    }
}
# A local Build directory avoids treating this source-build harness as a Launcher installed build.
New-Item -ItemType Directory -Path $taskBuild -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $Engine 'Engine/Build/Build.version') -Destination $taskBuild -Force
# Platforms is local so extension configuration never writes through to the installed engine.
$taskPlatforms = Join-Path $taskHost 'Platforms'
New-Item -ItemType Directory -Path $taskPlatforms -Force | Out-Null
if ((Get-Item -LiteralPath $taskPlatforms).LinkType) { throw 'Build-host Platforms must be a local directory' }
$taskWeb = Join-Path $taskPlatforms 'Web'
New-Item -ItemType Directory -Path $taskWeb -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $taskRoot 'reference-engine/Engine/Platforms/Web/Config') -Destination $taskWeb -Recurse -Force
Copy-Item -LiteralPath (Join-Path $taskRoot 'reference-engine/Engine/Platforms/Web/Source') -Destination $taskWeb -Recurse -Force
# Cached makefiles also restore their old environment, including the SDK config path spelling.
foreach ($taskTarget in @('UEWebSmoke', 'UEWebApplication')) {
    $taskMakefile = [IO.Path]::GetFullPath((Join-Path $taskRoot "tests/ue-web-smoke/Intermediate/Build/Web/wasm64/$taskTarget/Development/Makefile.bin"))
    if (-not $taskMakefile.StartsWith("$taskRoot\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected target makefile path.' }
    Remove-Item -LiteralPath $taskMakefile -Force -ErrorAction SilentlyContinue
}
$taskSavedSdk = $env:WEB_EMSDK_ROOT
$taskSavedConfig = $env:EM_CONFIG
$taskSavedNodePath = $env:NODE_PATH
$taskSavedEngineRoot = $env:UE_ENGINE_ROOT
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
try {
    $taskProcess.ProcessorAffinity = [IntPtr]3
    $env:WEB_EMSDK_ROOT = Join-Path $taskRoot '.tools/emsdk'
    # Keep the same spelling as the full Engine build to avoid resetting the shared SDK cache.
    $env:EM_CONFIG = (Join-Path $env:WEB_EMSDK_ROOT '.emscripten').Replace('\', '/')
    $env:UE_ENGINE_ROOT = Join-Path $Engine 'Engine'
    if (-not $env:NODE_PATH) {
        $env:NODE_PATH = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
    }
    & node (Join-Path $PSScriptRoot 'verify-web-blake3.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Portable BLAKE3 vectors failed' }
    & node (Join-Path $PSScriptRoot 'verify-web-libpng.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Portable libPNG verification failed' }
    & $taskDotnet build (Join-Path $PSScriptRoot 'web-ubt/UnrealBuildTool.Web.csproj') "-p:UEEngineRoot=$Engine/Engine" --nologo -v:minimal |
        Tee-Object -FilePath (Join-Path $PSScriptRoot 'results/web-ubt-build.log')
    if ($LASTEXITCODE -ne 0) { throw 'Isolated Web UBT build failed' }
    & $taskDotnet $taskUbt -Mode=ValidatePlatforms -Platforms=Web -OutputSDKs |
        Tee-Object -FilePath (Join-Path $PSScriptRoot 'results/web-ubt-sdk.log')
    if ($LASTEXITCODE -ne 0) { throw 'Web platform validation failed' }
    & $taskDotnet $taskUbt -Mode=WebToolchainSmoke "-Source=$(Join-Path $PSScriptRoot 'web-ubt-smoke.cpp')" "-Output=$(Join-Path $PSScriptRoot 'build/web-ubt-smoke')" |
        Tee-Object -FilePath (Join-Path $PSScriptRoot 'results/web-ubt-smoke.log')
    if ($LASTEXITCODE -ne 0) { throw 'Web UBT compile/link smoke failed' }
    & node (Join-Path $PSScriptRoot 'verify-web-ubt.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Web UBT artifact/runtime verification failed' }
    & $taskDotnet $taskUbt -Mode=WebToolchainSmoke -CoreTypes "-Source=$(Join-Path $PSScriptRoot 'web-core-types.cpp')" "-Output=$(Join-Path $PSScriptRoot 'build/web-core-types')" |
        Tee-Object -FilePath (Join-Path $PSScriptRoot 'results/web-core-types-build.log')
    if ($LASTEXITCODE -ne 0) { throw 'UE Core platform types WASM build failed' }
    & node (Join-Path $PSScriptRoot 'verify-web-core-types.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'UE Core platform types browser verification failed' }
    & node (Join-Path $PSScriptRoot 'verify-web-core-compression-source.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'UE Core Oodle conditional source verification failed' }
    & node (Join-Path $PSScriptRoot 'probe-web-core-target.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Ordinary Web Core Program build verification failed' }
    & node (Join-Path $PSScriptRoot 'verify-web-core-program.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Ordinary UE Core Program runtime verification failed' }
    $taskCoreObject = Join-Path $taskRoot 'tests/ue-web-smoke/Intermediate/Build/Web/wasm64/UEWebSmoke/Development/Core/GenericPlatformStricmp.cpp.o'
    & $taskDotnet $taskUbt -Mode=WebToolchainSmoke -CoreTypes "-CoreObject=$taskCoreObject" "-Source=$(Join-Path $PSScriptRoot 'web-core-services.cpp')" "-Output=$(Join-Path $PSScriptRoot 'build/web-core-services')" |
        Tee-Object -FilePath (Join-Path $PSScriptRoot 'results/web-core-services-build.log')
    if ($LASTEXITCODE -ne 0) { throw 'UE Core services WASM build failed' }
    & node (Join-Path $PSScriptRoot 'verify-web-core-services.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'UE Core services browser verification failed' }
    & node (Join-Path $PSScriptRoot 'probe-web-application-target.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Ordinary Web ApplicationCore Program build verification failed' }
    & node (Join-Path $PSScriptRoot 'verify-web-application.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Web ApplicationCore main loop and browser input verification failed' }
    & node (Join-Path $PSScriptRoot 'probe-web-engine-target.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Web Engine Target reflection/selected-object compilation verification failed' }
} finally {
    $taskProcess.ProcessorAffinity = $taskAffinity
    $env:WEB_EMSDK_ROOT = $taskSavedSdk
    $env:EM_CONFIG = $taskSavedConfig
    $env:NODE_PATH = $taskSavedNodePath
    $env:UE_ENGINE_ROOT = $taskSavedEngineRoot
}
