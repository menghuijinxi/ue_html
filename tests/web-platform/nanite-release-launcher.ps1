param([ValidateSet('default','villa')][string]$Scene='default',[ValidateRange(1024,65535)][int]$Port=8766,[switch]$NoBrowser)
$ErrorActionPreference='Stop'
$taskIndex=Join-Path $PSScriptRoot "$Scene/index.html"
if(!(Test-Path -LiteralPath $taskIndex)){throw '缺少场景文件，请从完整测试目录运行启动器。'}
$taskUrl="http://127.0.0.1:$Port/$Scene/index.html"
$taskHasher=[Security.Cryptography.SHA256]::Create()
$taskStream=[IO.File]::OpenRead($taskIndex)
try{$taskETag='"'+[BitConverter]::ToString($taskHasher.ComputeHash($taskStream)).Replace('-','').ToLowerInvariant()+'"'}
finally{$taskStream.Dispose();$taskHasher.Dispose()}
$taskListeners=[Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
if(!($taskListeners | Where-Object {$_.Port -eq $Port})){
 $taskNode=(Get-Command node -ErrorAction Stop).Source
 $taskOldHost=$env:HOST;$taskOldPort=$env:PORT
 try{
  $env:HOST='127.0.0.1';$env:PORT="$Port"
  $taskServer=Start-Process -FilePath $taskNode -ArgumentList "`"$(Join-Path $PSScriptRoot 'serve.cjs')`"" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
 }finally{$env:HOST=$taskOldHost;$env:PORT=$taskOldPort}
}
$taskReady=$false
for($taskAttempt=0;$taskAttempt -lt 30;$taskAttempt++){
 try{
  $taskRequest=[Net.HttpWebRequest]::Create($taskUrl)
  $taskRequest.Method='HEAD';$taskRequest.Timeout=2000;$taskRequest.Proxy=$null
  $taskResponse=$taskRequest.GetResponse()
  try{if($taskResponse.Headers['ETag'] -ne $taskETag -or $taskResponse.Headers['Cross-Origin-Opener-Policy'] -ne 'same-origin' -or $taskResponse.Headers['Cross-Origin-Embedder-Policy'] -ne 'require-corp'){throw "端口 $Port 正由其他服务使用。"}}
  finally{$taskResponse.Close()}
  $taskReady=$true;break
 }catch{if(!$taskServer){throw};if($taskServer.HasExited){throw '场景服务启动失败。'};[Threading.Thread]::Sleep(200)}
}
if(!$taskReady){throw '场景服务未就绪。'}
if(!$NoBrowser){
 $taskBrowser="${env:ProgramFiles(x86)}/Microsoft/Edge/Application/msedge.exe"
 if(!(Test-Path -LiteralPath $taskBrowser)){throw '未找到 Microsoft Edge。请在支持 WebGPU 的浏览器打开下方地址。'}
 $taskProfile=Join-Path $env:LOCALAPPDATA 'UEHTML/Nanite-20261111'
 Start-Process -FilePath $taskBrowser -ArgumentList @("--user-data-dir=`"$taskProfile`"",'--no-first-run','--no-default-browser-check','--new-window',$taskUrl) -WindowStyle Normal | Out-Null
}
[pscustomobject]@{Url=$taskUrl;Scene=$Scene;Ready=$taskReady}
