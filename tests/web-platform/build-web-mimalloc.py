"""Keep Emscripten's C allocator replacement, while UE owns C++ new/delete.

Build a private archive. Do not modify the SDK's source or shared cache, and do
not suppress duplicate-symbol errors. All unmodified archive members are reused.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
sdk = root / '.tools/emsdk'
emscripten = sdk / 'upstream/emscripten'
os.environ['EM_CONFIG'] = str(sdk / '.emscripten').replace('\\', '/')
sys.path.insert(0, str(emscripten))
from tools.settings import settings
from tools import system_libs

settings.MEMORY64 = 1
settings.PTHREADS = 1
settings.SHARED_MEMORY = 1
output = root / '.tools/web-mimalloc-ue'
output.mkdir(exist_ok=True)
source = emscripten / 'system/lib/mimalloc/src'
stock = emscripten / 'cache/sysroot/lib/wasm64-emscripten/libmimalloc-mt.a'
if not stock.exists():
    bootstrap = output / 'bootstrap.c'
    bootstrap.write_text('int main(void) { return 0; }\n', encoding='utf8')
    subprocess.run([sys.executable, str(emscripten / 'emcc.py'), str(bootstrap),
                    '-O2', '-m64', '-pthread', '-sMALLOC=mimalloc',
                    '-o', str(output / 'bootstrap.js')], check=True)
override = (source / 'alloc-override.c').read_text(encoding='utf8')
begin = override.index('#ifdef __cplusplus', override.index('// Override new/delete'))
end = override.index('#endif // __cplusplus', begin) + len('#endif // __cplusplus')
patched = override[:begin] + '#if 0 /* UE supplies every global C++ new/delete overload. */\n' + override[begin:end] + '\n#endif\n' + override[end:]
(output / 'alloc-override.c').write_text(patched, encoding='utf8')
shutil.copyfile(source / 'alloc.c', output / 'alloc.c')
library = system_libs.libmimalloc(is_mt=True, is_ww=False)
library.build_dir = str(output)
flags = library.get_cflags() + ['-I' + str(source)]
subprocess.run([sys.executable, str(emscripten / 'emcc.py'), *flags, '-c',
                str(output / 'alloc.c'), '-o', str(output / 'alloc.o')], check=True)
archive = output / 'libmimalloc-ue-mt.a'
shutil.copyfile(stock, archive)
subprocess.run([str(sdk / 'upstream/bin/llvm-ar.exe'), 'rcs', str(archive),
                str(output / 'alloc.o')], check=True)
names = subprocess.check_output([str(sdk / 'upstream/bin/llvm-nm.exe'),
                                '--defined-only', '--extern-only', str(archive)], text=True)
assert not any(line.split()[-1].startswith(('_Znw', '_Zna', '_Zdl', '_Zda'))
               for line in names.splitlines() if line.split())
assert all(any(line.split()[-1] == name for line in names.splitlines() if line.split())
           for name in ('malloc', 'free', 'posix_memalign', 'malloc_usable_size', 'mi_malloc'))

def audit(file):
    return {'file': str(file), 'sha256': hashlib.sha256(Path(file).read_bytes()).hexdigest()}

report = {'pass': True, 'sources': [audit(Path(__file__)), audit(source / 'alloc.c'),
          audit(source / 'alloc-override.c'), audit(emscripten / 'tools/system_libs.py')],
          'stock': audit(stock), 'patched': audit(output / 'alloc-override.c'),
          'compileFlags': flags, 'archive': audit(archive), 'cppOverrides': 0,
          'boundary': 'Only the C++ override block is excluded in a private alloc.o. C/POSIX replacement and all other SDK archive members are retained. Stock source/cache untouched.'}
(output / 'build.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
print(json.dumps({'pass': True, 'archive': str(archive)}))
