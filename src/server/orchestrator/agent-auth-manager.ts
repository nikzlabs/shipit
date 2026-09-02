/**
 * AgentAuthManager — shared interface implemented by every login flow (Claude
 * OAuth, Codex device flow, …) so the orchestrator can dispatch lifecycle
 * operations through a `Map<LoginIntegrationId, AgentAuthManager>` lookup
 * instead of branching on agent id at every call site. (docs/155)
 *
 * **Keyed by the login flow, not by the harness** (docs/252 phase 2's deferred
 * re-key). A harness is not a vendor: `claude` names a CLI, `anthropic-oauth`
 * names a sign-in. They coincide only while each harness has exactly one native
 * service, which is the assumption a provider-neutral harness removes. The
 * catalogue declares the key (`ModeCredential.login`), and
 * `harnessesForLoginIntegration` answers the question the old key answered by
 * accident: which harnesses a completed sign-in affects.
 *
 * What deliberately stays harness-keyed is documented at that function.
 *
 * Scope. The interface covers the surface that's the same across providers:
 * kicking off a flow, cancelling it, signing out, killing the process at
 * shutdown, asking whether credentials are configured, and the
 * `pending`/`complete`/`failed` lifecycle events. The flow-pending payload
 * varies between providers (Claude prints a paste-code URL; Codex prints a
 * URL + user code) — captured by the discriminated {@link AgentAuthPendingDetails}
 * union in `ws-server-messages.ts` so the interface stays typed end-to-end
 * (STOP-GATE: no `unknown` events).
 *
 * Events. Concrete managers also emit their legacy/CLI-specific events
 * (`auth_url`, `codex_auth_pending`, …) for back-compat with existing
 * listeners and unit tests, but the orchestrator's SSE wiring rides the
 * normalized events on this interface so adding a backend is one entry in
 * the auth-manager map and one emit-site update in the new backend's class.
 */

import type { EventEmitter } from "node:events";
import type { LoginIntegrationId } from "../shared/catalogue/types.js";
import type { AgentAuthPendingDetails } from "../shared/types/ws-server-messages.js";
import type {
  AgentAuthLogPayload,
  AgentAuthProgressPayload,
} from "./agents/claude/auth-diagnostics.js";

/** Optional payload accompanying the {@link AgentAuthManager} `failed` event. */
export interface AgentAuthFailedPayload {
  /**
   * Coarse failure category — drives the next-step copy in the UI.
   *
   * `duplicate` is never emitted by a manager: it is ShipIt refusing an
   * otherwise-successful sign-in that resolved to an already-connected account
   * (docs/150-multiple-provider-subscriptions req 22). It shares this payload so the client has one failure
   * channel per provider flow.
   */
  reason?: "timeout" | "denied" | "error" | "revoked" | "duplicate";
  /** Human-readable detail. Surfaced in the sign-in card error toast. */
  message?: string;
}

/**
 * Options for starting an account-scoped auth flow (docs/150). The manager
 * forces the provider CLI to read and write credentials under `credentialDir`
 * instead of the singleton root (`/root/.claude`, `/root/.codex`). The
 * directory is a provider-account root
 * (`provider-accounts/<provider>/acct_<id>`) whose layout already mirrors
 * `$HOME` — `<root>/.claude` + `<root>/.claude.json` for Claude, `<root>/.codex`
 * for Codex — so scoping a flow is just spawning the CLI with `HOME` set to it.
 *
 * docs/150-multiple-provider-subscriptions req 19 — both fields are **required**. They were optional during the
 * migration, when `startAuth` could still begin an account-less flow; that
 * endpoint and its callers are gone, and `startAccountAuth` is now the only way
 * a flow begins. Keeping them optional would leave a second way for provider
 * auth to work — the thing req 19 exists to remove — and it is not inert: the
 * client files every challenge under an account row and drops an
 * `agent_auth_*` event that names none, so an unscoped flow would prompt a CLI
 * the user could never see or answer. Requiring the scope makes that
 * unrepresentable rather than merely unused.
 */
export interface AgentAuthStartOptions {
  /**
   * Provider-account id this flow authenticates. Echoed back through
   * {@link AgentAuthManager.getActiveAccountId} so the SSE wiring can qualify
   * `agent_auth_*` events to the originating Settings row.
   */
  accountId: string;
  /** Credential root (account directory) the CLI reads and writes. */
  credentialDir: string;
}

/** Options for the account-scoped read/sign-out methods. */
export interface AgentAuthScopeOptions {
  /** Credential root to target. Omit for the legacy singleton path. */
  credentialDir?: string;
}

export interface AgentAuthManager extends EventEmitter<AgentAuthManagerEvents> {
  /**
   * Which login flow this manager implements. The key of the map that holds it,
   * and the identity every `agent_auth_*` broadcast carries.
   */
  readonly loginId: LoginIntegrationId;

  /**
   * Start the agent's auth flow for a specific provider account. Idempotent —
   * no-op if a flow is already in-flight. Concrete classes may re-broadcast
   * cached pending state to accommodate page reloads mid-flow (Codex's
   * device-code replay).
   *
   * docs/150-multiple-provider-subscriptions req 19 — the scope is required; there is no account-less flow.
   * `ProviderAccountManager.startAccountAuth` is the only caller, and it also
   * refuses to start while another account holds the provider's single login
   * process.
   */
  start(opts: AgentAuthStartOptions): void;

  /**
   * Cancel any in-flight flow. Idempotent. Used by explicit cancel routes
   * and as part of sign-out. Distinct from `kill()`: `kill()` is the
   * shutdown-hook tear-down; `cancel()` is the user-driven abort.
   */
  cancel(): void;

  /**
   * Submit a verification code into an in-flight flow, for backends whose
   * flow has a paste-code step (Claude OAuth). Backends without one (Codex
   * device-auth) omit this. Optional so the interface stays satisfiable by
   * both shapes.
   */
  submitCode?(code: string): void;

  /**
   * Remove on-disk credentials so the next agent turn falls back to env-var
   * auth (or to `auth_required` if none is set). Idempotent. Pass a
   * `credentialDir` to target a specific provider account (docs/150).
   */
  signOut(opts?: AgentAuthScopeOptions): void;

  /**
   * Whether credentials are present (file on disk OR an env var). The
   * matching `AgentRegistry.refreshAuth` consults this to flip the agent's
   * `hasRunnableModels` flag. Pass a `credentialDir` to check a specific
   * provider account's credentials instead of the singleton path.
   */
  isConfigured(opts?: AgentAuthScopeOptions): boolean;

  /**
   * The provider-account id of the flow currently in flight (or just
   * finished and not yet superseded), or `null` for a legacy singleton flow.
   * Read synchronously inside the `pending`/`complete`/`failed` event
   * handlers so the SSE wiring can qualify the broadcast to the right
   * Settings row (docs/150).
   */
  getActiveAccountId(): string | null;

  /**
   * Tear down any in-flight CLI subprocess and per-flow timers. Called from
   * the graceful-shutdown hook; safe to call when nothing is running.
   */
  kill(): void;

  /**
   * Snapshot of the in-flight pending payload, or `null` when no flow is
   * pending. Replayed to fresh SSE clients on connect so a mid-flow page
   * reload re-renders the sign-in card instead of stranding the user on a
   * dead button. Backends without a replay cache (Claude doesn't keep one
   * today) may return `null` unconditionally.
   */
  getPendingPayload(): AgentAuthPendingDetails | null;
}

/**
 * Typed event names emitted by every `AgentAuthManager`. Concrete classes
 * still emit their legacy/CLI-specific events for back-compat; the events
 * below are the normalized surface the orchestrator's SSE wiring listens to.
 */
export interface AgentAuthManagerEvents {
  pending: [details: AgentAuthPendingDetails];
  complete: [];
  failed: [payload?: AgentAuthFailedPayload];
  progress: [payload: AgentAuthProgressPayload];
  log: [payload: AgentAuthLogPayload];
}
