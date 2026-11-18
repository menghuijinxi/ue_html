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
  & D:/UE_5.8/Engine/Build/BatchFiles/Build.bat WebCurveFixtureEditor Win64 Development "-Project=$taskProject" -Module=WebCurveFixture -WaitMutex -NoHotReloadFromIDE -NoUBA -NoUbaLocal -MaxParallelActions=1 *> "$taskOutput/shader-build.log"
  if($LASTEXITCODE -ne 0){throw 'Curve shader host build failed'}
 }
 $taskHost=Join-Path $taskRoot $(if($Production){'.tools/ue58-nanite-cook-host/Engine'}else{'.tools/ue58-curves-preview-host/Engine'})
 $taskHostModules=Get-Content "$taskHost/Binaries/Win64/UnrealEditor.modules" -Raw | ConvertFrom-Json
 @{BuildId=$taskHostModules.BuildId;Modules=@{WebCurveFixture='UnrealEditor-WebCurveFixture.dll'}} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path (Split-Path $taskProject) 'Binaries/Win64/UnrealEditor.modules')
 $env:WEBGPU_TINT_DIR=Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
 $env:WEBGPU_INTERMEDIATE_DIR=Join-Path $taskOutput 'shader-conversion'
 & "$taskHost/Binaries/Win64/UnrealEditor-Cmd.exe" $taskProject -run=WebCurveFixture -CurveShaders -WebGPUCook -WebShaderMetadataValidate -TargetPlatform=Web -ddpi:Web:bIsEnabled=false "-Output=$taskOutput/shaders" "-CurveShaderRoot=$taskOutput/material-shader-root" -nullrhi -unattended -nop4 -nosplash -nosound "-abslog=$taskOutput/shader.log" *> "$taskOutput/shader-console.log"
 if($LASTEXITCODE -ne 0){throw 'Curve shader compilation failed'}
 if(Select-String -LiteralPath "$taskOutput/shader.log" -Pattern 'Error:|Ensure condition failed|Fatal error' -Quiet){throw 'Curve shaders logged an error'}
 foreach($taskStage in @('independent','dependent','decode','primitive')){if(-not (Test-Path "$taskOutput/shaders/$taskStage.wgsl")){throw "Missing shader $taskStage"}}
} finally {
 $taskProcess.ProcessorAffinity=$taskAffinity
}
