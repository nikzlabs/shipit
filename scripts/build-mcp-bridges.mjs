/**
 * build-mcp-bridges — precompile the internal stdio MCP bridges to self-contained
 * plain-JS bundles at image-build time (docs/199 / SHI-mcp-bridge-precompile).
 *
 * WHY: each bridge ships as TypeScript and is spawned by the agent CLI via
 * `tsx <bridge>.ts`. tsx compiles the file with esbuild on every spawn — a
 * ~1.5-2s, CPU-bound cost PER bridge. Claude registers five of them
 * (review/present/voice/bug/permission) and they all start concurrently with the
 * CLI, the worker, and the Playwright MCP server inside ONE container cgroup.
 * On a session at the AGENT_DEFAULTS limits (0.5 CPU) those five tsx compiles
 * contend for half a core and don't finish before the Claude CLI's 2000ms
 * headless MCP pre-wait elapses. The permission bridge is wired as
 * `--permission-prompt-tool`, so when it isn't connected in time the CLI exits 1
 * with "MCP tool mcp__shipit-permission__permission_prompt ... not found" and the
 * turn fails. Playwright never fails because it ships as prebuilt JS — no compile.
 *
 * THE FIX: bundle each bridge to a single self-contained ESM file (the
 * @modelcontextprotocol/sdk is inlined, so there is zero runtime node_modules
 * dependency) and run it with plain `node`. Measured startup drops from
 * ~1.7s (idle) / ~3.0s (under CPU contention harsher than 0.5 CPU) for tsx to
 * ~0.3s / ~0.74s for the compiled bundle — comfortably inside the 2000ms window.
 *
 * The worker's `resolveBridge()` (mcp-bridge-paths.ts) prefers these compiled
 * bundles and falls back to running the `.ts` source through tsx when they are
 * absent (dev images, local mode), so building is a pure prod-image optimization.
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionDir = path.join(root, "src/server/session");
const outdir = path.join(root, "dist/mcp-bridges");

// Keep this list in sync with the bridges resolved in session-worker.ts.
const BRIDGES = [
  "mcp-review-bridge",
  "mcp-present-bridge",
  "mcp-voice-bridge",
  "mcp-ask-bridge",
  "mcp-bug-bridge",
  "mcp-permission-bridge",
];

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
