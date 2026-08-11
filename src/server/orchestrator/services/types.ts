/**
 * Shared types and error class for the service layer.
 */

import type { AgentId, PermissionMode } from "../../shared/types.js";
import type { AgentReasoningCapability } from "../../shared/types/agent-types.js";
import type { EligibleModel } from "../../shared/agent-registry.js";
import type { AccountSelectionMode, CredentialRoute, FailoverCutoffs, SessionInfo, ProjectTemplate, RepoInfo, RuntimeMode } from "../../shared/types.js";
import type { VoiceDeliveryMode } from "../../shared/types/voice-note-types.js";
import type { BillingMode } from "../../shared/catalogue/types.js";

// ---- Types for service function results ----

export interface AgentInfo {
  id: AgentId;
  name: string;
  installed: boolean;
  hasRunnableModels: boolean;
  models: string[];
  /**
   * docs/252 phase 3 (req 8) — the models this install can actually run on this
   * harness, each as the `(service, billing mode, model)` triple it is selected
   * by. `models` above is this list's ids, kept for the call sites that still
   * speak bare ids; the picker reads this one, because an id alone cannot say
   * which service is billing the turn (req 11).
   */
  eligibleModels: EligibleModel[];
  /**
   * Whether the agent backend can run the chat-native AI review flow
   * (docs/125-chat-native-ai-review). The client uses this to gate the
   * "Ask agent to review" affordance in the file-preview modal.
   */
  supportsReview: boolean;
  /**
   * Whether this agent supports live steering (docs/140).
   */
  supportsSteering: boolean;
  /**
   * Whether this agent supports context compaction (docs/178). The client uses
   * this to gate the `/compact` entry in the composer's `/` command menu.
   */
  supportsCompaction: boolean;
  /**
   * Permission modes this agent supports (docs/138). The client uses this to
   * gate its agent-aware mode selector (e.g. only offer `guarded` when present).
   */
  supportedPermissionModes: PermissionMode[];
  /**
   * Character the composer types when the user picks a skill from the menu
   * (`/` for Claude, `$` for Codex). Mirrors `AgentCapabilities.skillInvocationPrefix`
   * over the wire so the client doesn't repeat the per-agent branch. (docs/155)
   */
  skillInvocationPrefix: string;
  /**
   * docs/217 — reasoning/effort options this agent exposes (or undefined). Drives
   * both the composer's reasoning control and the per-agent Settings tab default.
   */
  reasoning?: AgentReasoningCapability;
}

export interface GlobalSettings {
  /**
   * docs/257 req 8 — whether this install can actually run a turn: at least one
   * installed agent with a configured credential. Computed server-side (see
   * `computeCanRunTurns`) because the client must not re-derive it — three
   * consumers reading one field is what keeps the composer, the starter-prompts
   * gate and the onboarding panel from disagreeing.
   */
  canRunTurns: boolean;
  /**
   * docs/257 req 9 — when harness onboarding was first completed (ISO), or
   * absent for "never". The onboarding panel's presence is `absent && the
   * GitHub gate is not up`; nothing ever clears it, so removing every
   * credential later does not bring the panel back.
   */
  harnessOnboardingCompletedAt?: string;
  gitIdentity: { name: string; email: string };
  systemPrompt: string;
  agents: AgentInfo[];
  maxIdleContainers: number;
  agentSystemInstructionsEnabled: boolean;
  agentSystemInstructions: string;
  autoCreatePr: boolean;
  /**
   * When true and agent.supportsSteering, mid-turn messages steer the running
   * agent instead of being queued. (docs/140)
   */
  liveSteering: boolean;
  /**
   * docs/146 — when true, the PR poller's auto-resolve loop fires on
   * CONFLICTING transitions while the agent is idle. Force-pushes the
   * resolved rebase; default off.
   */
  autoResolveConflicts: boolean;
  /** docs/169 — when true, the PR poller's auto-fix-CI loop fires on FAILURE while the agent is idle. */
  autoFixCi: boolean;
  /**
   * docs/150 reqs 4-6 — proactive failover cutoffs. Reaching either window's
   * cutoff moves new work to the next eligible credential; both default to 90%.
   *
   * docs/252 phase 2 — keyed by `credentialModeKey(serviceId, billingMode)`,
   * not by agent id, and populated for every **subscription** mode in the
   * catalogue (a `key` mode has no entry: keys do not fail over, so there is no
   * group to order). Always populated, so the client never has to know the
   * default.
   */
  failoverCutoffs: Record<string, FailoverCutoffs>;
  /** docs/150 req 21 — selection mode, keyed exactly as {@link GlobalSettings.failoverCutoffs}. */
  accountSelectionMode: Record<string, AccountSelectionMode>;
  /** docs/218 — when true, resuming a merged, untouched session resets its branch to the latest base before the turn. Default on. */
  autoResetMergedBranch: boolean;
  /**
   * docs/144 — when true, a pinned session's agent may spawn another registered
   * agent for a one-shot sub-task (`shipit agent run`). Default off.
   */
  enableSubAgents: boolean;
  /**
   * docs/252 phase 7 (req 9) — the model the user PINNED for non-turn work
   * (session naming, pull-request descriptions), or absent for "follow the
   * install".
   *
   * Absent is a state, not a missing value, which is why this is not filled in
   * with the resolved answer: req 9's setting has to be visible as *unset* so
   * the user can see it tracks the install rather than a vendor they may stop
   * paying for. What it currently resolves to rides
   * {@link GlobalSettings.nonTurnModelResolved}.
   */
  nonTurnModel?: NonTurnModelSelection;
  /**
   * docs/252 phase 7 (req 9) — what non-turn work would run on **right now**,
   * pin or no pin, including the derived harness.
   *
   * Computed server-side rather than re-derived in the browser: the derivation
   * is req 9's rule (first eligible model, first installed harness offering it)
   * and a second implementation in the client is how the setting starts
   * disagreeing with what actually runs. Absent when nothing is runnable.
   */
  nonTurnModelResolved?: NonTurnModelResolved;
  /**
   * docs/163 — voice-note delivery mode: "native" (inline note + TTS),
   * "external" (webhook only), or "both". Default "native".
   */
  voiceDeliveryMode: VoiceDeliveryMode;
  /** docs/163 — whether an external voice-note webhook is configured. */
  voiceWebhookConfigured: boolean;
  /**
   * Provider subscription accounts grouped by provider (docs/150). Reserved
   * env/API-key routes are not represented here.
   */
  providerAccounts: CredentialRoute[];
  /**
   * docs/252 phase 2 — every credential the user holds, keyed by
   * `(serviceId, billingMode)` and in selection order within each group.
   *
   * A superset of {@link GlobalSettings.providerAccounts}: an account row IS a
   * `via: "account"` credential of its vendor's subscription mode, and appears
   * in both while the docs/150 routing machinery still reads the account shape.
   * Carries **no secret** — see `CredentialRoute`.
   */
  credentialRoutes: CredentialRoute[];
}

/** docs/252 phase 7 — the pinned non-turn selection, as it crosses the wire. */
export interface NonTurnModelSelection {
  serviceId: string;
  billingMode: BillingMode;
  modelId: string;
}

/** docs/252 phase 7 — the resolved answer, for display beside the "Default" option. */
export interface NonTurnModelResolved extends NonTurnModelSelection {
  serviceName: string;
  /** Model label, not the raw id — the same string the picker shows. */
  label: string;
  /** Derived (req 9): the first installed harness offering this model. */
  harnessId: AgentId;
  /** Whether the resolution came from the user's pin or from the derived default. */
  source: "pinned" | "default";
}

export interface GitHubStatus {
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
}

export interface BootstrapData {
  sessions: SessionInfo[];
  repos: RepoInfo[];
  agents: AgentInfo[];
  templates: Omit<ProjectTemplate, "files">[];
  githubStatus: GitHubStatus;
  settings: GlobalSettings;
  /**
   * Orchestrator runtime mode (feature 118). `"local"` means the orchestrator
   * runs in-process without a Docker/container layer (the dogfooding
   * ShipIt-in-ShipIt path). The client uses this to surface a local-mode
   * banner and hide container-only affordances (preview, terminal). Defaults
   * to `"containerized"` for every production deploy.
   */
  runtimeMode: RuntimeMode;
  /**
   * Host (optionally `host:port`) the VPS Tailscale forwarder advertises for
   * preview subdomains (docs/216). Present only on a Tailscale VPS deploy where
   * the forwarder has written `/opt/shipit/.tailnet-preview-host`. The client
   * uses it to route preview iframes through sslip.io while the app/WS stay on
   * the native MagicDNS host. Omitted on every other deploy.
   */
  tailnetPreviewHost?: string;
}

// ---- Error type for service-level errors with HTTP status codes ----

export class ServiceError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
