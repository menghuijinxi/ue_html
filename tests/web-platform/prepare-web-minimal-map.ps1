param([string]$Engine = 'H:/UE_5.8')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskReportFile = Join-Path $PSScriptRoot 'results/web-minimal-map-results.json'
$taskMap = Join-Path $taskRoot 'tests/ue-shader-host/Content/WebMinimal.umap'
function Get-TaskAudit([string]$File) {
    return @{file = $File; sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$taskSources = @($PSCommandPath) + @('Public/WebMinimalMapCommandlet.h', 'Private/WebMinimalMapCommandlet.cpp') |
    ForEach-Object {
        if ([IO.Path]::IsPathRooted($_)) { Get-TaskAudit $_ }
        else { Get-TaskAudit (Join-Path $taskRoot "tests/ue-shader-host/Source/UEShaderHost/$_") }
    }
if (Test-Path -LiteralPath $taskReportFile) {
    $taskPrevious = Get-Content -LiteralPath $taskReportFile -Raw | ConvertFrom-Json
    $taskInputsValid = $taskPrevious.pass -and $taskPrevious.sources.Count -eq $taskSources.Count
    foreach ($taskSource in $taskSources) {
        $taskInputsValid = $taskInputsValid -and @($taskPrevious.sources | Where-Object {
            $_.file -eq $taskSource.file -and $_.sha256 -eq $taskSource.sha256
        }).Count -eq 1
    }
    if ($taskInputsValid -and (Test-Path -LiteralPath $taskMap) -and
        (Get-TaskAudit $taskMap).sha256 -eq $taskPrevious.map.sha256) {
        Write-Output 'Reusing the audited minimal map for both Cook profiles.'
        return
    }
}
$taskLog = Join-Path $PSScriptRoot ("results/web-minimal-map-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
& (Join-Path $Engine 'Engine/Binaries/Win64/UnrealEditor-Cmd.exe') `
    (Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject') `
    '-run=WebMinimalMap' '-nullrhi' '-unattended' '-nop4' '-nosplash' '-nosound' `
    "-abslog=$taskLog" *> "$taskLog.console.txt"
if ($LASTEXITCODE -ne 0) { throw "Minimal map creation failed: $taskLog" }
@{date = Get-Date -Format o; pass = $true; sources = $taskSources; map = Get-TaskAudit $taskMap;
    log = Get-TaskAudit $taskLog} | ConvertTo-Json -Depth 6 |
    Set-Content -LiteralPath $taskReportFile -Encoding utf8
