param([string]$VisualStudio='C:/Program Files/Microsoft Visual Studio/18/Community')
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskBuild=Join-Path $PSScriptRoot 'build/draw-api'
$taskOutput=Join-Path $PSScriptRoot 'build/rhi-isolation'
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskCmake=Join-Path $VisualStudio 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
& $taskCmake -S (Join-Path $PSScriptRoot 'draw-api') -B $taskBuild -G 'Visual Studio 18 2026' -A x64 "-DCMAKE_PREFIX_PATH=$taskRoot/.tools/dawn-v20261009.190412"
if($LASTEXITCODE -ne 0){throw 'Isolation configure failed'}
& $taskCmake --build $taskBuild --config Release --target rhi_isolation_d3d12 rhi_isolation_dawn -j 4
if($LASTEXITCODE -ne 0){throw 'Isolation native build failed'}
Copy-Item -LiteralPath "$taskBuild/Release/rhi_isolation_d3d12.exe","$taskBuild/Release/rhi_isolation_dawn.exe" -Destination $taskOutput
Copy-Item -LiteralPath "$taskRoot/.tools/dxc-v1.9.2609/bin/x64/dxcompiler.dll","$taskRoot/.tools/dxc-v1.9.2609/bin/x64/dxil.dll" -Destination $taskOutput
$taskConfigBefore=$env:EM_CONFIG
try{
 $env:EM_CONFIG="$taskRoot/.tools/emsdk/.emscripten".Replace('\','/')
 foreach($taskVariant in @('scalar','simd')){
  $taskArgs=@('-O2','-m64','-pthread','-sPTHREAD_POOL_SIZE=4','-sSTACK_SIZE=1048576','-sDEFAULT_PTHREAD_STACK_SIZE=262144','-sALLOW_BLOCKING_ON_MAIN_THREAD=1','-sJSPI=1','-sALLOW_MEMORY_GROWTH=1','-sENVIRONMENT=worker','-sASSERTIONS=1','-sINCOMING_MODULE_JS_API=mainScriptUrlOrBlob,locateFile,printErr,onAbort','-fno-exceptions',
   '-DDRAW_COMMAND_STREAM=1','-DDRAW_PACKED_GROUPS=1','--js-library',"$taskRoot/reference-engine/Engine/Platforms/Web/Build/WebGPUCommandStream.js",'--js-library',"$taskRoot/reference-engine/Engine/Platforms/Web/Build/WebGPUPackedDescriptors.js",
   "--use-port=$taskRoot/.tools/emdawnwebgpu-v20261009.190412/emdawnwebgpu_pkg/emdawnwebgpu.port.py")
  if($taskVariant -eq 'simd'){$taskArgs+='-msimd128'}
  & "$taskRoot/.tools/emsdk/python/3.13.3_64bit/python.exe" "$taskRoot/.tools/emsdk/upstream/emscripten/em++.py" (Join-Path $PSScriptRoot 'rhi-isolation-webgpu.cpp') -o "$taskOutput/isolation-$taskVariant.js" @taskArgs
  if($LASTEXITCODE -ne 0){throw "Isolation $taskVariant wasm build failed"}
 }
 @{date=[DateTime]::UtcNow.ToString('o');optimization='O2';assertions=1;sharedMemory=$true;pool=4;wasm64=$true;jspi=$true;commandStream=$true;packedGroups=$true;simdVariants=@('scalar','simd');nativeConfiguration='Release';boundary='CPU preparation is a source-reviewed model, not linked UE functions. GPU operations are actual DX12/Dawn/browser WebGPU calls.'} | ConvertTo-Json -Depth 3 | Set-Content "$taskOutput/build-config.json" -Encoding utf8
}finally{$env:EM_CONFIG=$taskConfigBefore}
