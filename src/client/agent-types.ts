import type { PermissionMode } from "../server/shared/types.js";

/**
 * Describes an agent backend (Claude Code CLI, Codex CLI, etc.) as exposed
 * to the client. Used by the model/agent picker, auth cards, onboarding,
 * and the message input to gate features per backend.
 */
export interface AgentOption {
  id: string;
  name: string;
  installed: boolean;
  authConfigured: boolean;
  models: string[];
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
   * Whether the agent supports context compaction (docs/179). Gates the
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
}
