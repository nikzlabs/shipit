/**
 * build-mcp-bridges — precompile the consolidated internal stdio MCP bridge to a
 * self-contained plain-JS bundle at image-build time (docs/199; SHI-126 fix +
 * SHI-128 consolidation).
 *
 * WHY: the bridge ships as TypeScript and is spawned by the agent CLI. Under
 * `tsx <bridge>.ts` it compiles with esbuild on every spawn — a ~1.5-2s,
 * CPU-bound cost. It starts concurrently with the CLI, the worker, and the
 * Playwright MCP server inside ONE container cgroup. On a session at the
 * AGENT_DEFAULTS limits (0.5 CPU) the tsx compile contends for half a core and
 * didn't finish before the Claude CLI's 2000ms headless MCP pre-wait elapsed.
 * The permission tool is wired as `--permission-prompt-tool`, so when it isn't
 * connected in time the CLI exits 1 with
 * "MCP tool mcp__shipit__permission_prompt ... not found" and the turn fails.
 * Playwright never fails because it ships as prebuilt JS — no compile.
 *
 * THE FIX: bundle to a single self-contained ESM file (the
 * @modelcontextprotocol/sdk is inlined, so there is zero runtime node_modules
 * dependency) and run it with plain `node`. Measured startup drops from
 * ~1.7s (idle) / ~3.0s (under CPU contention harsher than 0.5 CPU) for tsx to
 * ~0.3s / ~0.74s for the compiled bundle — comfortably inside the 2000ms window.
 *
 * SHI-128 then collapsed the five per-tool bridges into ONE `mcp-shipit-bridge`
 * server (selected subset via the SHIPIT_MCP_TOOLS env), so there is a single
 * entry/bundle here now instead of six.
 *
 * The worker's `resolveBridge()` (mcp-bridge-paths.ts) prefers the compiled
 * bundle and falls back to running the `.ts` source through tsx when it is
 * absent (dev images, local mode), so building is a pure prod-image optimization.
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionDir = path.join(root, "src/server/session");
const outdir = path.join(root, "dist/mcp-bridges");

// Single consolidated bridge (SHI-128). Keep in sync with session-worker.ts's
// resolveBridge("mcp-shipit-bridge"). Bundling pulls in the mcp-tools/* modules.
const BRIDGES = ["mcp-shipit-bridge"];

const t0 = performance.now();
await build({
  entryPoints: BRIDGES.map((b) => path.join(sessionDir, `${b}.ts`)),
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Some transitive deps of the MCP SDK use CommonJS `require`; expose it in the
  // ESM output so the bundle runs under `node` with no external resolution.
  banner: {
    js: "import{createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);",
  },
  logLevel: "warning",
});

console.log(
  `[build-mcp-bridges] bundled ${BRIDGES.length} bridges → ${path.relative(root, outdir)} in ${(performance.now() - t0).toFixed(0)}ms`,
);
