param(
    [ValidatePattern('^[a-z0-9-]+$')]
    [string]$Folder = 'triplex-project-lumen-optimized-20261104',
    [ValidateRange(1024, 65535)]
    [int]$Port = 8765,
    [switch]$LegacyHlsl,
    [UInt64]$AffinityMask = 0,
    [ValidateRange(0, 65535)]
    [int]$DebugPort = 0
)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$taskIndex = Join-Path $PSScriptRoot "build/$Folder/index.html"
if (!(Test-Path -LiteralPath $taskIndex -PathType Leaf)) { throw "Package not found: $taskIndex" }
$taskBrowser = "${env:ProgramFiles(x86)}/Microsoft/Edge/Application/msedge.exe"
if (!(Test-Path -LiteralPath $taskBrowser -PathType Leaf)) { throw 'Microsoft Edge is not installed' }
if ($DebugPort -and ($DebugPort -lt 1024 -or $DebugPort -eq $Port)) {
    throw 'DebugPort must be at least 1024 and differ from the HTTP port'
}
$taskSelf = Get-Process -Id $PID
$taskPreviousAffinity = $taskSelf.ProcessorAffinity
if ($AffinityMask -and
    ($AffinityMask -band [UInt64]$taskPreviousAffinity.ToInt64()) -ne $AffinityMask) {
    throw 'The requested CPUs must be available to this launcher'
}
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskLabel = "preview-$taskStamp-$PID"
$taskResults = Join-Path $PSScriptRoot 'results'
[IO.Directory]::CreateDirectory($taskResults) | Out-Null
$taskUrl = "http://127.0.0.1:$Port/build/$Folder/index.html"
$taskExpectedETag = '"' + (Get-FileHash -LiteralPath $taskIndex -Algorithm SHA256).Hash.ToLowerInvariant() + '"'
$taskServer = $null
$taskOpened = $false
try {
    if (!(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) {
        $taskNode = (Get-Command node -ErrorAction Stop).Source
        $taskOldHost = $env:HOST
        $taskOldPort = $env:PORT
        try {
            $env:HOST = '127.0.0.1'
            $env:PORT = "$Port"
            $taskServer = Start-Process -FilePath $taskNode `
                -ArgumentList "`"$(Join-Path $PSScriptRoot 'serve.cjs')`"" `
                -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput (Join-Path $taskResults "$taskLabel-server.log") `
                -RedirectStandardError (Join-Path $taskResults "$taskLabel-server-errors.log")
        } finally {
            $env:HOST = $taskOldHost
            $env:PORT = $taskOldPort
        }
    }
    $taskReady = $false
    for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
        try {
            $taskResponse = Invoke-WebRequest -Uri $taskUrl -Method Head -UseBasicParsing -TimeoutSec 2
            if ($taskResponse.Headers['ETag'] -ne $taskExpectedETag -or
                $taskResponse.Headers['Cross-Origin-Opener-Policy'] -ne 'same-origin' -or
                $taskResponse.Headers['Cross-Origin-Embedder-Policy'] -ne 'require-corp') {
                throw "Port $Port is not serving this package with the required isolation headers"
            }
            $taskReady = $true
            break
        } catch {
            if (!$taskServer) { throw }
            if ($taskServer.HasExited) { throw 'Preview server exited; check its log in results' }
            Start-Sleep -Milliseconds 200
        }
    }
    if (!$taskReady) { throw "Preview server did not become ready: $taskUrl" }
    $taskProfile = Join-Path $PSScriptRoot "build/browser-profiles/$taskLabel"
    $taskArguments = @("--user-data-dir=`"$taskProfile`"", '--no-first-run',
        '--no-default-browser-check', '--new-window')
    if ($LegacyHlsl) { $taskArguments += '--disable-dawn-features=d3d12_use_hlsl_2021' }
    if ($DebugPort) {
        $taskArguments += @("--remote-debugging-port=$DebugPort", '--remote-debugging-address=127.0.0.1')
    }
    $taskNavigation = @($taskArguments) + $taskUrl
    $taskArguments += $(if ($AffinityMask) { 'about:blank' } else { $taskUrl })
    try {
        if ($AffinityMask) { $taskSelf.ProcessorAffinity = [IntPtr][Int64]$AffinityMask }
        $taskProcess = Start-Process -FilePath $taskBrowser -ArgumentList $taskArguments `
            -WindowStyle Normal -PassThru
        $taskAffinityChecks = @()
        if ($AffinityMask) {
            $taskGpuSeen = $false
            for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
                $taskChildren = @(Get-CimInstance Win32_Process -Filter "name='msedge.exe'" |
                    Where-Object { $_.ProcessId -eq $taskProcess.Id -or
                        $_.ParentProcessId -eq $taskProcess.Id })
                $taskGpuSeen = @($taskChildren | Where-Object CommandLine -Match '--type=gpu-process').Count -gt 0
                $taskAffinityChecks = @($taskChildren | ForEach-Object {
                    $taskChild = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
                    if ($taskChild) {
                        $taskChild.ProcessorAffinity = [IntPtr][Int64]$AffinityMask
                        [pscustomobject]@{
                            pid = $taskChild.Id
                            type = $(if ($_.CommandLine -match '--type=([^ ]+)') { $Matches[1] } else { 'browser' })
                            affinityMask = '0x{0:x}' -f $taskChild.ProcessorAffinity.ToInt64()
                        }
                    }
                })
                # A sandboxed GPU child can reset inherited affinity during startup.
                if ($taskGpuSeen -and $taskAttempt -ge 9) { break }
                Start-Sleep -Milliseconds 200
            }
            if (!$taskGpuSeen) { throw 'No preview GPU process found; scene has not been opened' }
            $taskExpectedMask = '0x{0:x}' -f $AffinityMask
            if (@($taskAffinityChecks | Where-Object affinityMask -NE $taskExpectedMask).Count) {
                throw 'Could not apply preview CPU affinity; scene has not been opened'
            }
            Start-Process -FilePath $taskBrowser -ArgumentList $taskNavigation -WindowStyle Normal | Out-Null
        }
    } finally { $taskSelf.ProcessorAffinity = $taskPreviousAffinity }
    $taskOpened = $true
    $taskReport = [ordered]@{
        date = (Get-Date).ToUniversalTime().ToString('o')
        url = $taskUrl
        browser = $taskBrowser
        browserVersion = (Get-Item -LiteralPath $taskBrowser).VersionInfo.FileVersion
        browserPid = $taskProcess.Id
        profile = $taskProfile
        legacyHlsl = $LegacyHlsl.IsPresent
        requestedAffinityMask = '0x{0:x}' -f $AffinityMask
        affinityChecks = $taskAffinityChecks
        debugPort = $DebugPort
        startedServerPid = $(if ($taskServer) { $taskServer.Id } else { $null })
        settingsOverrides = @()
        boundary = 'Temporary isolated preview. Affinity and LegacyHlsl are explicit diagnostic options, not a proven repair or a project setting.'
    }
    $taskReport | ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath (Join-Path $taskResults "$taskLabel.json") -Encoding utf8
    [pscustomobject]$taskReport
} finally {
    if ($taskServer -and !$taskOpened -and !$taskServer.HasExited) { $taskServer.Kill() }
}
