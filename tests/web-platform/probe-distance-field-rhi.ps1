param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskOutput = Join-Path $PSScriptRoot 'build/ue-rhi-distance-field'
$taskLog = Join-Path $PSScriptRoot 'results/distance-field-rhi-host.log'
$taskBuildLog = Join-Path $PSScriptRoot 'results/distance-field-rhi-build.log'
function Get-TaskAudit([string]$File) {
    return @{file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$taskReport = [ordered]@{date = Get-Date -Format o; pass = $false}
try {
    if (-not $SkipBuild) {
        & 'H:/UE_5.8/Engine/Build/BatchFiles/Build.bat' UEShaderHostEditor Win64 Development `
            "-Project=$taskProject" -WaitMutex -NoHotReloadFromIDE -NoUBA -MaxParallelActions=2 *> $taskBuildLog
        if ($LASTEXITCODE -ne 0) { throw "Native RHI build failed: $taskBuildLog" }
    }
    $taskRuntime = Join-Path $taskOutput 'distance-field-rhi-results.json'
    if (Test-Path -LiteralPath $taskRuntime) { Remove-Item -LiteralPath $taskRuntime }
    $taskArguments = @($taskProject, '-run=WebShaderProbe', '-WebRHIProbe', '-WebDistanceFieldRHIProbe',
        "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/distance-field-probes/ue-texture-worker')",
        "-WebMaterialShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-platform-material-worker')",
        "-Output=$taskOutput", '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound',
        "-abslog=$taskLog")
    & (Join-Path $taskRoot '.tools/ue58-web-platform-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe') `
        @taskArguments *> "$taskLog.console.log"
    if ($LASTEXITCODE -ne 0) { throw "Native RHI execution failed: $taskLog" }
    & node (Join-Path $PSScriptRoot 'verify-distance-field-rhi.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Distance-field RHI readback verification failed.' }
    $taskReport.arguments = $taskArguments
    $taskReport.verification = Get-TaskAudit (Join-Path $PSScriptRoot 'results/distance-field-rhi-verification.json')
    $taskReport.sources = @($PSCommandPath,
        (Join-Path $PSScriptRoot 'verify-distance-field-rhi.cjs'),
        (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp'),
        (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.h'),
        (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDistanceFieldProbe.cpp'),
        (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUTransitions.cpp')) |
        ForEach-Object { Get-TaskAudit $_ }
    $taskReport.products = @(
        (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPURHI.dll'),
        (Join-Path $taskRoot '.tools/ue58-dawn-host/WebGPUHost.dll')) | ForEach-Object { Get-TaskAudit $_ }
    $taskReport.log = Get-TaskAudit $taskLog
    $taskReport.pass = $true
} catch {
    $taskReport.failure = $_.ToString()
    throw
} finally {
    $taskReport | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'results/distance-field-rhi-probe-results.json') -Encoding utf8
}
[pscustomobject]$taskReport | Select-Object pass, failure | ConvertTo-Json
