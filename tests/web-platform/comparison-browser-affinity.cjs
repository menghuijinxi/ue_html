'use strict';
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
module.exports = function(profile, mask, apply) {
  assert(Number.isSafeInteger(mask) && mask > 0);
  const script = `
    $ErrorActionPreference = 'Stop'
    $comparisonRoots = @(Get-CimInstance Win32_Process -Filter "name='chrome.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:COMPARISON_PROFILE) -and
        $_.CommandLine -notmatch '--type=' })
    if ($comparisonRoots.Count -ne 1) { throw 'Expected one isolated comparison browser' }
    $comparisonRoot = $comparisonRoots[0].ProcessId
    $comparisonChecks = @(Get-CimInstance Win32_Process -Filter "name='chrome.exe'" |
      Where-Object { $_.ProcessId -eq $comparisonRoot -or $_.ParentProcessId -eq $comparisonRoot } |
      ForEach-Object {
        $comparisonProcess = Get-Process -Id $_.ProcessId -ErrorAction Stop
        if ($env:COMPARISON_APPLY -eq '1') {
          $comparisonProcess.ProcessorAffinity = [IntPtr][long]$env:COMPARISON_MASK
        }
        [pscustomobject]@{ pid=$comparisonProcess.Id
          type=$(if ($_.CommandLine -match '--type=([^ ]+)') {$Matches[1]} else {'browser'})
          mask=$comparisonProcess.ProcessorAffinity.ToInt64() }
      })
    ConvertTo-Json -InputObject $comparisonChecks -Compress
  `;
  const processes = JSON.parse(execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 20000,
      env: {...process.env, COMPARISON_PROFILE: profile, COMPARISON_MASK: String(mask), COMPARISON_APPLY: apply ? '1' : '0'}
    }));
  assert(processes.some(p => p.type === 'gpu-process'));
  assert(processes.every(p => p.mask === mask), 'Comparison browser affinity changed');
  return processes;
};
