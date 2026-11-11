param(
    [string]$Project = 'H:/ue_html/tests/web-platform/build/projects/triplex-virtual/TriplexHouseVilla.uproject',
    [string]$ShaderTypes,
    [ValidateRange(-1, 2147483647)][int]$Permutation = -1,
    [switch]$AllPermutations,
    [switch]$VSMAdaptiveProbe
)
$ErrorActionPreference = 'Stop'
if ($VSMAdaptiveProbe -and $ShaderTypes -ne 'FVirtualShadowMapProjectionCS') {
    throw 'VSMAdaptiveProbe is restricted to the projection shader.'
}
if ($Permutation -ge 0 -and (-not $ShaderTypes -or $AllPermutations)) {
    throw 'Permutation requires explicit ShaderTypes and cannot be combined with AllPermutations.'
}
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskHost = Join-Path $taskRoot '.tools/ue58-web-cook-host/Engine'
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskOutput = Join-Path $PSScriptRoot "build/virtual-resource-probe/$taskStamp"
$taskProject = (Resolve-Path -LiteralPath $Project).Path
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskPreviousTint = $env:WEBGPU_TINT_DIR
$taskPreviousIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
$taskReport = [ordered]@{
    date = Get-Date -Format o
    pass = $false
    project = $taskProject
    completeVirtualResourceScene = $false
    adaptiveProbe = [bool]$VSMAdaptiveProbe
    output = $taskOutput
}
try {
    $env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
    $env:WEBGPU_INTERMEDIATE_DIR = Join-Path $taskOutput 'ShaderConversion'
    $taskArguments = @($taskProject, '-run=WebShaderProbe', '-VirtualResourceShaderProbe',
        "-Output=$taskOutput", '-WebGPUCook', '-WebProjectSettingsCook',
        '-TargetPlatform=Web', '-ddpi:Web:bIsEnabled=false',
        '-nullrhi', '-sm5', '-unattended', '-nop4', '-nosplash', '-nosound',
        "-abslog=$taskOutput/shaders.log")
    if ($ShaderTypes) { $taskArguments += "-ShaderTypes=$ShaderTypes" }
    if ($Permutation -ge 0) { $taskArguments += "-Permutation=$Permutation" }
    if ($AllPermutations) { $taskArguments += '-AllPermutations' }
    if ($VSMAdaptiveProbe) { $taskArguments += '-WebVSMAdaptiveProbe' }
    $taskChild = Start-Process -FilePath (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-Cmd.exe') `
        -ArgumentList ($taskArguments | ForEach-Object { '"' + $_ + '"' }) -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput "$taskOutput/shaders.console" -RedirectStandardError "$taskOutput/shaders.stderr"
    $null = $taskChild.Handle
    while (-not $taskChild.WaitForExit(250)) {
        try { $taskChild.ProcessorAffinity = [IntPtr]4294901760 }
        catch { if (-not $taskChild.HasExited) { throw } }
    }
    $taskChild.WaitForExit()
    $taskReport.exitCode = $taskChild.ExitCode
    $taskResults = Join-Path $taskOutput 'virtual-resource-shader-results.json'
    if (Test-Path -LiteralPath $taskResults) {
        $taskReport.shaders = Get-Content -LiteralPath $taskResults -Raw | ConvertFrom-Json
    }
    if ($taskChild.ExitCode -ne 0 -or -not $taskReport.shaders.pass) {
        throw "Virtual resource shader conversion failed: $taskOutput"
    }
    $taskReport.pass = $true
} catch {
    $taskReport.failure = $_.ToString()
    throw
} finally {
    $env:WEBGPU_TINT_DIR = $taskPreviousTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskPreviousIntermediate
    $taskReport | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath "$taskOutput/probe-results.json" -Encoding utf8
    Write-Output "Virtual resource probe: $taskOutput/probe-results.json"
}
