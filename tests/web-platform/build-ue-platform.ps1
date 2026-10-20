param([string]$Engine = 'H:/UE_5.8')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskWorker = Join-Path $taskRoot '.tools/ue58-web-shader-worker/Engine/Binaries/Win64/ShaderCompileWorker.exe'
$taskEditor = Join-Path $taskRoot '.tools/ue58-web-platform-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe'
$env:P1_ENGINE = $Engine
$env:UE_ENGINE_ROOT = Join-Path $Engine 'Engine'
$env:P1_PLATFORM = '1'
$env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
$env:WEBGPU_INTERMEDIATE_DIR = Join-Path $PSScriptRoot 'build/web-format-temp'
try {
    & node (Join-Path $PSScriptRoot 'prepare-ue-shaders.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Global shader snapshot verification failed' }
    & node (Join-Path $PSScriptRoot 'prepare-material-shaders.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Material shader snapshot verification failed' }
    & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development "-Project=$taskProject" -WaitMutex -NoHotReloadFromIDE
    if ($LASTEXITCODE -ne 0) { throw 'ShaderFormat and host build failed' }
    & node (Join-Path $PSScriptRoot 'build-worker-module.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Worker module build failed' }
    & node (Join-Path $PSScriptRoot 'build-static-platform-host.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Static ShaderPlatform host build failed' }
    foreach ($taskKind in @('ue-platform-full', 'ue-platform-material')) {
        $taskArguments = @($taskProject, '-run=WebShaderProbe', '-WebShaderPlatform',
            "-Output=$(Join-Path $PSScriptRoot "build/$taskKind")", "-WebFormatWorker=$taskWorker",
            '-unattended', '-nosplash', '-nop4', '-NoSound',
            "-abslog=$(Join-Path $PSScriptRoot "results/$taskKind-host.log")")
        if ($taskKind -eq 'ue-platform-material') {
            $taskArguments += @('-MaterialProbe', '-AllowCommandletRendering',
                "-ShaderSnapshot=$(Join-Path $taskRoot '.tools/ue58-material-shaders')")
        } else { $taskArguments += '-nullrhi' }
        & $taskEditor @taskArguments 2>&1 |
            Select-String 'P1_PLATFORM|P1_MATERIAL|Worker batch|Error:|Fatal' | ForEach-Object { $_.Line }
        if ($LASTEXITCODE -ne 0) { throw "$taskKind Worker probe failed" }
    }
    & node (Join-Path $PSScriptRoot 'convert-ue-shaders.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Web-platform global baseline conversion failed' }
    & node (Join-Path $PSScriptRoot 'convert-ue-material.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Web-platform material baseline conversion failed' }
    & node (Join-Path $PSScriptRoot 'prepare-worker-artifacts.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Web-platform Worker artifact comparison failed' }
    & node (Join-Path $PSScriptRoot 'verify-web-platform-negatives.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Web-platform missing-registration checks failed' }
} finally {
    Remove-Item Env:P1_PLATFORM -ErrorAction SilentlyContinue
}
