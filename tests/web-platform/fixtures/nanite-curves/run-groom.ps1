param([switch]$SkipBuild,[switch]$Production)
$ErrorActionPreference='Stop'
$taskProcess=Get-Process -Id $PID
$taskAffinity=$taskProcess.ProcessorAffinity
try {
 $taskProcess.ProcessorAffinity=3
 $taskRoot='G:/UE_HTML/ue_html'
 $taskOutput=Join-Path $taskRoot 'tests/web-platform/results/nanite-curves'
 $taskProject=Join-Path $taskOutput 'fixture-host/WebCurveFixture.uproject'
 if(-not $SkipBuild){
  & D:/UE_5.8/Engine/Build/BatchFiles/Build.bat WebCurveFixtureEditor Win64 Development "-Project=$taskProject" -Module=WebCurveFixture -WaitMutex -NoHotReloadFromIDE -NoUBA -NoUbaLocal -MaxParallelActions=1 *> "$taskOutput/groom-build.log"
  if($LASTEXITCODE -ne 0){throw 'Groom fixture host build failed'}
 }
 $taskHost=Join-Path $taskRoot $(if($Production){'.tools/ue58-nanite-cook-host/Engine'}else{'.tools/ue58-curves-preview-host/Engine'})
 $taskModules=Get-Content "$taskHost/Binaries/Win64/UnrealEditor.modules" -Raw | ConvertFrom-Json
 @{BuildId=$taskModules.BuildId;Modules=@{WebCurveFixture='UnrealEditor-WebCurveFixture.dll'}} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path (Split-Path $taskProject) 'Binaries/Win64/UnrealEditor.modules')
 & "$taskHost/Binaries/Win64/UnrealEditor-Cmd.exe" $taskProject -run=WebCurveFixture -GroomFixture '-ini:Engine:[SystemSettings]:r.Nanite.AllowCurves=1,[SystemSettings]:r.HairStrands.Nanite=1,[SystemSettings]:r.HairStrands.Nanite.MaxPointPerCurve=256' "-Output=$taskOutput/groom" "-FixtureDirectory=$taskOutput/fixture-host/Content/WebNaniteCurves" -nullrhi -unattended -nop4 -nosplash -nosound "-abslog=$taskOutput/groom.log" *> "$taskOutput/groom-console.log"
 if($LASTEXITCODE -ne 0){throw 'Real Groom fixture creation failed'}
 if(Select-String -LiteralPath "$taskOutput/groom.log" -Pattern 'Error:|Ensure condition failed|Fatal error' -Quiet){throw 'Groom fixture logged an error'}
 $taskReports=@(Get-ChildItem "$taskOutput/groom" -Filter groom.json -Recurse -File | ForEach-Object {Get-Content $_.FullName -Raw | ConvertFrom-Json})
 if($taskReports.Count -ne 4 -or @($taskReports | Where-Object {-not $_.pass -or $_.class -ne 'GroomAsset' -or $_.groups -ne 2 -or $_.materials -ne 2}).Count){throw 'Expected four real Groom assets with two material groups'}
} finally {
 $taskProcess.ProcessorAffinity=$taskAffinity
}
