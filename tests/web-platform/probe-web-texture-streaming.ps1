param()
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskOutput = Join-Path $PSScriptRoot 'build/streaming-native-texture'
$taskLog = Join-Path $PSScriptRoot 'results/streaming-native-texture.log'
$taskReport = [ordered]@{date = Get-Date -Format o; pass = $false}
function Get-TaskAudit([string]$File) {
    return @{file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
try {
    $taskArguments = @(
        (Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'),
        '-run=WebShaderProbe', '-WebTextureSRVProbe', '-WebTextureBCProbe',
        '-WebTextureIESProbe', '-WebTextureReflectionProbe', '-WebTextureStreamingProbe',
        "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-platform-full-worker')",
        "-Output=$taskOutput", '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound',
        "-abslog=$taskLog"
    )
    & (Join-Path $taskRoot '.tools/ue58-web-platform-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe') @taskArguments *> "$taskLog.console.txt"
    if ($LASTEXITCODE -ne 0) { throw "Texture streaming probe failed ($LASTEXITCODE): $taskLog" }
    $taskRuntime = Join-Path $taskOutput 'texture-srv-results.json'
    $taskResult = Get-Content -LiteralPath $taskRuntime -Raw | ConvertFrom-Json
    if (-not $taskResult.pass -or $taskResult.modes.Count -ne 2) { throw 'Native texture checks failed.' }
    foreach ($taskMode in $taskResult.modes) {
        if ($taskMode.checks.Count -ne 181 -or @($taskMode.checks | Where-Object {-not $_.pass}).Count) {
            throw "Incomplete native checks in $($taskMode.mode)."
        }
    }
    $taskReport.arguments = $taskArguments
    $taskReport.runtime = Get-TaskAudit $taskRuntime
    $taskReport.log = Get-TaskAudit $taskLog
    $taskReport.sources = @($PSCommandPath) + @('WebGPUDynamicRHI.cpp', 'WebGPUDynamicRHI.h',
        'WebGPUTransitions.cpp', 'WebGPUTextureSRVProbe.cpp', 'WebGPUGlobalScope.cpp') | ForEach-Object {
        if ([IO.Path]::IsPathRooted($_)) { Get-TaskAudit $_ }
        else { Get-TaskAudit (Join-Path $taskRoot "tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/$_") }
    }
    $taskReport.products = @(
        (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPURHI.dll'),
        (Join-Path $taskRoot '.tools/ue58-dawn-host/WebGPUHost.dll')) | ForEach-Object {Get-TaskAudit $_}
    $taskReport.pass = $true
} catch {
    $taskReport.failure = $_.ToString()
    throw
} finally {
    $taskReport | ConvertTo-Json -Depth 12 |
        Set-Content -LiteralPath (Join-Path $PSScriptRoot 'results/web-texture-streaming-native-results.json') -Encoding utf8
}
[pscustomobject]$taskReport | Select-Object pass, failure | ConvertTo-Json
