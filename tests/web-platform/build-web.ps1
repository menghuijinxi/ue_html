param(
    [string[]]$Variants = @('gpu32', 'gpu64', 'gpu32-thread', 'gpu64-thread', 'abi32', 'abi64', 'abi32-thread', 'abi64-thread')
)
$ErrorActionPreference = 'Stop'
$taskWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskSdk = Join-Path $taskWorkspace '.tools/emsdk'
$taskPython = Join-Path $taskSdk 'python/3.13.3_64bit/python.exe'
$taskEmcc = Join-Path $taskSdk 'upstream/emscripten/em++.py'
$taskPort = Join-Path $taskWorkspace '.tools/emdawnwebgpu-v20261009.190412/emdawnwebgpu_pkg/emdawnwebgpu.port.py'
$taskBuild = Join-Path $PSScriptRoot 'build/web'
New-Item -ItemType Directory -Path $taskBuild -Force | Out-Null
foreach ($taskVariant in $Variants) {
    $taskSource = if ($taskVariant.StartsWith('gpu')) { 'probe.cpp' } else { 'abi.cpp' }
    $taskArgs = @($taskEmcc, (Join-Path $PSScriptRoot $taskSource), '-std=c++20', '-O1',
        '-sASSERTIONS=1', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=33554432',
        '-sSTACK_SIZE=1048576', '-sEXIT_RUNTIME=0', '-o', (Join-Path $taskBuild "$taskVariant.js"))
    if ($taskVariant.StartsWith('gpu')) { $taskArgs += "--use-port=$taskPort" }
    if ($taskVariant.Contains('64')) { $taskArgs += '-m64' }
    if ($taskVariant.EndsWith('-thread')) {
        $taskArgs += @('-pthread', '-sPTHREAD_POOL_SIZE=2', '-sPROXY_TO_PTHREAD=1')
        if ($taskVariant.StartsWith('gpu')) {
            $taskArgs += @('-sOFFSCREENCANVAS_SUPPORT=1', '-sOFFSCREENCANVASES_TO_PTHREAD=#scene')
        }
    }
    Write-Output "Building $taskVariant"
    & $taskPython @taskArgs
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $taskVariant" }
}
