import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { ERROR_CAPTURE_SCRIPT } from "./vite-error-plugin.js";

const VITE_PORT = 5173;
const WORKSPACE_DIR = "/workspace";

// Resolve the vite binary from the project's own node_modules so we never
// trigger an npx download when spawning in /workspace.
const VITE_BIN = path.resolve(process.cwd(), "node_modules/.bin/vite");

/**
 * Generate the contents of a Vite wrapper config that loads the user's
 * existing config (if any), merges in the ShipIt error-capture plugin,
 * and sets the dev server port/host.
 */
function generateWrapperConfig(script: string): string {
  // The wrapper config is plain JavaScript (.mjs) that Vite can load directly.
  // It uses loadConfigFromFile to discover and merge the user's config.
  const escapedScript = JSON.stringify(script);
  return `
import { loadConfigFromFile, mergeConfig, defineConfig } from 'vite';

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

export class ViteManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private _running = false;
  private _port = VITE_PORT;

  get running(): boolean {
    return this._running;
  }

  get port(): number {
    return this._port;
  }

  /**
   * Write the ShipIt Vite wrapper config to the workspace's .shipit/ directory
   * so the error-capture plugin is injected into the preview HTML.
   */
  private writeWrapperConfig(workspaceDir?: string): string {
    const cwd = workspaceDir ?? WORKSPACE_DIR;
    const dir = path.join(cwd, ".shipit");
    const configPath = path.join(dir, "vite.config.mjs");
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(configPath, generateWrapperConfig(ERROR_CAPTURE_SCRIPT), "utf-8");
    } catch (err) {
      console.error("[vite-manager] failed to write wrapper config:", err);
    }
    return configPath;
  }

  /**
   * Start the Vite dev server.
   * If already running, this is a no-op.
   * @param workspaceDir - Working directory for Vite. Defaults to /workspace.
   */
  start(workspaceDir?: string): void {
    if (this.proc) return;

    const cwd = workspaceDir ?? WORKSPACE_DIR;
    console.log("[vite-manager] starting Vite dev server on port", this._port, "in", cwd);

    const configPath = this.writeWrapperConfig(workspaceDir);

    this.proc = spawn(VITE_BIN, ["--config", configPath, "--port", String(this._port), "--host", "0.0.0.0"], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      console.log("[vite]", text.trim());

      // Detect when Vite is ready (it prints the local URL)
      if (text.includes("Local:") || text.includes("ready in")) {
        if (!this._running) {
          this._running = true;
          this.emit("ready", this._port);
        }
      }
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error("[vite stderr]", text);
    });

    this.proc.on("close", (code) => {
      console.log("[vite-manager] Vite exited with code", code);
      this._running = false;
      this.proc = null;
      this.emit("stopped", code);
    });

    this.proc.on("error", (err) => {
      console.error("[vite-manager] spawn error:", err.message);
      this._running = false;
      this.proc = null;
      this.emit("error", err);
    });
  }

  /**
   * Stop the Vite dev server.
   */
  stop(): void {
    if (this.proc) {
      console.log("[vite-manager] stopping Vite dev server");
      this.proc.kill("SIGTERM");
      this.proc = null;
      this._running = false;
    }
  }

  /**
   * Restart the Vite dev server.
   * @param workspaceDir - Working directory for Vite. Defaults to /workspace.
   */
  restart(workspaceDir?: string): void {
    this.stop();
    this.start(workspaceDir);
  }
}
