param([string]$Report = 'nanite-canvas-transitions')
$ErrorActionPreference = 'Stop'
if ($Report -notmatch '^[a-z0-9-]+$') { throw 'Invalid report name' }
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
function Get-TaskAudit([string]$File) {
    return @{file=[IO.Path]::GetFullPath($File);sha256=(Get-FileHash -LiteralPath $File).Hash.ToLowerInvariant()}
}
try {
    $taskProcess.ProcessorAffinity = 3
    $taskOutput = Join-Path $PSScriptRoot "build/$Report-native-rhi"
    $taskLog = Join-Path $PSScriptRoot "results/$Report-native-rhi.log"
    & (Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe') `
        (Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject') -run=WebShaderProbe -WebRHIProbe -WebCanvasTransitionRHIProbe -WebGPUCook `
        "-WebShaderDirectory=$taskOutput" "-WebMaterialShaderDirectory=$taskOutput" `
        "-Output=$taskOutput" -nullrhi -norhithread -unattended -nosplash -nop4 -NoSound "-abslog=$taskLog" *> "$taskLog.console.txt"
    if ($LASTEXITCODE -ne 0) { throw "Canvas transition probe failed: $taskLog" }
    $taskRuntimePath = Join-Path $taskOutput 'rhi-results.json'
    $taskRuntime = Get-Content -LiteralPath $taskRuntimePath -Raw | ConvertFrom-Json
    $taskChecks = @($taskRuntime.checks | Where-Object {$_.name -like 'canvas-backbuffer-*'})
    if (-not $taskRuntime.pass -or -not $taskRuntime.hostRestored -or $taskRuntime.errors.Count -or $taskChecks.Count -ne 8 -or @($taskChecks | Where-Object {-not $_.pass}).Count) {
        throw 'Canvas backbuffer transition checks failed or are incomplete'
    }
    $taskSources = @($PSCommandPath) + @('WebGPUTransitions.cpp','WebGPUTransitionProbe.cpp','WebGPUTransitionProbe.h','WebGPUDynamicRHI.cpp','WebGPURHIProbe.cpp') |
        ForEach-Object {if ([IO.Path]::IsPathRooted($_)) {Get-TaskAudit $_} else {Get-TaskAudit (Join-Path $taskRoot "tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/$_")}}
    $taskReport = [ordered]@{pass=$true; checks=$taskChecks; runtime=(Get-TaskAudit $taskRuntimePath); log=(Get-TaskAudit $taskLog);
        sources=$taskSources; products=@((Get-TaskAudit (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPURHI.dll')))}
    $taskReport | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'results/nanite-canvas-transitions.json') -Encoding utf8
    $taskReport | ConvertTo-Json -Depth 4
} finally { $taskProcess.ProcessorAffinity = $taskAffinity }
