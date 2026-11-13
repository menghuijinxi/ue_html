@echo off
setlocal
set "UE_HTML_TEST_CLEANUP_SELF=%~f0"
set "UE_HTML_TEST_CLEANUP_MODE=%~1"
powershell.exe -NoLogo -NoProfile -Command "$ErrorActionPreference='Stop'; $taskText=[IO.File]::ReadAllText($env:UE_HTML_TEST_CLEANUP_SELF,[Text.Encoding]::UTF8); $taskMarker='# === POWERSHELL BODY ==='; $taskOffset=$taskText.LastIndexOf($taskMarker); if($taskOffset -lt 0){throw 'Missing cleanup script body'}; & ([ScriptBlock]::Create($taskText.Substring($taskOffset+$taskMarker.Length)))"
set "UE_HTML_TEST_CLEANUP_EXIT=%errorlevel%"
if /I not "%~1"=="--preview" if /I not "%~1"=="--execute" pause
exit /b %UE_HTML_TEST_CLEANUP_EXIT%

# === POWERSHELL BODY ===
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
trap { Write-Host ('清理停止：' + $_.Exception.Message) -ForegroundColor Red; exit 1 }
$taskMode = $env:UE_HTML_TEST_CLEANUP_MODE
if ($taskMode -and $taskMode -notin @('--preview','--execute')) { throw '支持 --preview 预览，--execute 执行；双击可交互执行。' }
$taskRoot = 'G:\UE_HTML\ue_html\tests\web-platform'
$taskProfileParent = Join-Path $taskRoot 'results\browser-profiles'
$taskFailedNames = @('nanite-pack-programmable-20261112','nanite-pack-programmable-content-20261112','nanite-pack-material-20261112','nanite-pack-material-content-20261112','nanite-pack-fixture-20261112','nanite-pack-fixture-content-20261112')
$taskTargets = @(
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\gpu-nanite-batch-off-spawn-20261112'; Bytes=3683435440L; Files=1168L; LastWrite=1794459466513L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\gpu-nanite-batch-on-spawn-20261112'; Bytes=3683312389L; Files=1167L; LastWrite=1794459524692L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\gpu-nanite-occlusion-controlled-off-20261112'; Bytes=3683585231L; Files=1173L; LastWrite=1794463441333L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\gpu-nanite-occlusion-controlled-on-20261112'; Bytes=3683705937L; Files=1174L; LastWrite=1794463499709L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\gpu-nanite-occlusion-off-spawn-20261112'; Bytes=3683560822L; Files=1171L; LastWrite=1794462667593L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\gpu-nanite-occlusion-on-spawn-20261112'; Bytes=3683437046L; Files=1169L; LastWrite=1794462714407L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\gpu-nanite-pack-controlled-off-20261112'; Bytes=3678327335L; Files=1171L; LastWrite=1794470055525L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\gpu-nanite-pack-controlled-on-20261112'; Bytes=3678327308L; Files=1171L; LastWrite=1794470107569L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-batch-cpu-off-20261112'; Bytes=3687530383L; Files=1169L; LastWrite=1794459692334L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-batch-cpu-on-20261112'; Bytes=3687529903L; Files=1168L; LastWrite=1794459825692L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-batch-default-correctness-20261112'; Bytes=517541183L; Files=975L; LastWrite=1794459104127L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-batch-default-correctness-fixed-20261112'; Bytes=517139620L; Files=978L; LastWrite=1794459225773L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-batch-default-scalar-20261112'; Bytes=517034860L; Files=977L; LastWrite=1794460710210L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-batch-late-stall-diagnostic-20261112-0'; Bytes=3687654842L; Files=1171L; LastWrite=1794460506416L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-batch-motion-abba-20261112-0'; Bytes=3687654440L; Files=1171L; LastWrite=1794459965169L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-batch-motion-abba-20261112-1'; Bytes=3687654462L; Files=1171L; LastWrite=1794460087663L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-batch-motion-abba-20261112-2'; Bytes=3687653854L; Files=1170L; LastWrite=1794460208345L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-batch-motion-abba-20261112-3'; Bytes=3687777619L; Files=1172L; LastWrite=1794460330966L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-batch-villa-correctness-20261112'; Bytes=3681635249L; Files=1169L; LastWrite=1794459372954L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-default-off-20261112'; Bytes=517161533L; Files=980L; LastWrite=1794467399177L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-default-on-20261112'; Bytes=517161076L; Files=979L; LastWrite=1794467449872L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-default-scalar-off-20261112'; Bytes=517303851L; Files=981L; LastWrite=1794467500781L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-default-scalar-on-20261112'; Bytes=517181094L; Files=981L; LastWrite=1794467550025L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-eligibility-20261112'; Bytes=3682409338L; Files=1170L; LastWrite=1794468041565L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-motion-abba-20261112-0'; Bytes=3687134873L; Files=1172L; LastWrite=1794466946349L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-motion-abba-20261112-1'; Bytes=3687136095L; Files=1172L; LastWrite=1794467064763L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-motion-abba-20261112-2'; Bytes=3687135391L; Files=1173L; LastWrite=1794467196152L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-motion-abba-20261112-3'; Bytes=3687135510L; Files=1173L; LastWrite=1794467323917L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-motion-baab-20261112-0'; Bytes=3687135463L; Files=1173L; LastWrite=1794468157032L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-motion-baab-20261112-1'; Bytes=3687135611L; Files=1173L; LastWrite=1794468278997L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-motion-baab-20261112-2'; Bytes=3687135331L; Files=1173L; LastWrite=1794468393577L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-motion-baab-20261112-3'; Bytes=3687134870L; Files=1172L; LastWrite=1794468508017L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-off-diagnostic-20261112-0'; Bytes=3687135347L; Files=1172L; LastWrite=1794466794054L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-on-diagnostic-20261112-0'; Bytes=3687135911L; Files=1173L; LastWrite=1794466624875L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-recovery-20261112-packed'; Bytes=517093249L; Files=977L; LastWrite=1794467888748L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-recovery-20261112-scalar'; Bytes=517118123L; Files=978L; LastWrite=1794467947235L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-villa-off-20261112'; Bytes=3681781094L; Files=1172L; LastWrite=1794467661420L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-material-precache-villa-on-20261112'; Bytes=3681780927L; Files=1172L; LastWrite=1794467778776L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-occlusion-default-correctness-20261112'; Bytes=517141562L; Files=980L; LastWrite=1794462138799L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-occlusion-default-scalar-20261112'; Bytes=517160102L; Files=981L; LastWrite=1794462341218L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-occlusion-eligibility-20261112'; Bytes=3682243221L; Files=1167L; LastWrite=1794462567380L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-occlusion-motion-abba-20261112-0'; Bytes=3687779858L; Files=1174L; LastWrite=1794462990557L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-occlusion-motion-abba-20261112-1'; Bytes=3687779576L; Files=1174L; LastWrite=1794463110748L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-occlusion-motion-abba-20261112-2'; Bytes=3687778778L; Files=1173L; LastWrite=1794463229486L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-occlusion-motion-abba-20261112-3'; Bytes=3687779561L; Files=1174L; LastWrite=1794463349734L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-occlusion-off-spawn-20261112'; Bytes=3683461176L; Files=1171L; LastWrite=1794462794519L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-occlusion-on-spawn-20261112'; Bytes=3683461014L; Files=1171L; LastWrite=1794462872363L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-occlusion-recovery-20261112-packed'; Bytes=517077622L; Files=977L; LastWrite=1794462401003L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-occlusion-recovery-20261112-scalar'; Bytes=517097020L; Files=978L; LastWrite=1794462462023L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-occlusion-stall-diagnostic-20261112-0'; Bytes=3687780088L; Files=1174L; LastWrite=1794463661038L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-occlusion-villa-correctness-20261112'; Bytes=3681760306L; Files=1171L; LastWrite=1794462272621L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-on-off-gap-20261112-0'; Bytes=13071529L; Files=185L; LastWrite=1794492325421L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-on-off-gap-retry-20261112-0'; Bytes=3685496354L; Files=1131L; LastWrite=1794492474382L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-on-off-gap-retry-20261112-1'; Bytes=3687018525L; Files=1174L; LastWrite=1794492605724L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-on-off-gap-retry-20261112-2'; Bytes=3686894914L; Files=1173L; LastWrite=1794492722206L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-on-off-gap-retry-20261112-3'; Bytes=3685373384L; Files=1130L; LastWrite=1794492831115L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-default-correctness-20261112'; Bytes=517183076L; Files=979L; LastWrite=1794469820186L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-default-scalar-20261112'; Bytes=517202983L; Files=981L; LastWrite=1794469872197L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-eligibility-20261112'; Bytes=3682431069L; Files=1171L; LastWrite=1794471141573L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-motion-abba-20261112-0'; Bytes=3687945235L; Files=1175L; LastWrite=1794470499038L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-motion-abba-20261112-1'; Bytes=3687821486L; Files=1173L; LastWrite=1794470612668L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-motion-abba-20261112-2'; Bytes=3687822648L; Files=1174L; LastWrite=1794470731858L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-motion-abba-20261112-3'; Bytes=3687821183L; Files=1174L; LastWrite=1794470850266L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-motion-diagnostic-20261112-0'; Bytes=3687823229L; Files=1174L; LastWrite=1794471297742L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-off-spawn-20261112'; Bytes=3683648007L; Files=1173L; LastWrite=1794470303656L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-on-spawn-20261112'; Bytes=3683648306L; Files=1174L; LastWrite=1794470383891L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-programmable-20261112-packed'; Bytes=3794044029L; Files=233L; LastWrite=1794471451606L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-programmable-final-20261112-packed'; Bytes=3956557865L; Files=235L; LastWrite=1794471698423L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-programmable-retry-20261112-packed'; Bytes=3793831363L; Files=234L; LastWrite=1794471563816L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-programmable-verified-20261112-packed'; Bytes=4081209608L; Files=1170L; LastWrite=1794471968138L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-programmable-verified-20261112-scalar'; Bytes=4081586388L; Files=1181L; LastWrite=1794472105926L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-recovery-20261112-packed'; Bytes=517119770L; Files=976L; LastWrite=1794470989810L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-recovery-20261112-scalar'; Bytes=517139425L; Files=978L; LastWrite=1794471049765L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-villa-correctness-20261112'; Bytes=3681802014L; Files=1172L; LastWrite=1794469971903L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-wpo-20261112-packed'; Bytes=4081642952L; Files=1167L; LastWrite=1794472231307L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\results\browser-profiles\nanite-pack-wpo-20261112-scalar'; Bytes=4081731282L; Files=1176L; LastWrite=1794472350941L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\build\nanite-pack-programmable-20261112'; Bytes=3780123040L; Files=13L; LastWrite=1794471420602L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\build\nanite-pack-programmable-content-20261112'; Bytes=3604798214L; Files=5L; LastWrite=1794471353725L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\build\nanite-pack-material-20261112'; Bytes=3779909830L; Files=13L; LastWrite=1794471540701L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\build\nanite-pack-material-content-20261112'; Bytes=3604588831L; Files=5L; LastWrite=1794471533296L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\build\nanite-pack-fixture-20261112'; Bytes=3942512565L; Files=13L; LastWrite=1794471681900L }
    [pscustomobject]@{ Path='G:\UE_HTML\ue_html\tests\web-platform\build\nanite-pack-fixture-content-20261112'; Bytes=3767192116L; Files=5L; LastWrite=1794471674567L }
)
if ($taskTargets.Count -ne 82 -or @($taskTargets.Path | Select-Object -Unique).Count -ne 82) { throw '固定清单数量有误。' }
function Get-TaskState([string]$taskPath) {
    $taskResolved = [IO.Path]::GetFullPath($taskPath).TrimEnd('\')
    $taskParent = [IO.Path]::GetDirectoryName($taskResolved)
    $taskName = [IO.Path]::GetFileName($taskResolved)
    if (-not $taskResolved.StartsWith($taskRoot + '\',[StringComparison]::OrdinalIgnoreCase) -or
        ($taskParent -ne $taskProfileParent -and -not ($taskParent -eq (Join-Path $taskRoot 'build') -and $taskName -in $taskFailedNames))) { throw ('拒绝清单外路径：' + $taskResolved) }
    if ($taskResolved -notin $taskTargets.Path) { throw '目标不在固定清单中。' }
    $taskItem = Get-Item -LiteralPath $taskResolved -Force
    if (-not $taskItem.PSIsContainer) { throw '目标不是目录。' }
    $taskAncestor = $taskItem
    while ($null -ne $taskAncestor) {
        if ($taskAncestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('路径包含链接：' + $taskAncestor.FullName) }
        $taskAncestor = $taskAncestor.Parent
    }
    $taskStack = [Collections.Generic.Stack[IO.FileSystemInfo]]::new()
    $taskStack.Push($taskItem)
    [long]$taskBytes=0; [long]$taskFiles=0; [long]$taskLatest=0
    while ($taskStack.Count) {
        $taskCurrent=$taskStack.Pop(); $taskCurrent.Refresh()
        if ($taskCurrent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('包含链接：' + $taskCurrent.FullName) }
        $taskStamp=([DateTimeOffset]$taskCurrent.LastWriteTimeUtc).ToUnixTimeMilliseconds()
        $taskLatest=[math]::Max($taskLatest,$taskStamp)
        if ($taskCurrent -is [IO.DirectoryInfo]) { foreach ($taskChild in $taskCurrent.EnumerateFileSystemInfos()) { $taskStack.Push($taskChild) } }
        else { $taskBytes += $taskCurrent.Length; $taskFiles++ }
    }
    [pscustomobject]@{Bytes=$taskBytes;Files=$taskFiles;LastWrite=$taskLatest}
}
function Assert-TaskInactive([string]$taskPath) {
    $taskActive=@(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match '^(msedge|chrome|firefox)(\.exe)?$' -and $_.CommandLine -and
        $_.CommandLine.Replace('/','\').IndexOf($taskPath,[StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    if ($taskActive.Count) { throw '目录被浏览器使用，本次跳过。' }
}
Write-Host '旧自动测试缓存清理（2026-11-13，固定 82 项）'
Write-Host '保留源码、原始场景、最新测试包、Cook、测试报告与证据。'
$taskReady=[Collections.Generic.List[object]]::new(); $taskSkipped=[Collections.Generic.List[string]]::new()
foreach ($taskEntry in $taskTargets) {
    if (-not (Test-Path -LiteralPath $taskEntry.Path)) { $taskSkipped.Add('不存在，跳过：'+$taskEntry.Path); continue }
    try {
        $taskState=Get-TaskState $taskEntry.Path
        if ($taskState.Bytes -ne $taskEntry.Bytes -or $taskState.Files -ne $taskEntry.Files -or $taskState.LastWrite -gt $taskEntry.LastWrite) { throw '清单生成后内容有变化。' }
        Assert-TaskInactive $taskEntry.Path
        $taskReady.Add($taskEntry)
    } catch { $taskSkipped.Add('跳过：'+$taskEntry.Path+'；'+$_.Exception.Message) }
}
foreach ($taskEntry in $taskReady) { Write-Host ('{0,8:N3} GiB  {1}' -f ($taskEntry.Bytes/1GB),$taskEntry.Path) }
foreach ($taskMessage in $taskSkipped) { Write-Host $taskMessage -ForegroundColor Yellow }
[long]$taskTotalBytes=0
foreach ($taskEntry in $taskReady) { $taskTotalBytes += $taskEntry.Bytes }
Write-Host ('可清理 {0} 项，逻辑大小 {1:N2} GiB（硬链接可能重复计数）。' -f $taskReady.Count,($taskTotalBytes/1GB))
if ($taskMode -eq '--preview') { Write-Host '仅预览，没有删除文件。'; exit 0 }
if (-not $taskReady.Count) { Write-Host '没有可清理的目录。'; exit 0 }
if ($taskMode -ne '--execute' -and (Read-Host '输入 DELETE 执行，其他输入取消') -cne 'DELETE') { Write-Host '已取消。'; exit 0 }
$taskLog=Join-Path ([IO.Path]::GetDirectoryName($env:UE_HTML_TEST_CLEANUP_SELF)) ('cleanup-old-tests-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff')+'.json')
[long]$taskFreeBefore=([IO.DriveInfo]::new('G:\')).AvailableFreeSpace
$taskDeleted=[Collections.Generic.List[object]]::new(); $taskFailed=[Collections.Generic.List[string]]::new()
foreach ($taskEntry in $taskReady) {
    try {
        Assert-TaskInactive $taskEntry.Path
        $taskState=Get-TaskState $taskEntry.Path
        if ($taskState.Bytes -ne $taskEntry.Bytes -or $taskState.Files -ne $taskEntry.Files -or $taskState.LastWrite -gt $taskEntry.LastWrite) { throw '执行前内容有变化。' }
        Remove-Item -LiteralPath $taskEntry.Path -Recurse -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $taskEntry.Path) { throw '删除后目录仍存在。' }
        $taskDeleted.Add($taskEntry)
        Write-Host ('已删除 [{0}/{1}] {2}' -f $taskDeleted.Count,$taskReady.Count,$taskEntry.Path)
    } catch { $taskMessage=$taskEntry.Path+'；'+$_.Exception.Message; $taskFailed.Add($taskMessage); Write-Host ('未完整删除：'+$taskMessage) -ForegroundColor Yellow }
}
[long]$taskFreeAfter=([IO.DriveInfo]::new('G:\')).AvailableFreeSpace
[pscustomobject]@{Date=[DateTimeOffset]::Now.ToString('o');Deleted=@($taskDeleted);Failed=@($taskFailed);Skipped=@($taskSkipped);FreeBefore=$taskFreeBefore;FreeAfter=$taskFreeAfter} |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $taskLog -Encoding UTF8
Write-Host ('完成：删除 {0} 项，失败 {1} 项；G 盘 {2:N2}→{3:N2} GiB，实际增加 {4:N2} GiB。' -f $taskDeleted.Count,$taskFailed.Count,($taskFreeBefore/1GB),($taskFreeAfter/1GB),(($taskFreeAfter-$taskFreeBefore)/1GB))
Write-Host ('日志：'+$taskLog)
if ($taskFailed.Count) { exit 1 }
exit 0
