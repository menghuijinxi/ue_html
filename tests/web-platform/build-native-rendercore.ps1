param(
    [string]$Engine = 'H:/UE_5.8',
    [ValidateSet('RenderCore', 'Renderer')][string]$Module = 'RenderCore'
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskHost = Join-Path $taskRoot '.tools/ue58-web-native-build-host/Engine'
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskModuleName = $Module.ToLowerInvariant()
$taskLog = Join-Path $PSScriptRoot "results/native-$taskModuleName-$taskStamp.log"
$taskReportFile = Join-Path $PSScriptRoot "results/native-$taskModuleName-build-results.json"
$taskActions = Join-Path $PSScriptRoot "build/native-$taskModuleName-actions-$taskStamp.json"
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskFlag = "UE_WEB_NATIVE_$($Module.ToUpperInvariant())"
$taskSavedFlag = [Environment]::GetEnvironmentVariable($taskFlag)
$taskReport = [ordered]@{
    date = Get-Date -Format o
    pass = $false
    nativeModuleOnly = $true
    fullSourceEngineBuild = $false
    nativeModuleLoadVerified = $false
    completeUEScene = $false
}
function Get-TaskAudit([string]$File) {
    return @{ file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
}
try {
    $taskProcess.ProcessorAffinity = [IntPtr]3
    [Environment]::SetEnvironmentVariable($taskFlag, '1')
    $taskPrepareArguments = @((Join-Path $PSScriptRoot 'prepare-native-rendercore-host.cjs'))
    if ($Module -eq 'Renderer') { $taskPrepareArguments += '--renderer' }
    & node @taskPrepareArguments *> "$taskLog.prepare"
    if ($LASTEXITCODE -ne 0) { throw "Native host preparation failed: $taskLog.prepare" }
    $taskPreparedFile = Join-Path $PSScriptRoot "results/native-$taskModuleName-host-results.json"
    $taskPrepared = Get-Content -LiteralPath $taskPreparedFile -Raw | ConvertFrom-Json
    $taskReport.hostPreparation = Get-TaskAudit $taskPreparedFile
    $taskDotnet = Join-Path $Engine 'Engine/Binaries/ThirdParty/DotNet/10.0/win-x64/dotnet.exe'
    & $taskDotnet build (Join-Path $PSScriptRoot 'native-ubt/UnrealBuildTool.Native.csproj') -c Release --no-restore *> "$taskLog.ubt-build"
    if ($LASTEXITCODE -ne 0) { throw "Native UBT build failed: $taskLog.ubt-build" }
    $taskUBT = Join-Path $taskHost 'Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll'
    # A plugin-only build can cache a target without the native RenderCore outputs.
    $taskMakefile = Join-Path $taskRoot 'tests/ue-shader-host/Intermediate/Build/Win64/x64/UEShaderHostEditor/Development/Makefile.bin'
    if (Test-Path -LiteralPath $taskMakefile) { Remove-Item -LiteralPath $taskMakefile }
    $taskArguments = @($taskUBT, 'UEShaderHostEditor', 'Win64', 'Development',
        "-Project=$taskProject", "-Module=$Module", '-NoUBA', '-NoUbaLocal',
        '-MaxParallelActions=1', '-NoHotReloadFromIDE')
    & $taskDotnet @taskArguments "-WriteOutdatedActions=$taskActions" "-Log=$taskLog.actions-ubt" *> "$taskLog.actions"
    if ($LASTEXITCODE -ne 0) { throw "Native action export failed: $taskLog.actions" }
    $taskExport = Get-Content -LiteralPath $taskActions -Raw | ConvertFrom-Json
    foreach ($taskAction in $taskExport.Actions) {
        foreach ($taskProduced in $taskAction.ProducedItems) {
            $taskResolved = [IO.Path]::GetFullPath($taskProduced)
            $taskAllowed = $taskResolved.StartsWith("$taskHost\", [StringComparison]::OrdinalIgnoreCase) -or
                $taskResolved.StartsWith((Join-Path $taskRoot 'tests/ue-shader-host/Intermediate/'), [StringComparison]::OrdinalIgnoreCase)
            if (-not $taskAllowed) { throw "Native build output escaped isolated workspace: $taskResolved" }
            if ($taskResolved -match '\.(dll|exe)$' -and
                [IO.Path]::GetFileName($taskResolved) -ne "UnrealEditor-$Module.dll") {
                throw "Only $Module may be rebuilt: $taskResolved"
            }
        }
    }
    $taskReport.actions = Get-TaskAudit $taskActions
    $taskReport.actionCount = $taskExport.Actions.Count
    & $taskDotnet @taskArguments "-Log=$taskLog.ubt" *> $taskLog
    $taskReport.exitCode = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw "Native $Module build failed: $taskLog" }
    foreach ($taskInput in $taskPrepared.installedInputs) {
        if ((Get-TaskAudit $taskInput.file).sha256 -ne $taskInput.sha256) { throw "Installed input changed: $($taskInput.file)" }
    }
    $taskReport.installedInputsUnmodified = $true
    $taskReport.installedInputs = $taskPrepared.installedInputs
    $taskReport.sourceFiles = @($taskPrepared.sourceFiles) + @(
        $PSCommandPath,
        (Join-Path $PSScriptRoot 'native-ubt/UEBuildTarget.cs'),
        (Join-Path $PSScriptRoot 'native-ubt/UnrealBuildTool.Native.csproj')
    ) | ForEach-Object { if ($_ -is [string]) { Get-TaskAudit $_ } else { $_ } }
    $taskReport.products = @("UnrealEditor-$Module.dll", "UnrealEditor-$Module.pdb") |
        ForEach-Object { Get-TaskAudit (Join-Path $taskHost "Binaries/Win64/$_") }
    $taskReport.ubt = Get-TaskAudit $taskUBT
    $taskReport.log = Get-TaskAudit $taskLog
    $taskReport.boundary = "Isolated native $Module module build using installed 5.8.0 source with audited target Web overlays. Other native modules remain precompiled dependencies. Module loading, Cook completion, WASM loading and rendering require separate verification."
    $taskReport.pass = $true
} catch {
    $taskReport.failure = $_.ToString()
    throw
} finally {
    $taskReport | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $taskReportFile -Encoding utf8
    [Environment]::SetEnvironmentVariable($taskFlag, $taskSavedFlag)
    $taskProcess.ProcessorAffinity = $taskAffinity
}
Write-Output ([pscustomobject]$taskReport | Select-Object pass, actionCount, installedInputsUnmodified, log | ConvertTo-Json)
