param(
    [Parameter(Mandatory)][string]$ShaderType,
    [int]$Permutation = 0
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskHost = Join-Path $taskRoot '.tools/ue58-web-cook-host/Engine'
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskOutput = Join-Path $PSScriptRoot "build/web-desktop-shader/$taskStamp"
$taskLog = Join-Path $PSScriptRoot "results/web-desktop-shader-$taskStamp.log"
$taskPreviousTint = $env:WEBGPU_TINT_DIR
$taskPreviousIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
$taskProcess = Get-Process -Id $PID
$taskPreviousAffinity = $taskProcess.ProcessorAffinity
try {
    $taskProcess.ProcessorAffinity = [IntPtr]3
    $env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
    $env:WEBGPU_INTERMEDIATE_DIR = Join-Path $taskOutput 'ShaderConversion'
    $taskSettings = @(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'cook-profiles/DefaultTemplateDesktopEngine.ini') |
        Where-Object { $_ -match '^(r\.|landscape\.)[a-zA-Z0-9.]*=' } |
        ForEach-Object { "-ini:Engine:[SystemSettings]:$_" })
    $taskArguments = @(
        (Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'),
        '-run=WebShaderProbe', '-DesktopShaderProbe', "-ShaderType=$ShaderType",
        "-Permutation=$Permutation", "-Output=$taskOutput", '-WebGPUCook',
        '-nullrhi', '-sm5', '-unattended', '-nop4', '-nosplash', '-nosound', "-abslog=$taskLog"
    ) + $taskSettings
    & (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-Cmd.exe') @taskArguments *> "$taskLog.console.txt"
    $taskExitCode = $LASTEXITCODE
    $taskReport = Join-Path $taskOutput 'desktop-shader-results.json'
    if (Test-Path -LiteralPath $taskReport) {
        $taskSummary = Get-Content -LiteralPath $taskReport -Raw | ConvertFrom-Json
        $taskSummary.errors = @($taskSummary.errors | ForEach-Object { $_.Substring(0, [Math]::Min(500, $_.Length)) })
        $taskSummary | ConvertTo-Json -Depth 4
    }
    Write-Output "Log: $taskLog"
    if ($taskExitCode -ne 0) { throw "Desktop shader replay failed: $ShaderType/$Permutation" }
} finally {
    $env:WEBGPU_TINT_DIR = $taskPreviousTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskPreviousIntermediate
    $taskProcess.ProcessorAffinity = $taskPreviousAffinity
}
