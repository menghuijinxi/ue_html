param([string]$Engine='D:/UE_5.8', [string]$FixtureDirectory='', [switch]$SkipBuild)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskOutput=Join-Path $PSScriptRoot 'results/nanite-assembly'
$taskProject=Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskProcess=Get-Process -Id $PID
$taskAffinity=$taskProcess.ProcessorAffinity
$taskSavedTint=$env:WEBGPU_TINT_DIR
$taskSavedIntermediate=$env:WEBGPU_INTERMEDIATE_DIR
$taskSavedEngine=$env:UE_ENGINE_ROOT
function Get-TaskAudit([string]$File){
 return @{file=[IO.Path]::GetFullPath($File);sha256=(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
try{
 if(-not $FixtureDirectory){throw 'A workspace fixture directory is required'}
 $FixtureDirectory=[IO.Path]::GetFullPath($FixtureDirectory)
 if(-not $FixtureDirectory.StartsWith($taskRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture output must stay in the workspace'}
 if(-not (Test-Path -LiteralPath (Join-Path (Split-Path $FixtureDirectory) 'WebNaniteSkinning/NaniteSkinPlane.uasset'))){throw 'Generate the skeletal fixture assets first'}
 New-Item -ItemType Directory -Path $taskOutput,$FixtureDirectory -Force | Out-Null
 $taskProcess.ProcessorAffinity=3
 $env:UE_ENGINE_ROOT=Join-Path $Engine 'Engine'
 & node (Join-Path $PSScriptRoot 'prepare-web-cook-shaders.cjs') *> "$taskOutput/prepare.log"
 if($LASTEXITCODE -ne 0){throw 'Assembly shader preparation failed'}
 $taskNames=@('tests/web-platform/compile-nanite-assembly.ps1','tests/web-platform/prepare-web-cook-shaders.cjs','tests/web-platform/web-nanite-shader-overrides.cjs',
  'tests/ue-shader-host/Source/UEShaderHost/UEShaderHost.Build.cs','tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp',
  'tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteAssemblyProbe.cpp','tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteSkinningProbe.cpp',
  'tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteProgrammableProbe.cpp','tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteMaterialProbe.cpp',
  'reference-engine/Engine/Source/Runtime/Engine/Private/Nanite/WebNaniteAssemblyCapacity.h',
  'reference-engine/Engine/Source/Runtime/Engine/Private/Nanite/NaniteWebVertexFactory.cpp',
  'reference-engine/Engine/Source/Runtime/Renderer/Private/Nanite/NaniteWebProgrammableRaster.cpp',
  'reference-engine/Engine/Shaders/Private/Nanite/WebNaniteFeatures.ush',
  'reference-engine/Engine/Shaders/Private/Nanite/WebNaniteProgrammableRaster.usf',
  'reference-engine/Engine/Shaders/Private/Nanite/WebNaniteVertexFactory.ush','reference-engine/Engine/Shaders/Private/Nanite/NaniteVertexFetch.ush')
 $taskSources=@($taskNames | ForEach-Object {Get-TaskAudit (Join-Path $taskRoot $_)})
 if(-not $SkipBuild){
  & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development "-Project=$taskProject" -Module=UEShaderHost -WaitMutex -NoHotReloadFromIDE -NoUBA -NoUbaLocal -MaxParallelActions=1 *> "$taskOutput/build.log"
  if($LASTEXITCODE -ne 0){throw 'Assembly shader host build failed'}
 }
 $env:WEBGPU_TINT_DIR=Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
 $taskHost=Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe'
 & node (Join-Path $PSScriptRoot 'activate-native-nanite-builder.cjs') (Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine') *> "$taskOutput/builder-activation.log"
 if($LASTEXITCODE -ne 0){throw 'Assembly Nanite builder activation failed'}
 $taskJobs=@(
  @{name='fixture';flag='WebNaniteAssemblyProbe';extra=@("-FixtureDirectory=$FixtureDirectory")},
  @{name='material-output';flag='WebNaniteSkinningMaterials';extra=@('-WebNaniteAssemblyShaders')},
  @{name='basepass-output';flag='WebNaniteSkinningBasePass';extra=@('-WebNaniteAssemblyShaders')})
 $taskLogs=@()
 foreach($taskJob in $taskJobs){
  $taskDestination=Join-Path $taskOutput $taskJob.name
  New-Item -ItemType Directory -Path $taskDestination -Force | Out-Null
  $env:WEBGPU_INTERMEDIATE_DIR=Join-Path $taskDestination 'conversion'
  $taskArgs=@('-run=WebShaderProbe',"-$($taskJob.flag)",'-WebGPUCook','-WebShaderMetadataValidate',
   '-ini:Engine:[SystemSettings]:r.Nanite.AllowAssemblies=1',"-Output=$taskDestination",'-nullrhi','-unattended','-nop4','-nosplash','-nosound',"-abslog=$taskDestination/compiler.log")+$taskJob.extra
  & $taskHost $taskProject @taskArgs *> "$taskDestination/console.log"
  if($LASTEXITCODE -ne 0){throw "Assembly verification failed: $($taskJob.name)"}
  if(Select-String -LiteralPath "$taskDestination/compiler.log" -Pattern 'Error:|Ensure condition failed|Fatal error' -Quiet){throw "Assembly verification logged an error: $($taskJob.name)"}
  $taskLogs+=Get-TaskAudit "$taskDestination/compiler.log"
  $taskLogs+=Get-TaskAudit "$taskDestination/console.log"
 }
 $taskFixtures=Get-Content "$taskOutput/fixture/fixtures.json" -Raw | ConvertFrom-Json
 if(-not $taskFixtures.pass -or $taskFixtures.fixtures.Count -ne 8){throw 'Incomplete assembly fixtures'}
 foreach($taskF in $taskFixtures.fixtures){
  if($taskF.transforms -ne 4 -or $taskF.rootPages -le 0 -or $taskF.clusterCapacity -lt $taskF.clusters -or $taskF.hierarchyLevels -le 0){throw 'Invalid assembly resource'}
  if($taskF.streaming -ne $taskF.asset.Contains('Streaming')){throw 'Assembly streaming policy mismatch'}
 }
 $taskMaterials=Get-Content "$taskOutput/material-output/materials.json" -Raw | ConvertFrom-Json
 $taskBasePass=Get-Content "$taskOutput/basepass-output/basepass.json" -Raw | ConvertFrom-Json
 if(-not $taskMaterials.pass -or $taskMaterials.cases.Count -ne 40 -or -not $taskBasePass.pass -or $taskBasePass.cases.Count -ne 20){throw 'Incomplete assembly permutations'}
 foreach($taskCase in @($taskMaterials.cases)+@($taskBasePass.cases)){
  if(-not $taskCase.preprocessed -or -not $taskCase.compiled -or $taskCase.errors.Count){throw 'Invalid assembly shader result'}
 }
 foreach($taskSource in $taskSources){if((Get-TaskAudit $taskSource.file).sha256 -ne $taskSource.sha256){throw "Input changed: $($taskSource.file)"}}
 $taskAssets=@('NaniteAssemblySmall','NaniteAssemblyStreaming','NaniteAssemblyResident','NaniteAssemblyStreamingB',
  'NaniteAssemblySkinSmall','NaniteAssemblySkinStreaming','NaniteAssemblySkinResident','NaniteAssemblySkinStreamingB')
 foreach($taskSize in 0..1){foreach($taskPart in 0..1){$taskAssets+="NaniteAssemblyPart$taskSize$taskPart";$taskAssets+="NaniteAssemblySkinPart$taskSize$taskPart"}}
 $taskAssets+=@(0..4 | ForEach-Object {"NaniteAssemblyMaterial$_"})
 @{pass=$true;sources=$taskSources;fixtures=$taskFixtures.fixtures;materials=$taskMaterials;basepass=$taskBasePass;
  builder=Get-TaskAudit (Join-Path $taskRoot '.tools/ue58-nanite-cook-host/Engine/Binaries/Win64/UnrealEditor-NaniteBuilder.dll');
  builderBuild=Get-TaskAudit (Join-Path $PSScriptRoot 'results/native-nanitebuilder-build-results.json');
  binary=Get-TaskAudit (Join-Path $taskRoot 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll');logs=$taskLogs;
  assets=@($taskAssets | ForEach-Object {Get-TaskAudit (Join-Path $FixtureDirectory "$_.uasset")});
  sourceGeometry=@(Get-ChildItem -LiteralPath "$taskOutput/fixture" -File | Where-Object {$_.Extension -in @('.json','.bin')} | ForEach-Object {Get-TaskAudit $_.FullName})
 } | ConvertTo-Json -Depth 20 | Set-Content "$taskOutput/verified.json" -Encoding utf8
}finally{
 $taskProcess.ProcessorAffinity=$taskAffinity
 $env:WEBGPU_TINT_DIR=$taskSavedTint
 $env:WEBGPU_INTERMEDIATE_DIR=$taskSavedIntermediate
 $env:UE_ENGINE_ROOT=$taskSavedEngine
}
