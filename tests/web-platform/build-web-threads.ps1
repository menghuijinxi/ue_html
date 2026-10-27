param(
    [string]$Engine = 'H:/UE_5.8',
    [ValidateRange(1, 16)][int]$MaxParallelActions = 4,
    [switch]$SkipHostPreparation
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskHost = Join-Path $taskRoot '.tools/ue58-web-build-host/Engine'
$taskDotnet = Join-Path $Engine 'Engine/Binaries/ThirdParty/DotNet/10.0/win-x64/dotnet.exe'
$taskUbt = Join-Path $taskHost 'Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll'
& (Join-Path $PSScriptRoot 'build-web-blake3.ps1') -Threads
& (Join-Path $PSScriptRoot 'build-web-libpng.ps1') -Threads
if (-not $SkipHostPreparation) { & (Join-Path $PSScriptRoot 'prepare-web-core-host.ps1') -Engine $Engine }
$taskWeb = Join-Path $taskHost 'Platforms/Web'
if ((Get-Item -LiteralPath $taskWeb).LinkType) { throw 'Build-host Web platform must be local.' }
foreach ($taskPart in @('Config', 'Source')) {
    Copy-Item -LiteralPath (Join-Path $taskRoot "reference-engine/Engine/Platforms/Web/$taskPart") -Destination $taskWeb -Recurse -Force
}
$taskResults = Join-Path $PSScriptRoot 'results'
New-Item -ItemType Directory -Path $taskResults -Force | Out-Null
$taskLog = Join-Path $taskResults ("web-threads-build-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$taskSavedSdk = $env:WEB_EMSDK_ROOT
$taskSavedConfig = $env:EM_CONFIG
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskReport = [ordered]@{ pass = $false; date = (Get-Date -Format o); target = 'UEWebThreads'; threaded = $true }
function Get-ThreadAudit([string]$File) {
    return @{ file = $File; sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
}
try {
    $taskMask = [long]([Math]::Pow(2, [Math]::Min(16, $MaxParallelActions * 2)) - 1)
    $taskProcess.ProcessorAffinity = [IntPtr]($taskAffinity.ToInt64() -band $taskMask)
    $env:WEB_EMSDK_ROOT = Join-Path $taskRoot '.tools/emsdk'
    $env:EM_CONFIG = (Join-Path $env:WEB_EMSDK_ROOT '.emscripten').Replace('\', '/')
    & $taskDotnet build (Join-Path $PSScriptRoot 'web-ubt/UnrealBuildTool.Web.csproj') "-p:UEEngineRoot=$Engine/Engine" --nologo -v:minimal *> $taskLog
    if ($LASTEXITCODE -ne 0) { throw "Web UBT build failed. See $taskLog" }
    $taskArguments = @($taskUbt, 'UEWebThreads', 'Web', 'Development',
        "-Project=$(Join-Path $taskRoot 'tests/ue-web-smoke/UEWebSmoke.uproject')",
        '-NoUBA', "-MaxParallelActions=$MaxParallelActions", '-NoUBTMakefiles')
    Write-Output "Building shared-memory UE Core candidate. Log: $taskLog"
    & $taskDotnet @taskArguments *>> $taskLog
    if ($LASTEXITCODE -ne 0) { throw "UE threaded build failed. See $taskLog" }
    $taskIntermediate = Join-Path $taskRoot 'tests/ue-web-smoke/Intermediate/Build/Web/wasm64/UEWebThreads/Development'
    $taskResponse = Join-Path $taskIntermediate 'UEWebThreads.js.rsp'
    $taskLinkText = Get-Content -LiteralPath $taskResponse -Raw
    if (-not $taskLinkText.Contains('-pthread') -or -not $taskLinkText.Contains('wasm64-thread/libBLAKE3.a')) {
        throw 'Thread candidate must use pthread linkage and a separate BLAKE3 archive.'
    }
    $taskObjects = @([regex]::Matches($taskLinkText, '(?m)^"([^"\r\n]+\.o)"\r?$') | ForEach-Object {
        $taskObject = $_.Groups[1].Value
        $taskCompile = Get-Content -LiteralPath "$taskObject.rsp" -Raw
        $taskDefinitions = [regex]::Match($taskCompile, '(?m)^-include "([^"]+/Definitions[^"]*\.h)"').Groups[1].Value
        if (-not $taskDefinitions -or -not (Test-Path -LiteralPath $taskDefinitions)) {
            throw "Missing UBT compile definitions: $taskObject"
        }
        $taskDefinesText = Get-Content -LiteralPath $taskDefinitions -Raw
        if (-not $taskCompile.Contains('-pthread') -or $taskDefinesText -notmatch '(?m)^#define UE_WEB_THREADS 1\r?$' -or
            -not $taskObject.Replace('\', '/').Contains('/UEWebThreads/')) {
            throw "Mixed thread memory model or target objects: $taskObject"
        }
        $taskSource = [regex]::Match($taskCompile, '(?m)^-c\r?\n"([^"]+)"').Groups[1].Value
        if (-not $taskSource) { throw "Missing compiler input: $taskObject" }
        @{ object = Get-ThreadAudit $taskObject; response = Get-ThreadAudit "$taskObject.rsp";
            definitions = Get-ThreadAudit $taskDefinitions; source = Get-ThreadAudit $taskSource }
    })
    if ($taskObjects.Count -lt 500) { throw 'Expected a complete Core target build.' }
    $taskReport.products = @('UEWebThreads.js', 'UEWebThreads.wasm') | ForEach-Object {
        Get-ThreadAudit (Join-Path $taskRoot "tests/ue-web-smoke/Binaries/Web/$_")
    }
    $taskReport.linkResponse = Get-ThreadAudit $taskResponse
    $taskReport.objects = $taskObjects
    $taskReport.sourceFiles = @($PSCommandPath,
        (Join-Path $taskRoot 'tests/ue-web-smoke/Source/UEWebThreads.Target.cs')) +
        @(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'tests/ue-web-smoke/Source/UEWebThreads') -Recurse -File | ForEach-Object { $_.FullName }) +
        @(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'reference-engine/Engine/Platforms/Web') -Recurse -File |
            Where-Object { $_.Extension -notin @('.a', '.o') } | ForEach-Object { $_.FullName })
    $taskReport.sourceFiles = @($taskReport.sourceFiles | ForEach-Object { Get-ThreadAudit $_ })
    $taskReport.platformCopies = @(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'reference-engine/Engine/Platforms/Web/Config'),
        (Join-Path $taskRoot 'reference-engine/Engine/Platforms/Web/Source') -Recurse -File |
        Where-Object { $_.Extension -notin @('.a', '.o') } | ForEach-Object {
            $taskRelative = [IO.Path]::GetRelativePath((Join-Path $taskRoot 'reference-engine/Engine/Platforms/Web'), $_.FullName)
            $taskCopied = Join-Path $taskWeb $taskRelative
            $taskOriginalAudit = Get-ThreadAudit $_.FullName
            $taskCopiedAudit = Get-ThreadAudit $taskCopied
            if ($taskOriginalAudit.sha256 -ne $taskCopiedAudit.sha256) { throw "Stale platform overlay: $taskCopied" }
            @{ source = $taskOriginalAudit; copied = $taskCopiedAudit }
        })
    $taskReport.dependencies = @('blake3', 'libpng') | ForEach-Object {
        $taskDependencyReport = Join-Path $taskResults "web-$_-thread-build-results.json"
        $taskDependency = Get-Content -LiteralPath $taskDependencyReport -Raw | ConvertFrom-Json
        if (-not $taskDependency.pass -or -not $taskDependency.threaded) { throw "Invalid shared-memory dependency: $_" }
        Get-ThreadAudit $taskDependencyReport
    }
    $taskReport.ubt = Get-ThreadAudit $taskUbt
    $taskReport.pass = $true
} finally {
    $taskReport.log = Get-ThreadAudit $taskLog
    $taskReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskResults 'web-threads-build-results.json') -Encoding utf8
    $env:WEB_EMSDK_ROOT = $taskSavedSdk
    $env:EM_CONFIG = $taskSavedConfig
    $taskProcess.ProcessorAffinity = $taskAffinity
}
