import type { AgentId } from "../agent-types.js";
import type { BillingMode } from "../../catalogue/types.js";

/** Provenance for a prompt delivered by another ShipIt session's agent. */
export interface SessionMessageOrigin {
  sessionId: string;
  sessionTitle: string;
  relation: "parent" | "child" | "sibling";
}

/**
 * docs/178 — a persisted "Context compacted" transcript card. Shared verbatim by
 * the live WS payload (`WsCompactionCard`), the persisted chat-history row
 * (`PersistedMessage.compaction`), and the client card so the three can't drift
 * (same pattern as the voice-note / bug-report / issue-write cards). Every detail
 * field is optional because Codex supplies none of them natively — the card
 * degrades to a bare "Context compacted" row when they're absent.
 */
export interface CompactionCard {
  /** Stable id — keeps the live append + history rehydration idempotent. */
  id: string;
  /** `"manual"` for an explicit `/compact`, `"auto"` when the CLI self-compacted. */
  trigger?: "manual" | "auto";
  /** Context-window occupancy (tokens) before compaction. */
  preTokens?: number;
  /** Context-window occupancy (tokens) after compaction. */
  postTokens?: number;
  /** How long the compaction took, in ms, when the backend reports it. */
  durationMs?: number;
  createdAt: string;
}

/**
 * docs/261 phase 4 (req 9) — the resolved parameters a sub-agent consult ran on,
 * minus the harness (which is the card's own `subAgentId`).
 *
 * Ids, never rendered labels. A label is a catalogue fact that can be corrected;
 * an id is what the run was billed and attributed against. Storing the label too
 * would freeze a name at spawn time and give the same card two sources for one
 * fact — the client resolves both through the catalogue at render and falls back
 * to the id, which is a worse label but never a wrong one (the rule
 * `client/utils/service-label.ts` already follows).
 *
 * All four are required, because req 3 makes `(service, billing mode, model)`
 * what identifies a model at all — the same id is reachable through a vendor and
 * through a gateway at different prices — and req 5 makes the reasoning level
 * part of the reviewer rather than a separate decision.
 */
export interface SubAgentRunTarget {
  serviceId: string;
  billingMode: BillingMode;
  modelId: string;
  /** The harness-specific level (e.g. `"high"`), never absent since docs/261. */
  reasoningEffort: string;
}

/**
 * docs/144 — the persisted "Consulted Opus 5 · 47s · $0.03" transcript card for a
 * completed sub-agent spawn. Unlike the transient in-flight spinner (the
 * `sub_agent_spawn` WS message + `subAgentSpawns` store), this terminal record
 * IS transcript content — the user expects it to stay where the consultation
 * happened, surviving a session switch and a full reload — so it follows the
 * side-channel-card persistence contract (emitted via `emitChatCard`, anchored
 * inline at the spawn position, persisted in chat history). Renders for every
 * terminal status, not just success (a cancelled/timed-out/failed consult is
 * still a fact the transcript should keep).
 *
 * planning#280 — the card is now created in a `pending` state at SPAWN time and
 * patched to its terminal status on completion, so an in-flight consult has a
 * DURABLE surface. The transient `sub_agent_spawn` chip is live activity only
 * and dies on the first session switch; since docs/236 tells agents to
 * background long consults, the in-flight state routinely outlives both its
 * turn and every switch the user makes, and a spawn whose container was
 * restarted mid-flight used to leave no trace at all.
 */
export interface SubAgentConsultCard {
  /** Stable id — keeps the live append + history rehydration idempotent. */
  cardId: string;
  /** The in-flight spawn this card finalizes; clears the matching running chip. */
  spawnId: string;
  /**
   * The **harness** that was consulted — a CLI, not a model (docs/252 phase 1).
   * On its own it is no longer an answer to "what reviewed this": Claude Code
   * can drive a non-Anthropic model, so "Consulted Claude" says which process
   * ran and nothing about which weights did. {@link runOn} carries the rest.
   */
  subAgentId: AgentId;
  /**
   * docs/261 phase 4 (req 9) — **what this consult actually ran on**, so its
   * usage and cost are attributable to the service and billing mode that served
   * it and the card can say which model reviewed the work.
   *
   * Copied from the target `runSubAgent` captures ONCE at spawn admission
   * (`services/sub-agent-target.ts`), which is the same value the spawn, the
   * retries and the usage row use — so the card cannot name a model that did not
   * run. Written onto the `pending` card at creation rather than at completion,
   * because a consult is in flight for minutes and "who is being asked" is the
   * first thing the row has to answer; the pending → terminal patch carries it
   * through unchanged.
   *
   * Optional only for rows written before this phase. The whole card serializes
   * to one json column (`messages.sub_agent_consult`), so this needs no
   * migration and no `CARD_MESSAGE_FIELDS` change — an older row simply parses
   * without it and the card falls back to naming the harness alone.
   */
  runOn?: SubAgentRunTarget;
  /**
   * docs/264 req 14 — the **role** that started this run, when one did.
   *
   * {@link runOn} says what ran; this says what was *asked for*. They are
   * different facts and neither implies the other: a role resolves to a tuple
   * (and the reviewer's resolves per run), so a card carrying only the tuple
   * cannot answer "was this the reviewer, or `deep-dive`?" — which is the
   * question a user reading the transcript actually has.
   *
   * A **snapshot of the name**, taken at spawn admission. Editing or deleting the
   * role afterwards does not reach back into a card that already exists — the
   * same rule a child session's `originRoleName` follows.
   *
   * Absent for a run that named all five parameters itself, and for rows written
   * before this phase. Serializes into the card's single json column, so no
   * migration and no `CARD_MESSAGE_FIELDS` change.
   */
  roleName?: string;
  /**
   * `pending` while the spawn is in flight; otherwise the terminal status,
   * which drives the verb ("Consulted" / "Cancelled" / …).
   */
  status: "pending" | "success" | "error" | "timeout" | "cancelled";
  /**
   * planning#309 — a SHIPIT-authored one-line explanation of a terminal status, for
   * the cases where the status alone is misleading. Currently set only by the
   * boot reconcile, which cancels consults stranded `pending` by an orchestrator
   * restart: without it "Cancelled Codex" is indistinguishable from a consult
   * the user cancelled.
   *
   * Deliberately NOT `outputMarkdown`. That field is the sub-agent's verbatim
   * words — it is what `shipit agent result` prints on stdout and what planning#247
   * guarantees is the same artifact the user reads — so putting ShipIt's own
   * prose there would hand a caller our apology in the consultant's voice. This
   * field renders as ShipIt's commentary on both surfaces (the card face, and
   * the shim's stderr).
   */
  statusDetail?: string;
  durationMs?: number;
  costUsd?: number;
  /** True when the sub-agent's output hit the wall-clock or character cap. */
  truncated?: boolean;
  /**
   * docs/220 — the sub-agent's verbatim final output (markdown), so a brokered
   * consult is *visible*, not just attested. ShipIt renders what it brokers: the
   * card shows a stripped-down preview and opens the full text in a read-only
   * viewer. Already length-bounded upstream by the spawn primitive's
   * `maxOutputChars` cap (32K), which is also what sets `truncated`. Absent on a
   * transport-failure card (no output was produced) and on empty output.
   */
  outputMarkdown?: string;
  /**
   * docs/244 / planning#299 — set on the SERVE path only: `outputMarkdown` carries
   * just the one-line preview the card face draws, and the full text is fetched
   * from `/api/sessions/:id/sub-agent-consults/:cardId` when the viewer opens.
   * Never persisted — the stored card always holds the whole output, which is
   * what `shipit agent result` reads.
   */
  outputTruncated?: true;
  createdAt: string;
}

/**
 * docs/207 / planning#155 — one optional action the agent proposes via the
 * `propose_actions` tool. The card renders these as a button (one action) or a
 * checklist (2+); ticking declares intent and the agent does the work, so no
 * field here ever executes anything directly.
 */
export interface ActionChecklistItem {
  /** Stable id for this action within the card (used as the React key + selection key). */
  id: string;
  /** Short button / checkbox text. */
  label: string;
  /** Optional one-line explanation under the label. */
  description?: string;
  /** The agent's recommendation — pre-ticks the box. The user still decides. */
  defaultChecked?: boolean;
  /**
   * The self-contained instruction the agent receives if this action is chosen.
   * Self-contained on purpose: the card outlives the turn, the agent, even a
   * destroyed-and-re-cloned container, so the submitted message is rebuilt from
   * the ticked `payload`s — never from warm conversation context.
   */
  payload: string;
}

/**
 * docs/207 / planning#155 — a persisted "action checklist" transcript card. The agent
 * proposes one or more INDEPENDENT optional follow-ups; the user resolves the
 * subset they want with a SINGLE batched submit (one message → one turn, never N
 * racing clicks). The card is an immutable, reusable message composer: it has no
 * terminal state, never locks, and can be re-submitted with a different subset
 * indefinitely. Shared verbatim by the live WS payload (`WsActionChecklistCard`),
 * the persisted chat-history row (`PersistedMessage.actionChecklist`), and the
 * client card so the three can't drift — same pattern as the issue-ref / sub-
 * agent-consult cards (static payload, no client store, no in-place patch path).
 *
 * Provenance (`branch`, `headSha`, `createdAt`) is captured at emit time and is
 * immutable. It travels into the message the card sends so the agent can inspect
 * current state and adapt/decline if an action is now obsolete (branch merged, PR
 * already exists, files moved) — the "honest at click-time" guarantee without a
 * stale *state* or a lock.
 */
export interface ActionChecklistCard {
  /** Stable id — dedupes the live append vs the reconnect/reload replay. */
  cardId: string;
  /** Optional heading, e.g. "Optional follow-ups". */
  title?: string;
  /** 1..N proposed actions. One → button card; two or more → checklist card. */
  actions: ActionChecklistItem[];
  /** Branch the actions were proposed against (provenance, immutable). */
  branch?: string;
  /** Short HEAD SHA the actions were proposed against (provenance, immutable). */
  headSha?: string;
  /** Emit time — doubles as the "proposed <date>" provenance stamp. */
  createdAt: string;
}

/**
 * docs/218 — a persisted "branch updated to latest base" transcript card. Emitted
 * right after the user's message (and before the agent's response) when a merged
 * session's branch was automatically reset to `origin/<base>` before continuing,
 * so the user plainly sees the destructive move that just happened. Immutable, no
 * lifecycle — the card is written once on emit and never patched. Shared verbatim
 * by the live WS payload (`WsBranchAutoResetCard`), the persisted chat-history row
 * (`PersistedMessage.branchAutoReset`), and the client card so the three can't
 * drift (same static-payload pattern as the issue-ref / action-checklist cards).
 */
export interface BranchAutoResetCard {
  /** Stable id — dedupes the live append vs the reconnect/reload replay. */
  cardId: string;
  /** The base branch the branch was reset onto (e.g. "main"). */
  base: string;
  /** The merged PR whose branch this was. */
  prNumber: number;
  prUrl: string;
  /** Short HEAD SHAs before → after the reset, for auditability. */
  fromSha: string;
  toSha: string;
  /** Emit time — doubles as the provenance stamp. */
  createdAt: string;
  /**
   * planning#279 — this reset ran under `shipit branch reset-to-base --force`, which
   * bypasses the "this branch is exactly what merged" safety clause. The forced
   * path is trust-based rather than gated, so the transcript record IS the
   * accountability: absent these two fields the card describes a reset that
   * passed the full gate, which is a materially different claim.
   *
   * Both optional, and the whole card serializes to ONE json column
   * (`messages.branch_auto_reset`), so this needs no migration and no
   * `CARD_MESSAGE_FIELDS` change — existing rows simply parse without them.
   */
  forced?: boolean;
  /** The operator-supplied justification, required whenever `forced` is true. */
  forceReason?: string;
}

/**
 * docs/221 — a persisted "synced with <base>" transcript card. Emitted after a
 * successful "Sync with <base>" (manual rebase-onto-base) flow that rewrote the
 * session branch and/or fast-forwarded the session clone's local `<base>` ref up
 * to `origin/<base>`. Unlike the transient rebase banner/toast, this is durable
 * scrollback so the user has a lasting record that the branch was rebased and the
 * local base moved. Immutable, no lifecycle — written once on emit, never patched.
 * Shared verbatim by the live WS payload (`WsBranchSyncedCard`), the persisted
 * chat-history row (`PersistedMessage.branchSynced`), and the client card so the
 * three can't drift. Idempotent on the client by `cardId` (live emit vs the
 * reconnect/reload replay).
 */
export interface BranchSyncedCard {
  /** Stable id — dedupes the live append vs the reconnect/reload replay. */
  cardId: string;
  /** The base branch synced against (e.g. "main"). */
  base: string;
  /**
   * Session-branch HEAD before → after the rebase. Equal (and present) when the
   * branch was already up to date; the client suppresses the "rebased" line then.
   */
  headFromSha: string;
  headToSha: string;
  /**
   * Local `<base>` ref before → after the fast-forward to `origin/<base>`.
   * `baseFromSha` is null when the local base ref didn't exist before. Equal when
   * the local base was already current; the client suppresses the "updated" line.
   */
  baseFromSha: string | null;
  baseToSha: string;
  /** Whether the rewritten branch was force-pushed to origin (false when no auth). */
  forcePushed: boolean;
  /** Emit time — doubles as the provenance stamp. */
  createdAt: string;
}

/**
 * docs/250 — a persisted "renamed this session" transcript card (requirement 9).
 * Emitted when the agent retitles its own session via `shipit session rename`, so
 * a name that changed mid-session can be explained after the fact ("why is this
 * session called that?") instead of silently differing from what the user
 * remembers. Immutable, no lifecycle — written once on emit, never patched.
 *
 * Distinct from the `session_renamed` WS/SSE event, which updates the SIDEBAR
 * entry: this is the scrollback row, and per CLAUDE.md transcript content has to
 * be persisted, not merely emitted. Shared verbatim by the live WS payload
 * (`WsSessionRenamedCard`), the persisted chat-history row
 * (`PersistedMessage.sessionRenamed`), and the client card so the three can't
 * drift. Idempotent on the client by `cardId` (live emit vs reconnect/reload replay).
 */
export interface SessionRenamedCard {
  /** Stable id — dedupes the live append vs the reconnect/reload replay. */
  cardId: string;
  /** The title the session had before this rename. */
  from: string;
  /** The title it has now. */
  to: string;
  /** Emit time — doubles as the provenance stamp. */
  createdAt: string;
}

// ---- Chat history message (shared data type) ----

/**
 * A single nested event emitted by a subagent (Claude's Task tool). The
 * `parentToolUseId` links it back to a tool_use block in the parent message's
 * `toolUse` list. Used for subagent transparency (109).
 */
export type WsSubagentEvent =
  | {
      kind: "assistant";
      parentToolUseId: string;
      text: string;
      toolUse: {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      }[];
    }
  | {
      kind: "tool_result";
      parentToolUseId: string;
      toolResults: {
        toolUseId: string;
        content: string;
        isError?: boolean;
      }[];
    };

export interface WsChatHistoryMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  }[];
  images?: {
    /** Base64 payload. Replaced by `src` on the serve path (docs/244). */
    data?: string;
    mediaType: string;
    /** docs/244 — content-addressed URL, set instead of `data` on the wire. */
    src?: string;
  }[];
  files?: {
    path: string;
    contentPreview: string;  // first 200 chars of content
    startLine?: number;
    endLine?: number;
  }[];
  isError?: boolean;
  toolResults?: {
    toolUseId: string;
    content: string;
    isError?: boolean;
  }[];
  /** True while the agent turn that produced this message is still running. */
  inProgress?: boolean;
  /** Git commit hash produced by auto-commit after this assistant message. */
  commitHash?: string;
  /** Parent commit hash (HEAD before the auto-commit). Used for rollback. */
  parentCommitHash?: string;
  /** Upload paths consumed by this message (for hydration of pending vs sent state). */
  uploadPaths?: string[];
  notice?: boolean;
  noticeLevel?: "info" | "warn";
  rolledBack?: boolean;
  forkChild?: { childSessionId: string; title: string; branch: string };
  codeRollbackHash?: string;
  /**
   * Events emitted by subagents (Claude's Task tool) under any tool in this
   * message's `toolUse`. The client groups these by `parentToolUseId` and
   * renders them as a nested tree (109 — subagent transparency).
   */
  subagentEvents?: WsSubagentEvent[];
}
