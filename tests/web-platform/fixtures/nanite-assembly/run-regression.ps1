param([switch]$SkipKernels,[switch]$KernelsOnly,[ValidateSet('','skin-budget','static-scene','static-streaming','static-budget','ordinary')][string]$StartAt='')
$ErrorActionPreference='Stop'
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
if(-not $SkipKernels){
& node verify-nanite-assembly-transforms.cjs *> results/nanite-assembly/production-transforms.log
if($LASTEXITCODE -ne 0){throw 'Assembly transform kernel failed'}
foreach($taskKernel in @('hierarchy','occlusion')){
 foreach($taskLocal in @($false,$true)){
  $taskArguments=@();if($taskLocal){$taskArguments+='--local'}
  $taskSuffix=if($taskLocal){'-local'}else{''}
  & node "verify-nanite-assembly-$taskKernel.cjs" @taskArguments *> "results/nanite-assembly/production-$taskKernel$taskSuffix.log"
  if($LASTEXITCODE -ne 0){throw "Assembly kernel failed: $taskKernel $taskSuffix"}
 }
}
}
if($KernelsOnly){return}
$taskStarted=-not $StartAt
foreach($taskStatic in @($true,$false)){
 $taskKind=if($taskStatic){'static'}else{'skin'}
 foreach($taskSuite in @('scene','streaming','budget')){
  if("$taskKind-$taskSuite" -eq $StartAt){$taskStarted=$true}
  if(-not $taskStarted){continue}
  $taskScript=if($taskSuite -eq 'scene'){'probe-nanite-assembly.cjs'}else{"probe-nanite-assembly-$taskSuite.cjs"}
  foreach($taskScalar in @($false,$true)){
   $taskArguments=@();if($taskStatic){$taskArguments+='--static'};if($taskScalar){$taskArguments+='--scalar-visibility'}
   $taskSuffix=if($taskScalar){'-scalar'}else{''}
   & node $taskScript @taskArguments *> "results/nanite-assembly/regression-$taskKind-$taskSuite$taskSuffix.log"
   if($LASTEXITCODE -ne 0){throw "Assembly regression failed: $taskKind $taskSuite $taskSuffix"}
  }
 }
 if(-not $taskStarted){continue}
 $taskArguments=@();if($taskStatic){$taskArguments+='--static'}
 & node verify-nanite-assembly-oracle.cjs @taskArguments *> "results/nanite-assembly/$taskKind-oracle.log"
 if($LASTEXITCODE -ne 0){throw "Assembly oracle failed: $taskKind"}
}
& ./fixtures/nanite-skinning/run-regression.ps1 *> results/nanite-assembly/ordinary-regression.log
if($LASTEXITCODE -ne 0){throw 'Ordinary mesh regressions failed'}
& node collect-nanite-assembly-evidence.cjs *> results/nanite-assembly/collect.log
if($LASTEXITCODE -ne 0){throw 'Assembly evidence collection failed'}
