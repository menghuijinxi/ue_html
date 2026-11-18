param([switch]$SkipBuild)
$ErrorActionPreference='Stop'
$taskProcess=Get-Process -Id $PID
$taskAffinity=$taskProcess.ProcessorAffinity
try {
 $taskProcess.ProcessorAffinity=3
 $taskRoot='G:/UE_HTML/ue_html'
 $taskOutput=Join-Path $taskRoot 'tests/web-platform/results/nanite-curves'
 $taskProject=Join-Path $taskOutput 'fixture-host/WebCurveFixture.uproject'
 if(-not $SkipBuild){
  & D:/UE_5.8/Engine/Build/BatchFiles/Build.bat WebCurveFixtureEditor Win64 Development "-Project=$taskProject" -Module=WebCurveFixture -WaitMutex -NoHotReloadFromIDE -NoUBA -NoUbaLocal -MaxParallelActions=1 *> "$taskOutput/material-build.log"
  if($LASTEXITCODE -ne 0){throw 'Curve material host build failed'}
 }
 $taskHost=Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine'
 $taskModules=Get-Content "$taskHost/Binaries/Win64/UnrealEditor.modules" -Raw | ConvertFrom-Json
 @{BuildId=$taskModules.BuildId;Modules=@{WebCurveFixture='UnrealEditor-WebCurveFixture.dll'}} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path (Split-Path $taskProject) 'Binaries/Win64/UnrealEditor.modules')
 $env:WEBGPU_TINT_DIR=Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
 $env:WEBGPU_INTERMEDIATE_DIR=Join-Path $taskOutput 'material-conversion'
 & "$taskHost/Binaries/Win64/UnrealEditor-Cmd.exe" $taskProject -run=WebCurveFixture -CurveMaterialShaders -WebGPUCook -WebShaderMetadataValidate -TargetPlatform=Web -ddpi:Web:bIsEnabled=false "-Output=$taskOutput/material-shaders" "-CurveShaderRoot=$taskOutput/material-shader-root" -nullrhi -unattended -nop4 -nosplash -nosound "-abslog=$taskOutput/material-shaders.log" *> "$taskOutput/material-shaders-console.log"
 if($LASTEXITCODE -ne 0){throw 'Curve material shader compilation failed'}
 if(Select-String -LiteralPath "$taskOutput/material-shaders.log" -Pattern 'Error:|Ensure condition failed|Fatal error' -Quiet){throw 'Curve material shaders logged an error'}
 foreach($taskSuite in @(@{name='raster/materials.json';count=44},@{name='basepass/basepass.json';count=22})){
  $taskReport=Get-Content (Join-Path "$taskOutput/material-shaders" $taskSuite.name) -Raw | ConvertFrom-Json
  if(-not $taskReport.pass -or $taskReport.cases.Count -ne $taskSuite.count -or @($taskReport.cases | Where-Object {-not $_.compiled -or -not $_.preprocessed -or $_.errors.Count}).Count){throw "Incomplete curve material shaders: $($taskSuite.name)"}
 }
} finally {
 $taskProcess.ProcessorAffinity=$taskAffinity
}
