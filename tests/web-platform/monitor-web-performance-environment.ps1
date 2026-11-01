param(
    [Parameter(Mandatory=$true)][string]$Output,
    [Parameter(Mandatory=$true)][string]$StopFile
)
$ErrorActionPreference = 'Stop'
$previous = @{}
$previousTime = [DateTime]::UtcNow
while (-not (Test-Path -LiteralPath $StopFile)) {
    $now = [DateTime]::UtcNow
    $elapsed = ($now - $previousTime).TotalSeconds
    $processes = @(Get-Process -ErrorAction SilentlyContinue)
    $next = @{}
    $activity = @()
    foreach ($process in $processes) {
        if ($null -eq $process.CPU) { continue }
        $next[$process.Id] = $process.CPU
        if ($previous.ContainsKey($process.Id) -and $elapsed -gt 1) {
            $delta = [Math]::Max(0, $process.CPU - $previous[$process.Id])
            $activity += [PSCustomObject]@{name=$process.ProcessName;pid=$process.Id;cpuCores=$delta/$elapsed}
        }
    }
    $blockers = @($processes | Where-Object {
        $_.ProcessName -match '^(cod|UnrealEditor(?:-Cmd)?|ShaderCompileWorker|clang\+\+|wasm-ld|UnrealBuildTool)$'
    } | ForEach-Object { [PSCustomObject]@{name=$_.ProcessName;pid=$_.Id} })
    [PSCustomObject]@{
        utc=$now.ToString('o');sampleSeconds=$elapsed;blockers=$blockers
        topCPU=@($activity | Sort-Object cpuCores -Descending | Select-Object -First 6)
        edgeProcesses=@($processes | Where-Object ProcessName -eq 'msedge').Count
    } | ConvertTo-Json -Depth 4 -Compress | Add-Content -LiteralPath $Output -Encoding utf8
    $previous = $next
    $previousTime = $now
    Start-Sleep -Seconds 5
}
