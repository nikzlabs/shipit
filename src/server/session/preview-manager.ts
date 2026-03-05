import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ERROR_CAPTURE_SCRIPT } from "./vite-error-plugin.js";
import { checkPort } from "./port-scanner.js";
import { resolvePreviewConfig, PreviewConfigError } from "./preview-config.js";
import type { PreviewConfig } from "./preview-config.js";
import {
  isInstallDone,
  markInstallDone,
  clearInstallMarker,
  runInstallCommand,
  deleteNodeModules,
} from "./install-runner.js";
import { getErrorMessage } from "../shared/utils.js";

const VITE_PORT = 5173;

/**
 * Extract missing native module name from a crash caused by a platform
 * mismatch (e.g. @rollup/rollup-linux-arm64-gnu). Returns the npm package
 * name or null if the crash is not a native module issue.
 *
 * This happens when `package-lock.json` was generated on a different OS/arch
 * and npm didn't install the correct optional dependency for the container.
 */
export function extractMissingNativeModule(output: string): string | null {
  // Match: Cannot find module '@rollup/rollup-linux-arm64-gnu'
  // Match: Cannot find module @esbuild/linux-arm64
  const match = /Cannot find module ['"]?(@(?:rollup|esbuild|swc|parcel)\/[a-z0-9_-]+)/i.exec(output);
  if (match) return match[1];
  // Fallback: rollup's own error message referencing the npm optional deps bug
  // but no parseable module name — caller should use the generic recovery path.
  if (output.includes("npm has a bug related to optional dependencies")) return "";
  return null;
}

/**
 * Check if an exit code indicates a signal-killed process whose native binary
 * is likely corrupted or built for the wrong platform (e.g. musl binary on
 * glibc, wrong arch).  Exit code = 128 + signal number on Linux:
 *   SIGBUS  (7)  → 135 — bad memory access (wrong libc, corrupted binary)
 *   SIGILL  (4)  → 132 — illegal instruction (wrong arch)
 *   SIGSEGV (11) → 139 — segfault (corrupted binary)
 *   SIGABRT (6)  → 134 — assertion failure in native code
 */
export function isNativeBinarySignalCrash(exitCode: number): boolean {
  return exitCode === 135 || exitCode === 132 || exitCode === 139 || exitCode === 134;
}

/** Max time (ms) after process start to consider a crash "immediate". */
const QUICK_CRASH_THRESHOLD_MS = 10_000;

// Resolve the vite binary from the project's own node_modules so we never
// trigger an npx download when spawning in /workspace.
const VITE_BIN = path.resolve(process.cwd(), "node_modules/.bin/vite");

// Resolve the absolute path to vite's ESM entry so the wrapper config written
// to /workspace/.shipit/ can import it regardless of node_modules layout.
const _require = createRequire(import.meta.url);
const VITE_MODULE_PATH = _require.resolve("vite");

/** Max time to wait for a port to open (ms). */
const PORT_POLL_TIMEOUT = 30_000;
/** Interval between port checks (ms). */
const PORT_POLL_INTERVAL = 500;

/**
 * Generate the contents of a Vite wrapper config that loads the user's
 * existing config (if any), merges in the ShipIt error-capture plugin,
 * and sets the dev server port/host.
 */
function generateWrapperConfig(script: string): string {
  const escapedScript = JSON.stringify(script);
  const escapedVitePath = JSON.stringify(VITE_MODULE_PATH);
  return `
const _vitePath = ${escapedVitePath};
const { loadConfigFromFile, mergeConfig, defineConfig } = await import(_vitePath);

const SCRIPT = ${escapedScript};

const shipitPlugin = {
  name: 'shipit-error-capture',
  transformIndexHtml(html) {
    const i = html.indexOf('<head>');
    if (i !== -1) {
      const p = i + 6;
      return html.slice(0, p) + '\\n' + SCRIPT + '\\n' + html.slice(p);
    }
    return SCRIPT + '\\n' + html;
  }
};

let base = {};
try {
  const r = await loadConfigFromFile({ command: 'serve', mode: 'development' });
  if (r) base = r.config;
} catch {}

export default mergeConfig(base, defineConfig({ plugins: [shipitPlugin] }));
`.trimStart();
}

/**
 * Config-driven preview manager that replaces ViteManager.
 *
 * Reads shipit.yaml (or falls back to package.json / index.html) to determine
 * the correct preview command. Supports two modes:
 * - "html" mode: serves static files with ShipIt's bundled Vite binary
 * - "command" mode: runs an arbitrary shell command (e.g. `npm run dev`)
 *
 * Also handles the install step before starting the preview if configured.
 *
 * Events:
 *   "ready"          — preview server is accepting connections (ports: number[])
 *   "stopped"        — preview process exited (code: number | null)
 *   "error"          — spawn/runtime error (err: Error)
 *   "config_missing" — no valid config found
 *   "config_error"   — shipit.yaml is malformed (message: string)
 *   "install_status" — install step status change ({ status, message? })
 *   "log"            — log output from preview/install process ({ source, text })
 */
export class PreviewManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private installProc: ChildProcess | null = null;
  private _running = false;
  private _ports: number[] = [];
  private _config: PreviewConfig | null = null;
  private _workspaceDir: string | null = null;
  /** Timestamp when the preview process was spawned (for quick-crash detection). */
  private _processStartTime = 0;
  /** Buffered process output for native module crash detection. */
  private _processLogs: string[] = [];
  /** Whether we've already retried once for a native module crash (prevents infinite loop). */
  private _nativeModuleRetried = false;

  get running(): boolean {
    return this._running;
  }

  /** All ports this preview is serving on. First is primary. */
  get ports(): number[] {
    return this._ports;
  }

  /** Primary port (first in the list), or null if not running. */
  get port(): number | null {
    return this._ports.length > 0 ? this._ports[0] : null;
  }

  get config(): PreviewConfig | null {
    return this._config;
  }

  /**
   * Write the ShipIt Vite wrapper config to the workspace's .shipit/ directory
   * so the error-capture plugin is injected into the preview HTML.
   */
  private writeWrapperConfig(workspaceDir: string): string {
    const dir = path.join(workspaceDir, ".shipit");
    const configPath = path.join(dir, "vite.config.mjs");
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(configPath, generateWrapperConfig(ERROR_CAPTURE_SCRIPT), "utf-8");
    } catch (err) {
      console.error("[preview-manager] failed to write wrapper config:", err);
    }
    return configPath;
  }

  /**
   * Resolve config and start the preview server.
   * For "html" mode, uses ShipIt's bundled Vite binary with the wrapper
   * config (error-capture plugin). For "command" mode, spawns via shell.
   */
  async start(workspaceDir: string): Promise<void> {
    if (this.proc) return;

    this._workspaceDir = workspaceDir;

    let config: PreviewConfig;
    try {
      config = await resolvePreviewConfig(workspaceDir);
    } catch (err) {
      if (err instanceof PreviewConfigError) {
        this.emit("config_error", err.message);
        return;
      }
      throw err;
    }

    this._config = config;

    if (config.source === "none") {
      this.emit("config_missing", ["shipit.yaml", "package.json"]);
      return;
    }

    // ---- Install step ----
    console.log("[preview-manager] config source:", config.source, "install:", config.install ?? "(none)");
    if (config.install) {
      const installDone = isInstallDone(workspaceDir);
      console.log("[preview-manager] install needed, isInstallDone:", installDone);
      if (!installDone) {
        this.emit("install_status", { status: "running" });

        const cwd = config.mode.kind === "command" && config.mode.directory
          ? path.resolve(workspaceDir, config.mode.directory)
          : workspaceDir;

        try {
          const exitCode = await runInstallCommand({
            command: config.install,
            cwd,
            onOutput: (text) => {
              this.emit("log", { source: "install", text });
            },
          });

          if (exitCode !== 0) {
            this.emit("install_status", {
              status: "error",
              message: `Install command exited with code ${exitCode}`,
            });
            return; // Do not start preview
          }

          markInstallDone(workspaceDir);
          this.emit("install_status", { status: "complete" });
        } catch (err) {
          this.emit("install_status", {
            status: "error",
            message: `Install failed: ${getErrorMessage(err)}`,
          });
          return;
        }
      }
    }

    // ---- Start preview ----
    if (config.mode.kind === "html") {
      this.startHtmlMode(workspaceDir);
    } else {
      this.startCommandMode(workspaceDir, config.mode);
    }
  }

  /**
   * Start the bundled Vite binary for static HTML serving with error capture.
   */
  private startHtmlMode(workspaceDir: string): void {
    console.log("[preview-manager] starting HTML mode (bundled Vite) on port", VITE_PORT, "in", workspaceDir);

    this._processStartTime = Date.now();
    this._processLogs = [];

    const configPath = this.writeWrapperConfig(workspaceDir);

    this.proc = spawn(
      VITE_BIN,
      ["--config", configPath, "--port", String(VITE_PORT), "--host", "0.0.0.0"],
      {
        cwd: workspaceDir,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this._processLogs.push(text);
      console.log("[vite]", text.trim());
      this.emit("log", { source: "preview", text });

      if (text.includes("Local:") || text.includes("ready in")) {
        if (!this._running) {
          this._running = true;
          this._ports = [VITE_PORT];
          this.emit("ready", this._ports);
        }
      }
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        this._processLogs.push(text);
        console.error("[vite stderr]", text);
        this.emit("log", { source: "preview", text });
      }
    });

    this.wireProcessEvents(this.proc, "Vite");
  }

  /**
   * Start a command-mode preview by spawning the configured shell command.
   */
  private startCommandMode(
    workspaceDir: string,
    mode: { command: string; ports?: number[]; directory?: string },
  ): void {
    const cwd = mode.directory
      ? path.resolve(workspaceDir, mode.directory)
      : workspaceDir;

    this._processStartTime = Date.now();
    this._processLogs = [];

    console.log("[preview-manager] starting command mode:", mode.command, "in", cwd);

    this.proc = spawn("sh", ["-c", mode.command], {
      cwd,
      // HOST=0.0.0.0 tells many frameworks (CRA, Angular, Flask) to bind to
      // all interfaces — required in Docker where the browser connects through
      // port mapping rather than localhost.
      env: { ...process.env, HOST: "0.0.0.0" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this._processLogs.push(text);
      console.log("[preview]", text.trim());
      this.emit("log", { source: "preview", text });

      // Auto-detect the listening port from common dev server output patterns
      // (e.g. "http://localhost:5173", "http://127.0.0.1:3000").
      if (!this._running) {
        const portMatch = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(text);
        if (portMatch) {
          const port = Number(portMatch[1]);
          if (port > 0 && port <= 65535) {
            this._running = true;
            this._ports = [port];
            this.emit("ready", this._ports);
          }
        }
      }
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        this._processLogs.push(text);
        console.error("[preview stderr]", text);
        this.emit("log", { source: "preview", text });
      }
    });

    this.wireProcessEvents(this.proc, "command");

    // Poll for explicit ports if configured; otherwise rely on stdout detection
    // above (which catches the actual port even when Vite falls back to 5175+).
    if (mode.ports && mode.ports.length > 0) {
      this.pollPorts(mode.ports);
    }
  }

  /**
   * Poll specified ports until they open, then emit "ready".
   */
  private pollPorts(ports: number[]): void {
    const startTime = Date.now();
    const found = new Set<number>();

    const poll = async () => {
      if (!this.proc) return; // Process was stopped

      for (const port of ports) {
        if (found.has(port)) continue;
        const open = await checkPort(port);
        if (open) {
          found.add(port);
          if (!this._running) {
            this._running = true;
            this._ports = [port];
            this.emit("ready", this._ports);
          } else {
            this._ports = [...this._ports, port];
          }
        }
      }

      if (found.size < ports.length && Date.now() - startTime < PORT_POLL_TIMEOUT) {
        setTimeout(poll, PORT_POLL_INTERVAL);
      }
    };

    setTimeout(poll, PORT_POLL_INTERVAL);
  }

  /**
   * Wire close/error handlers on a spawned process.
   * Captures a reference to the process so that stale events from a
   * previously killed process cannot clobber the state of a newer one
   * (e.g. when stop() + start() run in quick succession).
   */
  private wireProcessEvents(proc: ChildProcess, label: string): void {
    proc.on("close", (code) => {
      if (this.proc !== proc) return; // stale event from a previous process
      console.log(`[preview-manager] ${label} exited with code`, code);

      // Detect native binary issues on quick crashes and auto-recover once.
      // Two patterns:
      //   1. "Cannot find module @rollup/..." — package missing, install it directly
      //   2. SIGBUS/SIGILL/SIGSEGV — binary installed but corrupted or wrong
      //      platform (e.g. musl on glibc), clean reinstall needed
      const isQuickCrash = code !== 0 && Date.now() - this._processStartTime < QUICK_CRASH_THRESHOLD_MS;
      if (isQuickCrash && !this._nativeModuleRetried && this._workspaceDir) {
        const output = this._processLogs.join("\n");
        const missingModule = extractMissingNativeModule(output);
        const signalCrash = code !== null && isNativeBinarySignalCrash(code);

        if (missingModule !== null || signalCrash) {
          this._nativeModuleRetried = true;
          this._running = false;
          this._ports = [];
          this.proc = null;

          if (missingModule) {
            // Install the specific missing package — fast and targeted
            console.log(`[preview-manager] Installing missing native module: ${missingModule}`);
            this.emit("install_status", {
              status: "running",
              message: `Installing missing native module: ${missingModule}`,
            });
            void (async () => {
              try {
                const exitCode = await runInstallCommand({
                  command: `npm install --no-save ${missingModule}`,
                  cwd: this._workspaceDir!,
                  onOutput: (text) => this.emit("log", { source: "install", text }),
                });
                if (exitCode !== 0) {
                  console.error(`[preview-manager] Failed to install ${missingModule} (exit ${exitCode})`);
                  this.emit("stopped", code);
                  return;
                }
                console.log(`[preview-manager] Installed ${missingModule}, retrying preview`);
                await this.start(this._workspaceDir!);
              } catch (err) {
                console.error("[preview-manager] Native module recovery failed:", err);
                this.emit("stopped", code);
              }
            })();
          } else {
            // Signal crash or generic npm bug — clean reinstall
            const reason = signalCrash ? `signal crash (exit ${code})` : "native module platform mismatch";
            console.log(`[preview-manager] ${reason} — cleaning node_modules and retrying`);
            deleteNodeModules(this._workspaceDir);
            clearInstallMarker(this._workspaceDir);
            this.emit("install_status", {
              status: "running",
              message: `Reinstalling — ${reason} detected`,
            });
            this.start(this._workspaceDir).catch((err) => {
              console.error("[preview-manager] Recovery failed:", err);
              this.emit("stopped", code);
            });
          }
          return; // Don't emit "stopped" — we're retrying
        }
      }

      this._running = false;
      this._ports = [];
      this.proc = null;
      this.emit("stopped", code);
    });

    proc.on("error", (err) => {
      if (this.proc !== proc) return;
      console.error(`[preview-manager] ${label} spawn error:`, err.message);
      this._running = false;
      this._ports = [];
      this.proc = null;
      this.emit("error", err);
    });
  }

  /**
   * Stop the running preview process.
   */
  stop(): void {
    if (this.proc) {
      console.log("[preview-manager] stopping preview process");
      // Kill the entire process group (negative PID) so child processes
      // spawned by the shell (npm → node → vite) are also terminated.
      // Command-mode processes are spawned with detached: true to get their
      // own process group.
      const pid = this.proc.pid;
      if (pid) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          // Process group may already be gone — fall back to direct kill
          this.proc.kill("SIGTERM");
        }
      } else {
        this.proc.kill("SIGTERM");
      }
      this.proc = null;
      this._running = false;
      this._ports = [];
    }
  }

  /**
   * Stop then start with the given workspace dir.
   */
  async restart(workspaceDir: string): Promise<void> {
    this.stop();
    // Clear install marker so install re-runs with potentially new config
    clearInstallMarker(workspaceDir);
    // Reset native module retry flag — this is a new user-initiated cycle
    this._nativeModuleRetried = false;
    await this.start(workspaceDir);
  }
}
