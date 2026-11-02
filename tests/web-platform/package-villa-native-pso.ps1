param(
    [string]$Engine = 'D:/UE_5.8',
    [string]$Project = 'G:/UE_HTML/TriplexHouseVilla/TriplexHouseVilla.uproject',
    [string]$Label = 'villa-native-pso-v1'
)
$ErrorActionPreference = 'Stop'
if ($Label -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid label.' }
$taskRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$taskPrefix = Join-Path $taskRoot "results/$Label-package"
$taskStage = Join-Path $taskRoot "build/$Label"
$taskConfig = Join-Path (Split-Path $Project) 'Config'
$taskBefore = @(Get-ChildItem -LiteralPath $taskConfig -Recurse -File | Get-FileHash -Algorithm SHA256 | Select-Object Path,Hash)
$taskArgs = @('BuildCookRun', "-project=$Project", '-nop4', '-installed', '-utf8output',
    '-platform=Win64', '-clientconfig=Development', '-nocompileeditor', "-unrealexe=$Engine/Engine/Binaries/Win64/UnrealEditor-Cmd.exe", '-build', '-cook',
    '-stage', '-pak', '-unattended', '-map=/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla',
    "-stagingdirectory=$taskStage")
[ordered]@{started=(Get-Date).ToString('o');engine=$Engine;project=$Project;arguments=$taskArgs;configBefore=$taskBefore} |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$taskPrefix-launch.json" -Encoding UTF8
& (Join-Path $Engine 'Engine/Build/BatchFiles/RunUAT.bat') @taskArgs *> "$taskPrefix.log"
$taskExit = $LASTEXITCODE
$taskAfter = @(Get-ChildItem -LiteralPath $taskConfig -Recurse -File | Get-FileHash -Algorithm SHA256 | Select-Object Path,Hash)
$taskChanged = @(Compare-Object $taskBefore $taskAfter -Property Path,Hash)
[ordered]@{completed=(Get-Date).ToString('o');exitCode=$taskExit;configUnchanged=($taskChanged.Count -eq 0);stage=$taskStage} |
    ConvertTo-Json | Set-Content -LiteralPath "$taskPrefix-complete.json" -Encoding UTF8
if ($taskChanged.Count) { throw 'Project Config changed while packaging.' }
if ($taskExit -ne 0) { throw "Packaging failed: $taskPrefix.log" }
Write-Output "Packaged native Development build: $taskStage"
