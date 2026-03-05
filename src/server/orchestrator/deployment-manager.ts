import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import type { DeployTarget, DeployContext, DeployResult } from "./deploy-targets/deploy-target.js";
import type { DeployTargetInfo } from "../shared/types.js";
import { getErrorMessage } from "../shared/utils.js";

export interface FrameworkInfo {
  name: string;
  buildCommand: string;
  outputDirectory: string;
}

export class DeploymentManager extends EventEmitter {
  private targets = new Map<string, DeployTarget>();
  private abortController: AbortController | null = null;
  private _deploying = false;

  get deploying(): boolean {
    return this._deploying;
  }

  /** Register a deployment target. Called at startup. */
  register(target: DeployTarget): void {
    if (this.targets.has(target.info.id)) {
      throw new Error(`Deploy target "${target.info.id}" is already registered`);
    }
    this.targets.set(target.info.id, target);
  }

  /** Return metadata for all registered targets (sent to client for UI rendering). */
  getTargets(): DeployTargetInfo[] {
    return Array.from(this.targets.values()).map((t) => t.info);
  }

  /** Look up a target by ID. Returns undefined if not registered. */
  getTarget(targetId: string): DeployTarget | undefined {
    return this.targets.get(targetId);
  }

  /** Detect framework from package.json and project structure. */
  async detectFramework(workspaceDir: string): Promise<FrameworkInfo> {
    const pkgPath = path.join(workspaceDir, "package.json");

    if (!existsSync(pkgPath)) {
      return { name: "static", buildCommand: "", outputDirectory: "." };
    }

    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8")) as Record<string, Record<string, string> & { build?: string }> & { scripts?: { build?: string }; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Next.js
      if (deps.next) {
        return { name: "next", buildCommand: "npm run build", outputDirectory: ".next" };
      }

      // Vite (most ShipIt templates)
      if (deps.vite) {
        return { name: "vite", buildCommand: "npm run build", outputDirectory: "dist" };
      }

      // Create React App
      if (deps["react-scripts"]) {
        return { name: "cra", buildCommand: "npm run build", outputDirectory: "build" };
      }

      // Has a build script but unknown framework
      if (pkg.scripts?.build) {
        return { name: "unknown", buildCommand: "npm run build", outputDirectory: "dist" };
      }

      // No build script → treat as static
      return { name: "static", buildCommand: "", outputDirectory: "." };
    } catch {
      return { name: "static", buildCommand: "", outputDirectory: "." };
    }
  }

  /** Run the project's build command. Returns true on success. */
  async build(workspaceDir: string, buildCommand: string): Promise<boolean> {
    if (!buildCommand) return true;

    return new Promise((resolve) => {
      const [cmd, ...args] = buildCommand.split(" ");
      const proc = spawn(cmd, args, {
        cwd: workspaceDir,
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      });

      proc.stdout.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n").filter(Boolean)) {
          this.emit("log", { text: line });
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n").filter(Boolean)) {
          this.emit("log", { text: line });
        }
      });

      proc.on("close", (code) => {
        resolve(code === 0);
      });

      proc.on("error", () => {
        resolve(false);
      });
    });
  }

  /**
   * Deploy to a registered target. This is the single entry point for all
   * deployments regardless of platform.
   */
  async deploy(targetId: string, ctx: Omit<DeployContext, "log" | "signal">): Promise<DeployResult> {
    const target = this.targets.get(targetId);
    if (!target) throw new Error(`Unknown deploy target: "${targetId}"`);
    if (this._deploying) throw new Error("Deployment already in progress");

    this._deploying = true;
    this.abortController = new AbortController();

    const fullCtx: DeployContext = {
      ...ctx,
      log: (text: string) => this.emit("log", { text }),
      signal: this.abortController.signal,
    };

    try {
      this.emit("status", { phase: "deploying" });

      // Optional pre-deploy hook (project creation, etc.)
      if (target.prepare) {
        await target.prepare(fullCtx);
      }

      const result = await target.deploy(fullCtx);
      this.emit("complete", { ...result, targetId });
      return result;
    } catch (err: unknown) {
      this.emit("error", { message: getErrorMessage(err), phase: "deploying" });
      throw err;
    } finally {
      this._deploying = false;
      this.abortController = null;
    }
  }

  /** Cancel an in-progress deployment. */
  cancel(): void {
    this.abortController?.abort();
  }
}
