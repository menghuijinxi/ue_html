param()
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskOutput = Join-Path $PSScriptRoot 'build/occlusion-native-rhi'
$taskLog = Join-Path $PSScriptRoot 'results/occlusion-native-rhi.log'
$taskReport = [ordered]@{date = Get-Date -Format o; pass = $false}
function Get-TaskAudit([string]$File) {
    return @{file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
try {
    $taskArguments = @(
        (Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'),
        '-run=WebShaderProbe', '-WebRHIProbe', '-WebOcclusionProbe',
        "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-platform-full-worker')",
        "-WebMaterialShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-platform-material-worker')",
        "-Output=$taskOutput", '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound',
        "-abslog=$taskLog"
    )
    & (Join-Path $taskRoot '.tools/ue58-web-platform-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe') @taskArguments *> "$taskLog.console.txt"
    if ($LASTEXITCODE -ne 0) { throw "Occlusion query probe failed ($LASTEXITCODE): $taskLog" }
    $taskRuntime = Join-Path $taskOutput 'rhi-results.json'
    $taskResult = Get-Content -LiteralPath $taskRuntime -Raw | ConvertFrom-Json
    $taskChecks = @($taskResult.transitions.checks | Where-Object {$_.name -like 'occlusion-*'})
    if (-not $taskResult.pass -or $taskChecks.Count -ne 7 -or
        @($taskChecks | Where-Object {-not $_.pass}).Count -or $taskResult.errors.Count) {
        throw 'Native occlusion checks failed or are incomplete.'
    }
    $taskReport.checks = $taskChecks.Count
    $taskReport.arguments = $taskArguments
    $taskReport.runtime = Get-TaskAudit $taskRuntime
    $taskReport.log = Get-TaskAudit $taskLog
    $taskReport.sources = @($PSCommandPath) + @('WebGPUDynamicRHI.cpp', 'WebGPUDynamicRHI.h',
        'WebGPUTransitionProbe.cpp', 'WebGPURHIProbe.cpp') | ForEach-Object {
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
        Set-Content -LiteralPath (Join-Path $PSScriptRoot 'results/web-occlusion-native-results.json') -Encoding utf8
}
[pscustomobject]$taskReport | Select-Object pass, checks, failure | ConvertTo-Json
