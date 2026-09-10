import type { LoginIntegrationId } from "../../catalogue/types.js";

/** Stops this session's turn; the sign-in URL follows on global SSE. */
export interface WsAuthRequired {
  type: "auth_required";
}

export type AgentAuthPendingDetails =
  | {
      kind: "code-paste-url";
      verificationUri: string;
    }
  | {
      kind: "device-code";
      verificationUri: string;
      userCode: string;
      expiresInSec: number;
    };

export interface WsAgentAuthPending {
  type: "agent_auth_pending";
  loginId: LoginIntegrationId;
  accountId?: string;
  details: AgentAuthPendingDetails;
}

export interface WsAgentAuthComplete {
  type: "agent_auth_complete";
  loginId: LoginIntegrationId;
  accountId?: string;
}

export interface WsAgentAuthFailed {
  type: "agent_auth_failed";
  loginId: LoginIntegrationId;
  accountId?: string;
  /** duplicate can remove the account row; show its message outside that row. */
  reason?: "timeout" | "denied" | "error" | "revoked" | "missing_credentials" | "duplicate";
  message?: string;
}

export type AgentAuthPhase =
  | "starting"
  | "waiting_for_cli"
  | "skipping_setup"
  | "waiting_for_url"
  | "waiting_for_code"
  | "checking_credentials"
  | "complete"
  | "failed";

export interface WsAgentAuthProgress {
  type: "agent_auth_progress";
  loginId: LoginIntegrationId;
  accountId?: string;
  attemptId: string;
  phase: AgentAuthPhase;
  message: string;
  elapsedMs?: number;
}

export interface WsAgentAuthLog {
  type: "agent_auth_log";
  loginId: LoginIntegrationId;
  accountId?: string;
  attemptId: string;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  source: "shipit" | "claude_stdout" | "claude_stderr" | "claude_control";
  message: string;
}
