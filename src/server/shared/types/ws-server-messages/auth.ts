import type { AgentId } from "../agent-types.js";

// ---- Auth types ----

/**
 * Per-session WS message: the agent CLI signalled `auth_required` during a
 * turn, so the orchestrator killed the turn and is kicking off the
 * appropriate auth flow. Stops the turn spinner on the client; the
 * follow-up `agent_auth_pending` SSE event carries the actual sign-in URL.
 *
 * Distinct from the SSE `agent_auth_pending` family below — this one is
 * scoped to the failing session, not broadcast app-wide.
 */
export interface WsAuthRequired {
  type: "auth_required";
}

/**
 * Discriminated payload for {@link WsAgentAuthPending}. Each backend's auth
 * flow surfaces different information to the user, so the union is the
 * shared shape: lifting it into a flat record would either pad it with
 * unused fields or fall back to `unknown`.
 *
 *   - `code-paste-url`: Claude OAuth — the user visits the URL, then pastes
 *     the resulting code back into the sign-in card.
 *   - `device-code`: Codex `--device-auth` / RFC 8628 — the user visits the
 *     URL and types the short user code into auth.openai.com; the CLI polls
 *     the auth server until the user approves.
 *
 * Adding a backend with a third flow (e.g. an API-key paste) is one new
 * variant here plus a matching branch in the sign-in card.
 */
export type AgentAuthPendingDetails =
  | {
      kind: "code-paste-url";
      /** URL the user opens to authorize; on return, they paste a code into the sign-in card. */
      verificationUri: string;
    }
  | {
      kind: "device-code";
      /** Verification URL printed by the CLI (`https://auth.openai.com/codex/device`). */
      verificationUri: string;
      /** Short code the user types into the verification page (`XXXX-XXXXX`). */
      userCode: string;
      /** Device-code TTL in seconds. */
      expiresInSec: number;
    };

/**
 * Server → Client (SSE-broadcast): a per-agent auth flow has produced its
 * pending state and is waiting on the user. Adding a new backend means
 * emitting this event from its `AgentAuthManager` — the client's single
 * handler dispatches on `agentId` + `details.kind`. (docs/155 Phase 2b)
 */
export interface WsAgentAuthPending {
  type: "agent_auth_pending";
  agentId: AgentId;
  /**
   * Provider-account id this flow authenticates (docs/150). Present when the
   * flow was started for a specific stored account row; omitted for the
   * legacy singleton flow. The client uses it to attach the pending state to
   * the matching Settings account row.
   */
  accountId?: string;
  details: AgentAuthPendingDetails;
}

/**
 * Server → Client (SSE-broadcast): a per-agent auth flow completed
 * successfully. Receivers refresh the agent list — `authConfigured` for the
 * named agent flips to `true`. (docs/155 Phase 2b)
 */
export interface WsAgentAuthComplete {
  type: "agent_auth_complete";
  agentId: AgentId;
  /** Provider-account id that just authenticated (docs/150), when scoped. */
  accountId?: string;
}

/**
 * Server → Client (SSE-broadcast): a per-agent auth flow failed or the
 * persisted credentials were revoked. `reason` lets the UI tailor the next
 * step (retry on `timeout`/`denied`/`error`, prompt re-sign-in on
 * `revoked`). (docs/155 Phase 2b)
 */
export interface WsAgentAuthFailed {
  type: "agent_auth_failed";
  agentId: AgentId;
  /** Provider-account id whose flow failed (docs/150), when scoped. */
  accountId?: string;
  reason?: "timeout" | "denied" | "error" | "revoked";
  message?: string;
}
