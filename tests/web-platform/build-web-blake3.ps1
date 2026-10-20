$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskSource = Join-Path $taskRoot 'reference-engine/Engine/Source/ThirdParty/BLAKE3/1.3.1/c'
$taskOutput = Join-Path $PSScriptRoot 'build/web-blake3'
$taskLibrary = Join-Path $taskRoot 'reference-engine/Engine/Platforms/Web/Source/ThirdParty/BLAKE3/1.3.1/lib/wasm64/libBLAKE3.a'
$taskSdk = Join-Path $taskRoot '.tools/emsdk'
$taskPython = Join-Path $taskSdk 'python/3.13.3_64bit/python.exe'
$taskEmcc = Join-Path $taskSdk 'upstream/emscripten/emcc.py'
$taskEmar = Join-Path $taskSdk 'upstream/emscripten/emar.py'
$taskConfigBefore = $env:EM_CONFIG
$taskProcess = Get-Process -Id $PID
$taskAffinityBefore = $taskProcess.ProcessorAffinity
New-Item -ItemType Directory -Path $taskOutput, (Split-Path $taskLibrary -Parent), (Join-Path $PSScriptRoot 'results') -Force | Out-Null
$taskLog = Join-Path $PSScriptRoot 'results/web-blake3-build.log'
$taskReport = [ordered]@{ pass = $false; date = (Get-Date -Format o); architecture = 'wasm64'; version = '1.3.1'; portable = $true }
function Get-BlakeAudit([string]$File) {
    return @{ file = $File; sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
}
try {
    $taskProcess.ProcessorAffinity = [IntPtr]3
    $env:EM_CONFIG = (Join-Path $taskSdk '.emscripten').Replace('\', '/')
    $taskObjects = @()
    foreach ($taskName in @('blake3', 'blake3_dispatch', 'blake3_portable')) {
        $taskObject = Join-Path $taskOutput "$taskName.o"
        & $taskPython $taskEmcc -m64 -O2 -DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0 -c (Join-Path $taskSource "$taskName.c") -o $taskObject *>> $taskLog
        if ($LASTEXITCODE -ne 0) { throw "Portable BLAKE3 compilation failed: $taskName" }
        $taskObjects += $taskObject
    }
    & $taskPython $taskEmar rcs $taskLibrary @taskObjects *>> $taskLog
    if ($LASTEXITCODE -ne 0) { throw 'Portable BLAKE3 archive failed' }
    $taskSmoke = Join-Path $taskOutput 'web-blake3.js'
    & $taskPython $taskEmcc -m64 -O2 (Join-Path $PSScriptRoot 'web-blake3.c') "-I$taskSource" $taskLibrary -o $taskSmoke '-sENVIRONMENT=web,node' '-sALLOW_MEMORY_GROWTH=1' '-sEXPORTED_FUNCTIONS=["_main","_WebBlake3Digest"]' '-sEXPORTED_RUNTIME_METHODS=["UTF8ToString"]' *>> $taskLog
    if ($LASTEXITCODE -ne 0) { throw 'Portable BLAKE3 test executable failed' }
    $taskReport.pass = $true
    $taskReport.library = Get-BlakeAudit $taskLibrary
    $taskReport.objects = @($taskObjects | ForEach-Object { Get-BlakeAudit $_ })
    $taskReport.sourceFiles = @($PSCommandPath, (Join-Path $PSScriptRoot 'web-blake3.c'),
        (Join-Path $taskSource 'blake3.c'), (Join-Path $taskSource 'blake3_dispatch.c'),
        (Join-Path $taskSource 'blake3_portable.c'), (Join-Path $taskSource 'blake3.h'),
        (Join-Path $taskSource 'blake3_impl.h')) | ForEach-Object { Get-BlakeAudit $_ }
    $taskReport.products = @($taskSmoke, [IO.Path]::ChangeExtension($taskSmoke, '.wasm')) | ForEach-Object { Get-BlakeAudit $_ }
    Write-Output "P3_WEB_BLAKE3 portable 1.3.1 archive and wasm64 test executable built."
} finally {
    $env:EM_CONFIG = $taskConfigBefore
    $taskProcess.ProcessorAffinity = $taskAffinityBefore
    $taskReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'results/web-blake3-build-results.json') -Encoding utf8
}
