// Prefer compiled bundles: per-spawn tsx compilation can exceed CLI MCP startup waits.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolvedBridge {
  /** Launch command: node for bundles, tsx for source. */
  tsxBin: string;
  bridgePath: string;
}

const SESSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPILED_DIR = path.resolve(SESSION_DIR, "../../../dist/mcp-bridges");
const TSX_BIN = path.resolve(SESSION_DIR, "../../../node_modules/.bin/tsx");

export interface ResolveBridgeDirs {
  compiledDir?: string;
  sourceDir?: string;
  nodeBin?: string;
  tsxBin?: string;
}

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
