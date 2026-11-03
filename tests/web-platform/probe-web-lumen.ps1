param(
    [ValidateSet('Policy', 'Shaders', 'All')][string]$Mode = 'All',
    [string]$ShaderTypes,
    [switch]$AllPermutations
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskHost = Join-Path $taskRoot '.tools/ue58-web-cook-host/Engine'
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskOutput = Join-Path $PSScriptRoot "build/lumen-probe/$taskStamp"
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskSelf = Get-Process -Id $PID
$taskAffinity = $taskSelf.ProcessorAffinity
$taskTint = $env:WEBGPU_TINT_DIR
$taskIntermediate = $env:WEBGPU_INTERMEDIATE_DIR
$taskReport = [ordered]@{ date = Get-Date -Format o; pass = $false; mode = $Mode
    cpuAffinity = 4294901760; completeLumenScene = $false; output = $taskOutput; policies = @() }
try {
    # Isolate the previously reproduced host DXC crash; this is not a renderer setting.
    $taskSelf.ProcessorAffinity = [IntPtr]4294901760
    $env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
    $env:WEBGPU_INTERMEDIATE_DIR = Join-Path $taskOutput 'ShaderConversion'
    & node (Join-Path $PSScriptRoot 'prepare-web-lumen-probe.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Lumen project fixture preparation failed' }
    $taskProjects = Get-Content (Join-Path $PSScriptRoot 'build/lumen-project-settings/projects.json') -Raw | ConvertFrom-Json
    if ($Mode -ne 'Shaders') {
        foreach ($taskCase in $taskProjects) {
            $taskFile = Join-Path $taskOutput "$($taskCase.name)-policy.json"
            $taskArguments = @($taskCase.project, '-run=WebShaderProbe', '-LumenPolicyProbe',
                "-ExpectedLumen=$([int]$taskCase.expected)", "-Output=$taskFile", '-WebGPUCook',
                '-WebProjectSettingsCook', '-TargetPlatform=Web', '-ddpi:Web:bIsEnabled=false',
                '-nullrhi', '-sm5', '-unattended', '-nop4', '-nosplash',
                '-nosound', "-abslog=$taskFile.log")
            & (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-Cmd.exe') @taskArguments *> "$taskFile.console"
            if ($LASTEXITCODE -ne 0) { throw "Lumen policy probe failed: $taskFile" }
            $taskReport.policies += Get-Content -LiteralPath $taskFile -Raw | ConvertFrom-Json
        }
    }
    if ($Mode -ne 'Policy') {
        $taskProject = ($taskProjects | Where-Object name -eq 'gi').project
        $taskArguments = @($taskProject, '-run=WebShaderProbe', '-LumenShaderProbe',
            "-Output=$taskOutput", '-WebGPUCook', '-WebProjectSettingsCook',
            '-TargetPlatform=Web', '-ddpi:Web:bIsEnabled=false',
            '-nullrhi', '-sm5', '-unattended', '-nop4', '-nosplash', '-nosound',
            "-abslog=$taskOutput/shaders.log")
        if ($ShaderTypes) { $taskArguments += "-ShaderTypes=$ShaderTypes" }
        if ($AllPermutations) { $taskArguments += '-AllPermutations' }
        & (Join-Path $taskHost 'Binaries/Win64/UnrealEditor-Cmd.exe') @taskArguments *> "$taskOutput/shaders.console"
        $taskCode = $LASTEXITCODE
        $taskReport.shaders = Get-Content (Join-Path $taskOutput 'lumen-shader-results.json') -Raw | ConvertFrom-Json
        if ($taskCode -ne 0) { throw "Lumen shader conversion has failures: $taskOutput/lumen-shader-results.json" }
    }
    $taskReport.pass = $true
} catch {
    $taskReport.failure = $_.ToString()
    throw
} finally {
    $taskSelf.ProcessorAffinity = $taskAffinity
    $env:WEBGPU_TINT_DIR = $taskTint
    $env:WEBGPU_INTERMEDIATE_DIR = $taskIntermediate
    $taskReport | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath "$taskOutput/probe-results.json" -Encoding utf8
    Write-Output "Lumen probe: $taskOutput/probe-results.json"
}
