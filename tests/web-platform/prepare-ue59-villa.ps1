param(
    [string]$SourceProject = 'H:/TriplexHouseVilla/TriplexHouseVilla.uproject',
    [string]$Destination = 'E:/UE59WebBenchmark/TriplexHouseVilla'
)
$ErrorActionPreference = 'Stop'
$taskSourceProject = (Resolve-Path -LiteralPath $SourceProject).Path
$taskSourceRoot = Split-Path $taskSourceProject
$taskDestination = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $taskDestination) {
    throw "Destination already exists; refusing to overwrite: $taskDestination"
}
if ($taskDestination.StartsWith($taskSourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The benchmark copy must be outside the original project.'
}
$taskProject = Get-Content -LiteralPath $taskSourceProject -Raw | ConvertFrom-Json -AsHashtable
if ($taskProject.Modules.Count -gt 0) {
    throw 'This preparation script expects the original Blueprint-only villa project.'
}
$taskInputs = @(
    Get-Item -LiteralPath $taskSourceProject
    Get-ChildItem -LiteralPath (Join-Path $taskSourceRoot 'Config') -File -Recurse
    Get-ChildItem -LiteralPath (Join-Path $taskSourceRoot 'Content') -File -Recurse
)
$taskManifest = @($taskInputs | ForEach-Object {
    [ordered]@{
        path = [IO.Path]::GetRelativePath($taskSourceRoot, $_.FullName).Replace('\', '/')
        bytes = $_.Length
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
})
New-Item -ItemType Directory -Path $taskDestination -Force | Out-Null
foreach ($taskDirectory in @('Config', 'Content')) {
    & robocopy (Join-Path $taskSourceRoot $taskDirectory) (Join-Path $taskDestination $taskDirectory) /E /COPY:DAT /DCOPY:DAT /R:2 /W:2 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { throw "Copy failed for $taskDirectory (robocopy $LASTEXITCODE)." }
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'ue59-villa/Source') -Destination $taskDestination -Recurse
$taskPlatformConfig = Join-Path $taskDestination 'Config/Wasm'
New-Item -ItemType Directory -Path $taskPlatformConfig -Force | Out-Null
if (Test-Path -LiteralPath (Join-Path $taskPlatformConfig 'WasmEngine.ini')) {
    throw 'The source already has a WasmEngine.ini; merge its settings explicitly.'
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'ue59-villa/WasmEngine.ini') -Destination $taskPlatformConfig
$taskProject.EngineAssociation = ''
$taskProject.Modules = @(@{ Name = 'TriplexHouseVilla'; Type = 'Runtime'; LoadingPhase = 'Default' })
$taskPlugins = [Collections.Generic.List[object]]::new()
foreach ($taskPlugin in $taskProject.Plugins) { $taskPlugins.Add($taskPlugin) }
foreach ($taskName in @('OnlineSubsystemUtils', 'OnlineSubsystemNull')) {
    $taskPlugin = $taskPlugins | Where-Object { $_.Name -eq $taskName } | Select-Object -First 1
    if (-not $taskPlugin) {
        $taskPlugin = @{ Name = $taskName; Enabled = $true }
        $taskPlugins.Add($taskPlugin)
    }
    $taskPlugin.PlatformDenyList = @(@($taskPlugin.PlatformDenyList) + 'Wasm' | Where-Object { $_ } | Select-Object -Unique)
}
foreach ($taskName in @('AIAssistant', 'AllToolsets', 'ToolsetRegistry')) {
    $taskPlugin = $taskPlugins | Where-Object { $_.Name -eq $taskName } | Select-Object -First 1
    if (-not $taskPlugin) {
        $taskPlugin = @{ Name = $taskName; Enabled = $false }
        $taskPlugins.Add($taskPlugin)
    }
    $taskPlugin.Enabled = $false
}
$taskProject.Plugins = $taskPlugins.ToArray()
$taskProject | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $taskDestination 'TriplexHouseVilla.uproject') -Encoding utf8NoBOM
foreach ($taskInput in $taskManifest | Where-Object { $_.path -ne 'TriplexHouseVilla.uproject' }) {
    $taskHash = (Get-FileHash -LiteralPath (Join-Path $taskDestination $taskInput.path) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($taskHash -ne $taskInput.sha256) { throw "Copied input differs: $($taskInput.path)" }
}
$taskReport = [ordered]@{
    created = (Get-Date).ToString('o')
    sourceProject = $taskSourceProject
    project = (Join-Path $taskDestination 'TriplexHouseVilla.uproject')
    sourceFiles = $taskManifest
    copiedAssetsAndConfigVerified = $true
    changes = @(
        'Added a minimal C++ game module and game/editor targets in the copy.'
        'Cleared EngineAssociation for an explicitly selected source engine.'
        'Denied OnlineSubsystemUtils and OnlineSubsystemNull on Wasm only.'
        'Disabled editor AI toolsets in the isolated project as required by the official web cook guide.'
        'Enabled the experimental desktop tier alongside both default official mobile tiers.'
        'Kept all original asset and configuration files byte-identical.'
    )
}
$taskReportPath = Join-Path $taskDestination 'ue59-benchmark-inputs.json'
$taskReport | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $taskReportPath -Encoding utf8NoBOM
Write-Output "Prepared and verified $($taskManifest.Count) source files: $taskDestination"
