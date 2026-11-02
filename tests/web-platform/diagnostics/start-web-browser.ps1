param(
    [Parameter(Mandatory = $true)]
    [UInt64]$AffinityMask,
    [ValidateSet('Edge', 'Chrome')]
    [string]$Browser = 'Edge',
    [uri]$Url = 'http://127.0.0.1:8765/build/triplex-project-tsr-tlv-distance-fields-threads/index.html',
    [ValidateRange(0, 65535)]
    [int]$DebugPort = 0
)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$taskExecutable = if ($Browser -eq 'Edge') {
    "${env:ProgramFiles(x86)}/Microsoft/Edge/Application/msedge.exe"
} else { "$env:ProgramFiles/Google/Chrome/Application/chrome.exe" }
if (!(Test-Path -LiteralPath $taskExecutable)) { throw "Browser not installed: $taskExecutable" }
if (!$Url.IsAbsoluteUri -or $Url.Scheme -notin @('http', 'https')) { throw 'An HTTP(S) URL is required' }
if (!$AffinityMask) { throw 'Specify a nonzero diagnostic CPU affinity mask' }
if ($DebugPort -and $DebugPort -lt 1024) { throw 'Debug port must be at least 1024' }

$taskSelf = Get-Process -Id $PID
$taskPreviousAffinity = $taskSelf.ProcessorAffinity
$taskAllowed = [UInt64]$taskPreviousAffinity.ToInt64()
if (($AffinityMask -band $taskAllowed) -ne $AffinityMask) {
    throw 'The requested CPUs must be available to this launcher'
}
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskProfile = Join-Path $taskRoot "tests/web-platform/build/browser-profiles/diagnostic-$Browser-$taskStamp-$PID"
$taskArguments = @("--user-data-dir=`"$taskProfile`"", '--no-first-run',
    '--no-default-browser-check', '--new-window')
if ($DebugPort) {
    $taskArguments += @("--remote-debugging-port=$DebugPort", '--remote-debugging-address=127.0.0.1')
}
$taskArguments += $Url.AbsoluteUri

try {
    # Set the parent before creation so the new browser and children inherit it.
    $taskSelf.ProcessorAffinity = [IntPtr][Int64]$AffinityMask
    $taskProcess = Start-Process -FilePath $taskExecutable -ArgumentList $taskArguments `
        -WindowStyle Normal -PassThru
} finally { $taskSelf.ProcessorAffinity = $taskPreviousAffinity }
$taskReport = [ordered]@{
    date = (Get-Date).ToUniversalTime().ToString('o')
    browser = $taskExecutable
    pid = $taskProcess.Id
    url = $Url.AbsoluteUri
    profile = $taskProfile
    requestedAffinityMask = '0x{0:x}' -f $AffinityMask
    debugPort = $DebugPort
    settingsOverrides = @()
    boundary = 'Temporary diagnostic browser only. Does not repair normal startup or certify hardware health.'
}
$taskReportFile = Join-Path $taskRoot "tests/web-platform/results/web-browser-launch-$taskStamp-$PID.json"
$taskReport | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $taskReportFile -Encoding utf8
$taskReport | ConvertTo-Json -Depth 4
