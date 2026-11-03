param()
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskOutput=Join-Path $PSScriptRoot 'build/allocator-contract'
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskConfigBefore=$env:EM_CONFIG
try {
 $env:EM_CONFIG="$taskRoot/.tools/emsdk/.emscripten".Replace('\','/')
 foreach($taskAllocator in @('dlmalloc','mimalloc')) {
  $taskArgs=@('-O2','-m64','-pthread','-sPTHREAD_POOL_SIZE=4','-sSTACK_SIZE=1048576','-sALLOW_MEMORY_GROWTH=1','-sENVIRONMENT=worker','-sASSERTIONS=1','-sINCOMING_MODULE_JS_API=mainScriptUrlOrBlob,locateFile','-fno-exceptions',"-sMALLOC=$taskAllocator")
  & "$taskRoot/.tools/emsdk/python/3.13.3_64bit/python.exe" "$taskRoot/.tools/emsdk/upstream/emscripten/em++.py" (Join-Path $PSScriptRoot 'allocator-contract.cpp') -o "$taskOutput/$taskAllocator.js" @taskArgs
  if($LASTEXITCODE -ne 0){throw "Allocator contract build failed: $taskAllocator"}
 }
}finally{$env:EM_CONFIG=$taskConfigBefore}
