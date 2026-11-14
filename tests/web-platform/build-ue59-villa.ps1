param(
    [Parameter(Mandatory)]
    [ValidateSet('Dependencies', 'ToolDependencies', 'Editor', 'Shaders', 'Package')]
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
    'ToolDependencies' {
        $taskRepairRoot = Join-Path $PSScriptRoot 'build/ue59-tool-dependencies'
        $taskRepairBuild = Join-Path $taskRepairRoot 'Engine/Build'
        New-Item -ItemType Directory -Path $taskRepairBuild -Force | Out-Null
        $taskOfficialManifest = [System.Xml.XmlDocument]::new()
        $taskOfficialManifest.Load((Join-Path $taskEngine 'Engine/Build/Commit.gitdeps.xml'))
        $taskSubset = [System.Xml.XmlDocument]::new()
        [void]$taskSubset.AppendChild($taskSubset.ImportNode($taskOfficialManifest.DocumentElement, $false))
        foreach ($taskSection in @('Files', 'Blobs', 'Packs')) {
            [void]$taskSubset.DocumentElement.AppendChild($taskSubset.CreateElement($taskSection))
        }
        $taskRepairFiles = @(
            'Engine/Binaries/DotNET/EpicGames.Perforce.Native/linux-x64/Release/EpicGames.Perforce.Native.so'
            'Engine/Binaries/DotNET/EpicGames.Perforce.Native/mac-x64/Release/EpicGames.Perforce.Native.dylib'
            'Engine/Source/Programs/AutomationTool/IOS/Resources/GreenCheck.png'
            'Engine/Source/Programs/AutomationTool/IOS/Resources/GreyCheck.png'
            'Engine/Source/Programs/AutomationTool/IOS/ExportOptions.plist.template'
        )
        foreach ($taskFile in $taskRepairFiles) {
            $taskFileNode = $taskOfficialManifest.SelectSingleNode("/DependencyManifest/Files/File[@Name='$taskFile']")
            if (-not $taskFileNode) { throw "Missing official dependency entry: $taskFile" }
            $taskHash = $taskFileNode.GetAttribute('Hash')
            $taskBlobNode = $taskOfficialManifest.SelectSingleNode("/DependencyManifest/Blobs/Blob[@Hash='$taskHash']")
            if (-not $taskBlobNode) { throw "Missing official blob: $taskHash" }
            $taskPackHash = $taskBlobNode.GetAttribute('PackHash')
            $taskPackNode = $taskOfficialManifest.SelectSingleNode("/DependencyManifest/Packs/Pack[@Hash='$taskPackHash']")
            if (-not $taskPackNode) { throw "Missing official pack: $taskPackHash" }
            [void]$taskSubset.SelectSingleNode('/DependencyManifest/Files').AppendChild($taskSubset.ImportNode($taskFileNode, $true))
            [void]$taskSubset.SelectSingleNode('/DependencyManifest/Blobs').AppendChild($taskSubset.ImportNode($taskBlobNode, $true))
            if (-not $taskSubset.SelectSingleNode("/DependencyManifest/Packs/Pack[@Hash='$taskPackHash']")) {
                [void]$taskSubset.SelectSingleNode('/DependencyManifest/Packs').AppendChild($taskSubset.ImportNode($taskPackNode, $true))
            }
        }
        $taskSubset.Save((Join-Path $taskRepairBuild 'ToolDependencies.gitdeps.xml'))
        $taskExecutable = Join-Path $taskEngine 'Engine/Binaries/DotNET/GitDependencies/win-x64/GitDependencies.exe'
        $taskArguments = @("--root=$taskRepairRoot", '--force', '--threads=2', '--no-cache')
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
    requestedCompilerVersion = $CompilerVersion
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
    if ($Phase -in @('Dependencies', 'ToolDependencies') -and (Select-String -LiteralPath "$taskPrefix.log" -Pattern '^Invalid command line parameter:' -Quiet)) {
        $taskExit = 1
    }
    if ($Phase -eq 'ToolDependencies' -and $taskExit -eq 0) {
        foreach ($taskFile in $taskRepairFiles) {
            $taskFileNode = $taskSubset.SelectSingleNode("/DependencyManifest/Files/File[@Name='$taskFile']")
            $taskDownloaded = Join-Path $taskRepairRoot $taskFile
            $taskExpected = $taskFileNode.GetAttribute('Hash')
            if ((Get-FileHash -LiteralPath $taskDownloaded -Algorithm SHA1).Hash.ToLowerInvariant() -ne $taskExpected) {
                throw "Official dependency checksum mismatch: $taskFile"
            }
            $taskDestination = Join-Path $taskEngine $taskFile
            New-Item -ItemType Directory -Path (Split-Path $taskDestination) -Force | Out-Null
            Copy-Item -LiteralPath $taskDownloaded -Destination $taskDestination
            if ((Get-FileHash -LiteralPath $taskDestination -Algorithm SHA1).Hash.ToLowerInvariant() -ne $taskExpected) {
                throw "Copied dependency checksum mismatch: $taskFile"
            }
            Add-Content -LiteralPath "$taskPrefix.log" -Value "Verified $taskFile SHA1=$taskExpected"
        }
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
