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
export interface ModelChoice {
  serviceId: string;
  serviceName: string;
  billingMode: "sub" | "key";
  modelId: string;
  label: string;
}

/**
 * An eligible row as the SERVER sends it — a {@link ModelChoice} that also
 * carries the catalogue's model identity.
 *
 * The two are deliberately separate. A row the server offers always knows which
 * model it is; a choice the composer hands back does not have to, because the
 * legacy `models` fallback (an older payload with no eligible set) can build one
 * from a bare id. Collapsing them would either make identity optional on the
 * wire — the branch cross-backend review objected to — or force the fallback to
 * invent a key, which is worse: an invented key COMPARES EQUAL to another
 * invented one, and this feature's whole point is that two rows sharing a key
 * are the same model.
 */
export interface EligibleModelOption extends ModelChoice {
  /**
   * docs/261 phase 6 — the catalogue's authored model identity, mirroring
   * `EligibleModel.canonicalModelKey`. Two options carrying one key are one
   * model, so changing the service can keep the model the user had.
   *
   * REQUIRED, like its server counterpart. Cross-backend review found it
   * declared optional "for an older payload", which ShipIt does not have — the
   * client and the server ship together — and which bought nothing but a silent
   * branch where the retention rule quietly stopped applying.
   */
  canonicalModelKey: string;
}

export interface AgentOption {
  id: string;
  name: string;
  installed: boolean;
  /**
   * docs/252 phase 3 (req 8) — this harness has at least one model this install
   * can run. Called `authConfigured` until the meaning moved: under req 2 a
   * harness is runnable with no account at its own vendor at all, so an
   * auth-shaped name described the wrong axis. Mirrors `AgentInfo` on the
   * server, whose docstring carries the full note.
   */
  hasRunnableModels: boolean;
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

/**
 * docs/252 phase 3 — is this saved selection one the install can still run on
 * `agentId`?
 *
 * The browser's saved slot is the only selection that outlives a credential
 * change: it holds a triple written when a subscription was connected, and it
 * seeds both the WebSocket connect and Quick Capture. `selectionExists` says the
 * catalogue still carries the row, which is a different question — the mode may
 * have lost its credential since. A stale `sub` triple accepted here becomes a
 * session whose very first turn fails to authenticate.
 *
 * Gated at the shared SOURCE rather than per ingress: both readers of the slot
 * ask this, so a third one cannot inherit the hole by forgetting a check.
 */
export function isSelectionEligibleForAgent(
  agents: AgentOption[],
  agentId: string,
  selection: { serviceId: string; billingMode: "sub" | "key"; modelId: string } | undefined,
): boolean {
  if (!selection) return false;
  const agent = agents.find((a) => a.id === agentId);
  // An older payload carries no eligible set, and refusing everything on that
  // basis would be worse than the staleness this guards against.
  if (!agent?.eligibleModels) return true;
  return agent.eligibleModels.some(
    (m) =>
      m.serviceId === selection.serviceId
      && m.billingMode === selection.billingMode
      && m.modelId === selection.modelId,
  );
}
