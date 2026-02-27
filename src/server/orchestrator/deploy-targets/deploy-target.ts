import type { DeployTargetInfo } from "../../shared/types.js";

/** Context passed to deploy(). Everything the target needs. */
export interface DeployContext {
  workspaceDir: string;
  outputDir: string;
  credentials: Record<string, string>;
  environment: "production" | "preview";
  projectName: string;
  /** Emit a log line (streamed to terminal panel). */
  log: (text: string) => void;
  /** Signal from the manager — abort was requested. */
  signal: AbortSignal;
}

export interface DeployResult {
  url: string;
  environment: "production" | "preview";
  durationMs: number;
}

/** The interface every deployment target implements. */
export interface DeployTarget {
  /** Static metadata (id, name, config fields). */
  readonly info: DeployTargetInfo;

  /**
   * Optional pre-deploy hook. Called before deploy() — use for project
   * creation, resource provisioning, etc. Idempotent (safe to call every time).
   */
  prepare?(ctx: DeployContext): Promise<void>;

  /** Run the deployment. Return the live URL on success, throw on failure. */
  deploy(ctx: DeployContext): Promise<DeployResult>;
}
