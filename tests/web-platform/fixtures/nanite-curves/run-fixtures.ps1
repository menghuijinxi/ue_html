param([switch]$SkipBuild,[switch]$Production)
$ErrorActionPreference='Stop'
$taskProcess=Get-Process -Id $PID
$taskAffinity=$taskProcess.ProcessorAffinity
try {
 $taskProcess.ProcessorAffinity=3
 $taskOutput='G:/UE_HTML/ue_html/tests/web-platform/results/nanite-curves'
 $taskProject=Join-Path $taskOutput 'fixture-host/WebCurveFixture.uproject'
 if(-not $SkipBuild){
  & D:/UE_5.8/Engine/Build/BatchFiles/Build.bat WebCurveFixtureEditor Win64 Development "-Project=$taskProject" -Module=WebCurveFixture -WaitMutex -NoHotReloadFromIDE -NoUBA -NoUbaLocal -MaxParallelActions=1 *> "$taskOutput/build.log"
  if($LASTEXITCODE -ne 0){throw 'Curve fixture host build failed'}
 }
 $taskHost=Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))) $(if($Production){'.tools/ue58-nanite-cook-host/Engine'}else{'.tools/ue58-curves-preview-host/Engine'})
 $taskInstalledModules=Get-Content "$taskHost/Binaries/Win64/UnrealEditor.modules" -Raw | ConvertFrom-Json
 @{BuildId=$taskInstalledModules.BuildId;Modules=@{WebCurveFixture='UnrealEditor-WebCurveFixture.dll'}} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path (Split-Path $taskProject) 'Binaries/Win64/UnrealEditor.modules')
 & "$taskHost/Binaries/Win64/UnrealEditor-Cmd.exe" $taskProject -run=WebCurveFixture '-ini:Engine:[SystemSettings]:r.Nanite.AllowCurves=1' '-LogCmds=LogStaticMesh verbose' "-Output=$taskOutput/fixtures" -nullrhi -unattended -nop4 -nosplash -nosound "-abslog=$taskOutput/fixture.log" *> "$taskOutput/fixture-console.log"
 if($LASTEXITCODE -ne 0){throw 'Curve fixture creation failed'}
 if(Select-String -LiteralPath "$taskOutput/fixture.log" -Pattern 'Error:|Ensure condition failed|Fatal error' -Quiet){throw 'Curve fixture logged an error'}
 $taskReports=@(Get-ChildItem "$taskOutput/fixtures" -Filter fixture.json -Recurse -File | ForEach-Object {Get-Content $_.FullName -Raw | ConvertFrom-Json})
 if($taskReports.Count -ne 29 -or @($taskReports | Where-Object {-not $_.pass}).Count){throw 'Expected twenty-nine native curve fixtures'}
} finally {
 $taskProcess.ProcessorAffinity=$taskAffinity
}
