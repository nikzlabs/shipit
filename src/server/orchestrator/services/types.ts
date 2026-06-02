/**
 * Shared types and error class for the service layer.
 */

import type { AgentId, PermissionMode } from "../../shared/types.js";
import type { ProviderAccount, SessionInfo, ProjectTemplate, RepoInfo, RuntimeMode } from "../../shared/types.js";
import type { VoiceDeliveryMode } from "../../shared/types/voice-note-types.js";

// ---- Types for service function results ----

export interface AgentInfo {
  id: AgentId;
  name: string;
  installed: boolean;
  authConfigured: boolean;
  models: string[];
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
}

export interface GlobalSettings {
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
  providerAccounts: ProviderAccount[];
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
   * Controls whether the client should force container preview subdomains even
   * for hostnames that normally fall back to path previews, such as single-label
   * MagicDNS names or `*.ts.net` Tailscale names. Use `"always"` only when DNS
   * resolves `{sessionId}--{port}.<shipit-host>` to the ShipIt orchestrator.
   */
  previewSubdomains: "auto" | "always";
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
