param(
 [string]$VisualStudio='C:/Program Files/Microsoft Visual Studio/18/Community',
 [ValidateSet('jspi','asyncify')][string]$WasmSuspension='jspi'
)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskBuild=Join-Path $PSScriptRoot 'build/draw-api'
$taskCmake=Join-Path $VisualStudio 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
& $taskCmake -S (Join-Path $PSScriptRoot 'draw-api') -B $taskBuild -G 'Visual Studio 18 2026' -A x64 "-DCMAKE_PREFIX_PATH=$taskRoot/.tools/dawn-v20261009.190412"
if($LASTEXITCODE -ne 0){throw 'Draw benchmark configure failed'}
& $taskCmake --build $taskBuild --config Release -j 4
if($LASTEXITCODE -ne 0){throw 'Draw benchmark native build failed'}
Copy-Item -LiteralPath "$taskRoot/.tools/dxc-v1.9.2609/bin/x64/dxcompiler.dll","$taskRoot/.tools/dxc-v1.9.2609/bin/x64/dxil.dll" -Destination "$taskBuild/Release"
$taskEMBefore=$env:EM_CONFIG
try{
 $env:EM_CONFIG="$taskRoot/.tools/emsdk/.emscripten".Replace('\','/')
 $taskSuspendArgs=@(if($WasmSuspension -eq 'jspi'){'-sJSPI=1'}else{'-sASYNCIFY=1';'-sASYNCIFY_STACK_SIZE=131072'})
 & "$taskRoot/.tools/emsdk/python/3.13.3_64bit/python.exe" "$taskRoot/.tools/emsdk/upstream/emscripten/em++.py" (Join-Path $PSScriptRoot 'draw-api-webgpu.cpp') -o "$taskBuild/draw-wasm.js" -O3 -m64 @taskSuspendArgs -sALLOW_MEMORY_GROWTH=1 -sENVIRONMENT=worker -sASSERTIONS=0 -fno-exceptions "--use-port=$taskRoot/.tools/emdawnwebgpu-v20261009.190412/emdawnwebgpu_pkg/emdawnwebgpu.port.py"
 if($LASTEXITCODE -ne 0){throw 'Draw benchmark wasm64 build failed'}
 @{date=[DateTime]::UtcNow.ToString('o');wasmSuspension=$WasmSuspension;wasmOptimization='O3';wasmAssertions=0;wasmExceptions='disabled';nativeConfiguration='Release';dawnVersion='v20261009.190412';emdawnVersion='v20261009.190412'} | ConvertTo-Json | Set-Content "$taskBuild/build-config.json" -Encoding utf8
}finally{$env:EM_CONFIG=$taskEMBefore}
