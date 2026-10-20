param()
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskResults = Join-Path $PSScriptRoot 'results'
$taskBaselineFile = Join-Path $taskResults 'web-engine-webgpu-es31-cook-results-before-material-host-20261020-1021.json'
$taskBaseline = Get-Content -LiteralPath $taskBaselineFile -Raw | ConvertFrom-Json
$taskBuildFile = Join-Path $taskResults 'web-material-host-build-results.json'
$taskBuild = Get-Content -LiteralPath $taskBuildFile -Raw | ConvertFrom-Json
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskOutput = Join-Path $PSScriptRoot "build/web-material-cook/$taskStamp"
$taskLog = Join-Path $taskResults "web-material-cook-$taskStamp.log"
$taskHost = Join-Path $taskRoot '.tools/ue58-web-es31-cook-host/Engine'
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskTint = $env:WEBGPU_TINT_DIR
$taskIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
function Get-TaskAudit([string]$File) {
    return @{ file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$taskReport = [ordered]@{
    date = Get-Date -Format o; diagnosticOnly = $true; pass = $false; completeUEScene = $false
    baseline = Get-TaskAudit $taskBaselineFile; nativeBuild = Get-TaskAudit $taskBuildFile
    output = $taskOutput; changedInputs = @()
}
try {
    if (-not $taskBuild.pass) { throw 'Native material host build failed.' }
    foreach ($taskItem in @($taskBuild.sources) + @($taskBuild.products)) {
        if ((Get-TaskAudit $taskItem.file).sha256 -ne $taskItem.sha256) { throw "Native build input changed: $($taskItem.file)" }
    }
    foreach ($taskItem in @($taskBaseline.sourceFiles) + @($taskBaseline.hostProducts) + @($taskBaseline.shaderSourcesReport)) {
        $taskCurrent = Get-TaskAudit $taskItem.file
        if ($taskCurrent.sha256 -ne $taskItem.sha256) {
            if ($taskItem.file -notmatch '(WebGPUShaderFormat[\\/]Private[\\/]WebGPUShaderFormat.cpp|WebGPUShaderFormat[\\/]Public[\\/]WebGPUShaderCode.h|Binaries[\\/]Win64[\\/]UnrealEditor-WebGPUShaderFormat.dll)$') {
                throw "Unexpected baseline change: $($taskItem.file)"
            }
            $taskReport.changedInputs += @{ previous = $taskItem; current = $taskCurrent }
        }
    }
    if ($taskReport.changedInputs.Count -ne 3) { throw 'Expected only the two shader-format sources and native DLL to change.' }
    $taskReport.sourceFiles = @(Get-TaskAudit $PSCommandPath) + @($taskBaseline.sourceFiles | ForEach-Object { Get-TaskAudit $_.file }) +
        @($taskBuild.sources | ForEach-Object { Get-TaskAudit $_.file })
    $taskReport.hostProducts = @($taskBaseline.hostProducts | ForEach-Object { Get-TaskAudit $_.file }) +
        @($taskBuild.products | ForEach-Object { Get-TaskAudit $_.file })
    $taskReport.shaderSourcesReport = Get-TaskAudit $taskBaseline.shaderSourcesReport.file
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
    $taskInventory = Join-Path $taskOutput 'ShaderConversion/inventory.json'
    if (Test-Path -LiteralPath $taskInventory) { $taskReport.inventory = Get-TaskAudit $taskInventory }
    $taskReport.shaderFailures = @(Get-ChildItem -LiteralPath $taskOutput -Filter failure.json -Recurse -File |
        ForEach-Object { @{ diagnostic = Get-TaskAudit $_.FullName; detail = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json } })
    $taskReport.pass = $taskReport.jobCacheDDCDisabled -and $taskReport.debugValidationRetained -and
        $taskReport.reachedMaterialCompilation -and -not $taskReport.jobCacheAssertionObserved
    $taskReport.cookSucceeded = $taskReport.exitCode -eq 0
    $taskReport.boundary = 'Diagnostic Cook with the resource-only uniform binding fix and a shader-format cache-key bump. All original package/profile/eligibility settings and full job validation are retained; only per-job DDC is disabled. pass verifies that the material compilation stage was reached without the job-cache assertion. It does not mean Cook succeeded or any failed optional feature was excluded.'
} catch {
    $taskReport.failure = $_.ToString()
    throw
} finally {
    $taskReport | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $taskResults 'web-material-cook-results.json') -Encoding utf8
    $env:WEBGPU_TINT_DIR = $taskTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskIntermediate
    $taskProcess.ProcessorAffinity = $taskAffinity
}
[pscustomobject]$taskReport | Select-Object pass, exitCode, cookSucceeded, jobCacheAssertionObserved,
    parameterMismatchObserved, reachedMaterialCompilation, log | ConvertTo-Json
