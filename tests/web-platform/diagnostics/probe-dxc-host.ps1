param(
    [string]$CompilerPath = '.tools/dxc-google-fog-diagnostic/dxcompiler.dll',
    [string]$InputDirectory = 'tests/web-platform/results/dawn-dxc-inputs',
    [ValidateRange(1, 10000)][int]$Rounds = 30,
    [ValidateRange(1, 3600)][int]$TimeoutSeconds = 180,
    [int]$FileIndex = -1,
    [switch]$NewCompiler,
    [UInt64]$AffinityMask = 0,
    [ValidatePattern('^[a-z0-9-]+$')][string]$Name = 'default'
)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$taskCompiler = (Resolve-Path $(if ([IO.Path]::IsPathRooted($CompilerPath)) {
    $CompilerPath
} else { Join-Path $taskRoot $CompilerPath })).Path
$taskInput = (Resolve-Path $(if ([IO.Path]::IsPathRooted($InputDirectory)) {
    $InputDirectory
} else { Join-Path $taskRoot $InputDirectory })).Path
$taskSource = Join-Path $PSScriptRoot 'dxc-batch.cpp'
$taskOutput = Join-Path $taskRoot 'tests/web-platform/results'
$taskExecutable = Join-Path $taskOutput "dxc-batch-$Name.exe"
$taskReportFile = Join-Path $taskOutput "web-default-dxc-host-$Name-results.json"
$taskLog = Join-Path $taskOutput "web-default-dxc-host-$Name.log"
$taskErrors = Join-Path $taskOutput "web-default-dxc-host-$Name-errors.log"
function Get-Audit([string]$File) {
    @{file = $File; sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}

# This is an opt-in diagnostic for a child process, not a browser or machine setting.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class WebCompilerHostCpuSets {
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetSystemCpuSetInformation(IntPtr buffer, uint length,
        out uint returnedLength, IntPtr process, uint flags);
    public static object[] Read() {
        uint length;
        GetSystemCpuSetInformation(IntPtr.Zero, 0, out length, IntPtr.Zero, 0);
        IntPtr buffer = Marshal.AllocHGlobal((int)length);
        try {
            if (!GetSystemCpuSetInformation(buffer, length, out length, IntPtr.Zero, 0))
                throw new System.ComponentModel.Win32Exception();
            var sets = new List<object>();
            for (int offset = 0; offset < length;) {
                IntPtr item = IntPtr.Add(buffer, offset);
                int size = Marshal.ReadInt32(item);
                if (size < 20 || offset + size > length) throw new Exception("Invalid CPU set size");
                if (Marshal.ReadInt32(item, 4) == 0) sets.Add(new {
                    id = Marshal.ReadInt32(item, 8), group = Marshal.ReadInt16(item, 12),
                    logicalIndex = Marshal.ReadByte(item, 14), coreIndex = Marshal.ReadByte(item, 15),
                    efficiencyClass = Marshal.ReadByte(item, 18)
                });
                offset += size;
            }
            return sets.ToArray();
        } finally { Marshal.FreeHGlobal(buffer); }
    }
}
'@

$taskVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$taskVs = & $taskVswhere -latest -products '*' -property installationPath
if (!$taskVs) { throw 'Visual Studio C++ tools are required' }
$taskVcvars = Join-Path $taskVs 'VC/Auxiliary/Build/vcvars64.bat'
$taskInclude = Join-Path $taskRoot '.tools/dxc-v1.9.2609/inc'
$taskObject = Join-Path $taskOutput "dxc-batch-$Name.obj"
# Match the UE host toolchain. No installed engine or browser DLL is replaced.
$taskCompile = "`"$taskVcvars`" -vcvars_ver=14.34 >nul && cl.exe /nologo /EHsc /std:c++17 /Od /I `"$taskInclude`" `"$taskSource`" /Fo:`"$taskObject`" /Fe:`"$taskExecutable`" /link ole32.lib"
& $env:ComSpec /d /c $taskCompile
if ($LASTEXITCODE -ne 0) { throw "Diagnostic harness compilation failed: $LASTEXITCODE" }

$taskArguments = @("`"$taskCompiler`"", "`"$taskInput`"", "$Rounds", "$FileIndex",
    $(if ($NewCompiler) { 'new' } else { 'reuse' }), "$AffinityMask")
$taskTimer = [System.Diagnostics.Stopwatch]::StartNew()
$taskProcess = Start-Process -FilePath $taskExecutable -ArgumentList $taskArguments `
    -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $taskLog -RedirectStandardError $taskErrors
$taskMaxThreads = 0
$taskTimedOut = $false
while (!$taskProcess.WaitForExit(25)) {
    if ($taskTimer.Elapsed.TotalSeconds -gt $TimeoutSeconds) {
        $taskTimedOut = $true
        $taskProcess.Kill()
        break
    }
    $taskProcess.Refresh()
    $taskMaxThreads = [Math]::Max($taskMaxThreads, $taskProcess.Threads.Count)
}
$taskProcess.WaitForExit()
$taskTimer.Stop()
$taskInputs = @(Get-ChildItem -LiteralPath $taskInput -Filter '*.hlsl' |
    Where-Object { $FileIndex -lt 0 -or [int]($_.BaseName.Split('-')[0]) -eq $FileIndex } |
    ForEach-Object { Get-Audit $_.FullName })
$taskCpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$taskBios = Get-CimInstance Win32_BIOS
$taskReport = [ordered]@{
    date = (Get-Date).ToUniversalTime().ToString('o')
    pass = !$taskTimedOut -and $taskProcess.ExitCode -eq 0
    exitCode = $taskProcess.ExitCode
    timedOut = $taskTimedOut
    timeoutSeconds = $TimeoutSeconds
    elapsedSeconds = $taskTimer.Elapsed.TotalSeconds
    rounds = $Rounds
    requestedCompilations = $Rounds * $taskInputs.Count
    newCompiler = $NewCompiler.IsPresent
    requestedAffinityMask = "0x{0:x}" -f $AffinityMask
    selectedCpus = @([WebCompilerHostCpuSets]::Read() | Where-Object {
        $AffinityMask -eq 0 -or ($AffinityMask -band ([UInt64]1 -shl $_.logicalIndex)) -ne 0
    })
    maxObservedThreadCount = $taskMaxThreads
    processor = $taskCpu.Name
    bios = @{version = $taskBios.SMBIOSBIOSVersion; date = $taskBios.ReleaseDate.ToString('o')}
    cpuSets = [WebCompilerHostCpuSets]::Read()
    compiler = Get-Audit $taskCompiler
    executable = Get-Audit $taskExecutable
    inputManifest = $(if (Test-Path (Join-Path $taskInput 'manifest.json')) {
        Get-Audit (Join-Path $taskInput 'manifest.json')
    } else { $null })
    sources = @((Get-Audit $PSCommandPath), (Get-Audit $taskSource))
    inputs = $taskInputs
    log = Get-Audit $taskLog
    errors = Get-Audit $taskErrors
    boundary = 'A passing restricted-affinity run does not certify normal browser startup or hardware health.'
}
$taskReport | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $taskReportFile -Encoding utf8
[pscustomobject]$taskReport | Select-Object pass, exitCode, timedOut, requestedCompilations, elapsedSeconds, requestedAffinityMask,
    maxObservedThreadCount |
    ConvertTo-Json
if (!$taskReport.pass) { exit 1 }
