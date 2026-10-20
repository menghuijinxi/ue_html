param()
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskEditor = Join-Path $taskRoot '.tools/ue58-web-platform-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe'
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskReport = [ordered]@{date = Get-Date -Format o; pass = $false; runs = @()}
function Get-TaskAudit([string]$File) {
    return @{file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
try {
    foreach ($taskMode in @('global', 'material', 'direct-material', 'viewport')) {
        $taskOutput = Join-Path $PSScriptRoot "build/ue-rhi-static-$taskMode"
        $taskLog = Join-Path $PSScriptRoot "results/web-static-uniforms-$taskMode.log"
        if ($taskMode -eq 'viewport') {
            $taskOutput = Join-Path $PSScriptRoot 'build/ue-rhi-canvas-viewport'
            $taskLog = Join-Path $PSScriptRoot 'results/web-canvas-native-viewport.log'
        }
        $taskProbe = switch ($taskMode) {
            'global' { '-WebGlobalRHIProbe' }
            'viewport' { '-WebViewportRHIProbe' }
            default { '-WebRHIProbe' }
        }
        $taskArguments = @($taskProject, '-run=WebShaderProbe', $taskProbe,
            "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-platform-full-worker')",
            "-WebMaterialShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-platform-material-worker')",
            "-Output=$taskOutput", '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound',
            "-abslog=$taskLog")
        if ($taskMode -in @('global', 'material')) { $taskArguments += '-WebStaticUniformProbe' }
        if ($taskMode -in @('material', 'direct-material')) { $taskArguments += '-WebMaterialOnlyProbe' }
        & $taskEditor @taskArguments *> "$taskLog.console.txt"
        $taskExit = $LASTEXITCODE
        if ($taskExit -ne 0) { throw "Native $taskMode probe failed ($taskExit): $taskLog" }
        $taskResultName = switch ($taskMode) {
            'global' { 'global-rhi-results.json' }
            'viewport' { 'viewport-rhi-results.json' }
            default { 'rhi-results.json' }
        }
        $taskRuntime = Get-TaskAudit (Join-Path $taskOutput $taskResultName)
        if (-not (Get-Content -LiteralPath $taskRuntime.file -Raw | ConvertFrom-Json).pass) {
            throw "Native $taskMode checks failed."
        }
        $taskReport.runs += @{mode = $taskMode; exitCode = $taskExit; arguments = $taskArguments;
            runtime = $taskRuntime; log = Get-TaskAudit $taskLog}
    }
    $taskReport.sources = @($PSCommandPath) + @('WebGPUDynamicRHI.h', 'WebGPUDynamicRHI.cpp',
        'WebGPUGlobalProbe.cpp', 'WebGPUMaterialProbe.cpp', 'WebGPURHIProbe.cpp', 'WebGPUProbeUtils.h',
        'WebGPUViewportProbe.cpp') |
        ForEach-Object {
            if ([IO.Path]::IsPathRooted($_)) { Get-TaskAudit $_ }
            else { Get-TaskAudit (Join-Path $taskRoot "tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/$_") }
        }
    $taskReport.products = @(
        (Join-Path $taskRoot 'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPURHI.dll'),
        (Join-Path $taskRoot 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll'),
        (Join-Path $taskRoot '.tools/ue58-dawn-host/WebGPUHost.dll')) |
        ForEach-Object { Get-TaskAudit $_ }
    $taskReport.fixtures = @('ue-platform-full-worker', 'ue-platform-material-worker') | ForEach-Object {
        Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot "build/$_") -File |
            Where-Object { $_.Extension -in @('.webshader', '.bin', '.json') } |
            ForEach-Object { Get-TaskAudit $_.FullName }
    }
    $taskReport.pass = $true
} catch {
    $taskReport.failure = $_.ToString()
    throw
} finally {
    $taskReport | ConvertTo-Json -Depth 12 |
        Set-Content -LiteralPath (Join-Path $PSScriptRoot 'results/web-static-uniforms-native-results.json') -Encoding utf8
}
[pscustomobject]$taskReport | Select-Object pass, failure | ConvertTo-Json
