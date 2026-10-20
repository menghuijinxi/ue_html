$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskSource = Join-Path $taskRoot 'reference-engine/Engine/Source/ThirdParty/libPNG/libPNG-1.6.44'
$taskOutput = Join-Path $PSScriptRoot 'build/web-libpng'
$taskLibrary = Join-Path $taskRoot 'reference-engine/Engine/Platforms/Web/Source/ThirdParty/libPNG/libPNG-1.6.44/lib/wasm64/libpng.a'
$taskSdk = Join-Path $taskRoot '.tools/emsdk'
$taskPython = Join-Path $taskSdk 'python/3.13.3_64bit/python.exe'
$taskEmcc = Join-Path $taskSdk 'upstream/emscripten/emcc.py'
$taskEmar = Join-Path $taskSdk 'upstream/emscripten/emar.py'
$taskConfigBefore = $env:EM_CONFIG
$taskProcess = Get-Process -Id $PID
$taskAffinityBefore = $taskProcess.ProcessorAffinity
New-Item -ItemType Directory -Path $taskOutput, (Split-Path $taskLibrary -Parent), (Join-Path $PSScriptRoot 'results') -Force | Out-Null
$taskLog = Join-Path $PSScriptRoot 'results/web-libpng-build.log'
$taskReport = [ordered]@{ pass = $false; date = (Get-Date -Format o); architecture = 'wasm64'; version = '1.6.44'; portable = $true }
function Get-PngAudit([string]$File) {
    return @{ file = $File; sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
}
try {
    $taskProcess.ProcessorAffinity = [IntPtr]3
    $env:EM_CONFIG = (Join-Path $taskSdk '.emscripten').Replace('\', '/')
    $taskObjects = @()
    $taskSources = @(Get-ChildItem -LiteralPath $taskSource -Filter '*.c' -File | Where-Object { $_.Name -notin @('example.c', 'pngtest.c') })
    if ($taskSources.Count -ne 15) { throw 'Unexpected libPNG source inventory' }
    foreach ($taskFile in $taskSources) {
        $taskObject = Join-Path $taskOutput "$($taskFile.BaseName).o"
        & $taskPython $taskEmcc -m64 -O2 --use-port=zlib -DPNG_INTEL_SSE_OPT=0 -DPNG_ARM_NEON_OPT=0 -DPNG_MIPS_MSA_OPT=0 -DPNG_MIPS_MMI_OPT=0 -DPNG_POWERPC_VSX_OPT=0 -DPNG_LOONGARCH_LSX_OPT=0 -c $taskFile.FullName -o $taskObject *>> $taskLog
        if ($LASTEXITCODE -ne 0) { throw "Portable libPNG compilation failed: $($taskFile.Name)" }
        $taskObjects += $taskObject
    }
    & $taskPython $taskEmar rcs $taskLibrary @taskObjects *>> $taskLog
    if ($LASTEXITCODE -ne 0) { throw 'Portable libPNG archive failed' }
    $taskSmoke = Join-Path $taskOutput 'web-libpng.js'
    & $taskPython $taskEmcc -m64 -O2 --use-port=zlib (Join-Path $PSScriptRoot 'web-libpng.c') "-I$taskSource" $taskLibrary -o $taskSmoke '-sENVIRONMENT=web,node' '-sALLOW_MEMORY_GROWTH=1' *>> $taskLog
    if ($LASTEXITCODE -ne 0) { throw 'Portable libPNG test executable failed' }
    $taskReport.pass = $true
    $taskReport.library = Get-PngAudit $taskLibrary
    $taskReport.objects = @($taskObjects | ForEach-Object { Get-PngAudit $_ })
    $taskReport.sourceFiles = @($PSCommandPath, (Join-Path $PSScriptRoot 'web-libpng.c')) +
        @($taskSources | ForEach-Object { $_.FullName }) +
        @(Get-ChildItem -LiteralPath $taskSource -Filter '*.h' -File | ForEach-Object { $_.FullName })
    $taskReport.sourceFiles = @($taskReport.sourceFiles | ForEach-Object { Get-PngAudit $_ })
    $taskReport.products = @($taskSmoke, [IO.Path]::ChangeExtension($taskSmoke, '.wasm')) | ForEach-Object { Get-PngAudit $_ }
    Write-Output 'P3_WEB_LIBPNG portable 1.6.44 archive and wasm64 test executable built.'
} finally {
    $env:EM_CONFIG = $taskConfigBefore
    $taskProcess.ProcessorAffinity = $taskAffinityBefore
    $taskReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'results/web-libpng-build-results.json') -Encoding utf8
}
