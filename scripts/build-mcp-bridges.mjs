// Precompile to avoid missing the CLI's MCP startup deadline under CPU contention.
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionDir = path.join(root, "src/server/session");
const outdir = path.join(root, "dist/mcp-bridges");

const BRIDGES = ["mcp-shipit-bridge"];

const t0 = performance.now();
await build({
  entryPoints: BRIDGES.map((b) => path.join(sessionDir, `${b}.ts`)),
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Transitive SDK dependencies still call CommonJS require.
  banner: {
    js: "import{createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);",
  },
  logLevel: "warning",
});

console.log(
  `[build-mcp-bridges] bundled ${BRIDGES.length} bridges → ${path.relative(root, outdir)} in ${(performance.now() - t0).toFixed(0)}ms`,
);
