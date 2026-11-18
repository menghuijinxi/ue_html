$ErrorActionPreference='Stop'
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
& node verify-nanite-curve-material-index.cjs *> results/nanite-curves/material-index-console.log
if($LASTEXITCODE -ne 0){throw 'Curve visibility material-index verification failed'}
& node verify-nanite-curve-material-visualization.cjs *> results/nanite-curves/material-visualization-console.log
if($LASTEXITCODE -ne 0){throw 'Curve visualization material-index verification failed'}
foreach($taskGroom in @($false,$true)){
 $taskArguments=@();$taskPrefix=''
 if($taskGroom){$taskArguments+='--groom';$taskPrefix='groom-'}
 foreach($taskCheck in @('decode','native-bounds','hierarchy-bounds')){
  & node "results/nanite-curves/verify-$taskCheck.cjs" @taskArguments *> "results/nanite-curves/$taskPrefix$taskCheck-console.log"
  if($LASTEXITCODE -ne 0){throw "Curve verification failed: $taskPrefix$taskCheck"}
 }
}
foreach($taskCheck in @('curve-kernels','scaled-bounds','native-wave-endpoints','native-visibility-index')){
 & node "results/nanite-curves/verify-$taskCheck.cjs" *> "results/nanite-curves/$taskCheck-console.log"
 if($LASTEXITCODE -ne 0){throw "Curve verification failed: $taskCheck"}
}
