param([string]$Engine = 'H:/UE_5.8')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskProject = Join-Path $taskRoot 'tests/ue-shader-host/UEShaderHost.uproject'
$taskBinaries = Join-Path $taskRoot '.tools/ue58-web-platform-host/Engine/Binaries/Win64'
$taskEditor = Join-Path $taskBinaries 'UnrealEditor-Cmd.exe'
$taskOutput = Join-Path $PSScriptRoot 'build/ue-rhi'
$taskReport = Join-Path $PSScriptRoot 'results/ue-rhi-build-results.json'
$taskGlobalOutput = Join-Path $PSScriptRoot 'build/ue-rhi-global'
$taskGlobalReport = Join-Path $PSScriptRoot 'results/ue-rhi-global-build-results.json'
$taskViewportOutput = Join-Path $PSScriptRoot 'build/ue-rhi-viewport'
$taskViewportReport = Join-Path $PSScriptRoot 'results/ue-rhi-viewport-build-results.json'
$taskTextureSRVOutput = Join-Path $PSScriptRoot 'build/ue-rhi-texture-srv'
$taskTextureSRVReport = Join-Path $PSScriptRoot 'results/ue-rhi-texture-srv-build-results.json'
$taskBufferSRVOutput = Join-Path $PSScriptRoot 'build/ue-rhi-buffer-srv'
$taskBufferSRVReport = Join-Path $PSScriptRoot 'results/ue-rhi-buffer-srv-build-results.json'
$taskBufferUAVOutput = Join-Path $PSScriptRoot 'build/ue-rhi-buffer-uav'
$taskBufferUAVReport = Join-Path $PSScriptRoot 'results/ue-rhi-buffer-uav-build-results.json'
$taskUint4Output = Join-Path $PSScriptRoot 'build/ue-rhi-uint4'
$taskUint4Report = Join-Path $PSScriptRoot 'results/ue-rhi-uint4-build-results.json'
$taskStructuredOutput = Join-Path $PSScriptRoot 'build/ue-rhi-structured'
$taskStructuredReport = Join-Path $PSScriptRoot 'results/ue-rhi-structured-build-results.json'
$taskFloat4Output = Join-Path $PSScriptRoot 'build/ue-rhi-float4'
$taskFloat4Report = Join-Path $PSScriptRoot 'results/ue-rhi-float4-build-results.json'
$taskBufferLockOutput = Join-Path $PSScriptRoot 'build/ue-rhi-buffer-lock'
$taskBufferLockReport = Join-Path $PSScriptRoot 'results/ue-rhi-buffer-lock-build-results.json'
$taskTexture3DOutput = Join-Path $PSScriptRoot 'build/ue-rhi-texture-3d'
$taskTexture3DReport = Join-Path $PSScriptRoot 'results/ue-rhi-texture-3d-build-results.json'
$taskTextureUintOutput = Join-Path $PSScriptRoot 'build/ue-rhi-texture-uint'
$taskTextureUintReport = Join-Path $PSScriptRoot 'results/ue-rhi-texture-uint-build-results.json'
$env:UE_ENGINE_ROOT = Join-Path $Engine 'Engine'
if (-not $env:NODE_PATH) {
    $env:NODE_PATH = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
}
if (Test-Path -LiteralPath $taskReport) { Remove-Item -LiteralPath $taskReport }
if (Test-Path -LiteralPath $taskGlobalReport) { Remove-Item -LiteralPath $taskGlobalReport }
if (Test-Path -LiteralPath $taskViewportReport) { Remove-Item -LiteralPath $taskViewportReport }
if (Test-Path -LiteralPath $taskTextureSRVReport) { Remove-Item -LiteralPath $taskTextureSRVReport }
if (Test-Path -LiteralPath $taskBufferSRVReport) { Remove-Item -LiteralPath $taskBufferSRVReport }
if (Test-Path -LiteralPath $taskBufferUAVReport) { Remove-Item -LiteralPath $taskBufferUAVReport }
if (Test-Path -LiteralPath $taskUint4Report) { Remove-Item -LiteralPath $taskUint4Report }
if (Test-Path -LiteralPath $taskStructuredReport) { Remove-Item -LiteralPath $taskStructuredReport }
if (Test-Path -LiteralPath $taskFloat4Report) { Remove-Item -LiteralPath $taskFloat4Report }
if (Test-Path -LiteralPath $taskBufferLockReport) { Remove-Item -LiteralPath $taskBufferLockReport }
if (Test-Path -LiteralPath $taskTexture3DReport) { Remove-Item -LiteralPath $taskTexture3DReport }
if (Test-Path -LiteralPath $taskTextureUintReport) { Remove-Item -LiteralPath $taskTextureUintReport }
$taskTextureUintShaderReport = Join-Path $PSScriptRoot 'results/ue-texture-uint-shader-build-results.json'
if (Test-Path -LiteralPath $taskTextureUintShaderReport) { Remove-Item -LiteralPath $taskTextureUintShaderReport }
$taskTextureShaderReport = Join-Path $PSScriptRoot 'results/ue-texture-shader-build-results.json'
if (Test-Path -LiteralPath $taskTextureShaderReport) { Remove-Item -LiteralPath $taskTextureShaderReport }
$taskBufferShaderReport = Join-Path $PSScriptRoot 'results/ue-buffer-shader-build-results.json'
if (Test-Path -LiteralPath $taskBufferShaderReport) { Remove-Item -LiteralPath $taskBufferShaderReport }
$taskStartupDiagnostic = Join-Path $PSScriptRoot 'results/ue-rhi-startup-diagnostic.json'
if (Test-Path -LiteralPath $taskStartupDiagnostic) { Remove-Item -LiteralPath $taskStartupDiagnostic }
& node (Join-Path $PSScriptRoot 'build-dawn-host.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Native Dawn C API DLL build failed' }

# This also builds the RHI module, refreshes the isolated host and recompiles its Worker packets.
& (Join-Path $PSScriptRoot 'build-ue-platform.ps1') -Engine $Engine
if ($LASTEXITCODE -ne 0) { throw 'Web ShaderPlatform prerequisite failed' }
foreach ($taskDependency in @(
    (Join-Path $taskRoot '.tools/ue58-dawn-host/WebGPUHost.dll'),
    (Join-Path $taskRoot '.tools/dxc-v1.9.2609/bin/x64/dxcompiler.dll'),
    (Join-Path $taskRoot '.tools/dxc-v1.9.2609/bin/x64/dxil.dll')
)) {
    Copy-Item -LiteralPath $taskDependency -Destination $taskBinaries -Force
}
$env:WEBGPU_TINT_DIR = Join-Path $taskRoot '.tools/dawn-v20261009.190412/bin'
$taskBufferShaderArguments = @($taskProject, '-run=WebShaderProbe', '-WebBufferShaderProbe', '-WebShaderPlatform',
    "-Output=$(Join-Path $PSScriptRoot 'build/ue-buffer-shader')",
    "-WebFormatWorker=$(Join-Path $taskRoot '.tools/ue58-web-shader-worker/Engine/Binaries/Win64/ShaderCompileWorker.exe')",
    '-nullrhi', '-unattended', '-nosplash', '-nop4', '-NoSound',
    "-abslog=$(Join-Path $PSScriptRoot 'results/ue-buffer-shader-host.log')")
& $taskEditor @taskBufferShaderArguments 2>&1 |
    Select-String 'P2_BUFFER_SHADER|P1_PLATFORM|Worker batch|Error:|Fatal|Assertion' | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw "Buffer SRV Worker shader compilation failed: $LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'prepare-buffer-worker.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Buffer SRV Worker shader verification failed' }
$taskTextureShaderArguments = @($taskProject, '-run=WebShaderProbe', '-WebTextureShaderProbe', '-WebShaderPlatform',
    "-Output=$(Join-Path $PSScriptRoot 'build/ue-texture-shader')",
    "-WebFormatWorker=$(Join-Path $taskRoot '.tools/ue58-web-shader-worker/Engine/Binaries/Win64/ShaderCompileWorker.exe')",
    '-nullrhi', '-unattended', '-nosplash', '-nop4', '-NoSound',
    "-abslog=$(Join-Path $PSScriptRoot 'results/ue-texture-shader-host.log')")
& $taskEditor @taskTextureShaderArguments 2>&1 |
    Select-String 'P2_BUFFER_SHADER|P1_PLATFORM|Worker batch|Error:|Fatal|Assertion' | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw "Texture3D Worker shader compilation failed: $LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'prepare-texture-worker.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Texture3D Worker shader verification failed' }
$taskTextureUintShaderArguments = @($taskProject, '-run=WebShaderProbe', '-WebTextureUintShaderProbe', '-WebShaderPlatform',
    "-Output=$(Join-Path $PSScriptRoot 'build/ue-texture-uint-shader')",
    "-WebFormatWorker=$(Join-Path $taskRoot '.tools/ue58-web-shader-worker/Engine/Binaries/Win64/ShaderCompileWorker.exe')",
    '-nullrhi', '-unattended', '-nosplash', '-nop4', '-NoSound',
    "-abslog=$(Join-Path $PSScriptRoot 'results/ue-texture-uint-shader-host.log')")
& $taskEditor @taskTextureUintShaderArguments 2>&1 |
    Select-String 'P2_BUFFER_SHADER|P1_PLATFORM|Worker batch|Error:|Fatal|Assertion' | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw "Texture uint Worker shader compilation failed: $LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'prepare-texture-worker.cjs') --uint
if ($LASTEXITCODE -ne 0) { throw 'Texture uint Worker shader verification failed' }
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskRuntimeReport = Join-Path $taskOutput 'rhi-results.json'
if (Test-Path -LiteralPath $taskRuntimeReport) { Remove-Item -LiteralPath $taskRuntimeReport }
$taskArguments = @($taskProject, '-run=WebShaderProbe', '-WebRHIProbe',
    "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-platform-full-worker')",
    "-WebMaterialShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-platform-material-worker')",
    "-Output=$taskOutput", '-nullrhi', '-unattended', '-nosplash', '-nop4', '-NoSound',
    "-abslog=$(Join-Path $PSScriptRoot 'results/ue-rhi-host.log')")
& $taskEditor @taskArguments 2>&1 |
    Select-String 'P2_RHI|P2_MATERIAL|P2_TRANSITION|Error:|Fatal|Assertion' | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw "WebGPURHI commandlet failed: $LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'verify-ue-rhi.cjs')
if ($LASTEXITCODE -ne 0) { throw 'WebGPURHI readback/provenance verification failed' }
New-Item -ItemType Directory -Path $taskGlobalOutput -Force | Out-Null
$taskGlobalRuntimeReport = Join-Path $taskGlobalOutput 'global-rhi-results.json'
if (Test-Path -LiteralPath $taskGlobalRuntimeReport) { Remove-Item -LiteralPath $taskGlobalRuntimeReport }
$taskGlobalArguments = @($taskProject, '-run=WebShaderProbe', '-WebGlobalRHIProbe',
    "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-platform-full-worker')",
    "-Output=$taskGlobalOutput", '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound',
    "-abslog=$(Join-Path $PSScriptRoot 'results/ue-rhi-global-host.log')")
& $taskEditor @taskGlobalArguments 2>&1 |
    Select-String 'P2_GLOBAL|Error:|Fatal|Assertion' | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw "Global WebGPURHI commandlet failed: $LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'verify-ue-rhi-global.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Global WebGPURHI readback/provenance verification failed' }
New-Item -ItemType Directory -Path $taskViewportOutput -Force | Out-Null
$taskViewportRuntimeReport = Join-Path $taskViewportOutput 'viewport-rhi-results.json'
if (Test-Path -LiteralPath $taskViewportRuntimeReport) { Remove-Item -LiteralPath $taskViewportRuntimeReport }
$taskViewportArguments = @($taskProject, '-run=WebShaderProbe', '-WebViewportRHIProbe',
    "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-platform-full-worker')",
    "-Output=$taskViewportOutput", '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound',
    "-abslog=$(Join-Path $PSScriptRoot 'results/ue-rhi-viewport-host.log')")
& $taskEditor @taskViewportArguments 2>&1 |
    Select-String 'P2_VIEWPORT|Error:|Fatal|Assertion' | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw "Viewport WebGPURHI commandlet failed: $LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'verify-ue-rhi-viewport.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Viewport WebGPURHI readback/provenance verification failed' }
New-Item -ItemType Directory -Path $taskTextureSRVOutput -Force | Out-Null
$taskTextureSRVRuntimeReport = Join-Path $taskTextureSRVOutput 'texture-srv-results.json'
if (Test-Path -LiteralPath $taskTextureSRVRuntimeReport) { Remove-Item -LiteralPath $taskTextureSRVRuntimeReport }
$taskTextureSRVArguments = @($taskProject, '-run=WebShaderProbe', '-WebTextureSRVProbe',
    "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-platform-full-worker')",
    "-Output=$taskTextureSRVOutput", '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound',
    "-abslog=$(Join-Path $PSScriptRoot 'results/ue-rhi-texture-srv-host.log')")
& $taskEditor @taskTextureSRVArguments 2>&1 |
    Select-String 'P2_TEXTURE_SRV|Error:|Fatal|Assertion' | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw "TextureSRV WebGPURHI commandlet failed: $LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'verify-ue-rhi-texture-srv.cjs')
if ($LASTEXITCODE -ne 0) { throw 'TextureSRV WebGPURHI readback/provenance verification failed' }
New-Item -ItemType Directory -Path $taskBufferSRVOutput -Force | Out-Null
$taskBufferSRVRuntimeReport = Join-Path $taskBufferSRVOutput 'buffer-srv-results.json'
if (Test-Path -LiteralPath $taskBufferSRVRuntimeReport) { Remove-Item -LiteralPath $taskBufferSRVRuntimeReport }
$taskBufferSRVArguments = @($taskProject, '-run=WebShaderProbe', '-WebBufferSRVProbe',
    "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-buffer-worker')",
    "-Output=$taskBufferSRVOutput", '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound',
    "-abslog=$(Join-Path $PSScriptRoot 'results/ue-rhi-buffer-srv-host.log')")
& $taskEditor @taskBufferSRVArguments 2>&1 |
    Select-String 'P2_BUFFER_SRV|Error:|Fatal|Assertion' | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw "BufferSRV WebGPURHI commandlet failed: $LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'verify-ue-rhi-buffer-srv.cjs')
if ($LASTEXITCODE -ne 0) { throw 'BufferSRV WebGPURHI readback/provenance verification failed' }
New-Item -ItemType Directory -Path $taskBufferUAVOutput -Force | Out-Null
$taskBufferUAVRuntimeReport = Join-Path $taskBufferUAVOutput 'buffer-uav-results.json'
if (Test-Path -LiteralPath $taskBufferUAVRuntimeReport) { Remove-Item -LiteralPath $taskBufferUAVRuntimeReport }
$taskBufferUAVArguments = @($taskProject, '-run=WebShaderProbe', '-WebBufferUAVProbe',
    "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-buffer-worker')",
    "-Output=$taskBufferUAVOutput", '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound',
    "-abslog=$(Join-Path $PSScriptRoot 'results/ue-rhi-buffer-uav-host.log')")
& $taskEditor @taskBufferUAVArguments 2>&1 |
    Select-String 'P2_BUFFER_UAV|Error:|Fatal|Assertion' | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw "BufferUAV WebGPURHI commandlet failed: $LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'verify-ue-rhi-buffer-uav.cjs')
if ($LASTEXITCODE -ne 0) { throw 'BufferUAV WebGPURHI readback/provenance verification failed' }
New-Item -ItemType Directory -Path $taskUint4Output -Force | Out-Null
$taskUint4RuntimeReport = Join-Path $taskUint4Output 'uint4-results.json'
if (Test-Path -LiteralPath $taskUint4RuntimeReport) { Remove-Item -LiteralPath $taskUint4RuntimeReport }
$taskUint4Arguments = @($taskProject, '-run=WebShaderProbe', '-WebUint4Probe',
    "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-buffer-worker')",
    "-Output=$taskUint4Output", '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound',
    "-abslog=$(Join-Path $PSScriptRoot 'results/ue-rhi-uint4-host.log')")
& $taskEditor @taskUint4Arguments 2>&1 |
    Select-String 'P2_UINT4|Error:|Fatal|Assertion' | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw "Uint4 WebGPURHI commandlet failed: $LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'verify-ue-rhi-uint4.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Uint4 WebGPURHI readback/provenance verification failed' }
New-Item -ItemType Directory -Path $taskStructuredOutput -Force | Out-Null
$taskStructuredRuntimeReport = Join-Path $taskStructuredOutput 'structured-results.json'
if (Test-Path -LiteralPath $taskStructuredRuntimeReport) { Remove-Item -LiteralPath $taskStructuredRuntimeReport }
$taskStructuredArguments = @($taskProject, '-run=WebShaderProbe', '-WebStructuredProbe',
    "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-buffer-worker')",
    "-Output=$taskStructuredOutput", '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound',
    "-abslog=$(Join-Path $PSScriptRoot 'results/ue-rhi-structured-host.log')")
& $taskEditor @taskStructuredArguments 2>&1 |
    Select-String 'P2_STRUCTURED|Error:|Fatal|Assertion' | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw "Structured WebGPURHI commandlet failed: $LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'verify-ue-rhi-structured.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Structured WebGPURHI readback/provenance verification failed' }
New-Item -ItemType Directory -Path $taskFloat4Output -Force | Out-Null
$taskFloat4RuntimeReport = Join-Path $taskFloat4Output 'float4-results.json'
if (Test-Path -LiteralPath $taskFloat4RuntimeReport) { Remove-Item -LiteralPath $taskFloat4RuntimeReport }
$taskFloat4Arguments = @($taskProject, '-run=WebShaderProbe', '-WebFloat4Probe',
    "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-buffer-worker')",
    "-Output=$taskFloat4Output", '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound',
    "-abslog=$(Join-Path $PSScriptRoot 'results/ue-rhi-float4-host.log')")
& $taskEditor @taskFloat4Arguments 2>&1 |
    Select-String 'P2_FLOAT4|Error:|Fatal|Assertion' | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw "Float4 WebGPURHI commandlet failed: $LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'verify-ue-rhi-float4.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Float4 WebGPURHI readback/provenance verification failed' }
New-Item -ItemType Directory -Path $taskBufferLockOutput -Force | Out-Null
$taskBufferLockRuntimeReport = Join-Path $taskBufferLockOutput 'buffer-lock-results.json'
if (Test-Path -LiteralPath $taskBufferLockRuntimeReport) { Remove-Item -LiteralPath $taskBufferLockRuntimeReport }
$taskBufferLockArguments = @($taskProject, '-run=WebShaderProbe', '-WebBufferLockProbe',
    "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-buffer-worker')",
    "-Output=$taskBufferLockOutput", '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound',
    "-abslog=$(Join-Path $PSScriptRoot 'results/ue-rhi-buffer-lock-host.log')")
& $taskEditor @taskBufferLockArguments 2>&1 |
    Select-String 'P2_BUFFER_LOCK|Error:|Fatal|Assertion' | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw "BufferLock WebGPURHI commandlet failed: $LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'verify-ue-rhi-buffer-lock.cjs')
if ($LASTEXITCODE -ne 0) { throw 'BufferLock WebGPURHI readback/provenance verification failed' }
New-Item -ItemType Directory -Path $taskTexture3DOutput -Force | Out-Null
$taskTexture3DRuntimeReport = Join-Path $taskTexture3DOutput 'texture-3d-results.json'
if (Test-Path -LiteralPath $taskTexture3DRuntimeReport) { Remove-Item -LiteralPath $taskTexture3DRuntimeReport }
$taskTexture3DArguments = @($taskProject, '-run=WebShaderProbe', '-WebTexture3DProbe',
    "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-texture-worker')",
    "-Output=$taskTexture3DOutput", '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound',
    "-abslog=$(Join-Path $PSScriptRoot 'results/ue-rhi-texture-3d-host.log')")
& $taskEditor @taskTexture3DArguments 2>&1 |
    Select-String 'P2_TEXTURE_3D|Error:|Fatal|Assertion' | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw "Texture3D WebGPURHI commandlet failed: $LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'verify-ue-rhi-texture-3d.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Texture3D WebGPURHI readback/provenance verification failed' }
New-Item -ItemType Directory -Path $taskTextureUintOutput -Force | Out-Null
$taskTextureUintRuntimeReport = Join-Path $taskTextureUintOutput 'texture-uint-results.json'
if (Test-Path -LiteralPath $taskTextureUintRuntimeReport) { Remove-Item -LiteralPath $taskTextureUintRuntimeReport }
$taskTextureUintArguments = @($taskProject, '-run=WebShaderProbe', '-WebTextureUintProbe',
    "-WebShaderDirectory=$(Join-Path $PSScriptRoot 'build/ue-texture-uint-worker')",
    "-Output=$taskTextureUintOutput", '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound',
    "-abslog=$(Join-Path $PSScriptRoot 'results/ue-rhi-texture-uint-host.log')")
& $taskEditor @taskTextureUintArguments 2>&1 |
    Select-String 'P2_TEXTURE_UINT|Error:|Fatal|Assertion' | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw "Texture uint WebGPURHI commandlet failed: $LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'verify-ue-rhi-texture-uint.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Texture uint WebGPURHI readback/provenance verification failed' }
& node (Join-Path $PSScriptRoot 'probe-ue-rhi-startup.cjs')
if ($LASTEXITCODE -ne 0) { throw 'ImportedRHI startup diagnostic did not reach the expected blocker' }
& node (Join-Path $PSScriptRoot 'verify-web-renderer-source.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Web Renderer conditional-source compilation verification failed' }
