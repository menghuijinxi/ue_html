param()
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskHost = Join-Path $taskRoot '.tools/ue58-web-es31-cook-host/Engine'
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskOutput = Join-Path $PSScriptRoot "build/vertex-factory-policy-$taskStamp"
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
function Get-TaskAudit([string]$File) {
    return @{file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$taskReport = [ordered]@{ date = Get-Date -Format o; pass = $false; runs = @() }
try {
    foreach ($taskMode in @('desktop', 'web', 'other-target')) {
        $taskResult = Join-Path $taskOutput "$taskMode.json"
        $taskLog = Join-Path $taskOutput "$taskMode.log"
        $taskArguments = @((Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'),
            '-run=WebShaderProbe', '-VertexFactoryPolicyProbe', "-Output=$taskResult",
            '-nullrhi', '-unattended', '-nop4', '-nosound', '-processaffinity=2',
            "-abslog=$taskLog", '-UTF8Output', '-ddpi:Web:bIsEnabled=false')
        if ($taskMode -eq 'web') { $taskArguments += @('-WebGPUCook', '-WebGPUES31Cook', '-TargetPlatform=Web') }
        if ($taskMode -eq 'other-target') { $taskArguments += @('-WebGPUCook', '-WebGPUES31Cook', '-TargetPlatform=Windows') }
        & (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-Cmd.exe') @taskArguments *> "$taskLog.console.txt"
        $taskExitCode = $LASTEXITCODE
        if (-not (Test-Path -LiteralPath $taskResult)) { throw "Vertex factory probe exited $taskExitCode without a result: $taskLog" }
        $taskReport.runs += @{
            mode = $taskMode; exitCode = $taskExitCode
            result = Get-TaskAudit $taskResult; log = Get-TaskAudit $taskLog
            detail = Get-Content -LiteralPath $taskResult -Raw | ConvertFrom-Json
        }
        if ($taskExitCode -ne 0) { throw "Vertex factory probe failed: $taskLog" }
    }
    $taskReport.sources = @($PSCommandPath,
        (Join-Path $taskRoot 'tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp'),
        (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/RenderCore/Private/VertexFactory.cpp'),
        (Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/RenderCore/Public/WebShaderPlatform.h')) |
        ForEach-Object { Get-TaskAudit $_ }
    $taskReport.products = @(
        (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-RenderCore.dll'),
        (Join-Path $taskRoot 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll')) |
        ForEach-Object { Get-TaskAudit $_ }
    $taskReport.pass = $true
} catch {
    $taskReport.failure = $_.ToString()
    throw
} finally {
    $taskReport | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'results/web-vertex-factory-policy-results.json') -Encoding utf8
}
[pscustomobject]$taskReport | Select-Object pass, runs | ConvertTo-Json -Depth 7
