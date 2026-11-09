param(
    [Parameter(Mandatory)]
    [ValidateSet('Dependencies', 'Editor', 'Shaders', 'Package')]
    [string]$Phase,
    [string]$Engine = 'E:/UE59WebBenchmark/engine-5.9',
    [string]$Project = 'E:/UE59WebBenchmark/TriplexHouseVilla/TriplexHouseVilla.uproject',
    [string]$Emsdk = 'E:/UE59WebBenchmark/emsdk-6.0.10',
    [string]$Archive = 'E:/UE59WebBenchmark/package',
    [int]$MaxParallelActions = 12,
    [string]$CompilerVersion = '14.44.35227',
    [ValidateRange(0, [long]::MaxValue)][long]$HostProcessorAffinity = 0
)
$ErrorActionPreference = 'Stop'
$taskEngine = (Resolve-Path -LiteralPath $Engine).Path
$taskResults = Join-Path $PSScriptRoot 'results/ue59-official-villa'
New-Item -ItemType Directory -Path $taskResults -Force | Out-Null
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskPrefix = Join-Path $taskResults "$($Phase.ToLowerInvariant())-$taskStamp"
$taskCommit = (& git -C $taskEngine rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve engine commit.' }
$taskDirty = @(& git -C $taskEngine status --porcelain --untracked-files=no)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect engine worktree.' }
if ($taskDirty.Count) { throw 'Official benchmark requires unmodified tracked engine files.' }
$env:WASM_EMSDK_ROOT = [IO.Path]::GetFullPath($Emsdk)
$env:EMSDK = $env:WASM_EMSDK_ROOT
$env:VSLANG = '1033'
$taskBuildArgs = @("-MaxParallelActions=$MaxParallelActions", '-NoUBA', "-CompilerVersion=$CompilerVersion")
switch ($Phase) {
    'Dependencies' {
        $taskExecutable = Join-Path $taskEngine 'Engine/Binaries/DotNET/GitDependencies/win-x64/GitDependencies.exe'
        $taskArguments = @('--force', '--threads=12',
            '--exclude=Android', '--exclude=IOS', '--exclude=Mac', '--exclude=Linux',
            '--exclude=LinuxArm64', '--exclude=TVOS', '--exclude=VisionOS', '--exclude=Win32',
            '--exclude=linux-x64', '--exclude=linux-arm64', '--exclude=mac-x64',
            '--exclude=mac-arm64', '--exclude=win-arm64')
    }
    'Editor' {
        $taskExecutable = Join-Path $taskEngine 'Engine/Build/BatchFiles/Build.bat'
        $taskArguments = @('TriplexHouseVillaEditor', 'Win64', 'Development', "-Project=$Project",
            '-WaitMutex', '-NoHotReloadFromIDE') + $taskBuildArgs
    }
    'Shaders' {
        $taskExecutable = Join-Path $taskEngine 'Engine/Build/BatchFiles/Build.bat'
        $taskArguments = @('ShaderCompileWorker', 'Win64', 'Development', '-WaitMutex') + $taskBuildArgs
    }
    'Package' {
        $taskExecutable = Join-Path $taskEngine 'Engine/Build/BatchFiles/RunUAT.bat'
        $taskArguments = @('BuildCookRun', "-project=$Project", '-platform=Wasm',
            '-clientconfig=Development', '-build', '-cook', '-stage', '-pak', '-iostore', '-package',
            '-archive', "-archivedirectory=$Archive", '-unattended', '-utf8output', '-nop4',
            '-nocompileeditor', '-map=/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla',
            '-AdditionalCookerOptions=-unattended -nopause -nosplash -nullrhi',
            "-UbtArgs=$($taskBuildArgs -join ' ')")
    }
}
$taskStart = Get-Date
$taskBuildProcess = Get-Process -Id $PID
$taskSavedAffinity = $taskBuildProcess.ProcessorAffinity
$taskEffectiveAffinity = if ($HostProcessorAffinity) { $HostProcessorAffinity } else { $taskSavedAffinity.ToInt64() }
[ordered]@{
    started = $taskStart.ToString('o')
    phase = $Phase
    engine = $taskEngine
    commit = $taskCommit
    engineTrackedFilesClean = $true
    project = $Project
    emsdk = $env:WASM_EMSDK_ROOT
    compilerVersion = $CompilerVersion
    hostProcessorAffinity = $taskEffectiveAffinity
    executable = $taskExecutable
    arguments = $taskArguments
    log = "$taskPrefix.log"
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$taskPrefix-start.json" -Encoding utf8NoBOM
Write-Output "$Phase started. Log: $taskPrefix.log"
Push-Location $taskEngine
try {
    if ($HostProcessorAffinity) { $taskBuildProcess.ProcessorAffinity = [IntPtr]$HostProcessorAffinity }
    & $taskExecutable @taskArguments *> "$taskPrefix.log"
    $taskExit = $LASTEXITCODE
    if ($Phase -eq 'Dependencies' -and (Select-String -LiteralPath "$taskPrefix.log" -Pattern '^Invalid command line parameter:' -Quiet)) {
        $taskExit = 1
    }
} finally {
    $taskBuildProcess.ProcessorAffinity = $taskSavedAffinity
    Pop-Location
}
[ordered]@{
    completed = (Get-Date).ToString('o')
    seconds = [math]::Round(((Get-Date) - $taskStart).TotalSeconds, 3)
    phase = $Phase
    exitCode = $taskExit
    commit = $taskCommit
    log = "$taskPrefix.log"
} | ConvertTo-Json | Set-Content -LiteralPath "$taskPrefix-complete.json" -Encoding utf8NoBOM
Get-Content -LiteralPath "$taskPrefix.log" -Tail 35
if ($taskExit -ne 0) { throw "$Phase failed with exit code ${taskExit}: $taskPrefix.log" }
Write-Output "$Phase completed."
