param([string[]]$AdditionalResponses = @())
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskReportPath = Join-Path $PSScriptRoot 'results/web-engine-webgpu-link-results.json'
$taskCachePath = Join-Path $PSScriptRoot 'build/web-engine-object-cache.json'
$taskHashes = @{}
function Get-TaskAudit([string]$File) {
    $taskPath = [IO.Path]::GetFullPath($File)
    if (-not $taskHashes.ContainsKey($taskPath)) {
        $taskHashes[$taskPath] = (Get-FileHash -LiteralPath $taskPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return @{file = $taskPath; sha256 = $taskHashes[$taskPath]}
}
function Test-TaskAudit($Item) {
    return $Item -and (Test-Path -LiteralPath $Item.file) -and
        (Get-TaskAudit $Item.file).sha256 -eq $Item.sha256
}
$taskPrior = Get-Content -LiteralPath $taskReportPath -Raw | ConvertFrom-Json
if (-not $taskPrior.pass) { throw 'Preserve or restore a successful link report before iteration.' }
$taskResponses = @($taskPrior.recompiledObjects | ForEach-Object { $_.response.file }) +
    @($AdditionalResponses | ForEach-Object { [IO.Path]::GetFullPath($_) })
$taskResponses = @($taskResponses | Select-Object -Unique)
$taskOutputs = @{}
foreach ($taskResponse in $taskResponses) {
    $taskArguments = @(Get-Content -LiteralPath $taskResponse)
    if ($taskArguments[0] -ne '-c' -or $taskArguments[2] -ne '-o') {
        throw "Unexpected compile response: $taskResponse"
    }
    $taskOutputs[[IO.Path]::GetFullPath($taskArguments[3].Trim('"'))] = $taskResponse
}
$taskResponses = @($taskOutputs.Values)
$taskCompiler = Get-TaskAudit (Join-Path $taskRoot '.tools/emsdk/upstream/bin/clang++.exe')
$taskCache = $null
if (Test-Path -LiteralPath $taskCachePath) {
    $taskCache = Get-Content -LiteralPath $taskCachePath -Raw | ConvertFrom-Json
    if (-not (Test-TaskAudit $taskCache.compiler)) { $taskCache = $null }
}
$taskCompile = @()
$taskReuse = @()
foreach ($taskResponse in $taskResponses) {
    $taskEntry = @($taskCache.objects | Where-Object { $_.compilation.response.file -eq $taskResponse })
    $taskReusable = $taskEntry.Count -eq 1
    if ($taskReusable) {
        $taskObject = $taskEntry[0]
        foreach ($taskKey in @('source', 'response', 'product', 'log')) {
            $taskReusable = $taskReusable -and (Test-TaskAudit $taskObject.compilation.$taskKey)
        }
        foreach ($taskDependency in $taskObject.dependencyPaths) {
            $taskStored = $taskCache.dependencies.PSObject.Properties[$taskDependency].Value
            if (-not $taskStored -or -not (Test-TaskAudit $taskStored)) { $taskReusable = $false; break }
        }
    }
    if ($taskReusable) { $taskReuse += $taskEntry[0].compilation }
    else { $taskCompile += $taskResponse }
}
Write-Output "Compile $($taskCompile.Count) changed units; reuse $($taskReuse.Count) dependency-verified objects."
& (Join-Path $PSScriptRoot 'link-web-engine-webgpu.ps1') -RecompileResponses $taskCompile | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Incremental diagnostic compile/link failed.' }
$taskBuild = Get-Content -LiteralPath $taskReportPath -Raw | ConvertFrom-Json
if (-not $taskBuild.pass) { throw 'Diagnostic link did not pass.' }
$taskFresh = @($taskBuild.recompiledObjects)
$taskBuild.recompiledObjects = @($taskFresh) + @($taskReuse)
$taskBuild | Add-Member -NotePropertyName freshCompiledObjectCount -NotePropertyValue $taskFresh.Count -Force
$taskBuild | Add-Member -NotePropertyName reusedObjectCount -NotePropertyValue $taskReuse.Count -Force
$taskBuild | Add-Member -NotePropertyName objectReusePolicy -NotePropertyValue 'Compiler, response, source, object, original compile log and every Clang dependency SHA256 must match.' -Force
$taskBuild.sourceFiles += Get-TaskAudit $PSCommandPath
$taskHashes = @{}
$taskDependencies = @{}
$taskObjects = @()
foreach ($taskCompilation in $taskBuild.recompiledObjects) {
    foreach ($taskKey in @('source', 'response', 'product', 'log')) {
        if (-not (Test-TaskAudit $taskCompilation.$taskKey)) { throw "Compilation audit changed: $taskKey" }
    }
    $taskDependencyFile = "$($taskCompilation.product.file).d"
    $taskLines = @(Get-Content -LiteralPath $taskDependencyFile)
    if ($taskLines.Count -lt 2 -or $taskLines[0] -notmatch ':\s+\\$') {
        throw "Unexpected Clang dependency format: $taskDependencyFile"
    }
    $taskPaths = @($taskLines | Select-Object -Skip 1 | ForEach-Object {
        $taskPath = ($_.Trim() -replace '\s+\\$', '').Replace('\ ', ' ')
        if ($taskPath) {
            if (-not [IO.Path]::IsPathRooted($taskPath) -or -not (Test-Path -LiteralPath $taskPath -PathType Leaf)) {
                throw "Missing or malformed Clang dependency: $taskPath"
            }
            [IO.Path]::GetFullPath($taskPath)
        }
    } | Select-Object -Unique)
    if ($taskPaths.Count -lt 2) { throw 'A compiled object must include its source and dependencies.' }
    foreach ($taskPath in $taskPaths) { $taskDependencies[$taskPath] = Get-TaskAudit $taskPath }
    $taskObjects += @{compilation = $taskCompilation; dependencyPaths = $taskPaths}
}
@{date = Get-Date -Format o; compiler = $taskCompiler; objects = $taskObjects; dependencies = $taskDependencies} |
    ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $taskCachePath -Encoding utf8NoBOM
$taskBuild | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $taskReportPath -Encoding utf8NoBOM
Write-Output "Diagnostic link passed: $($taskFresh.Count) compiled, $($taskReuse.Count) reused, $($taskDependencies.Count) audited dependencies."
