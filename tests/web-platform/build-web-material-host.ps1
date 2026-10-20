param()
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host'
$taskFormat = Join-Path $taskProject 'Plugins/WebGPUShader'
$taskCompiler = 'C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.50.35717/bin/Hostx64/x64'
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskReportFile = Join-Path $PSScriptRoot 'results/web-material-host-build-results.json'
$taskProcess = Get-Process -Id $PID
$taskAffinity = $taskProcess.ProcessorAffinity
$taskReport = [ordered]@{ date = Get-Date -Format o; pass = $false; actions = @(); normalUBTBuildVerified = $false }
function Get-TaskAudit([string]$File) {
    return @{ file = [IO.Path]::GetFullPath($File); sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
}
try {
    $taskProcess.ProcessorAffinity = [IntPtr]3
    $taskReport.sources = @(
        $PSCommandPath,
        "$taskFormat/Source/WebGPUShaderFormat/Private/WebGPUShaderFormat.cpp",
        "$taskFormat/Source/WebGPUShaderFormat/Public/WebGPUShaderCode.h",
        "$taskProject/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp"
    ) | ForEach-Object { Get-TaskAudit $_ }
    $taskFormatIntermediate = "$taskFormat/Intermediate/Build/Win64/x64/UnrealEditor/Development/WebGPUShaderFormat"
    $taskProjectIntermediate = "$taskProject/Intermediate/Build/Win64/x64/UnrealEditor/Development/UEShaderHost"
    $taskActions = @(
        @{ tag = 'format-compile'; tool = 'cl.exe'; response = "$taskFormatIntermediate/WebGPUShaderFormat.cpp.obj.rsp" },
        @{ tag = 'format-lib'; tool = 'link.exe'; response = "$taskFormatIntermediate/UnrealEditor-WebGPUShaderFormat.lib.rsp" },
        @{ tag = 'format-link'; tool = 'link.exe'; response = "$taskFormatIntermediate/UnrealEditor-WebGPUShaderFormat.dll.rsp" },
        @{ tag = 'probe-compile'; tool = 'cl.exe'; response = "$taskProjectIntermediate/WebShaderProbeCommandlet.cpp.obj.rsp" },
        @{ tag = 'probe-link'; tool = 'link.exe'; response = "$taskProjectIntermediate/UnrealEditor-UEShaderHost.dll.rsp" }
    )
    # Reuse the matching installed-host PCH include identity; every output stays in the workspace.
    Push-Location 'H:/UE_5.8/Engine/Source'
    try {
        foreach ($taskAction in $taskActions) {
            $taskResponseText = Get-Content -LiteralPath $taskAction.response -Raw
            $taskOutputMatches = [regex]::Matches($taskResponseText, '(?im)^/(?:OUT:|PDB:|Fo)"([^"]+)"')
            if ($taskOutputMatches.Count -eq 0) { throw "No explicit output in $($taskAction.response)" }
            foreach ($taskMatch in $taskOutputMatches) {
                $taskOutputPath = [IO.Path]::GetFullPath($taskMatch.Groups[1].Value)
                if (-not $taskOutputPath.StartsWith("$taskProject\", [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Output outside project: $taskOutputPath"
                }
            }
            $taskLog = Join-Path $PSScriptRoot "results/web-material-host-build-$taskStamp-$($taskAction.tag).log"
            $taskArguments = @("@$($taskAction.response)")
            if ($taskAction.tag -eq 'format-lib') { $taskArguments = @('/LIB') + $taskArguments }
            & (Join-Path $taskCompiler $taskAction.tool) @taskArguments *> $taskLog
            $taskExit = $LASTEXITCODE
            $taskReport.actions += @{
                tag = $taskAction.tag; tool = Get-TaskAudit (Join-Path $taskCompiler $taskAction.tool)
                response = Get-TaskAudit $taskAction.response; log = Get-TaskAudit $taskLog; exitCode = $taskExit
            }
            if ($taskExit -ne 0) { throw "Build failed: $taskLog" }
        }
    } finally { Pop-Location }
    $taskReport.products = @(
        "$taskFormatIntermediate/WebGPUShaderFormat.cpp.obj",
        "$taskFormatIntermediate/UnrealEditor-WebGPUShaderFormat.lib",
        "$taskFormat/Binaries/Win64/UnrealEditor-WebGPUShaderFormat.dll",
        "$taskProjectIntermediate/WebShaderProbeCommandlet.cpp.obj",
        "$taskProject/Binaries/Win64/UnrealEditor-UEShaderHost.dll"
    ) | ForEach-Object { Get-TaskAudit $_ }
    $taskReport.pass = $true
    $taskReport.boundary = 'Five explicit native compile/link actions using existing UBT response files and the matching installed-host PCH. No installed-engine sources or products are changed. This is not a full normal UBT build or target 5.8.3 compatibility verification.'
} catch {
    $taskReport.failure = $_.ToString()
    throw
} finally {
    $taskReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskReportFile -Encoding utf8
    $taskProcess.ProcessorAffinity = $taskAffinity
}
[pscustomobject]$taskReport | Select-Object pass, normalUBTBuildVerified, failure | ConvertTo-Json
