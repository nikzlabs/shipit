import type { PermissionMode } from "../server/shared/types.js";

/**
 * Describes an agent backend (Claude Code CLI, Codex CLI, etc.) as exposed
 * to the client. Used by the model/agent picker, auth cards, onboarding,
 * and the message input to gate features per backend.
 */
/**
 * docs/252 phase 3 (req 8) — one model this install can run on a harness, as the
 * `(service, billing mode, model)` triple it is selected by. The same model id
 * is reachable through a vendor directly and through a gateway, and through two
 * modes of one service, at different prices — so a bare id cannot say who is
 * billing the turn (req 11), which is why the picker groups on this.
 */
export interface EligibleModelOption {
  serviceId: string;
  serviceName: string;
  billingMode: "sub" | "key";
  modelId: string;
  label: string;
}

export interface AgentOption {
  id: string;
  name: string;
  installed: boolean;
  authConfigured: boolean;
  models: string[];
  /**
   * The credential-filtered join for this install (req 8). Optional for
   * backward-compat with older wire payloads and test fixtures; the picker falls
   * back to `models` as a single unnamed group when it is absent.
   */
  eligibleModels?: EligibleModelOption[];
  /**
   * Whether the agent backend can run the chat-native AI review flow
   * (docs/125-chat-native-ai-review). Drives whether the "Ask agent to
   * review" affordance shows up in the file-preview modal.
   */
  supportsReview: boolean;
  /**
   * Permission modes this agent supports (docs/138). Drives the agent-aware
   * mode selector — e.g. `guarded` is only offered when this includes it.
   * Optional for backward-compat with older wire payloads / test fixtures;
   * the selector falls back to hiding `guarded` when it's absent.
   */
  supportedPermissionModes?: PermissionMode[];
  /**
   * Whether the agent supports live steering — injecting user messages mid-turn.
   * (docs/140)
   */
  supportsSteering?: boolean;
  /**
   * Whether the agent supports context compaction (docs/178). Gates the
   * `/compact` entry in the composer's `/` command menu. Optional for
   * backward-compat with older wire payloads / test fixtures.
   */
  supportsCompaction?: boolean;
  /**
   * Character the user types in chat to invoke a skill (e.g. `/` for Claude,
   * `$` for Codex). Read by the composer's skill picker so the inserted token
   * matches the active backend. Optional for backward-compat with older
   * payloads / test fixtures — defaults to `/` when absent. (docs/155)
   */
  skillInvocationPrefix?: string;
  /**
   * docs/217 — reasoning/effort options this agent exposes (or absent). Drives
   * the composer's reasoning control and the per-agent "Sub-agent defaults"
   * section on the agent's Settings tab. The CLI knob and value set differ per
   * agent (Claude `--effort`: low…max; Codex `model_reasoning_effort`: none…xhigh).
   */
  reasoning?: {
    label: string;
    options: { value: string; label: string }[];
  };
}
