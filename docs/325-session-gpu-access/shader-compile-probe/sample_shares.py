"""The share of the sampler's samples for each library, in each phase of mesa_direct.py --phased.

Usage: python3 sample_shares.py <samples from psample> <phases from PHASE_LOG>
"""
import collections, os, sys

marks = [(float(l.split()[0]), l.split()[1]) for l in open(sys.argv[2])]
def phase(t):
    cur = 'start'
    for mt, name in marks:
        if t >= mt: cur = name
    return cur
def lib(path):
    b = os.path.basename(path)
    if 'gallium' in b or b.endswith('_dri.so') or 'libEGL_mesa' in b or 'libglapi' in b: return 'Mesa (libgallium)'
    if b.startswith('libnvidia') or '/usr/lib/wsl/drivers' in path: return 'NVIDIA: ' + b
    if '/usr/lib/wsl/lib' in path or b.startswith('libd3d12') or b.startswith('libdxcore'): return 'Direct3D 12 runtime: ' + b
    if b.startswith('libLLVM'): return 'LLVM'
    if b.startswith('libc.so') or b.startswith('libm.so') or b.startswith('libstdc++') or b.startswith('libgcc') or b.startswith('libpthread'): return 'C/C++ library: ' + b
    if 'python' in b or b.startswith('_ctypes') or b.startswith('libffi'): return 'python'
    return b or path
cnt = collections.defaultdict(collections.Counter)
for l in open(sys.argv[1]):
    t, path = l.rstrip('\n').split(' ', 1)
    cnt[phase(float(t))][lib(path)] += 1
for ph in ['compile', 'link', 'draw']:
    tot = sum(cnt[ph].values())
    print(f'-- {ph}: {tot} samples')
    for k, v in cnt[ph].most_common(7): print('   %5.1f %%  %s' % (100 * v / tot, k))
