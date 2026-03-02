import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const INSTALL_MARKER_DIR = ".shipit";
const INSTALL_MARKER_FILE = ".install-done";

/**
 * Parse the `install` field from a shipit.yaml content string.
 * Returns the install command string or undefined if not present/invalid.
 */
export function parseInstallCommand(yamlContent: string): string | undefined {
  // Simple line-based parsing — avoids requiring the `yaml` package
  // which isn't installed yet. Handles the common case:
  //   install: npm install
  for (const line of yamlContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("install:")) {
      const value = trimmed.slice("install:".length).trim();
      return value || undefined;
    }
  }
  return undefined;
}

/**
 * Check whether the install step has already completed for a workspace
 * by looking for the `.shipit/.install-done` marker file.
 */
export function isInstallDone(workspaceDir: string): boolean {
  const markerPath = path.join(workspaceDir, INSTALL_MARKER_DIR, INSTALL_MARKER_FILE);
  return fs.existsSync(markerPath);
}

/**
 * Write the install-done marker after a successful install.
 */
export function markInstallDone(workspaceDir: string): void {
  const dir = path.join(workspaceDir, INSTALL_MARKER_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, INSTALL_MARKER_FILE),
    new Date().toISOString(),
    "utf-8",
  );
}

/**
 * Clear the install-done marker so install will re-run next time.
 */
export function clearInstallMarker(workspaceDir: string): void {
  const markerPath = path.join(workspaceDir, INSTALL_MARKER_DIR, INSTALL_MARKER_FILE);
  try {
    fs.unlinkSync(markerPath);
  } catch {
    // Marker doesn't exist — nothing to clear
  }
}

/**
 * Delete node_modules in the given workspace directory.
 * Used for native module crash recovery — a fresh install ensures the
 * correct platform-specific binaries are resolved.
 */
export function deleteNodeModules(workspaceDir: string): void {
  const nodeModulesDir = path.join(workspaceDir, "node_modules");
  try {
    fs.rmSync(nodeModulesDir, { recursive: true, force: true });
    console.log("[install-runner] Deleted node_modules for clean reinstall");
  } catch {
    // May not exist — that's fine
  }
}

export interface RunInstallOptions {
  /** Shell command to run (e.g. "npm install"). */
  command: string;
  /** Working directory. */
  cwd: string;
  /** Called with each line of stdout/stderr output. */
  onOutput?: (text: string) => void;
}

/**
 * Run an install command as a child process.
 * Resolves with the exit code (0 = success).
 */
export function runInstallCommand(opts: RunInstallOptions): Promise<number> {
  const { command, cwd, onOutput } = opts;

  return new Promise((resolve, reject) => {
    const proc = spawn("sh", ["-c", command], {
      cwd,
      // Force npm to re-evaluate optional dependencies for the current
      // platform.  Without this, npm may skip platform-specific native
      // binaries (e.g. @rollup/rollup-linux-arm64-gnu) when a lock file
      // generated on another OS/arch is present.
      // See https://github.com/npm/cli/issues/4828
      env: { ...process.env, npm_config_force: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (onOutput) onOutput(text);
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (onOutput) onOutput(text);
    });

    proc.on("close", (code) => {
      resolve(code ?? 1);
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}
