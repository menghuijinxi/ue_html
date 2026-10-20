param([string]$Engine = 'H:/UE_5.8')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskHost = Join-Path $taskRoot '.tools/ue58-web-native-build-host/Engine'
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskLog = Join-Path $PSScriptRoot "results/native-rendercore-$taskStamp.log"
$taskReportFile = Join-Path $PSScriptRoot 'results/native-rendercore-build-results.json'
$taskActions = Join-Path $PSScriptRoot "build/native-rendercore-actions-$taskStamp.json"
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskSavedFlag = $env:UE_WEB_NATIVE_RENDERCORE
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
    $env:UE_WEB_NATIVE_RENDERCORE = '1'
    & node (Join-Path $PSScriptRoot 'prepare-native-rendercore-host.cjs') *> "$taskLog.prepare"
    if ($LASTEXITCODE -ne 0) { throw "Native host preparation failed: $taskLog.prepare" }
    $taskPreparedFile = Join-Path $PSScriptRoot 'results/native-rendercore-host-results.json'
    $taskPrepared = Get-Content -LiteralPath $taskPreparedFile -Raw | ConvertFrom-Json
    $taskReport.hostPreparation = Get-TaskAudit $taskPreparedFile
    $taskDotnet = Join-Path $Engine 'Engine/Binaries/ThirdParty/DotNet/10.0/win-x64/dotnet.exe'
    & $taskDotnet build (Join-Path $PSScriptRoot 'native-ubt/UnrealBuildTool.Native.csproj') -c Release --no-restore *> "$taskLog.ubt-build"
    if ($LASTEXITCODE -ne 0) { throw "Native UBT build failed: $taskLog.ubt-build" }
    $taskUBT = Join-Path $taskHost 'Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll'
    $taskArguments = @($taskUBT, 'UEShaderHostEditor', 'Win64', 'Development',
        "-Project=$taskProject", '-Module=RenderCore', '-NoUBA', '-NoUbaLocal',
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
                [IO.Path]::GetFileName($taskResolved) -ne 'UnrealEditor-RenderCore.dll') {
                throw "Only RenderCore may be rebuilt: $taskResolved"
            }
        }
    }
    $taskReport.actions = Get-TaskAudit $taskActions
    $taskReport.actionCount = $taskExport.Actions.Count
    & $taskDotnet @taskArguments "-Log=$taskLog.ubt" *> $taskLog
    $taskReport.exitCode = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw "Native RenderCore build failed: $taskLog" }
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
    $taskReport.products = @('UnrealEditor-RenderCore.dll', 'UnrealEditor-RenderCore.pdb') |
        ForEach-Object { Get-TaskAudit (Join-Path $taskHost "Binaries/Win64/$_") }
    $taskReport.ubt = Get-TaskAudit $taskUBT
    $taskReport.log = Get-TaskAudit $taskLog
    $taskReport.boundary = 'Native RenderCore only, using installed 5.8.0 source with target Shader.cpp, RenderUtils.cpp, GPUDebugCrashUtils.cpp, ResolveShader.cpp and shared WebShaderPlatform.h. Other native modules remain installed binaries. Module loading, Cook completion, WASM loading and rendering require separate verification.'
    $taskReport.pass = $true
} catch {
    $taskReport.failure = $_.ToString()
    throw
} finally {
    $taskReport | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $taskReportFile -Encoding utf8
    $env:UE_WEB_NATIVE_RENDERCORE = $taskSavedFlag
    $taskProcess.ProcessorAffinity = $taskAffinity
}
Write-Output ([pscustomobject]$taskReport | Select-Object pass, actionCount, installedInputsUnmodified, log | ConvertTo-Json)
