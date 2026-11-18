'use strict';
// Reuse the exact self-contained batch supplied by the user; update its list.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const cp = require('node:child_process');
const {audit} = require('./content-file-metadata.cjs');
const templateFile = path.join(__dirname, 'cleanup-old-tests-20261104.bat');
const planFile = path.join(__dirname, 'cleanup-test-cache-20261111.json');
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const template = fs.readFileSync(templateFile, 'utf8').replace(/\r\n/g, '\n');
assert.equal(plan.targets.length, 191);
const relatives = plan.targets.map(item => {
  assert.equal(item.links, 0);
  const relative = path.relative(plan.buildRoot, item.path);
  assert(/^(?:browser-profiles\\[a-z0-9-]+|browser-profile-archives\\[a-z0-9-]+|nanite-release-20261111-launcher-failed)$/.test(relative));
  return relative;
});
assert.equal(new Set(relatives).size, relatives.length);
let text = template
  .replace("[DateTimeOffset]::Parse('2026-11-03T00:00:00+08:00')", `[DateTimeOffset]::Parse('${plan.date}')`)
  .replace('# 固定清单：77 个旧测试浏览器目录、63 个旧 villa 测试包。\n# 保留 v47、v52，以及 2026-11-03 起更新的版本、Cook 资源和测试报告。',
    '# 固定清单：191 个旧测试缓存、缓存归档和失败交付副本。\n# 保留当前包、关闭 Nanite 的测试包、11 月 7 日旧版、源码、Cook 及证据。')
  .replace(/\$taskRelativeTargets = @\([\s\S]*?\n\)/,
    '$taskRelativeTargets = @(\n' + relatives.map(relative => "    '" + relative + "'").join('\n') + '\n)')
  .replace('.Count -ne 140)', '.Count -ne 191)')
  .replaceAll("'2026-11-03 起有更新：'", "'清单生成后有更新：'")
  .replace("Write-Host '旧测试产物清理（固定清单，截止 2026-11-03 00:00，香港时间）'",
    "Write-Host '旧测试缓存清理（2026-11-11 固定清单，单文件批处理）'")
  .replace("'仅处理固定清单内、2026-11-03 00:00 +08:00 之前更新的目录。'",
    "'仅处理 2026-11-11 固定清单内、清单生成前更新的目录。'")
  .replace("'^(villa-[a-z0-9-]+|browser-profiles\\\\[a-z0-9-]+)$'",
    () => "'^(browser-profiles\\\\[a-z0-9-]+|browser-profile-archives\\\\[a-z0-9-]+|nanite-release-20261111-launcher-failed)$'");
// Check resolved parents again immediately before deletion, including after
// the user reviews the list; keep the original native PowerShell removal.
const oldGuard = "    if (-not $taskDirectory.PSIsContainer) { throw '目标不是目录' }";
const newGuard = oldGuard + `
    $taskResolved = [IO.Path]::GetFullPath($taskDirectory.FullName)
    $taskRelativeCheck = $taskResolved.Substring($taskRoot.Length).TrimStart('\\')
    if (-not $taskResolved.StartsWith($taskRoot + '\\', [StringComparison]::OrdinalIgnoreCase) -or
        $taskRelativeCheck -notin $taskRelativeTargets) { throw '路径不在固定清单内' }
    $taskAncestor = $taskDirectory
    while ($null -ne $taskAncestor) {
        if ($taskAncestor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw ('路径包含链接或目录联接：' + $taskAncestor.FullName)
        }
        $taskAncestor = $taskAncestor.Parent
    }`;
assert(text.includes(oldGuard)); text = text.replace(oldGuard, newGuard);
const deleteMarker = '        # 删除前再次检查；扫描后新写入的目录会被跳过。';
assert(text.includes(deleteMarker));
text = text.replace(deleteMarker, () => `        $taskLive = @(Get-CimInstance Win32_Process | Where-Object {
            $_.Name -match '^(msedge|chrome|firefox)(\\.exe)?$' -and $_.CommandLine -and
            $_.CommandLine.IndexOf($taskEntry.Path, [StringComparison]::OrdinalIgnoreCase) -ge 0
        })
        if ($taskLive.Count -gt 0) { throw '目录正在被测试浏览器使用，本次跳过' }
` + deleteMarker);
assert(!text.includes('2026-11-03') && !text.includes('.Count -ne 140)'));
assert(text.includes('browser-profile-archives\\memory-addressing-20261106'));
const marker = '# === POWERSHELL BODY ===';
assert.equal(text.slice(0, text.lastIndexOf(marker)), template.slice(0, template.lastIndexOf(marker)));
const output = path.join(__dirname, 'cleanup-test-cache-standalone-20261111.bat');
fs.writeFileSync(output, text.replace(/\n/g, '\r\n')); // UTF-8 without BOM; CMD header is ASCII.
// Parse the embedded body with the same Windows PowerShell used by the batch
// before publishing the file the user will run. Parsing executes no body code.
cp.execFileSync('powershell.exe', ['-NoProfile', '-Command', `
  $taskText=[IO.File]::ReadAllText($env:UE_CLEANUP_BATCH_CHECK,[Text.Encoding]::UTF8)
  $taskMarker='# === POWERSHELL BODY ==='
  $taskBody=$taskText.Substring($taskText.LastIndexOf($taskMarker)+$taskMarker.Length)
  $taskErrors=$null
  [System.Management.Automation.Language.Parser]::ParseInput($taskBody,[ref]$null,[ref]$taskErrors) | Out-Null
  if($taskErrors.Count){$taskErrors | Select-Object -First 2 -ExpandProperty Message; exit 1}
`], {env: {...process.env, UE_CLEANUP_BATCH_CHECK: output}, stdio: 'pipe'});
const userFile = 'G:/UE_HTML/清理旧测试文件.bat';
fs.copyFileSync(output, userFile);
const compatibilityLauncher = path.join(__dirname, '清理旧测试缓存-20261111.bat');
fs.copyFileSync(output, compatibilityLauncher);
const report = {pass: true, date: new Date().toISOString(), source: audit(__filename),
  template: audit(templateFile), plan: audit(planFile), output: audit(output), userFile: audit(userFile),
  compatibilityLauncher: audit(compatibilityLauncher),
  directories: relatives.length, logicalGiB: plan.logicalBytes / 2 ** 30,
  boundary: 'Preserves the user-provided single-file CMD/embedded-PowerShell launcher. Only the fixed cleanup list, '
    + 'cutoff, count and related checks are updated. No deletion is performed by this packager.'};
fs.writeFileSync(path.join(__dirname, 'results/cleanup-standalone-20261111-package.json'), JSON.stringify(report, null, 2) + '\n');
console.log({pass: true, file: userFile, directories: relatives.length, logicalGiB: report.logicalGiB});
