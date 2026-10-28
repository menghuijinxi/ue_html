param(
    [string]$Engine = 'H:/UE_5.8',
    [string]$SourceProject = 'H:/TriplexHouseVilla/TriplexHouseVilla.uproject',
    [switch]$SkipBuild,
    [switch]$SkipCook
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskResults = Join-Path $PSScriptRoot 'results'
$taskID = 'villa-material-lab'
$taskProject = Join-Path $PSScriptRoot 'build/projects/villa-material-lab/TriplexHouseVilla.uproject'
$taskLayout = Join-Path $taskResults 'villa-material-lab-layout.json'
$taskTemplate = Join-Path $Engine 'Engine/Content/Maps/Templates/Template_Default.umap'
$taskTemplateHash = (Get-FileHash -LiteralPath $taskTemplate).Hash
function Get-TaskAudit([string]$File) {
    return @{file = [IO.Path]::GetFullPath($File);
        sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
if (-not $SkipCook) {
    if (-not $SkipBuild) {
        & (Join-Path $Engine 'Engine/Build/BatchFiles/Build.bat') UEShaderHostEditor Win64 Development `
            "-Project=$taskRoot/tests/ue-shader-host/UEShaderHost.uproject" `
            -WaitMutex -NoHotReloadFromIDE -NoUBA -MaxParallelActions=4 *> "$taskResults/villa-material-lab-native-build.log"
        if ($LASTEXITCODE -ne 0) { throw 'Villa material lab native build failed.' }
    }
    & node (Join-Path $PSScriptRoot 'prepare-web-project.cjs') "--project=$SourceProject" "--id=$taskID" `
        "--input-profile=$PSScriptRoot/cook-profiles/TriplexHouseVillaInput.ini"
    if ($LASTEXITCODE -ne 0) { throw 'Villa material lab project preparation failed.' }
    $taskConfig = Join-Path $PSScriptRoot 'cook-profiles/VillaMaterialLabProjectEngine.ini'
    Copy-Item -LiteralPath $taskConfig -Destination (Join-Path (Split-Path -Parent $taskProject) 'Config/DefaultEngine.ini')
    & (Join-Path $Engine 'Engine/Binaries/Win64/UnrealEditor-Cmd.exe') $taskProject `
        '-run=WebVillaMaterialLab' "-Output=$taskLayout" '-nullrhi' '-unattended' '-nop4' '-nosplash' '-nosound' `
        "-abslog=$taskResults/villa-material-lab-create.log" *> "$taskResults/villa-material-lab-create.console.txt"
    if ($LASTEXITCODE -ne 0) { throw 'Villa material lab map generation failed.' }
    if ((Get-FileHash -LiteralPath $taskTemplate).Hash -ne $taskTemplateHash) {
        throw 'The installed default template must remain unchanged.'
    }
    $taskPreparation = Get-Content "$taskResults/web-project-$taskID-prepare-results.json" -Raw | ConvertFrom-Json
    $taskPreparation | Add-Member -NotePropertyName lab -NotePropertyValue @{
        sourceTemplateUnmodified = $true
        layout = Get-TaskAudit $taskLayout
        sourceFiles = @($PSCommandPath, $taskConfig,
            "$taskRoot/tests/ue-shader-host/Source/UEShaderHost/Private/WebVillaMaterialLabCommandlet.cpp",
            "$taskRoot/tests/ue-shader-host/Source/UEShaderHost/Public/WebVillaMaterialLabCommandlet.h") |
            ForEach-Object { Get-TaskAudit $_ }
    } -Force
    $taskPreparation | ConvertTo-Json -Depth 12 |
        Set-Content -LiteralPath "$taskResults/web-project-$taskID-prepare-results.json" -Encoding utf8
    & (Join-Path $PSScriptRoot 'cook-web-engine.ps1') -Engine $Engine -Mode WebGPU-SM5 `
        -Scene Project -Project $taskProject -Map /Game/WebVillaMaterialLab -ReportId $taskID `
        -Profile (Join-Path $PSScriptRoot 'cook-profiles/DefaultTemplateDesktopEngine.ini') `
        -TextureCompression BC -CompressHDRCubemaps -TemplateEnvironment -StopOnShaderError -SkipBuild
    if ($LASTEXITCODE -ne 0) { throw 'Villa material lab Cook failed.' }
}
& node (Join-Path $PSScriptRoot 'stage-web-engine.cjs') "--project=$taskID" '--desktop'
if ($LASTEXITCODE -ne 0) { throw 'Villa material lab staging failed.' }
& node (Join-Path $PSScriptRoot 'package-web-villa-material-lab.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Villa material lab packaging failed.' }
Write-Output 'Villa material lab: http://127.0.0.1:8765/build/villa-material-lab-threads/index.html'
