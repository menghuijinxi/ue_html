param([string]$Engine = 'H:/UE_5.8')
$ErrorActionPreference = 'Stop'
$taskProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../ue-shader-host/UEShaderHost.uproject'))
$taskOutput = Join-Path $PSScriptRoot 'build/ue-full'
$taskLog = Join-Path $PSScriptRoot 'results/ue-host.log'
$env:P1_ENGINE = $Engine
& node (Join-Path $PSScriptRoot 'prepare-ue-shaders.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Shader input verification failed' }
& (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development "-Project=$taskProject" -WaitMutex -NoHotReloadFromIDE
if ($LASTEXITCODE -ne 0) { throw 'UE shader host build failed' }
& (Join-Path $Engine 'Engine/Binaries/Win64/UnrealEditor-Cmd.exe') $taskProject -run=WebShaderProbe "-Output=$taskOutput" -nullrhi -unattended -nosplash -nop4 -NoSound "-abslog=$taskLog" 2>&1 |
    Select-String 'P1_SHADER|LogTemp:|Error:|Fatal' | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw 'UE shader host execution failed' }
& node (Join-Path $PSScriptRoot 'convert-ue-shaders.cjs')
if ($LASTEXITCODE -ne 0) { throw 'WGSL conversion or binding contract verification failed' }
