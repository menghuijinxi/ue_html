param([string]$Engine = 'H:/UE_5.8')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskWorker = Join-Path $taskRoot '.tools/ue58-web-shader-worker/Engine/Binaries/Win64/ShaderCompileWorker.exe'
Remove-Item Env:P1_PLATFORM -ErrorAction SilentlyContinue
$env:P1_ENGINE = $Engine
$env:UE_ENGINE_ROOT = Join-Path $Engine 'Engine'
$env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
$env:WEBGPU_INTERMEDIATE_DIR = Join-Path $PSScriptRoot 'build/web-format-temp'
& node (Join-Path $PSScriptRoot 'prepare-ue-shaders.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Global shader snapshot verification failed' }
& node (Join-Path $PSScriptRoot 'prepare-material-shaders.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Material shader snapshot verification failed' }
& (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development "-Project=$taskProject" -WaitMutex -NoHotReloadFromIDE
if ($LASTEXITCODE -ne 0) { throw 'ShaderFormat and host build failed' }
& node (Join-Path $PSScriptRoot 'build-worker-module.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Worker module build failed' }
foreach ($taskKind in @('ue-full', 'ue-material')) {
    $taskArguments = @($taskProject, '-run=WebShaderProbe', "-Output=$(Join-Path $PSScriptRoot "build/$taskKind")",
        "-WebFormatWorker=$taskWorker", '-unattended', '-nosplash', '-nop4', '-NoSound',
        "-abslog=$(Join-Path $PSScriptRoot "results/ue-webformat-$taskKind-host.log")")
    if ($taskKind -eq 'ue-material') {
        $taskArguments += @('-MaterialProbe', '-AllowCommandletRendering',
            "-ShaderSnapshot=$(Join-Path $taskRoot '.tools/ue58-material-shaders')")
    } else { $taskArguments += '-nullrhi' }
    & (Join-Path $Engine 'Engine/Binaries/Win64/UnrealEditor-Cmd.exe') @taskArguments 2>&1 |
        Select-String 'P1_|LogTemp:|Error:|Fatal' | ForEach-Object { $_.Line }
    if ($LASTEXITCODE -ne 0) { throw "$taskKind Worker probe failed" }
}
& node (Join-Path $PSScriptRoot 'convert-ue-shaders.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Global baseline conversion failed' }
& node (Join-Path $PSScriptRoot 'convert-ue-material.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Material baseline conversion failed' }
& node (Join-Path $PSScriptRoot 'prepare-worker-artifacts.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Worker artifact comparison failed' }
