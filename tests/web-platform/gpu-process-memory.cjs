const {execFileSync} = require('node:child_process');
module.exports = function processGPUMemory({profile, pid}) {
  const command = '$ProgressPreference="SilentlyContinue"; $taskProcesses=Get-CimInstance Win32_Process; ' +
    (pid ? `$taskIds=@(${Number(pid)}); ` :
      '$taskIds=@($taskProcesses | Where-Object {$_.CommandLine -like ' +
      `'${('*' + profile + '*').replaceAll("'", "''")}' -or $_.CommandLine -like ` +
      `'${('*' + profile.replaceAll('\\', '/') + '*').replaceAll("'", "''")}' }).ProcessId; `) +
    'for($i=0;$i -lt 5;$i++){$taskIds+=@($taskProcesses | Where-Object {$taskIds -contains $_.ParentProcessId}).ProcessId}; ' +
    'Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | ForEach-Object {' +
    '$taskId=[int]([regex]::Match($_.Name,"^pid_(\\d+)_").Groups[1].Value); ' +
    'if($taskIds -contains $taskId){[pscustomobject]@{pid=$taskId;name=$_.Name;dedicated=[double]$_.DedicatedUsage;' +
    'shared=[double]$_.SharedUsage;committed=[double]$_.TotalCommitted}}} | ConvertTo-Json -Compress';
  const result = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64')], {encoding: 'utf8', windowsHide: true}).trim();
  const rows = result ? [JSON.parse(result)].flat() : [];
  return {rows, dedicated: rows.reduce((sum, row) => sum + row.dedicated, 0),
    shared: rows.reduce((sum, row) => sum + row.shared, 0),
    committed: rows.reduce((sum, row) => sum + row.committed, 0)};
};
