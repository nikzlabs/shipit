// Usage: node run-link.mjs <label> [--n=200] [--mode=sync|poll|groups] [--group=50] [--draw-group=0] [--pairs=all|small|large]
//          [--animate] [--capture] [--env=K=V]… [chromium flags…]
// Starts one Chromium, then times link.html on: a first load, a reload with the same sources,
// a second reload with the same sources, and a reload with different sources.
// Each line also has the host's 1-minute load average at the start and the end of the load, and the card's use
// from nvidia-smi each 500 ms during it.
// PLAYWRIGHT_FROM: the node_modules directory that has playwright-core. Default: the session image's.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(path.join(process.env.PLAYWRIGHT_FROM ?? "/opt/agent-cli/node_modules", "/"));
const { chromium } = require("playwright-core");

const here = path.dirname(new URL(import.meta.url).pathname);
const argv = process.argv.slice(2);
const label = argv.shift();
const opt = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const n = Number(opt("n", "200"));
const mode = opt("mode", "sync");
const pageOpt = { group: Number(opt("group", "50")), drawGroup: Number(opt("draw-group", "0")), pairs: opt("pairs", "all"), animate: argv.includes("--animate") };
const capture = argv.includes("--capture");
const env = { ...process.env };
for (const a of argv.filter((x) => x.startsWith("--env="))) { const [k, ...v] = a.slice(6).split("="); env[k] = v.join("="); }
const args = argv.filter((x) => !/^--(n|mode|group|draw-group|pairs|env)=/.test(x) && x !== "--capture" && x !== "--animate");

const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const file = path.join(here, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(here) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// CPU seconds of the browser's GPU process, from /proc.
const tck = 100;
const gpuPids = () => {
  const out = [];
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try { if (fs.readFileSync(`/proc/${d}/cmdline`, "utf8").includes("--type=gpu-process")) out.push(Number(d)); } catch { /* the process ended */ }
  }
  return out;
};
const before = new Set(gpuPids());
const gpuPid = () => gpuPids().find((p) => !before.has(p)) ?? null;
const mesaLibs = (pid) => { try { return [...new Set(fs.readFileSync(`/proc/${pid}/maps`, "utf8").split("\n").map((l) => l.split(" ").pop()).filter((f) => /libgallium|_dri\.so|libEGL_mesa|libnvidia|libnvwgf|libd3d12/.test(f)))]; } catch { return []; } };
const threadCpu = (pid) => { const out = {}; try { for (const tid of fs.readdirSync(`/proc/${pid}/task`)) { const f = fs.readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8"); const comm = f.slice(f.indexOf("(") + 1, f.lastIndexOf(")")); const r = f.slice(f.lastIndexOf(")") + 2).split(" "); out[`${comm}:${tid}`] = (Number(r[11]) + Number(r[12])) / tck; } } catch { /* the process ended */ } return out; };
const cpu = (pid) => { try { const f = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); return (Number(f[11]) + Number(f[12])) / tck; } catch { return NaN; } };
const load = () => Math.round(os.loadavg()[0] * 10) / 10;
// Starts nvidia-smi; the async function it returns stops it and gives min, mean and max of the card's use in %, or null.
const sampleCard = () => {
  let text = "";
  const child = spawn("nvidia-smi", ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits", "-lms", "500"], { stdio: ["ignore", "pipe", "ignore"] });
  const closed = new Promise((r) => { child.on("close", r); child.on("error", r); });
  child.stdout?.on("data", (d) => { text += d; });
  const within = (ms) => Promise.race([closed.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);
  return async () => {
    if (child.pid && child.exitCode === null) {
      child.kill();
      if (!(await within(2000))) { child.kill("SIGKILL"); if (!(await within(2000))) console.error(`nvidia-smi ${child.pid} did not stop`); }
    }
    const v = text.split("\n").map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number);
    return v.length ? { min: Math.min(...v), mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length), max: Math.max(...v), samples: v.length } : null;
  };
};

const browser = await chromium.launch({ headless: true, chromiumSandbox: false, channel: "chromium", args, env });
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
  if (capture) {
    await page.goto(`${base}/capture.html`);
    await page.waitForFunction(() => window.__done, null, { timeout: 120000 });
    const pairs = await page.evaluate(() => window.__pairs);
    const seen = new Set();
    const uniq = pairs.filter((p) => p.vs && p.fs && !seen.has(p.vs + p.fs) && seen.add(p.vs + p.fs));
    fs.writeFileSync(path.join(here, "sources.json"), JSON.stringify(uniq));
    console.log(JSON.stringify({ label, captured: pairs.length, unique: uniq.length, bytes: uniq.map((p) => p.vs.length + p.fs.length) }));
  } else {
    const steps = [["first load", 1], ["reload, same sources", 1], ["reload, same sources", 1], ["reload, new sources", 2]];
    for (const [name, salt] of steps) {
      if (name === "first load") await page.goto(`${base}/link.html`); else await page.reload();
      const pid = gpuPid();
      const load0 = load(), stopCard = sampleCard();
      let r, wall, c0, c1, th0, th1, card;
      try {
        c0 = cpu(pid); th0 = threadCpu(pid);
        const t0 = Date.now();
        r = await page.evaluate(([nn, s, m, o]) => window.run(nn, s, m, o), [n, salt, mode, pageOpt]);
        wall = (Date.now() - t0) / 1000;
        c1 = cpu(pid); th1 = threadCpu(pid);
      } finally {
        card = await stopCard();
      }
      if (r.error || r.failed) process.exitCode = 1;
      const threads = Object.fromEntries(Object.entries(th1).map(([k, v]) => [k, Math.round((v - (th0[k] ?? 0)) * 100) / 100]).filter(([, v]) => v >= 0.05).sort((a, b) => b[1] - a[1]));
      console.log(JSON.stringify({ label, step: name, ...r, gpuProcCpuS: Math.round((c1 - c0) * 100) / 100, libs: name === "first load" ? mesaLibs(pid) : undefined, threads, wallS: Math.round(wall * 100) / 100, loadavg: [load0, load()], cardUse: card }));
    }
  }
} finally {
  await browser.close();
  server.close();
}
