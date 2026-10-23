$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskSdk = Join-Path $taskRoot '.tools/emsdk'
$taskOutput = Join-Path $PSScriptRoot 'build/web-bindgroup-lifetime'
$taskSource = Join-Path $PSScriptRoot 'web-bindgroup-lifetime.cpp'
$taskPort = Join-Path $taskRoot 'reference-engine/Engine/Platforms/Web/Build/emdawnwebgpu-ue.port.py'
$taskBefore = Join-Path $taskRoot '.tools/emdawnwebgpu-v20261009.190412/emdawnwebgpu_pkg/emdawnwebgpu.port.py'
$taskSavedConfig = $env:EM_CONFIG
function Get-TaskAudit([string]$File) {
    return @{file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$taskReport = [ordered]@{date = Get-Date -Format o; pass = $false; variants = @()}
try {
    $env:EM_CONFIG = (Join-Path $taskSdk '.emscripten').Replace('\', '/')
    New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
    foreach ($taskVariant in @('before', 'fixed')) {
        $taskProduct = Join-Path $taskOutput "$taskVariant.js"
        $taskArgs = @((Join-Path $taskSdk 'upstream/emscripten/em++.py'), $taskSource,
            '-std=c++20', '-O1', '-m64', '-sASSERTIONS=1', '-sALLOW_MEMORY_GROWTH=1',
            '-sEXIT_RUNTIME=0', "--use-port=$(if ($taskVariant -eq 'fixed') { $taskPort } else { $taskBefore })",
            '-o', $taskProduct)
        $taskLog = Join-Path $PSScriptRoot "results/web-bindgroup-lifetime-$taskVariant-build.log"
        & (Join-Path $taskSdk 'python/3.13.3_64bit/python.exe') @taskArgs *> $taskLog
        if ($LASTEXITCODE -ne 0) { throw "Handle lifetime build failed: $taskLog" }
        $taskReport.variants += @{name = $taskVariant; log = Get-TaskAudit $taskLog
            products = @($taskProduct, ($taskProduct -replace '\.js$', '.wasm')) | ForEach-Object { Get-TaskAudit $_ }}
    }
    $taskReport.sources = @($PSCommandPath, $taskSource, $taskPort, $taskBefore,
        (Join-Path $taskRoot 'reference-engine/Engine/Platforms/Web/Build/WebGPUHandleDiagnostics.js'),
        (Join-Path $taskRoot 'reference-engine/Engine/Platforms/Web/Build/WebGPUStringViewABI.js')) |
        ForEach-Object { Get-TaskAudit $_ }
    $taskReport.pass = $true
} finally {
    $env:EM_CONFIG = $taskSavedConfig
    $taskReport | ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath (Join-Path $PSScriptRoot 'results/web-bindgroup-lifetime-build-results.json') -Encoding utf8
}
