const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const dawn = path.join(root, '.tools/dawn-v20261009.190412');
const output = path.join(root, '.tools/ue58-dawn-host');
const toolchain = 'C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.51.36231';
const sdk = 'C:/Program Files (x86)/Windows Kits/10/lib/10.0.22621.0';
fs.mkdirSync(output, {recursive: true});
const header = fs.readFileSync(path.join(dawn, 'include/dawn/webgpu.h'), 'utf8');
const apiExports = [...header.matchAll(/^WGPU_EXPORT [^\r\n;]*?\b(wgpu\w+)\(/gm)].map(match => match[1]);
if (apiExports.length < 150 || new Set(apiExports).size !== apiExports.length) throw Error('Dawn C API inventory invalid');
const definition = path.join(output, 'WebGPUHost.def');
fs.writeFileSync(definition, 'EXPORTS\n' + apiExports.join('\n') + '\n');
cp.execFileSync(path.join(toolchain, 'bin/Hostx64/x64/link.exe'), [
  '/nologo', '/DLL', '/MACHINE:X64', '/OPT:REF', '/OPT:ICF',
  `/DEF:${definition}`, `/OUT:${path.join(output, 'WebGPUHost.dll')}`,
  `/IMPLIB:${path.join(output, 'WebGPUHost.lib')}`,
  `/LIBPATH:${path.join(toolchain, 'lib/x64')}`,
  `/LIBPATH:${path.join(sdk, 'um/x64')}`, `/LIBPATH:${path.join(sdk, 'ucrt/x64')}`,
  path.join(dawn, 'lib/webgpu_dawn.lib'), 'user32.lib', 'onecore_apiset.lib', 'dxguid.lib',
], {stdio: 'inherit'});
const imports = cp.execFileSync(path.join(toolchain, 'bin/Hostx64/x64/dumpbin.exe'),
  ['/DEPENDENTS', path.join(output, 'WebGPUHost.dll')], {encoding: 'utf8'});
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.writeFileSync(path.join(__dirname, 'results/dawn-host-build.json'), JSON.stringify({
  pass: true, toolchain, exports: apiExports.length, dll: path.join(output, 'WebGPUHost.dll'),
  dllSha256: sha(path.join(output, 'WebGPUHost.dll')),
  dawnLibrarySha256: sha(path.join(dawn, 'lib/webgpu_dawn.lib')), imports,
  boundary: 'Native Dawn C API in a separate DLL. UE remains on its configured MSVC toolchain.',
}, null, 2));
console.log(JSON.stringify({pass: true, exports: apiExports.length, output}));
