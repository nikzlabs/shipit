#!/usr/bin/env python3
"""Mesa with no browser: compile, link and first-draw the same three.js programs through EGL.

Usage: [GALLIUM_DRIVER=d3d12|llvmpipe] python3 mesa_direct.py [--n 200] [--salt 1] [--info] [--binary]
           [--phased] [--draw-detail] [--fast-exit]
Prints one JSON line. --info: only the driver facts. --binary: also save and load each program binary.
--phased: compile all shaders, then link all programs. PHASE_LOG=<file>: write the time of each phase, for the sampler.
--draw-detail: glFinish after each first draw. --fast-exit: leave with os._exit, which skips the EGL teardown.
Exit status 1: a program did not compile or link.
"""
import ctypes, json, os, re, sys, time

args = sys.argv[1:]
def opt(name, default):
    return args[args.index(name) + 1] if name in args else default
N, SALT = int(opt("--n", "200")), int(opt("--salt", "1"))
INFO, BINARY, PHASED = "--info" in args, "--binary" in args, "--phased" in args
PHASE_LOG = os.environ.get("PHASE_LOG")
def mark(name):
    if PHASE_LOG:
        with open(PHASE_LOG, "a") as f: f.write(f"{time.monotonic():.6f} {name}\n")

egl = ctypes.CDLL("libEGL.so.1")
vp, ui, i32 = ctypes.c_void_p, ctypes.c_uint, ctypes.c_int
egl.eglGetPlatformDisplay.restype = vp; egl.eglGetPlatformDisplay.argtypes = [ui, vp, vp]
egl.eglGetDisplay.restype = vp; egl.eglGetDisplay.argtypes = [vp]
egl.eglInitialize.argtypes = [vp, ctypes.POINTER(i32), ctypes.POINTER(i32)]
egl.eglChooseConfig.argtypes = [vp, ctypes.POINTER(i32), ctypes.POINTER(vp), i32, ctypes.POINTER(i32)]
egl.eglCreateContext.restype = vp; egl.eglCreateContext.argtypes = [vp, vp, vp, ctypes.POINTER(i32)]
egl.eglCreatePbufferSurface.restype = vp; egl.eglCreatePbufferSurface.argtypes = [vp, vp, ctypes.POINTER(i32)]
egl.eglMakeCurrent.argtypes = [vp, vp, vp, vp]
egl.eglGetProcAddress.restype = vp; egl.eglGetProcAddress.argtypes = [ctypes.c_char_p]
egl.eglQueryString.restype = ctypes.c_char_p; egl.eglQueryString.argtypes = [vp, i32]

def arr(*v): return (i32 * len(v))(*v)
platform = "surfaceless"
dpy = egl.eglGetPlatformDisplay(0x31DD, None, None)  # EGL_PLATFORM_SURFACELESS_MESA
major, minor = i32(), i32()
if not dpy or not egl.eglInitialize(dpy, ctypes.byref(major), ctypes.byref(minor)):
    platform = "default"
    dpy = egl.eglGetDisplay(None)
    if not egl.eglInitialize(dpy, ctypes.byref(major), ctypes.byref(minor)):
        print(json.dumps({"error": "eglInitialize failed"})); sys.exit(1)
egl.eglBindAPI(0x30A0)  # EGL_OPENGL_ES_API
cfg, ncfg = vp(), i32()
egl.eglChooseConfig(dpy, arr(0x3033, 1, 0x3040, 0x40, 0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3038), ctypes.byref(cfg), 1, ctypes.byref(ncfg))
ctx = egl.eglCreateContext(dpy, cfg, None, arr(0x3098, 3, 0x30FB, 0, 0x3038))
surf = egl.eglCreatePbufferSurface(dpy, cfg, arr(0x3057, 480, 0x3056, 320, 0x3038))
if not ctx or not egl.eglMakeCurrent(dpy, surf, surf, ctx):
    print(json.dumps({"error": "no ES3 context", "eglError": hex(egl.eglGetError())})); sys.exit(1)

def fn(name, restype, *argtypes):
    addr = egl.eglGetProcAddress(name.encode())
    if not addr: raise RuntimeError(name)
    return ctypes.CFUNCTYPE(restype, *argtypes)(addr)

cp, sz = ctypes.c_char_p, ctypes.c_int
glGetString = fn("glGetString", cp, ui)
glGetIntegerv = fn("glGetIntegerv", None, ui, ctypes.POINTER(i32))
glCreateShader = fn("glCreateShader", ui, ui)
glShaderSource = fn("glShaderSource", None, ui, sz, ctypes.POINTER(cp), ctypes.POINTER(i32))
glCompileShader = fn("glCompileShader", None, ui)
glGetShaderiv = fn("glGetShaderiv", None, ui, ui, ctypes.POINTER(i32))
glGetShaderInfoLog = fn("glGetShaderInfoLog", None, ui, sz, ctypes.POINTER(i32), cp)
glCreateProgram = fn("glCreateProgram", ui)
glAttachShader = fn("glAttachShader", None, ui, ui)
glLinkProgram = fn("glLinkProgram", None, ui)
glGetProgramiv = fn("glGetProgramiv", None, ui, ui, ctypes.POINTER(i32))
glGetProgramInfoLog = fn("glGetProgramInfoLog", None, ui, sz, ctypes.POINTER(i32), cp)
glUseProgram = fn("glUseProgram", None, ui)
glGetActiveUniform = fn("glGetActiveUniform", None, ui, ui, sz, ctypes.POINTER(i32), ctypes.POINTER(i32), ctypes.POINTER(ui), cp)
glGetUniformLocation = fn("glGetUniformLocation", i32, ui, cp)
glUniform1i = fn("glUniform1i", None, i32, i32)
glGenVertexArrays = fn("glGenVertexArrays", None, sz, ctypes.POINTER(ui))
glBindVertexArray = fn("glBindVertexArray", None, ui)
glDrawArrays = fn("glDrawArrays", None, ui, i32, sz)
glReadPixels = fn("glReadPixels", None, i32, i32, sz, sz, ui, ui, vp)
glFinish = fn("glFinish", None)
glGetError = fn("glGetError", ui)
glGetProgramBinary = fn("glGetProgramBinary", None, ui, sz, ctypes.POINTER(i32), ctypes.POINTER(ui), vp)
glProgramBinary = fn("glProgramBinary", None, ui, ui, vp, sz)

def geti(pname):
    v = i32(-1); glGetIntegerv(pname, ctypes.byref(v)); return v.value

ext = (glGetString(0x1F03) or b"").decode().split()
out = {
    "platform": platform, "galliumDriver": os.environ.get("GALLIUM_DRIVER"),
    "renderer": (glGetString(0x1F01) or b"").decode(), "version": (glGetString(0x1F02) or b"").decode(),
    "numProgramBinaryFormats": geti(0x87FE),
    "parallelShaderCompileExt": "GL_KHR_parallel_shader_compile" in ext,
    "maxShaderCompilerThreads": geti(0x91B0),
}
glGetError()
if INFO:
    print(json.dumps(out)); sys.exit(0)

pairs = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "sources.json")))
def variant(text, i, is_fs):
    tag = f"#define SHIPIT_UNIQ {i}.0\n#define SHIPIT_SALT {SALT}.0\n"
    t = re.sub(r"^(#version 300 es[^\n]*\n)", lambda m: m.group(1) + tag, text, count=1)
    if is_fs:
        k = t.rfind("}")
        t = t[:k] + "\n\tgl_FragColor.rgb += vec3( ( SHIPIT_UNIQ + SHIPIT_SALT * 1000.0 ) * 1.0e-7 );\n}" + t[k + 1:]
    return t

def shader(kind, text):
    s = glCreateShader(kind)
    src = cp(text.encode()); glShaderSource(s, 1, ctypes.byref(src), None)
    glCompileShader(s)
    ok = i32(); glGetShaderiv(s, 0x8B81, ctypes.byref(ok))
    return s, ok.value

vao = ui(); glGenVertexArrays(1, ctypes.byref(vao)); glBindVertexArray(vao)
UNITS = {0x8B5E: 0, 0x8B60: 1, 0x8B62: 2, 0x8B5F: 3, 0x8DC1: 4, 0x8DC5: 5, 0x8DC4: 6}
t_compile = t_link = t_draw = t_save = t_load = 0.0
failed, first_log, progs, binaries = 0, None, [], []
log = ctypes.create_string_buffer(2000)
texts = [(variant(pairs[i % len(pairs)]["vs"], i, False), variant(pairs[i % len(pairs)]["fs"], i, True)) for i in range(N)]
compiled = []
mark("compile")
if PHASED:
    t0 = time.perf_counter()
    for vs_text, fs_text in texts:
        compiled.append(shader(0x8B31, vs_text) + shader(0x8B30, fs_text))
    t_compile = time.perf_counter() - t0
    mark("link")
for i in range(N):
    t0 = time.perf_counter()
    if PHASED: vs, ok1, fs, ok2 = compiled[i]
    else: vs, ok1 = shader(0x8B31, texts[i][0]); fs, ok2 = shader(0x8B30, texts[i][1])
    t1 = time.perf_counter()
    prog = glCreateProgram(); glAttachShader(prog, vs); glAttachShader(prog, fs)
    glLinkProgram(prog)
    ok = i32(); glGetProgramiv(prog, 0x8B82, ctypes.byref(ok))
    t2 = time.perf_counter()
    t_compile += t1 - t0; t_link += t2 - t1
    if not ok.value:
        failed += 1
        if first_log is None:
            glGetProgramInfoLog(prog, 2000, None, log); first_log = log.value.decode(errors="replace")[:300]
            if not first_log:
                glGetShaderInfoLog(fs if not ok2 else vs, 2000, None, log); first_log = log.value.decode(errors="replace")[:300]
        continue
    progs.append(prog)

mark("draw")
t0 = time.perf_counter()
name, size, kind = ctypes.create_string_buffer(256), i32(), ui()
draw_each = []
for prog in progs:
    td = time.perf_counter()
    glUseProgram(prog)
    count = i32(); glGetProgramiv(prog, 0x8B86, ctypes.byref(count))
    for u in range(count.value):
        glGetActiveUniform(prog, u, 256, None, ctypes.byref(size), ctypes.byref(kind), name)
        if kind.value in UNITS:
            base = name.value.decode().replace("[0]", "")
            for e in range(size.value):
                loc = glGetUniformLocation(prog, (base if size.value == 1 and "[" not in name.value.decode() else f"{base}[{e}]").encode())
                if loc >= 0: glUniform1i(loc, UNITS[kind.value])
    glDrawArrays(4, 0, 3)
    if "--draw-detail" in args: glFinish()
    draw_each.append(time.perf_counter() - td)
px = ctypes.create_string_buffer(4); glReadPixels(0, 0, 1, 1, 0x1908, 0x1401, px)
t_draw = time.perf_counter() - t0
mark("end")
gl_error = glGetError()
k = max(1, len(draw_each) // 5)
out["drawFirstFifthMs"] = round(sum(draw_each[:k]) * 1000 / k, 1)
out["drawLastFifthMs"] = round(sum(draw_each[-k:]) * 1000 / k, 1)
threads = {}
for tid in os.listdir("/proc/self/task"):
    try:
        f = open(f"/proc/self/task/{tid}/stat").read()
        comm = f[f.index("(") + 1:f.rindex(")")]; rest = f[f.rindex(")") + 2:].split()
        cpu = (int(rest[11]) + int(rest[12])) / 100
        if cpu >= 0.05: threads[f"{comm}:{'main' if int(tid) == os.getpid() else tid}"] = cpu
    except Exception: pass
out["threadCpuS"] = threads

if BINARY and out["numProgramBinaryFormats"] > 0:
    t0 = time.perf_counter()
    for prog in progs:
        ln = i32(); glGetProgramiv(prog, 0x8741, ctypes.byref(ln))
        buf = ctypes.create_string_buffer(ln.value); got, fmt = i32(), ui()
        glGetProgramBinary(prog, ln.value, ctypes.byref(got), ctypes.byref(fmt), buf)
        binaries.append((fmt.value, buf, got.value))
    t_save = time.perf_counter() - t0
    t0 = time.perf_counter(); loaded = 0
    for fmt, buf, ln in binaries:
        prog = glCreateProgram(); glProgramBinary(prog, fmt, buf, ln)
        ok = i32(); glGetProgramiv(prog, 0x8B82, ctypes.byref(ok)); loaded += ok.value
    t_load = time.perf_counter() - t0
    out.update({"binarySaveMs": round(t_save * 1000), "binaryLoadMs": round(t_load * 1000), "binaryLoaded": loaded,
                "binaryBytes": sum(b[2] for b in binaries)})

ms = lambda s: round(s * 1000)
out.update({"n": N, "salt": SALT, "failed": failed, "firstLog": first_log, "glError": gl_error,
            "compileMs": ms(t_compile), "linkMs": ms(t_link), "compileAndLinkMs": ms(t_compile + t_link),
            "perProgramMs": round((t_compile + t_link) * 1000 / N, 1), "firstDrawMs": ms(t_draw),
            "cpuS": round(sum(os.times()[:2]), 2)})
print(json.dumps(out), flush=True)
status = 1 if failed else 0
if "--fast-exit" in args: os._exit(status)
sys.exit(status)
