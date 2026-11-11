param([string]$VisualStudio='C:/Program Files/Microsoft Visual Studio/18/Community')
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskOutput=Join-Path $PSScriptRoot 'results/nanite-curves/vectorvm'
$taskSource=Join-Path $PSScriptRoot 'fixtures/vectorvm/vectorvm-web-contract.cpp'
$taskShim=Join-Path $PSScriptRoot 'fixtures/vectorvm'
$taskReference=Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/VectorVM/Private'
$taskSdk=Join-Path $taskRoot '.tools/emsdk'
$taskSavedConfig=$env:EM_CONFIG
try {
 $env:EM_CONFIG=(Join-Path $taskSdk '.emscripten').Replace('\','/')
New-Item -ItemType Directory -Force -Path $taskOutput | Out-Null
& node (Join-Path $taskShim 'prepare-integer-contract.cjs')
if($LASTEXITCODE -ne 0){throw 'VectorVM production integer contract extraction failed'}
$taskBatch=Join-Path $taskOutput 'compile.cmd'
@(
 '@echo off'
 "call `"$VisualStudio/Common7/Tools/VsDevCmd.bat`" -arch=amd64 >nul"
 "cl /nologo /std:c++20 /O2 /EHsc `"$taskSource`" /I`"$taskOutput`" /I`"$taskShim`" /I`"$taskReference`" /Fo`"$taskOutput/contract.obj`" /Fe`"$taskOutput/contract.exe`""
) | Set-Content -LiteralPath $taskBatch -Encoding ascii
& cmd.exe /d /c $taskBatch *> "$taskOutput/native-build.log"
if($LASTEXITCODE -ne 0){throw 'Native VectorVM reference compilation failed'}
& "$taskOutput/contract.exe" "$taskOutput/reference.bin" > "$taskOutput/native.json"
if($LASTEXITCODE -ne 0){throw 'Native VectorVM contract failed'}
$taskRuns=@()
foreach($taskMode in @('wasm64','wasm32-asan')){
 [string[]]$taskFlags=if($taskMode -eq 'wasm64'){@('-m64')}else{@('-fsanitize=address,undefined','-fno-sanitize-recover=all','-sALLOW_MEMORY_GROWTH=1')}
 $taskArguments=@("$taskSdk/upstream/emscripten/em++.py",$taskSource,"-I$taskReference","-I$taskOutput",'-std=c++20','-O2','-sASSERTIONS=2','-sENVIRONMENT=node','-sEXIT_RUNTIME=1')+$taskFlags+@('--preload-file',"$taskOutput/reference.bin@/vectorvm-reference.bin",'-o',"$taskOutput/$taskMode.js")
 & "$taskSdk/python/3.13.3_64bit/python.exe" @taskArguments *> "$taskOutput/$taskMode-build.log"
 if($LASTEXITCODE -ne 0){throw "VectorVM $taskMode compilation failed"}
 Push-Location $taskOutput
 try {
  & node "$taskOutput/$taskMode.js" > "$taskOutput/$taskMode.json" 2> "$taskOutput/$taskMode-stderr.log"
  if($LASTEXITCODE -ne 0){throw "VectorVM $taskMode contract failed"}
  if(Select-String -LiteralPath "$taskOutput/$taskMode-stderr.log" -Pattern 'runtime error:|Sanitizer:|ERROR:|SUMMARY:' -Quiet){throw "VectorVM $taskMode sanitizer failure"}
 } finally { Pop-Location }
 $taskResult=Get-Content "$taskOutput/$taskMode.json" -Raw | ConvertFrom-Json
 if(-not $taskResult.pass -or $taskResult.halfValues -ne 1304576 -or $taskResult.byteCases -ne 4096 -or $taskResult.shiftCases -ne 1024 -or $taskResult.integerCases -ne 8192){throw "Incomplete VectorVM $taskMode contract"}
 $taskRuns+=@{mode=$taskMode;result=$taskResult}
}
$taskFiles=@($PSCommandPath,$taskSource,"$taskShim/Platforms/VectorVMPlatformBase.h","$taskReference/Platforms/VectorVMPlatformGeneric.h","$taskReference/Platforms/VectorVMWebScalar.h","$taskReference/Platforms/VectorVMPlatformWeb.h","$taskReference/VectorVMRuntime.cpp","$taskOutput/reference.bin","$taskOutput/contract.exe","$taskOutput/wasm64.js","$taskOutput/wasm64.wasm","$taskOutput/wasm32-asan.js","$taskOutput/wasm32-asan.wasm")
$taskFiles+=@("$taskShim/prepare-integer-contract.cjs","$taskOutput/integer-contract.h")
$taskFiles+=@(Get-Content "$taskOutput/integer-contract-sources.json" -Raw | ConvertFrom-Json)
@{
 pass=$true
 native=(Get-Content "$taskOutput/native.json" -Raw | ConvertFrom-Json)
 web=$taskRuns
 sourceFiles=@($taskFiles | ForEach-Object { @{file=$_;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $_).Hash.ToLower();bytes=(Get-Item -LiteralPath $_).Length} })
 boundary='Production scalar operations compared bitwise with desktop VectorVM half conversion and x86 byte/shift instructions. All 65536 half encodings, signed midpoint neighborhoods, 1048576 random float bit patterns, nonaligned exact-width IO and all byte mask values. Actual FPU/SSE primitives and four Runtime integer functions are extracted unchanged; 8192 four-lane cases include signed edges, inverted clamp bounds and arbitrary boolean masks. Shifts >=32 explicitly return zero, matching SSE logical shifts. This contract does not by itself validate Niagara simulation or Groom rendering.'
} | ConvertTo-Json -Depth 10 | Set-Content "$taskOutput/verified.json"
Get-Content "$taskOutput/verified.json" -Raw | ConvertFrom-Json | Select-Object pass,native,web
} finally { $env:EM_CONFIG=$taskSavedConfig }
