$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskCmake = 'C:/Program Files/Microsoft Visual Studio/18/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
$taskDawn = Join-Path $taskRoot '.tools/dawn-v20261009.190412'
$taskBuild = Join-Path $PSScriptRoot 'build/tint-nanite'
& $taskCmake -S (Join-Path $PSScriptRoot 'tint-nanite') -B $taskBuild `
    -G 'Visual Studio 18 2026' -A x64 "-DDAWN_ROOT=$taskDawn"
if ($LASTEXITCODE -ne 0) { throw 'Nanite Tint configure failed' }
& $taskCmake --build $taskBuild --config Release
if ($LASTEXITCODE -ne 0) { throw 'Nanite Tint build failed' }
$taskBinary = Join-Path $taskBuild 'Release/tint_nanite.exe'
$taskDestination = Join-Path $taskDawn 'bin/tint_nanite.exe'
Copy-Item -LiteralPath $taskBinary -Destination $taskDestination
Write-Output "Nanite converter: $taskDestination"
