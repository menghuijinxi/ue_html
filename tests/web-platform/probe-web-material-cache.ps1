param()
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskBaselineFile = Join-Path $PSScriptRoot 'results/web-engine-webgpu-es31-cook-results-before-material-host-20261020-1021.json'
$taskBaseline = Get-Content -LiteralPath $taskBaselineFile -Raw | ConvertFrom-Json
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskOutput = Join-Path $PSScriptRoot "build/web-material-cache-probe/$taskStamp"
$taskLog = Join-Path $PSScriptRoot "results/web-material-cache-probe-$taskStamp.log"
$taskReportFile = Join-Path $PSScriptRoot "results/web-material-cache-probe-$taskStamp.json"
$taskHost = Join-Path $taskRoot '.tools/ue58-web-es31-cook-host/Engine'
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskSavedTint = $env:WEBGPU_TINT_DIR
$taskSavedIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
function Get-TaskAudit([string]$File) {
    return @{ file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$taskReport = [ordered]@{
    date = Get-Date -Format o
    diagnosticOnly = $true
    pass = $false
    completeUEScene = $false
    baseline = Get-TaskAudit $taskBaselineFile
    sourceFiles = @(Get-TaskAudit $PSCommandPath)
    output = $taskOutput
    changedSetting = 'r.ShaderCompiler.JobCacheDDC=0'
}
try {
    foreach ($taskItem in @($taskBaseline.sourceFiles) + @($taskBaseline.hostProducts) + @($taskBaseline.shaderSourcesReport)) {
        if ((Get-TaskAudit $taskItem.file).sha256 -ne $taskItem.sha256) { throw "Baseline input changed: $($taskItem.file)" }
    }
    New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
    $taskProcess.ProcessorAffinity = [IntPtr]3
    $env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
    $env:WEBGPU_INTERMEDIATE_DIR = Join-Path $taskOutput 'ShaderConversion'
    $taskArguments = @($taskBaseline.arguments | ForEach-Object {
        if ($_ -like '-OutputDir=*') { "-OutputDir=$taskOutput" }
        elseif ($_ -like '-abslog=*') { "-abslog=$taskLog" }
        else { $_ }
    })
    $taskArguments += '-ini:Engine:[SystemSettings]:r.ShaderCompiler.JobCacheDDC=0'
    $taskReport.arguments = $taskArguments
    & (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-Cmd.exe') @taskArguments *> "$taskLog.console.txt"
    $taskReport.exitCode = $LASTEXITCODE
    $taskReport.log = Get-TaskAudit $taskLog
    $taskText = Get-Content -LiteralPath $taskLog -Raw
    $taskReport.jobCacheDDCDisabled = $taskText.Contains('Set CVar [[r.ShaderCompiler.JobCacheDDC:0]]')
    $taskReport.debugValidationRetained = $taskText.Contains('Set CVar [[r.ShaderCompiler.DebugValidateJobCache:1]]')
    $taskReport.jobCacheAssertionObserved = $taskText -match 'Assertion failed: Job \[File:.*ShaderCompilerJobCache.cpp'
    $taskReport.parameterMismatchObserved = $taskText.Contains('has unbound parameters not represented in the parameter struct')
    $taskReport.reachedMaterialCompilation = $taskText -match 'Missing cached shadermap for '
    $taskReport.shaderFailures = @(Get-ChildItem -LiteralPath $taskOutput -Filter failure.json -Recurse -File |
        ForEach-Object { @{diagnostic = Get-TaskAudit $_.FullName; detail = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json} })
    $taskReport.pass = $taskReport.jobCacheDDCDisabled -and $taskReport.debugValidationRetained -and
        $taskReport.reachedMaterialCompilation -and -not $taskReport.jobCacheAssertionObserved
    $taskReport.boundary = 'Diagnostic replay changes only per-shader JobCacheDDC, keeping full job validation and the original shader/platform/package settings. This pass means the cache assertion was avoided and material compilation was reached, not Cook, shader correctness or browser success.'
} catch {
    $taskReport.failure = $_.ToString()
    throw
} finally {
    $taskReport | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $taskReportFile -Encoding utf8
    $env:WEBGPU_TINT_DIR = $taskSavedTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskSavedIntermediate
    $taskProcess.ProcessorAffinity = $taskAffinity
}
Write-Output ($taskReport | Select-Object pass, exitCode, jobCacheDDCDisabled, debugValidationRetained,
    jobCacheAssertionObserved, parameterMismatchObserved, reachedMaterialCompilation, log | ConvertTo-Json)
