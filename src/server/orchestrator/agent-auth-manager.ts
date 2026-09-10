import type { EventEmitter } from "node:events";
import type { LoginIntegrationId } from "../shared/catalogue/types.js";
import type { AgentAuthPendingDetails } from "../shared/types/ws-server-messages.js";
import type {
  AgentAuthLogPayload,
  AgentAuthProgressPayload,
} from "./agents/claude/auth-diagnostics.js";

export interface AgentAuthFailedPayload {
  reason?: "timeout" | "denied" | "error" | "revoked" | "duplicate";
  message?: string;
}

export interface AgentAuthStartOptions {
  accountId: string;
  /** Account root with a HOME-compatible credential layout. */
  credentialDir: string;
}

export interface AgentAuthScopeOptions {
  /** Omit for the legacy singleton path. */
  credentialDir?: string;
}

export interface AgentAuthManager extends EventEmitter<AgentAuthManagerEvents> {
  readonly loginId: LoginIntegrationId;

  /** No-op if a flow is in progress; may replay its pending state. */
  start(opts: AgentAuthStartOptions): void;

  cancel(): void;

  submitCode?(code: string): void;

  signOut(opts?: AgentAuthScopeOptions): void;

  isConfigured(opts?: AgentAuthScopeOptions): boolean;

  /** Read synchronously in event handlers; can identify a flow that just finished. */
  getActiveAccountId(): string | null;

  kill(): void;

  /** Replayed to new SSE clients; null when no replay is available. */
  getPendingPayload(): AgentAuthPendingDetails | null;
}

export interface AgentAuthManagerEvents {
  pending: [details: AgentAuthPendingDetails];
  complete: [];
  failed: [payload?: AgentAuthFailedPayload];
  progress: [payload: AgentAuthProgressPayload];
  log: [payload: AgentAuthLogPayload];
}
