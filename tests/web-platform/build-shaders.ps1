$ErrorActionPreference = 'Stop'
$taskWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskEngine = Join-Path $taskWorkspace 'reference-engine'
$taskDxc = Join-Path $taskWorkspace '.tools/dxc-v1.9.2609/bin/x64/dxc.exe'
$taskTint = Join-Path $taskWorkspace '.tools/dawn-v20261009.190412/bin/tint.exe'
$taskInfo = Join-Path $taskWorkspace '.tools/dawn-v20261009.190412/bin/tint_info.exe'
$taskBuild = Join-Path $PSScriptRoot 'build/shaders'
$taskSources = Join-Path $taskBuild 'source'
$taskFixtures = Join-Path $PSScriptRoot 'shader-fixtures'
New-Item -ItemType Directory -Path $taskSources -Force | Out-Null
$taskCommit = (& git -C $taskEngine rev-parse HEAD).Trim()
if ($taskCommit -ne '396c9f059903aed5fec78ecd3d437a40c6415368') {
    throw "UE source revision changed: $taskCommit"
}

# Copy Git blob bytes without archiving the entire partially cloned UE tree.
$taskSourceHashes = @{}
foreach ($taskFile in @('ScreenVertexShader.usf', 'ScreenPixelShader.usf', 'ClearReplacementShaders.usf')) {
    $taskStart = [Diagnostics.ProcessStartInfo]::new((Get-Command git).Source)
    $taskStart.UseShellExecute = $false
    $taskStart.RedirectStandardOutput = $true
    $taskStart.RedirectStandardError = $true
    $taskStart.Environment['GIT_NO_LAZY_FETCH'] = '1'
    foreach ($taskArg in @('-C', $taskEngine, 'show', "HEAD:Engine/Shaders/Private/$taskFile")) {
        $taskStart.ArgumentList.Add($taskArg)
    }
    $taskProcess = [Diagnostics.Process]::Start($taskStart)
    $taskStream = [IO.MemoryStream]::new()
    $taskProcess.StandardOutput.BaseStream.CopyTo($taskStream)
    $taskError = $taskProcess.StandardError.ReadToEnd()
    $taskProcess.WaitForExit()
    if ($taskProcess.ExitCode -ne 0) { throw "Source extraction failed: $taskFile $taskError" }
    $taskSource = Join-Path $taskSources $taskFile
    [IO.File]::WriteAllBytes($taskSource, $taskStream.ToArray())
    $taskStream.Dispose()
    $taskProcess.Dispose()
    $taskSourceHashes[$taskFile] = (Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash.ToLowerInvariant()
}

$taskClearDefines = @('-DVALUE_TYPE=float4', '-DENABLE_CLEAR_VALUE=1',
    '-DENABLE_BOUNDS=0', '-DENABLE_DEPTH=0', '-DUSE_WRAPPED_GROUP_COUNT=0')
$taskComputeDefines = @('-DVALUE_TYPE=float4', '-DENABLE_CLEAR_VALUE=1',
    '-DENABLE_BOUNDS=1', '-DTHREADGROUPSIZE_X=8', '-DTHREADGROUPSIZE_Y=1',
    '-DTHREADGROUPSIZE_Z=1', '-DUSE_WRAPPED_GROUP_COUNT=0')
$taskCases = @(
    @{name='screen-vs'; file='ScreenVertexShader.usf'; entry='Main'; stage='vs'; defines=@()},
    @{name='screen-ps'; file='ScreenPixelShader.usf'; entry='Main'; stage='ps'; defines=@()},
    @{name='screen-mip-ps'; file='ScreenPixelShader.usf'; entry='MainMipLevel'; stage='ps'; defines=@()},
    @{name='clear-vs'; file='ClearReplacementShaders.usf'; entry='ClearVS'; stage='vs'; defines=$taskClearDefines},
    @{name='clear-ps'; file='ClearReplacementShaders.usf'; entry='ClearPS'; stage='ps'; defines=$taskClearDefines},
    @{name='clear-structured-cs'; file='ClearReplacementShaders.usf'; entry='ClearCS'; stage='cs'; defines=($taskComputeDefines + '-DRESOURCE_TYPE=4')},
    @{name='clear-texture-cs'; file='ClearReplacementShaders.usf'; entry='ClearCS'; stage='cs'; defines=($taskComputeDefines + '-DRESOURCE_TYPE=1')},
    @{name='clear-typed-buffer-cs'; file='ClearReplacementShaders.usf'; entry='ClearCS'; stage='cs'; defines=($taskComputeDefines + '-DRESOURCE_TYPE=0'); expectedRejection=$true}
)
$taskResults = foreach ($taskCase in $taskCases) {
    $taskName = $taskCase.name
    $taskSpirv = Join-Path $taskBuild "$taskName.spv"
    $taskWgsl = Join-Path $taskBuild "$taskName.wgsl"
    $taskArgs = @((Join-Path $taskSources $taskCase.file), '-E', $taskCase.entry,
        '-T', "$($taskCase.stage)_6_0", '-HV', '2021', '-spirv',
        '-fspv-target-env=vulkan1.1', '-fvk-bind-globals', '2', '0',
        '-I', $taskFixtures, '-Fo', $taskSpirv) + $taskCase.defines
    $taskDxcOutput = (& $taskDxc @taskArgs 2>&1 | Out-String)
    $taskDxcExit = $LASTEXITCODE
    $taskTintExit = $null
    $taskReflection = $null
    $taskDiagnostics = $taskDxcOutput
    if ($taskDxcExit -eq 0) {
        $taskTintOutput = (& $taskTint $taskSpirv --format wgsl -o $taskWgsl 2>&1 | Out-String)
        $taskTintExit = $LASTEXITCODE
        $taskDiagnostics += $taskTintOutput
        if ($taskTintExit -eq 0) {
            $taskInfoOutput = (& $taskInfo --json $taskWgsl | Out-String)
            if ($LASTEXITCODE -ne 0) { throw "Reflection failed: $taskName" }
            $taskReflection = $taskInfoOutput | ConvertFrom-Json
            $taskInfoOutput | Set-Content -LiteralPath (Join-Path $taskBuild "$taskName.reflection.json") -Encoding utf8
        }
    }
    $taskExpectedRejection = $taskCase.expectedRejection -eq $true
    $taskPass = if ($taskExpectedRejection) {
        $taskDxcExit -eq 0 -and $taskTintExit -ne 0 -and $taskDiagnostics -match 'OpTypeImage|texel|buffer|Buffer'
    } else { $taskDxcExit -eq 0 -and $taskTintExit -eq 0 }
    $taskDiagnostics | Set-Content -LiteralPath (Join-Path $taskBuild "$taskName.log") -Encoding utf8
    Write-Host "$taskName : DXC=$taskDxcExit Tint=$taskTintExit expectedRejection=$taskExpectedRejection pass=$taskPass"
    [pscustomobject]@{
        name=$taskName; entry=$taskCase.entry; stage=$taskCase.stage
        expectedRejection=$taskExpectedRejection; dxcExit=$taskDxcExit; tintExit=$taskTintExit
        pass=$taskPass; diagnostics=$taskDiagnostics; reflection=$taskReflection
    }
}
$taskReport = [pscustomobject]@{
    kind='shader-conversion-smoke'; sourceCommit=$taskCommit; sourceSha256=$taskSourceHashes
    includeEnvironment='reduced-standalone-fixtures'
    completeUECompiler=$false; cases=@($taskResults)
    pass=(@($taskResults | Where-Object { !$_.pass }).Count -eq 0)
}
$taskReport | ConvertTo-Json -Depth 30 |
    Set-Content -LiteralPath (Join-Path $PSScriptRoot 'results/shader-build-results.json') -Encoding utf8
if (!$taskReport.pass) { throw 'Shader smoke matrix has unexpected failures; inspect per-case logs' }
