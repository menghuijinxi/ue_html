param([string]$Report = 'slate-transitions')
$ErrorActionPreference = 'Stop'
if ($Report -notmatch '^[a-z0-9-]+$') { throw 'Invalid report name.' }
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskOutput = Join-Path $PSScriptRoot "build/$Report-native-rhi"
$taskLog = Join-Path $PSScriptRoot "results/$Report-native-rhi.log"
$taskReport = [ordered]@{date = Get-Date -Format o; pass = $false}
function Get-TaskAudit([string]$File) {
    return @{file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
try {
    $taskArguments = @(
        (Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'),
        '-run=WebShaderProbe', '-WebRHIProbe',
        "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-platform-full-worker')",
        "-WebMaterialShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-platform-material-worker')",
        "-Output=$taskOutput", '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound',
        "-abslog=$taskLog"
    )
    & (Join-Path $taskRoot '.tools/ue58-web-platform-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe') @taskArguments *> "$taskLog.console.txt"
    $taskExit = $LASTEXITCODE
    $taskRuntime = Join-Path $taskOutput 'rhi-results.json'
    $taskResult = Get-Content -LiteralPath $taskRuntime -Raw | ConvertFrom-Json
    $taskChecks = @($taskResult.transitions.checks | Where-Object {$_.name -like 'slate-*'})
    $taskReport.exitCode = $taskExit
    $taskReport.checks = $taskChecks
    $taskReport.arguments = $taskArguments
    $taskReport.runtime = Get-TaskAudit $taskRuntime
    $taskReport.log = Get-TaskAudit $taskLog
    $taskReport.sources = @($PSCommandPath) + @('WebGPUDynamicRHI.cpp', 'WebGPUTransitions.cpp', 'WebGPUTransitionProbe.cpp') |
        ForEach-Object {
            if ([IO.Path]::IsPathRooted($_)) { Get-TaskAudit $_ }
            else { Get-TaskAudit (Join-Path $taskRoot "tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/$_") }
        }
    $taskReport.products = @(
        (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPURHI.dll'),
        (Join-Path $taskRoot '.tools/ue58-dawn-host/WebGPUHost.dll')) | ForEach-Object {Get-TaskAudit $_}
    if ($taskExit -ne 0 -or -not $taskResult.pass -or $taskChecks.Count -ne 9 -or
        @($taskChecks | Where-Object {-not $_.pass}).Count -or $taskResult.errors.Count) {
        throw 'Slate transition checks failed or are incomplete.'
    }
    $taskReport.pass = $true
} catch {
    $taskReport.failure = $_.ToString()
    throw
} finally {
    $taskReport | ConvertTo-Json -Depth 12 |
        Set-Content -LiteralPath (Join-Path $PSScriptRoot "results/web-$Report-native-results.json") -Encoding utf8
}
[pscustomobject]$taskReport | Select-Object pass, checks, failure | ConvertTo-Json -Depth 5
