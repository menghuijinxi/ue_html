param([string]$Report = 'final-1080p')
$ErrorActionPreference = 'Stop'
if ($Report -notmatch '^[a-z0-9-]+$') { throw 'Invalid report name.' }
$taskPrefix = Join-Path $PSScriptRoot "results/villa-distance-fields-$Report"
$taskCapture = Get-Content -LiteralPath "$taskPrefix-capture.json" -Raw | ConvertFrom-Json
$taskResults = @()
foreach ($taskRun in $taskCapture.runs) {
    # Unique parser keys preserve CSV columns even when UE emits duplicate stat names.
    $taskHeader = (Get-Content -LiteralPath $taskRun.csv -TotalCount 1) -split ','
    $taskKeys = @(0..($taskHeader.Count - 1) | ForEach-Object { "column$_" })
    $taskFrameKey = $taskKeys[[array]::IndexOf($taskHeader, 'FrameTime')]
    $taskRows = @(Import-Csv -LiteralPath $taskRun.csv -Header $taskKeys | Where-Object {
        $taskValue = 0.0
        [double]::TryParse($_.$taskFrameKey, [ref]$taskValue) -and $taskValue -gt 0
    })
    if ($taskRows.Count -lt 30) { throw "Insufficient CSV samples: $($taskRun.csv)" }
    $taskStats = @{}
    foreach ($taskName in @('GPUTime', 'FrameTime', 'GPU/SkyLightDiffuse', 'GPU/GlobalDistanceFieldUpdate',
        'GPU/DistanceFields', 'GPU/ReflectionEnvironment', 'DistanceField/AtlasMB',
        'DistanceField/IndirectionTableMB', 'DistanceField/IndirectionAtlasMB',
        'GPUMem/LocalBudgetMB', 'GPUMem/LocalUsedMB', 'GPUMem/SystemUsedMB',
        'DrawCall/DistanceFieldShadows')) {
        $taskIndex = [array]::IndexOf($taskHeader, $taskName)
        if ($taskIndex -lt 0) { continue }
        $taskKey = $taskKeys[$taskIndex]
        $taskValues = @($taskRows | ForEach-Object {
            $taskValue = 0.0
            if ([double]::TryParse($_.$taskKey, [ref]$taskValue)) { $taskValue }
        } | Sort-Object)
        if (-not $taskValues.Count) { continue }
        $taskStats[$taskName] = @{
            count = $taskValues.Count
            mean = ($taskValues | Measure-Object -Average).Average
            median = $taskValues[[int][math]::Floor($taskValues.Count * 0.5)]
            p95 = $taskValues[[int][math]::Floor($taskValues.Count * 0.95)]
            min = $taskValues[0]
            max = $taskValues[-1]
        }
    }
    $taskResults += @{name = $taskRun.case.name; stats = $taskStats;
        csv = @{file = $taskRun.csv; sha256 = (Get-FileHash -LiteralPath $taskRun.csv).Hash.ToLowerInvariant()}}
}
@{capture = @{file = "$taskPrefix-capture.json";
        sha256 = (Get-FileHash -LiteralPath "$taskPrefix-capture.json").Hash.ToLowerInvariant()};
    runs = $taskResults} | ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath "$taskPrefix-csv.json" -Encoding utf8
Write-Output "CSV analysis complete: $($taskResults.Count) runs."
