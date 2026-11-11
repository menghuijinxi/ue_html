param([switch]$SkipNativeBuild,[switch]$ResumeAfterGroom,[switch]$ResumeAfterShaders,[switch]$ResumeCook,[long]$HostProcessorAffinity=4080)
$ErrorActionPreference='Stop'
$env:UE_ENGINE_ROOT='D:/UE_5.8/Engine'
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
$taskProcess=Get-Process -Id $PID
$taskAffinity=$taskProcess.ProcessorAffinity
try {
 $taskProcess.ProcessorAffinity=$HostProcessorAffinity
 $taskPrevious=Get-Content results/web-project-nanite-streaming-desktop-cook-results.json -Raw | ConvertFrom-Json
 $taskExtra=@(($taskPrevious.arguments | Where-Object { $_.StartsWith('-PACKAGE=') }).Substring(9).Split('+') | Where-Object { $_.StartsWith('/Game/WebNanite') })
 $taskContent=Join-Path (Split-Path $taskPrevious.project) 'Content'
 if(-not $ResumeAfterGroom -and -not $ResumeAfterShaders -and -not $ResumeCook){
 foreach($taskModule in $(if($SkipNativeBuild){@()}else{@('NaniteBuilder','RenderCore','Renderer')})){
  & ./build-native-rendercore.ps1 -Engine D:/UE_5.8 -Module $taskModule -MaxParallelActions 1 -HostProcessorAffinity 3 *> "results/nanite-curves/native-$taskModule.log"
  if($LASTEXITCODE -ne 0){throw "Native $taskModule refresh failed"}
 }
 & node prepare-nanite-cook-host.cjs *> results/nanite-curves/prepare-production-host.log
 if($LASTEXITCODE -ne 0){throw 'Assembly Cook host refresh failed'}
 & ./compile-nanite-skinning.ps1 -Engine D:/UE_5.8 -FixtureDirectory (Join-Path $taskContent 'WebNaniteSkinning') *> results/nanite-curves/ordinary-skinning-console.log
 if($LASTEXITCODE -ne 0){throw 'Ordinary skeletal native verification failed'}
 & ./compile-nanite-assembly.ps1 -Engine D:/UE_5.8 -FixtureDirectory (Join-Path $taskContent 'WebNaniteAssembly') -SkipBuild *> results/nanite-curves/native-console.log
 if($LASTEXITCODE -ne 0){throw 'Assembly fixtures/material verification failed'}
 & ./results/nanite-curves/run-groom.ps1 -Production *> results/nanite-curves/production-groom-console.log
 if($LASTEXITCODE -ne 0){throw 'Production Groom fixture creation failed'}
 }
 $taskAssembly=Get-Content results/nanite-assembly/verified.json -Raw | ConvertFrom-Json
 if(-not $taskAssembly.pass){throw 'Assembly native evidence must pass before resuming'}
 $taskExtra+=@($taskAssembly.assets | ForEach-Object { '/Game/WebNaniteAssembly/'+[IO.Path]::GetFileNameWithoutExtension($_.file) })
 if(-not $ResumeAfterShaders -and -not $ResumeCook){
 & node results/nanite-curves/prepare-groom-inputs.cjs *> results/nanite-curves/production-groom-inputs.log
 if($LASTEXITCODE -ne 0){throw 'Production Groom reference preparation failed'}
 & node results/nanite-curves/prepare-gpu-inputs.cjs --groom *> results/nanite-curves/production-groom-gpu-inputs.log
 if($LASTEXITCODE -ne 0){throw 'Production Groom GPU input preparation failed'}
 & node results/nanite-curves/prepare-material-probe.cjs *> results/nanite-curves/production-material-probe.log
 if($LASTEXITCODE -ne 0){throw 'Production curve shader preparation failed'}
 & ./results/nanite-curves/run-material-shaders.ps1 *> results/nanite-curves/production-material-shaders.log
 if($LASTEXITCODE -ne 0){throw 'Production curve material compilation failed'}
 & node results/nanite-curves/prepare-cook-assets.cjs *> results/nanite-curves/production-cook-assets.log
 if($LASTEXITCODE -ne 0){throw 'Production Groom Cook asset preparation failed'}
 & ./results/nanite-curves/run-fixtures.ps1 -Production -SkipBuild *> results/nanite-curves/production-fixtures-console.log
 if($LASTEXITCODE -ne 0){throw 'Production curve Builder fixtures failed'}
 & ./results/nanite-curves/run-shaders.ps1 -Production -SkipBuild *> results/nanite-curves/production-shaders-console.log
 if($LASTEXITCODE -ne 0){throw 'Production curve decode shaders failed'}
 & node results/nanite-curves/prepare-gpu-inputs.cjs *> results/nanite-curves/production-fixture-inputs.log
 if($LASTEXITCODE -ne 0){throw 'Production curve GPU inputs failed'}
 & node collect-nanite-curves-native.cjs *> results/nanite-curves/production-native-evidence.log
 if($LASTEXITCODE -ne 0){throw 'Production curve native evidence failed'}
 & ./compile-nanite-programmable.ps1 -Engine D:/UE_5.8 -SkipBuild *> results/nanite-curves/programmable-console.log
 if($LASTEXITCODE -ne 0){throw 'Programmable regression compilation failed'}
 & ./compile-nanite-hierarchy.ps1 -Engine D:/UE_5.8 *> results/nanite-curves/hierarchy-console.log
 if($LASTEXITCODE -ne 0){throw 'Hierarchy compilation failed'}
 & ./compile-nanite-streaming.ps1 -Engine D:/UE_5.8 *> results/nanite-curves/streaming-console.log
 if($LASTEXITCODE -ne 0){throw 'Streaming compilation failed'}
 }
 $taskCurveAssets=Get-Content results/nanite-curves/cook-assets.json -Raw | ConvertFrom-Json
 $taskExtra+=@($taskCurveAssets.copies | ForEach-Object { $_.package })
 if(-not $ResumeCook){
 & ./probe-nanite-multimaterial.ps1 -Engine D:/UE_5.8 -SkipBuild *> results/nanite-curves/multimaterial-console.log
 if($LASTEXITCODE -ne 0){throw 'Multimaterial probe failed'}
 & ./probe-nanite-cook.ps1 -Engine D:/UE_5.8 -BrowserChannels msedge -SkipBuild *> results/nanite-curves/single-cook-probe-console.log
 if($LASTEXITCODE -ne 0){throw 'Current single-material Cook/decode reference failed'}
 $taskSingleCook=(Get-ChildItem results/nanite-cook -Directory | Sort-Object Name | Select-Object -Last 1).FullName
 $taskSingleFixture=Join-Path $taskSingleCook 'sm5-retained'
 & ./probe-nanite-uploader.ps1 -Engine D:/UE_5.8 -CookedAsset $taskSingleFixture -SkipBuild *> results/nanite-curves/uploader-single-console.log
 if($LASTEXITCODE -ne 0){throw 'Single uploader failed'}
 $taskSingle=(Get-ChildItem results/nanite-uploader -Directory | Sort-Object Name | Select-Object -Last 1).FullName
 & ./probe-nanite-uploader.ps1 -Engine D:/UE_5.8 -CookedAsset results/nanite-multimaterial -SkipBuild *> results/nanite-curves/uploader-multi-console.log
 if($LASTEXITCODE -ne 0){throw 'Multi uploader failed'}
 $taskMulti=(Get-ChildItem results/nanite-uploader -Directory | Sort-Object Name | Select-Object -Last 1).FullName
 @{single=$taskSingle;multi=$taskMulti;singleFixture=$taskSingleFixture;cookProbe=(Join-Path $taskSingleCook 'results.json')} | ConvertTo-Json | Set-Content results/nanite-curves/uploaders.json
 }
 & node collect-nanite-curves-native.cjs *> results/nanite-curves/production-native-evidence.log
 if($LASTEXITCODE -ne 0){throw 'Current production curve native evidence failed before Cook'}
 & ./cook-web-engine.ps1 -Engine D:/UE_5.8 -Mode WebGPU-SM5 -Scene Project -Project $taskPrevious.project -Map $taskPrevious.map -UseProjectSettings -NaniteCookData -ReportId nanite-streaming -HostProcessorAffinity $HostProcessorAffinity -StopOnShaderError -SkipBuild -ExtraPackages ($taskExtra | Select-Object -Unique) *> results/nanite-curves/cook-console.log
 if($LASTEXITCODE -ne 0){throw 'Curves and regression assets Cook failed'}
 & node stage-web-engine.cjs --project=nanite-streaming --desktop *> results/nanite-curves/stage-console.log
 if($LASTEXITCODE -ne 0){throw 'Curves and regression assets staging failed'}
} finally {
 $taskProcess.ProcessorAffinity=$taskAffinity
}
