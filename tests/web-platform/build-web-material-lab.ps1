param(
    [string]$Engine = 'H:/UE_5.8',
    [switch]$SkipBuild,
    [switch]$SkipCook
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskResults = Join-Path $PSScriptRoot 'results'
$taskProject = Join-Path $PSScriptRoot 'build/projects/material-lab/MaterialLab.uproject'
$taskTemplate = Join-Path $Engine 'Engine/Content/Maps/Templates/Template_Default.umap'
$taskTemplateHash = (Get-FileHash -LiteralPath $taskTemplate -Algorithm SHA256).Hash
function Get-TaskAudit([string]$File) {
    return @{file = [IO.Path]::GetFullPath($File);
        sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
New-Item -ItemType Directory -Path $taskResults -Force | Out-Null
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'build-web-engine.ps1') -Engine $Engine -MaxParallelActions 4
}
if (-not $SkipCook) {
    if (-not $SkipBuild) {
        & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development `
            "-Project=$taskRoot/tests/ue-shader-host/UEShaderHost.uproject" `
            -WaitMutex -NoHotReloadFromIDE -NoUBA -MaxParallelActions=1 *> "$taskResults/material-lab-native-build.log"
        if ($LASTEXITCODE -ne 0) { throw 'Material lab native build failed.' }
    }
    & node (Join-Path $PSScriptRoot 'prepare-web-project.cjs') `
        "--project=$taskRoot/tests/ue-material-lab/MaterialLab.uproject" '--id=material-lab'
    if ($LASTEXITCODE -ne 0) { throw 'Material lab project preparation failed.' }
    & (Join-Path $Engine 'Engine/Binaries/Win64/UnrealEditor-Cmd.exe') $taskProject `
        '-run=WebMaterialLab' "-Output=$taskResults/material-lab-layout.json" `
        '-nullrhi' '-unattended' '-nop4' '-nosplash' '-nosound' `
        "-abslog=$taskResults/material-lab-create.log" *> "$taskResults/material-lab-create.console.txt"
    if ($LASTEXITCODE -ne 0) { throw 'Material lab map generation failed.' }
    if ((Get-FileHash -LiteralPath $taskTemplate -Algorithm SHA256).Hash -ne $taskTemplateHash) {
        throw 'The source template must remain unchanged.'
    }
    $taskPreparation = @{
        date = Get-Date -Format o; pass = $true; sourceTemplateUnmodified = $true
        sourceFiles = @($PSCommandPath, $taskTemplate,
            "$taskRoot/tests/ue-shader-host/Source/UEShaderHost/Private/WebMaterialLabCommandlet.cpp",
            "$taskRoot/tests/ue-shader-host/Source/UEShaderHost/Public/WebMaterialLabCommandlet.h") |
            ForEach-Object { Get-TaskAudit $_ }
        generatedAssets = @(Get-ChildItem -LiteralPath (Join-Path (Split-Path -Parent $taskProject) 'Content') `
            -Recurse -File | Where-Object Extension -in @('.uasset', '.umap') |
            ForEach-Object { Get-TaskAudit $_.FullName })
        layout = Get-TaskAudit (Join-Path $taskResults 'material-lab-layout.json')
        log = Get-TaskAudit (Join-Path $taskResults 'material-lab-create.log')
    }
    $taskPreparation | ConvertTo-Json -Depth 6 |
        Set-Content -LiteralPath (Join-Path $taskResults 'web-material-lab-prepare-results.json') -Encoding utf8
    & (Join-Path $PSScriptRoot 'cook-web-engine.ps1') -Engine $Engine -Mode WebGPU-ES31 `
        -Scene Project -Project $taskProject -Map /Game/WebMaterialLab -ReportId material-lab `
        -Profile (Join-Path $PSScriptRoot 'cook-profiles/DefaultTemplateEngine.ini') `
        -TextureCompression BC -TemplateEnvironment -StopOnShaderError -SkipBuild
}
& node (Join-Path $PSScriptRoot 'stage-web-engine.cjs') '--project=material-lab'
if ($LASTEXITCODE -ne 0) { throw 'Material lab staging failed.' }
& node (Join-Path $PSScriptRoot 'package-web-material-lab.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Material lab packaging failed.' }
Write-Output 'Material lab: http://127.0.0.1:8765/build/material-lab/index.html'
