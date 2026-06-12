/**
 * mcp-bridge-paths — resolves how the worker launches an internal stdio MCP
 * bridge, preferring a precompiled plain-JS bundle over the TypeScript source
 * (docs/199 / SHI-mcp-bridge-precompile).
 *
 * Each bridge (review/present/voice/ask/bug/permission) historically ran as
 * `tsx <bridge>.ts`, which pays a ~1.5-2s esbuild compile on every spawn. On a
 * session at the AGENT_DEFAULTS 0.5-CPU limit, the five bridges Claude spawns
 * contend for half a core and don't connect before the CLI's 2000ms headless
 * MCP pre-wait elapses — and because the permission bridge is the
 * `--permission-prompt-tool`, the CLI then exits 1 ("...permission_prompt...
 * not found"). `scripts/build-mcp-bridges.mjs` precompiles each bridge to a
 * self-contained bundle in `dist/mcp-bridges/`; running it with plain `node`
 * drops startup to ~0.3s and removes the per-spawn compile entirely.
 *
 * Resolution order:
 *   1. `dist/mcp-bridges/<basename>.js` — the precompiled bundle (prod image),
 *      launched with the current `node` (`process.execPath`). No tsx, no compile.
 *   2. `<basename>.ts` next to this module — the source, launched via the
 *      absolute-path `tsx` binary. Used in dev/local images that don't run the
 *      build step. Mirrors the `gh`/`shipit` shim tsx-by-absolute-path rationale.
 *   3. `null` — neither is present (stripped-down test image); the adapter omits
 *      the bridge rather than failing agent start.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How to launch a bridge: `command bridgePath`. For a precompiled bundle
 * `command` is the `node` binary; for `.ts` source it is the `tsx` binary. The
 * field is named `tsxBin` for historical reasons (it once only ever held tsx) —
 * the adapters consume it as the spawn command in both cases.
 */
export interface ResolvedBridge {
  tsxBin: string;
  bridgePath: string;
}

const SESSION_DIR = path.dirname(fileURLToPath(import.meta.url));
// <root>/src/server/session → <root>/dist/mcp-bridges
const COMPILED_DIR = path.resolve(SESSION_DIR, "../../../dist/mcp-bridges");
// <root>/src/server/session → <root>/node_modules/.bin/tsx
const TSX_BIN = path.resolve(SESSION_DIR, "../../../node_modules/.bin/tsx");

/** Overridable paths — defaults point at the real container layout; tests inject fixtures. */
export interface ResolveBridgeDirs {
  /** Directory holding the precompiled `<basename>.js` bundles. */
  compiledDir?: string;
  /** Directory holding the `<basename>.ts` source. */
  sourceDir?: string;
  /** The `node` binary used to run a compiled bundle. */
  nodeBin?: string;
  /** The `tsx` binary used to run `.ts` source. */
  tsxBin?: string;
}

/**
 * Resolve the launch command + entry path for an internal MCP bridge by its base
 * name (e.g. `"mcp-shipit-bridge"`). Prefers the precompiled JS bundle and
 * falls back to the tsx-compiled source; returns null when neither exists.
 */
export function resolveBridge(basename: string, dirs: ResolveBridgeDirs = {}): ResolvedBridge | null {
  const compiledDir = dirs.compiledDir ?? COMPILED_DIR;
  const sourceDir = dirs.sourceDir ?? SESSION_DIR;
  const nodeBin = dirs.nodeBin ?? process.execPath;
  const tsxBin = dirs.tsxBin ?? TSX_BIN;

  const compiled = path.join(compiledDir, `${basename}.js`);
  if (fs.existsSync(compiled)) {
    return { tsxBin: nodeBin, bridgePath: compiled };
  }
  const source = path.join(sourceDir, `${basename}.ts`);
  if (fs.existsSync(source) && fs.existsSync(tsxBin)) {
    return { tsxBin, bridgePath: source };
  }
  return null;
}
