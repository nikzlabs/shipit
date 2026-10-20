// Usage: node run-upload.mjs <label> [--runs=1] [--layers=145] [--cases=array,tex2d-256,…] [--env=K=V]… [chromium flags…]
// Starts one Chromium and times WebGL 2 uploads on about:blank, one new page for each case and run.
// Each line has the renderer, the host's CPU pressure before the case, and two times: to the return of
// gl.finish(), which is only a flush in Chromium, and to the answer of a readPixels, which waits for the GPU process.
// PLAYWRIGHT_FROM: the node_modules directory that has playwright-core. Default: the session image's.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(path.join(process.env.PLAYWRIGHT_FROM ?? "/opt/agent-cli/node_modules", "/"));
const { chromium } = require("playwright-core");

const argv = process.argv.slice(2);
const label = argv.shift();
const opt = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const runs = Number(opt("runs", "1"));
const layers = Number(opt("layers", "145"));
const ALL = ["array", "array-by-layer", "tex2d-one", "tex2d-256", "tex2d-1100", "buffer-static", "buffer-dynamic"];
const cases = opt("cases", "array").split(",").flatMap((c) => (c === "all" ? ALL : [c]));
const env = { ...process.env };
for (const a of argv.filter((x) => x.startsWith("--env="))) { const [k, ...v] = a.slice(6).split("="); env[k] = v.join("="); }
const args = argv.filter((x) => !/^--(runs|layers|cases|env)=/.test(x));
const pressure = () => { try { return fs.readFileSync("/proc/pressure/cpu", "utf8").split("\n")[0]; } catch { return null; } };

// Runs in the page. S×S RGBA8 layers of 262144 bytes each when S is 256.
const upload = ({ name, N }) => {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) return { error: "no WebGL 2 context" };
  const renderer = gl.getParameter(gl.getExtension("WEBGL_debug_renderer_info").UNMASKED_RENDERER_WEBGL);
  const S = 256, layer = S * S * 4, A = gl.TEXTURE_2D_ARRAY, T = gl.TEXTURE_2D, RGBA = gl.RGBA, UB = gl.UNSIGNED_BYTE;
  const data = (bytes) => new Uint8Array(bytes).fill(200);
  const tex = (target) => gl.bindTexture(target, gl.createTexture());
  const steps = {
    "array": () => { const d = data(layer * N); tex(A); return () => { gl.texStorage3D(A, 1, gl.RGBA8, S, S, N); gl.texSubImage3D(A, 0, 0, 0, 0, S, S, N, RGBA, UB, d); return d.length; }; },
    "array-by-layer": () => { const d = data(layer); tex(A); return () => { gl.texStorage3D(A, 1, gl.RGBA8, S, S, N); for (let i = 0; i < N; i++) gl.texSubImage3D(A, 0, 0, 0, i, S, S, 1, RGBA, UB, d); return d.length * N; }; },
    "tex2d-one": () => { const W = 4096, H = N * 16, d = data(W * H * 4); tex(T); return () => { gl.texStorage2D(T, 1, gl.RGBA8, W, H); gl.texSubImage2D(T, 0, 0, 0, W, H, RGBA, UB, d); return d.length; }; },
    "tex2d-256": () => { const d = data(layer); return () => { for (let i = 0; i < N; i++) { tex(T); gl.texStorage2D(T, 1, gl.RGBA8, S, S); gl.texSubImage2D(T, 0, 0, 0, S, S, RGBA, UB, d); } return d.length * N; }; },
    "tex2d-1100": () => { const W = 1100, d = data(W * W * 4); tex(T); return () => { gl.texStorage2D(T, 1, gl.RGBA8, W, W); gl.texSubImage2D(T, 0, 0, 0, W, W, RGBA, UB, d); return d.length; }; },
    "buffer-static": () => { const d = data(layer); return () => { for (let i = 0; i < N; i++) { gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW); } return d.length * N; }; },
    "buffer-dynamic": () => { const d = data(layer); return () => { for (let i = 0; i < N; i++) { gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW); } return d.length * N; }; },
  };
  if (!steps[name]) return { error: `no case ${name}` };
  const run = steps[name]();
  gl.readPixels(0, 0, 1, 1, RGBA, UB, new Uint8Array(4));
  const t = performance.now();
  const bytes = run();
  gl.finish();
  const finishMs = Math.round(performance.now() - t);
  gl.readPixels(0, 0, 1, 1, RGBA, UB, new Uint8Array(4));
  return { bytes, finishMs, syncMs: Math.round(performance.now() - t), glError: gl.getError(), renderer };
};

const browser = await chromium.launch({ channel: "chromium", headless: true, chromiumSandbox: false, args, env });
let failed = false;
try {
  for (const name of cases) {
    for (let run = 0; run < runs; run++) {
      const page = await browser.newPage();
      await page.goto("about:blank");
      const cpuPressure = pressure();
      const result = await page.evaluate(upload, { name, N: layers });
      if (result.error || result.glError) failed = true;
      console.log(JSON.stringify({ label, case: name, run, layers, ...result, cpuPressure, tunables: env.GLIBC_TUNABLES ?? null, args: args.join(" ") }));
      await page.close();
    }
  }
} finally {
  await browser.close();
}
if (failed) process.exit(1);
