'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {audit} = require('./content-file-metadata.cjs');
const folder = process.argv.find(value => value.startsWith('--folder='))?.slice(9);
assert(folder && /^[a-z0-9-]+$/.test(folder));
const root = path.resolve(__dirname, '../..'), output = path.join(__dirname, 'build', folder);
const reportFile = path.join(__dirname, 'results', folder + '-package.json');
const packaged = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
assert(packaged.pass && path.resolve(packaged.output) === output);
assert(!fs.existsSync(path.join(output, 'comparison.html')), 'Preserve existing previews');
const revision = cwd => execFileSync('git', ['rev-parse', 'HEAD'], {cwd, encoding:'utf8', windowsHide:true}).trim();
const versions = {workspace: revision(root), engine: revision(path.join(root, 'reference-engine')),
  baseline: packaged.baseline, folder, date: new Date().toISOString(),
  psoPrecache: packaged.psoPrecache === true,
  localFrameBudget: packaged.localFrameBudget ?? 0,
  localFrameBudgetMode: packaged.localFrameBudgetMode || 'submitted',
  boundary: 'Latest runtime; original audited local Cook/config reused without recooking. Lumen remains disabled.'};
const pipeline = versions.localFrameBudgetMode === 'pipeline' && versions.localFrameBudget > 0;
const link = (occlusion, clock, rhiwake, gpuahead, gpumode) => 'index.html?' + new URLSearchParams({occlusion, clock, rhiwake,
  ...(gpuahead === undefined ? {} : {gpuahead, gpumode})});
const combinations = pipeline ? [
  ['新版调度（推荐）', 'history', 'local', 'priority', versions.localFrameBudget, 'pipeline'],
  ['旧版本地调度', 'history', 'local', 'priority', 0, 'submitted'],
  ['关闭本地调度', 'history', 'owner', 'priority', 0, 'submitted'],
  ['上一轮修复方案', 'history', 'local', 'priority', 4, 'submitted'],
  ['新版调度 · 放宽预算', 'history', 'local', 'priority', 4, 'pipeline'],
] : [
  ['A · 全部关闭', 'control', 'owner', 'channel'],
  ['B · 只开遮挡历史', 'history', 'owner', 'channel'],
  ['C · 只开本地调度', 'control', 'local', 'channel'],
  ['D · 遮挡与本地调度均开', 'history', 'local', 'channel'],
  ['E · 只开 RHI 优先级唤醒', 'control', 'owner', 'priority'],
];
const introduction = pipeline ? '新版调度限制尚未完成的帧，避免连续生产帧造成画面积压。先比较新版、旧版和关闭本地调度三个入口。' :
  '先用下面两个入口比较。两者均开启遮挡历史与 RHI 优先级唤醒，只切换 Game 本地调度。';
const navigation = pipeline ? `<a href="index.html">新版调度（推荐）</a>
<a href="${link('history','local','priority',0,'submitted')}">旧版本地调度</a>
<a href="${link('history','owner','priority',0,'submitted')}">关闭本地调度</a>` :
  `<a href="${link('history','owner','priority')}">关闭本地调度</a>
<a href="${link('history','local','priority')}">开启本地调度</a>`;
fs.writeFileSync(path.join(output, 'comparison.html'), `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>最新版本 · 调度对照</title><style>
body{font:16px/1.7 system-ui,sans-serif;background:#121820;color:#e7eef5;margin:0;padding:40px 24px}
main{max-width:850px;margin:auto}h1{font-size:30px;margin:0 0 12px}h2{font-size:21px;margin-top:32px}
p{color:#bdcad7}a{color:#92caff}nav{display:flex;gap:16px;flex-wrap:wrap;margin:24px 0}
nav a{padding:16px 24px;background:#243b54;border:1px solid #46698c;border-radius:10px;text-decoration:none}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:12px 8px;border-bottom:1px solid #334254}
small{color:#94a6b8}code{word-break:break-all}</style><main>
<h1>最新版本 · 本地调度对照</h1>
<p>${introduction}</p>
<nav>${navigation}</nav>
${versions.psoPrecache ? '<p>已开启 PSO 预缓存。请等待加载完成，再持续移动并转动视角，观察画面流畅度。</p>' : ''}
<p>每次只运行一个页面，启动并预热后，保持相同窗口、视角和移动路线，比较平均帧率与 1% Low。测试下一组前关闭上一组。</p>
<h2>进一步定位</h2><table><thead><tr><th>入口</th><th>遮挡历史</th><th>本地调度</th><th>RHI 优先级</th></tr></thead><tbody>
${combinations.map(([name,occlusion,clock,rhiwake,ahead,mode]) => `<tr><td><a href="${link(occlusion,clock,rhiwake,ahead,mode)}">${name}</a></td><td>${occlusion==='history'?'开':'关'}</td><td>${clock==='local'?'开':'关'}</td><td>${rhiwake==='priority'?'开':'关'}</td></tr>`).join('\n')}
</tbody></table><p>本包使用本机既有别墅资源，Lumen 关闭；所有入口使用同一运行时和资源。<a href="index.html">无参数默认入口</a></p>
<small>外围版本 ${versions.workspace.slice(0,8)} · 引擎版本 ${versions.engine.slice(0,9)} · ${folder}</small></main></html>`);
fs.writeFileSync(path.join(output, 'serve.py'), `import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import webbrowser

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.wasm': 'application/wasm', '.js': 'text/javascript'}
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, default=8875)
parser.add_argument('--no-browser', action='store_true')
args = parser.parse_args()
server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(Handler, directory=str(Path(__file__).resolve().parent)))
url = f'http://127.0.0.1:{args.port}/comparison.html'
print(url, flush=True)
if not args.no_browser:
    webbrowser.open(url)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
`);
fs.writeFileSync(path.join(output, 'start.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nwhere py >nul 2>nul\r\nif errorlevel 1 (\r\n  python serve.py\r\n) else (\r\n  py -3 serve.py\r\n)\r\nif errorlevel 1 pause\r\n');
fs.writeFileSync(path.join(output, 'README.txt'), `最新调度对照包\n\n解压后运行 start.cmd，需要 Python 3。\n也可执行 python serve.py，浏览器打开 http://127.0.0.1:8875/comparison.html。\n使用支持 WebGPU / memory64 的桌面 Edge 或 Chrome。关闭服务窗口即可停止。\n\n${introduction}\n每次只运行一个页面，等待加载完成后持续移动和转向。\nPSO 预缓存：${versions.psoPrecache ? '开启' : '关闭'}。\n${pipeline ? `默认完整流水线预算 ${versions.localFrameBudget} 帧。\n` : ''}本包复用本机已有 Lumen 关闭版别墅资源；没有重新 Cook。\n\n外围版本：${versions.workspace}\n引擎版本：${versions.engine}\n资源基线：${versions.baseline}\n`);
fs.writeFileSync(path.join(output, 'package-info.json'), JSON.stringify(versions, null, 2) + '\n');
const report = {pass:true, ...versions, packageReport:audit(reportFile), source:audit(__filename),
  products:['comparison.html','serve.py','start.cmd','README.txt','package-info.json'].map(name=>audit(path.join(output,name)))};
fs.writeFileSync(path.join(__dirname, 'results', folder + '-preview.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass:true, output, entry:'comparison.html'}));
