param([string]$Engine = 'H:/UE_5.8')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskOutput = Join-Path $PSScriptRoot 'build/ue-rhi-system-textures'
$taskBuildLog = Join-Path $PSScriptRoot 'results/web-system-textures-native-build.log'
$taskLog = Join-Path $PSScriptRoot 'results/web-system-textures-native.log'
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
function Get-TaskAudit([string]$File) {
    return @{file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$taskReport = [ordered]@{date = Get-Date -Format o; pass = $false}
try {
    & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development `
        "-Project=$taskProject" -WaitMutex -NoHotReloadFromIDE -NoUBA -MaxParallelActions=1 *> $taskBuildLog
    $taskReport.buildExitCode = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw "Native probe build failed: $taskBuildLog" }
    $taskArguments = @($taskProject, '-run=WebShaderProbe', '-WebTextureUintProbe',
        "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-texture-uint-worker')",
        "-Output=$taskOutput", '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound',
        "-abslog=$taskLog")
    $taskEditor = Join-Path $taskRoot '.tools/ue58-web-platform-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe'
    & $taskEditor @taskArguments *> "$taskLog.console.txt"
    $taskReport.exitCode = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw "Native probe failed: $taskLog" }
    $taskReport.arguments = $taskArguments
    $taskReport.runtime = Get-TaskAudit (Join-Path $taskOutput 'texture-uint-results.json')
    $taskRuntime = Get-Content -LiteralPath $taskReport.runtime.file -Raw | ConvertFrom-Json
    if (-not $taskRuntime.pass) { throw 'Native texture checks failed.' }
    $taskReport.sources = @($PSCommandPath,
        (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp'),
        (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUTextureUintProbe.cpp'),
        (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUTransitions.cpp')) |
        ForEach-Object { Get-TaskAudit $_ }
    $taskReport.products = @(
        (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPURHI.dll'),
        (Join-Path $taskRoot 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll'),
        (Join-Path $taskRoot '.tools/ue58-dawn-host/WebGPUHost.dll')) |
        ForEach-Object { Get-TaskAudit $_ }
    $taskReport.shaderPackets = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'build/ue-texture-uint-worker') -Filter '*.webshader' |
        ForEach-Object { Get-TaskAudit $_.FullName }
    $taskReport.buildLog = Get-TaskAudit $taskBuildLog
    $taskReport.log = Get-TaskAudit $taskLog
    $taskReport.pass = $true
} catch {
    $taskReport.failure = $_.ToString()
    throw
} finally {
    $taskReport | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'results/web-system-textures-native-results.json') -Encoding utf8
}
[pscustomobject]$taskReport | Select-Object pass, buildExitCode, exitCode, failure | ConvertTo-Json
