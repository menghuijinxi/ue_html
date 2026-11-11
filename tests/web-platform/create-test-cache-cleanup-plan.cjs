'use strict';
// Inventory only. The generated PowerShell script is run manually by the user.
const fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, 'build');
function scan(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return {bytes: 0, files: 0, links: 1, lastWrite: stat.mtimeMs};
  if (!stat.isDirectory()) return {bytes: stat.size, files: 1, links: 0, lastWrite: stat.mtimeMs};
  const sum = {bytes: 0, files: 0, links: 0, lastWrite: stat.mtimeMs};
  for (const name of fs.readdirSync(file)) {
    const item = scan(path.join(file, name));
    for (const key of ['bytes', 'files', 'links']) sum[key] += item[key];
    sum.lastWrite = Math.max(sum.lastWrite, item.lastWrite);
  }
  return sum;
}
const candidates = [];
for (const name of ['browser-profiles', 'browser-profile-archives']) {
  const parent = path.join(root, name);
  for (const entry of fs.readdirSync(parent, {withFileTypes: true})) {
    const file = path.join(parent, entry.name);
    candidates.push({path: file, reason: name === 'browser-profiles' ? '旧自动测试浏览器缓存' : '旧测试浏览器缓存归档', ...scan(file)});
  }
}
const failed = path.join(root, 'nanite-release-20261111-launcher-failed');
if (fs.existsSync(failed)) candidates.push({path: failed, reason: '已有证据归档的失败交付副本', ...scan(failed)});
const targets = candidates.filter(item => item.links === 0);
const skipped = candidates.filter(item => item.links !== 0);
const plan = {date: new Date().toISOString(), buildRoot: root, targets, skipped,
  logicalBytes: targets.reduce((sum, item) => sum + item.bytes, 0),
  boundary: 'Only named test caches and a failed duplicate release. No files are deleted by this generator. '
    + 'Link-containing candidates are excluded. Manual cleanup rechecks paths, live browser use and snapshot changes. '
    + 'Logical file bytes are not a guarantee of physical space recovered.'};
fs.writeFileSync(path.join(__dirname, 'cleanup-test-cache-20261111.json'), JSON.stringify(plan, null, 2) + '\n');
const lines = ['旧测试缓存清理清单（2026-11-11）',
  `共 ${targets.length} 个固定目录，逻辑大小 ${(plan.logicalBytes / 2 ** 30).toFixed(2)} GiB。`,
  '只列出自动测试浏览器缓存、其归档，以及失败交付副本。',
  '当前 Nanite 包、关闭 Nanite 的新包、11 月 7 日旧版、源码、Cook 和证据均保留。',
  '双击“清理旧测试缓存-20261111.bat”，核对列表后输入 DELETE。',
  '只预览可执行：清理旧测试缓存-20261111.bat -Preview',
  '脚本会跳过仍被浏览器占用、含链接或清单生成后发生变化的目录。不会关闭浏览器。',
  '我未执行删除；实际释放空间以运行后的 G 盘可用空间为准。', '',
  '逻辑大小(GiB)\t文件数\t用途\t完整路径',
  ...targets.map(item => `${(item.bytes / 2 ** 30).toFixed(3)}\t${item.files}\t${item.reason}\t${item.path}`),
  '', '因含链接而排除：', ...skipped.map(item => item.path)];
fs.writeFileSync(path.join(__dirname, '清理旧测试缓存-20261111.txt'), '\uFEFF' + lines.join('\r\n') + '\r\n');
console.log({directories: targets.length, logicalGiB: plan.logicalBytes / 2 ** 30, skippedLinks: skipped.length});
