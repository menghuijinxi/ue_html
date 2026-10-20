param([string]$Engine = 'H:/UE_5.8')
$ErrorActionPreference = 'Stop'
$taskProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../ue-shader-host/UEShaderHost.uproject'))
$taskOutput = Join-Path $PSScriptRoot 'build/ue-material'
$taskSnapshot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../.tools/ue58-material-shaders'))
$taskLog = Join-Path $PSScriptRoot 'results/ue-material-host.log'
$env:P1_ENGINE = $Engine
& node (Join-Path $PSScriptRoot 'prepare-material-shaders.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Target material shader verification failed' }
& (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development "-Project=$taskProject" -WaitMutex -NoHotReloadFromIDE
if ($LASTEXITCODE -ne 0) { throw 'UE material shader host build failed' }
& (Join-Path $Engine 'Engine/Binaries/Win64/UnrealEditor-Cmd.exe') $taskProject -run=WebShaderProbe -MaterialProbe "-Output=$taskOutput" "-ShaderSnapshot=$taskSnapshot" -AllowCommandletRendering -unattended -nosplash -nop4 -NoSound "-abslog=$taskLog" 2>&1 |
    Select-String 'P1_MATERIAL|LogTemp:|Error:|Fatal' | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw 'UE material shader host execution failed' }
& node (Join-Path $PSScriptRoot 'convert-ue-material.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Material conversion or binding verification failed' }
