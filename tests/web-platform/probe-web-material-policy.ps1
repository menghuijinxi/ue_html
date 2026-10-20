param()
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskBaseline = Get-Content (Join-Path $PSScriptRoot 'results/web-engine-webgpu-es31-cook-results-before-material-runtime-20261020.json') -Raw | ConvertFrom-Json
$taskResult = Join-Path $PSScriptRoot 'results/web-material-policy-native.json'
$taskLog = Join-Path $PSScriptRoot 'results/web-material-policy-native.log'
$taskArguments = @($taskBaseline.arguments | Where-Object {
    $_ -notmatch '^-run=|^-OutputDir=|^-PACKAGE=|^-abslog='
})
$taskArguments += @('-run=WebShaderProbe', '-MaterialPolicyProbe', "-Output=$taskResult", "-abslog=$taskLog")
$taskConfig = Join-Path $taskRoot 'tests/ue-shader-host/Config/Web/WebEngine.ini'
$taskArguments += @(Get-Content -LiteralPath $taskConfig |
    Where-Object { $_ -match '^[a-zA-Z][a-zA-Z0-9.]*=' } |
    ForEach-Object { "-ini:Engine:[SystemSettings]:$_" })
& (Join-Path $taskRoot '.tools/ue58-web-es31-cook-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe') @taskArguments *> "$taskLog.console.txt"
if ($LASTEXITCODE -ne 0) { throw "Material policy probe failed: $taskLog" }
$taskPolicy = Get-Content -LiteralPath $taskResult -Raw | ConvertFrom-Json
if ($taskPolicy.platform -ne 46 -or -not $taskPolicy.mobile -or $taskPolicy.dbuffer -or
    $taskPolicy.mobileDeferred -or -not $taskPolicy.fullDepthPrepass -or $taskPolicy.registeredWebSettings -ne 1) {
    throw "Web ES3.1 material policy still differs from the browser: $taskResult"
}
$taskPolicy | ConvertTo-Json
