'use strict';
// Shared test helper. Records conditions that change the speed of every engine
// thread by several percent between otherwise identical runs: a fixed CPU
// workload timed on the page thread and in a worker, the foreground window's
// process, and the priority class of the browser processes under test.
// Call before and after a measured window, never inside it.
const {execFileSync} = require('node:child_process');
function calibrate() {
  const work = () => { const start = performance.now(); let x = 0; for (let i = 0; i < 3e7; i++) x += Math.sqrt(i ^ (x & 7)); return performance.now() - start; };
  const main = Math.min(work(), work(), work());
  return new Promise(resolve => {
    const source = `const work=${work.toString()};postMessage(Math.min(work(),work(),work()));`;
    const worker = new Worker(URL.createObjectURL(new Blob([source], {type: 'text/javascript'})));
    worker.onmessage = e => { worker.terminate(); resolve({mainMs: main, workerMs: e.data}); };
    worker.onerror = () => resolve({mainMs: main, workerMs: null});
  });
}
const script = `
Add-Type -Namespace Win32 -Name User -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint processId);'
$id = 0; [void][Win32.User]::GetWindowThreadProcessId([Win32.User]::GetForegroundWindow(), [ref]$id)
$foreground = Get-Process -Id $id -ErrorAction SilentlyContinue
$edge = @(Get-Process -Name msedge -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ id = $_.Id; priority = [string]$_.PriorityClass; cpuSeconds = [math]::Round($_.CPU, 1); threads = $_.Threads.Count } } | Sort-Object cpuSeconds -Descending | Select-Object -First 6)
[pscustomobject]@{ foregroundProcess = $foreground.ProcessName; foregroundId = $id; foregroundTitle = $foreground.MainWindowTitle; busiestEdge = $edge } | ConvertTo-Json -Depth 4 -Compress
`;
function desktop() {
  try { return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {encoding: 'utf8', timeout: 20000})); }
  catch (e) { return {error: String(e.message).slice(0, 200)}; }
}
module.exports = async function sampleTestEnvironment(page) {
  const sample = {time: new Date().toISOString(), desktop: desktop()};
  try { sample.cpu = await page.evaluate(calibrate); } catch (e) { sample.cpu = {error: String(e.message).slice(0, 200)}; }
  return sample;
};
