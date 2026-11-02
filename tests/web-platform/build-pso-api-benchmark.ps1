param([string]$VisualStudio = 'C:/Program Files/Microsoft Visual Studio/18/Community')
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$taskBuild = Join-Path $PSScriptRoot 'build/pso-api-benchmark'
$taskDxc = Join-Path $taskRoot '.tools/dxc-v1.9.2609'
New-Item -ItemType Directory -Force -Path $taskBuild | Out-Null
$taskSource = Join-Path $PSScriptRoot 'pso-api-benchmark.cpp'
$taskExe = Join-Path $taskBuild 'pso-api-benchmark.exe'
$taskBatch = Join-Path $taskBuild 'compile.cmd'
@(
  '@echo off'
  "call `"$VisualStudio/Common7/Tools/VsDevCmd.bat`" -arch=amd64 >nul"
  "cl /nologo /std:c++20 /O2 /EHsc `"$taskSource`" /I`"$taskDxc/inc`" /Fo`"$taskBuild/pso-api-benchmark.obj`" /Fe`"$taskExe`" /link d3d12.lib dxgi.lib dxcompiler.lib /LIBPATH:`"$taskDxc/lib/x64`""
) | Set-Content -LiteralPath $taskBatch -Encoding ascii
& cmd.exe /d /c $taskBatch
if ($LASTEXITCODE -ne 0) { throw 'Standalone D3D12 benchmark compilation failed.' }
Copy-Item -LiteralPath "$taskDxc/bin/x64/dxcompiler.dll", "$taskDxc/bin/x64/dxil.dll" -Destination $taskBuild
& $taskExe prepare (Join-Path $taskBuild 'assets') unused
if ($LASTEXITCODE -ne 0) { throw 'DXIL shader preparation failed.' }
Get-Item -LiteralPath $taskExe | Select-Object FullName, Length
