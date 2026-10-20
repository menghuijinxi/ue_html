$ErrorActionPreference = 'Stop'
$taskWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskVs = 'C:/Program Files/Microsoft Visual Studio/18/Community'
$taskCmake = Join-Path $taskVs 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
$taskDawn = Join-Path $taskWorkspace '.tools/dawn-v20261009.190412'
$taskDxc = Join-Path $taskWorkspace '.tools/dxc-v1.9.2609/bin/x64'
$taskBuild = Join-Path $PSScriptRoot 'build/native'
& $taskCmake -S $PSScriptRoot -B $taskBuild -G 'Visual Studio 18 2026' -A x64 "-DCMAKE_PREFIX_PATH=$taskDawn"
if ($LASTEXITCODE -ne 0) { throw 'Native CMake configure failed' }
& $taskCmake --build $taskBuild --config Release -j 4
if ($LASTEXITCODE -ne 0) { throw 'Native build failed' }
Copy-Item -LiteralPath (Join-Path $taskDxc 'dxcompiler.dll'),(Join-Path $taskDxc 'dxil.dll') -Destination (Join-Path $taskBuild 'Release')
New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'results') -Force | Out-Null
foreach ($taskProbe in @('webgpu', 'abi')) {
    & (Join-Path $taskBuild "Release/${taskProbe}_probe.exe") 2>&1 |
        Tee-Object -FilePath (Join-Path $PSScriptRoot "results/native-$taskProbe.log")
    if ($LASTEXITCODE -ne 0) { throw "Native probe failed: $taskProbe" }
}
