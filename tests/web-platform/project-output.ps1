$script:ProjectOutputHelper = Join-Path $PSScriptRoot 'project-output.cjs'

function Assert-ProjectOutput {
    param([Parameter(Mandatory = $true)][string]$Path, [switch]$Tree)
    $taskMode = if ($Tree) { '--tree' } else { '--check' }
    & node $script:ProjectOutputHelper $taskMode $Path
    if ($LASTEXITCODE -ne 0) { throw "Output must remain inside this project: $Path" }
}

function Initialize-ProjectOutput {
    param([string[]]$Paths = @())
    $taskEnvironment = & node $script:ProjectOutputHelper --environment @Paths
    if ($LASTEXITCODE -ne 0) { throw 'Project output validation failed before starting the task.' }
    $taskEnvironment = $taskEnvironment | ConvertFrom-Json
    foreach ($taskVariable in $taskEnvironment.PSObject.Properties) {
        [Environment]::SetEnvironmentVariable($taskVariable.Name, $taskVariable.Value, 'Process')
    }
}
