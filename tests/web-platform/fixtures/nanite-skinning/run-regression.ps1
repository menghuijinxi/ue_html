$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath results/nanite-skinning/native-rebuild-pending){throw 'Native signed-zero weld verification is pending'}
$env:NODE_PATH='C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
$taskSuites=@(
 @('skinning',@()),@('skinning-streaming',@()),@('skinning-budget',@()),
 @('gpu-instances',@()),@('gpu-streaming',@('--gpu-instances')),
 @('distance',@()),@('spline',@()),@('spline-streaming',@('--spline')),
 @('wpo',@()),@('wpo-streaming',@('--wpo')),@('programmable',@()),
 @('materials',@()),@('composition',@()),@('composition-unmerged',@('--unmerged')),
 @('streaming',@()),@('spline-budget',@('--spline'))
)
foreach($taskSuite in $taskSuites){
 $taskName=$taskSuite[0]
 $taskScript=if($taskName -in @('wpo-streaming','spline-streaming','gpu-streaming')){'streaming'}elseif($taskName -eq 'spline-budget'){'streaming-budget'}elseif($taskName -eq 'composition-unmerged'){'composition'}else{$taskName}
 foreach($taskScalar in @($false,$true)){
  $taskArguments=@($taskSuite[1]);if($taskScalar){$taskArguments+='--scalar-visibility'}
  $taskSuffix=if($taskScalar){'-scalar'}else{''}
  if($taskName -eq 'skinning' -and -not $taskScalar){
   $taskExisting=Get-Content results/nanite-skinning/browser.json -Raw | ConvertFrom-Json
   $taskPackage=(Get-FileHash build/nanite-browser/package.json -Algorithm SHA256).Hash.ToLowerInvariant()
   $taskSource=(Get-FileHash probe-nanite-skinning.cjs -Algorithm SHA256).Hash.ToLowerInvariant()
   if($taskExisting.pass -and $taskExisting.tests.Count -eq 32 -and $taskExisting.package.sha256 -eq $taskPackage -and $taskExisting.source.sha256 -eq $taskSource){continue}
  }
  if($taskName -eq 'skinning-budget' -and -not $taskScalar){
   $taskExisting=Get-Content results/nanite-skinning-budget/browser.json -Raw | ConvertFrom-Json
   $taskPackage=(Get-FileHash build/nanite-browser/package.json -Algorithm SHA256).Hash.ToLowerInvariant()
   $taskSource=(Get-FileHash probe-nanite-skinning-budget.cjs -Algorithm SHA256).Hash.ToLowerInvariant()
   $taskVerifier=(Get-FileHash verify-nanite-budget-coverage.cjs -Algorithm SHA256).Hash.ToLowerInvariant()
   if($taskExisting.pass -and $taskExisting.budgets.Count -eq 5 -and $taskExisting.package.sha256 -eq $taskPackage -and $taskExisting.source.sha256 -eq $taskSource -and $taskExisting.verifier.sha256 -eq $taskVerifier){continue}
  }
  & node "probe-nanite-$taskScript.cjs" @taskArguments *> "results/nanite-skinning/regression-$taskName$taskSuffix.log"
  if($LASTEXITCODE -ne 0){throw "Regression failed: $taskName$taskSuffix"}
 }
}
& node verify-nanite-skinning-weld.cjs *> results/nanite-skinning/weld-browser.log
if($LASTEXITCODE -ne 0){throw 'Rebuilt skeletal geometry continuity failed'}
foreach($taskName in @('skinning','spline','wpo','distance','gpu-instances')){
 & node "verify-nanite-$taskName-oracle.cjs" *> "results/nanite-skinning/$taskName-oracle.log"
 if($LASTEXITCODE -ne 0){throw "Oracle checks failed: $taskName"}
}
& node collect-nanite-skinning-evidence.cjs *> results/nanite-skinning/collect.log
if($LASTEXITCODE -ne 0){throw 'Skinning evidence collection failed'}
