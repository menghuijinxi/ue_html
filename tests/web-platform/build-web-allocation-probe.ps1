$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskOutput=Join-Path $taskRoot '.tools/web-allocation-probe'
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskConfigBefore=$env:EM_CONFIG
try {
 $env:EM_CONFIG="$taskRoot/.tools/emsdk/.emscripten".Replace('\','/')
 & "$taskRoot/.tools/emsdk/python/3.13.3_64bit/python.exe" "$taskRoot/.tools/emsdk/upstream/emscripten/em++.py" (Join-Path $PSScriptRoot 'web-allocation-probe.cpp') -c -O2 -m64 -pthread -fno-exceptions -o "$taskOutput/probe.o"
 if($LASTEXITCODE -ne 0){throw 'Allocation probe compile failed'}
 & "$taskRoot/.tools/emsdk/upstream/bin/llvm-ar.exe" rcs "$taskOutput/probe.a" "$taskOutput/probe.o"
 if($LASTEXITCODE -ne 0){throw 'Allocation probe archive failed'}
}finally{$env:EM_CONFIG=$taskConfigBefore}
