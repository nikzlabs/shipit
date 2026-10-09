import type { AgentId } from "../agent-types.js";
import type { PermissionMode } from "../attachment-types.js";
import type { BillingMode } from "../../catalogue/types.js";
import type { SessionCapabilities } from "./session.js";

/**
 * Every choice a user makes when starting a session, apart from where and what
 * (docs/324-scheduled-sessions). A key added here must be applied
 * (`START_PARAM_APPLIERS`) and described (`START_PARAM_LABELS`) before it compiles.
 */
export interface SessionStartParams {
  /** Replaces the harness, model, service, billing mode and reasoning. */
  role?: string;
  agent?: AgentId;
  model?: string;
  serviceId?: string;
  billingMode?: BillingMode;
  reasoning?: string;
  permissionMode?: PermissionMode;
  /** True: contained; false: open; null: inherit the workspace setting. */
  networkMode?: boolean | null;
  /** Granted SSH destinations, by host id (docs/305-ssh-hosts). */
  sshHosts?: string[];
  /** Quick Capture's "Auto-merge when ready". */
  armAutoMerge?: boolean;
}

export type SessionStartTarget =
  | { kind: "repo"; repoUrl: string }
  | { kind: "sandbox"; capabilities: SessionCapabilities };

export interface SessionStartSpec {
  target: SessionStartTarget;
  params: SessionStartParams;
  prompt: string;
}
