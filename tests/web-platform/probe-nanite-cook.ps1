param(
    [string]$Engine = 'H:/UE_5.8',
    [ValidateSet('chrome', 'msedge')][string[]]$BrowserChannels = @('chrome', 'msedge'),
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskHost = Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine'
$taskOutput = Join-Path $PSScriptRoot ('results/nanite-cook/' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskPreviousEngine = $env:UE_ENGINE_ROOT
$taskPreviousTint = $env:WEBGPU_TINT_DIR
$taskPreviousIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
$taskReport = [ordered]@{date = Get-Date -Format o; pass = $false; cases = @(); output = $taskOutput;
    packagedLevel = $false; runtimeNaniteEnabled = $false}
function Get-TaskAudit([string]$File) {
    return @{file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File).Hash.ToLowerInvariant()}
}
try {
    $taskProcess.ProcessorAffinity = 3
    $env:UE_ENGINE_ROOT = Join-Path $Engine 'Engine'
    if (-not $SkipBuild) {
        & (Join-Path $PSScriptRoot 'build-tint-nanite.ps1')
        & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development `
            "-Project=$taskProject" -Module=WebGPUShaderFormat -Module=UEShaderHost `
            -WaitMutex -NoHotReloadFromIDE -NoUBA -NoUbaLocal -MaxParallelActions=1
        if ($LASTEXITCODE -ne 0) { throw 'Nanite Cook probe module build failed' }
        # UBT builds share generated project rules and must run sequentially.
        & (Join-Path $PSScriptRoot 'build-native-rendercore.ps1') -Engine $Engine -HostProcessorAffinity 3
    }
    $taskNative = Get-Content (Join-Path $PSScriptRoot 'results/native-rendercore-build-results.json') -Raw | ConvertFrom-Json
    if (-not $taskNative.pass) { throw 'Build the native RenderCore overlay first' }
    foreach ($taskInput in @($taskNative.sourceFiles) + @($taskNative.products) + @($taskNative.installedInputs)) {
        if ((Get-TaskAudit $taskInput.file).sha256 -ne $taskInput.sha256) { throw "Stale build: $($taskInput.file)" }
    }
    & node (Join-Path $PSScriptRoot 'prepare-nanite-cook-host.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Nanite Cook host preparation failed' }
    $taskDestination = Join-Path $taskHost 'Binaries/Win64/UnrealEditor-RenderCore.dll'
    $taskReport.renderCore = Get-TaskAudit $taskDestination
    & node (Join-Path $PSScriptRoot 'prepare-web-cook-shaders.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Shader overlay preparation failed' }
    $env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
    foreach ($taskCase in @(
        @{name='sm5-stripped'; flags=@('-WebGPUCook')},
        @{name='sm5-retained'; flags=@('-WebGPUCook', '-WebNaniteCookData')},
        @{name='es31-stripped'; flags=@('-WebGPUCook', '-WebGPUES31Cook', '-WebNaniteCookData')},
        @{name='null-stripped'; flags=@('-WebNullRHICook', '-WebNaniteCookData')}
    )) {
        $taskDirectory = Join-Path $taskOutput $taskCase.name
        New-Item -ItemType Directory -Path $taskDirectory -Force | Out-Null
        $env:WEBGPU_INTERMEDIATE_DIR = Join-Path $taskDirectory 'conversion'
        & (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-Cmd.exe') $taskProject `
            -run=WebShaderProbe -WebNaniteAssetProbe -WebNaniteCookRoundTrip "-Output=$taskDirectory" `
            @($taskCase.flags) -TargetPlatform=Web -ddpi:Web:bIsEnabled=false `
            -nullrhi -unattended -nop4 -nosplash -nosound "-abslog=$taskDirectory/compiler.log" `
            *> "$taskDirectory/console.log"
        if ($LASTEXITCODE -ne 0) { throw "Cook resource round trip failed: $taskDirectory/compiler.log" }
        $taskResult = Get-Content (Join-Path $taskDirectory 'cook-roundtrip.json') -Raw | ConvertFrom-Json
        if (-not $taskResult.pass) { throw "Cook validation failed: $taskDirectory" }
        $taskReport.cases += @{name = $taskCase.name; result = $taskResult;
            resource = Get-TaskAudit (Join-Path $taskDirectory 'resources.cooked.bin')}
    }
    & node (Join-Path $PSScriptRoot 'verify-web-nanite-asset.cjs') (Join-Path $taskOutput 'sm5-retained') ($BrowserChannels -join ',')
    if ($LASTEXITCODE -ne 0) { throw 'Browser verification of cooked Nanite pages failed' }
    $taskReport.browser = Get-Content (Join-Path $taskOutput 'sm5-retained/browser-results.json') -Raw | ConvertFrom-Json
    foreach ($taskInput in $taskNative.installedInputs) {
        if ((Get-TaskAudit $taskInput.file).sha256 -ne $taskInput.sha256) { throw "Installed input changed: $($taskInput.file)" }
    }
    $taskReport.installedInputsUnmodified = $true
    $taskReport.sources = @($PSCommandPath,
        (Join-Path $PSScriptRoot 'prepare-nanite-cook-host.cjs'),
        (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp'),
        (Join-Path $taskRoot 'tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteAssetProbe.cpp'),
        (Join-Path $PSScriptRoot 'verify-web-nanite-asset.cjs')) | ForEach-Object { Get-TaskAudit $_ }
    $taskReport.pass = $true
} catch {
    $taskReport.failure = $_.ToString()
    throw
} finally {
    $taskProcess.ProcessorAffinity = $taskAffinity
    $env:UE_ENGINE_ROOT = $taskPreviousEngine
    $env:WEBGPU_TINT_DIR = $taskPreviousTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskPreviousIntermediate
    $taskReport | ConvertTo-Json -Depth 30 | Set-Content (Join-Path $taskOutput 'results.json') -Encoding utf8
    Write-Output "Nanite Cook results: $taskOutput/results.json"
}
