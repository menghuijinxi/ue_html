param([string]$Report = 'nanite-topology')
$ErrorActionPreference = 'Stop'
if ($Report -notmatch '^[a-z0-9-]+$') { throw 'Invalid report name' }
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
function Get-TaskAudit([string]$File) {
    return @{file=[IO.Path]::GetFullPath($File);sha256=(Get-FileHash -LiteralPath $File).Hash.ToLowerInvariant()}
}
try {
    $taskBuildFile = Join-Path $PSScriptRoot 'results/nanite-uploader-build.json'
    $taskBuild = Get-Content -LiteralPath $taskBuildFile -Raw | ConvertFrom-Json
    if (-not $taskBuild.pass -or -not @($taskBuild.inputs | Where-Object {$_.file -like '*WebGPUTopologyProbe.h'}).Count) {
        throw 'Rebuild the native uploader with topology probe provenance first'
    }
    foreach ($taskInput in @($taskBuild.inputs) + @($taskBuild.binary, $taskBuild.log)) {
        if ((Get-TaskAudit $taskInput.file).sha256 -ne $taskInput.sha256) { throw "Rebuild the native probe: $($taskInput.file)" }
    }
    $taskProcess.ProcessorAffinity = 3
    $taskOutput = Join-Path $PSScriptRoot "results/$Report"
    New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
    $taskLog = Join-Path $taskOutput 'rhi.log'
    & (Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe') `
        (Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject') -run=WebShaderProbe -WebRHIProbe -WebTopologyRHIProbe -WebGPUCook `
        "-WebShaderDirectory=$taskOutput" "-WebMaterialShaderDirectory=$taskOutput" `
        "-Output=$taskOutput" -nullrhi -norhithread -unattended -nosplash -nop4 -NoSound "-abslog=$taskLog" *> "$taskLog.console.txt"
    if ($LASTEXITCODE -ne 0) { throw "Topology probe failed: $taskLog" }
    $taskRuntimeFile = Join-Path $taskOutput 'rhi-results.json'
    $taskRuntime = Get-Content -LiteralPath $taskRuntimeFile -Raw | ConvertFrom-Json
    if (-not $taskRuntime.pass -or -not $taskRuntime.hostRestored -or $taskRuntime.errors.Count -or
        $taskRuntime.cases.Count -ne 24 -or @($taskRuntime.cases | Where-Object {-not $_.pass}).Count -or
        $taskRuntime.vertexFormats.Count -ne 7 -or @($taskRuntime.vertexFormats | Where-Object {-not $_.pass}).Count -or
        $taskRuntime.bundlesCreated -lt 8 -or $taskRuntime.bundleHits -lt 8) {
        throw 'Topology, sparse stream, indexed or bundle readback failed'
    }
    $taskResult = [ordered]@{pass=$true; date=(Get-Date -Format o); source=(Get-TaskAudit $PSCommandPath);
        build=(Get-TaskAudit $taskBuildFile); runtime=(Get-TaskAudit $taskRuntimeFile); log=(Get-TaskAudit $taskLog);
        cases=$taskRuntime.cases; vertexFormats=$taskRuntime.vertexFormats; bundlesCreated=$taskRuntime.bundlesCreated; bundleHits=$taskRuntime.bundleHits}
    $taskResult | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $taskOutput 'verified.json') -Encoding utf8
    $taskResult | ConvertTo-Json -Depth 4
} finally { $taskProcess.ProcessorAffinity = $taskAffinity }
