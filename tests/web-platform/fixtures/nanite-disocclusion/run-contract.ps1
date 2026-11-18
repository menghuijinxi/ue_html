param([string]$VisualStudio='C:/Program Files/Microsoft Visual Studio/18/Community')
$ErrorActionPreference='Stop'
$taskPlatform=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskRoot=[IO.Path]::GetFullPath((Join-Path $taskPlatform '../..'))
$taskOutput=Join-Path $taskPlatform 'results/nanite-disocclusion-contract'
$taskInclude=Join-Path $taskRoot 'reference-engine/Engine/Source/Runtime/Renderer/Private'
[IO.Directory]::CreateDirectory($taskOutput) | Out-Null
@('@echo off',"call `"$VisualStudio/Common7/Tools/VsDevCmd.bat`" -arch=amd64 >nul",
 "cl /nologo /std:c++20 /O2 /EHsc `"$PSScriptRoot/contract.cpp`" /I`"$taskInclude`" /Fo`"$taskOutput/contract.obj`" /Fe`"$taskOutput/contract.exe`""
) | Set-Content -LiteralPath "$taskOutput/compile.cmd" -Encoding ascii
& cmd.exe /d /c "$taskOutput/compile.cmd" *> "$taskOutput/native-build.log"
if($LASTEXITCODE -ne 0){throw 'Native bounds contract build failed'}
& "$taskOutput/contract.exe" > "$taskOutput/native.json"
if($LASTEXITCODE -ne 0){throw 'Native bounds contract failed'}
$taskSavedConfig=$env:EM_CONFIG
try{
 $env:EM_CONFIG="$taskRoot/.tools/emsdk/.emscripten".Replace('\','/')
 & "$taskRoot/.tools/emsdk/python/3.13.3_64bit/python.exe" "$taskRoot/.tools/emsdk/upstream/emscripten/em++.py" "$PSScriptRoot/contract.cpp" "-I$taskInclude" -std=c++20 -O2 -m64 -sASSERTIONS=2 -sENVIRONMENT=node -sEXIT_RUNTIME=1 -o "$taskOutput/wasm64.js" *> "$taskOutput/wasm64-build.log"
 if($LASTEXITCODE -ne 0){throw 'Wasm bounds contract build failed'}
 & node "$taskOutput/wasm64.js" > "$taskOutput/wasm64.json" 2> "$taskOutput/wasm64-stderr.log"
 if($LASTEXITCODE -ne 0){throw 'Wasm bounds contract failed'}
}finally{$env:EM_CONFIG=$taskSavedConfig}
$taskFiles=@($PSCommandPath,"$PSScriptRoot/contract.cpp","$taskInclude/WebOcclusionBounds.h")+@(Get-ChildItem $taskOutput -File | Where-Object Name -ne 'verified.json' | ForEach-Object FullName)
@{pass=$true; runs=@('native','wasm64' | ForEach-Object {Get-Content "$taskOutput/$_.json" -Raw | ConvertFrom-Json});
 sources=@($taskFiles | ForEach-Object {@{file=$_;sha256=(Get-FileHash -LiteralPath $_).Hash.ToLowerInvariant()}});
 boundary='Actual production conservative sphere-cone bound. Independent finite segment/sphere intersections and constructed blockers across twelve orders of magnitude. Scene history and same-frame recovery are verified in the browser separately.'} |
 ConvertTo-Json -Depth 8 | Set-Content "$taskOutput/verified.json"
Get-Content "$taskOutput/verified.json" -Raw | ConvertFrom-Json | Select-Object pass,runs
