import type { AgentId } from "../agent-types.js";
import type { ProviderRouteKind } from "./provider.js";

// ---- Session types ----

/**
 * docs/211 — the capability set chosen at sandbox-session creation. Each flag is
 * an independent, immutable per-session grant:
 *   - `git`     (UI "GitHub access") — the GitHub credential broker: clone/push
 *               private repos and broker PR ops. Off ⇒ no GitHub token (public
 *               HTTPS clones may still work; "off" is *not* a network seal).
 *               Defaults to `false`.
 *   - `docker`  — session-scoped Docker (docs/128 `dockerAccess`): the agent's
 *               own containers/networks/volumes only, never the host socket.
 *               Defaults to `false`.
 *   - `network` (UI "Network access") — how contained egress is. `true` (default)
 *               = the standard Tier A allowlist every session runs under; `false`
 *               = lifeline-only (LLM API + ShipIt, plus github.com when `git` is
 *               granted). It only ever tightens, never widens. Defaults to `true`.
 *   - `dangerousGitHubOps` (docs/224, UI "Allow merging PRs") — a sub-grant under
 *               `git` for outward-facing, effectively-irreversible GitHub verbs
 *               (merge being the first). Off ⇒ `gh pr merge` is refused at the
 *               broker. Only meaningful when `git` is also granted. Defaults to
 *               `false`; this is the most prompt-injection-exposed verb, so it is
 *               never on unless the user explicitly opts in at creation.
 *
 * Capability *wiring* (threading `docker`/`network`/`git` into the container and
 * brokers) lands in docs/211 Phase 2; the foundation persists the chosen set.
 */
export interface SessionCapabilities {
  git: boolean;
  docker: boolean;
  network: boolean;
  dangerousGitHubOps: boolean;
}

/**
 * docs/211 — the default capability set for a freshly-created sandbox when the
 * client sends none: network on (parity with a normal session), GitHub and
 * Docker off (opt-in trust expansions). Normalizers coerce partial input
 * against this so a missing flag never reads as `undefined`.
 */
export const DEFAULT_SANDBOX_CAPABILITIES: SessionCapabilities = {
  git: false,
  docker: false,
  network: true,
  dangerousGitHubOps: false,
};

/**
 * docs/211 — coerce arbitrary (possibly partial / untrusted) input into a fully
 * populated {@link SessionCapabilities}, falling back to
 * {@link DEFAULT_SANDBOX_CAPABILITIES} for any missing or non-boolean field.
 * Used at the creation route (client payload) and `fromRow` (persisted JSON).
 */
export function normalizeCapabilities(input: unknown): SessionCapabilities {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const flag = (key: keyof SessionCapabilities): boolean => {
    const v = obj[key];
    return typeof v === "boolean" ? v : DEFAULT_SANDBOX_CAPABILITIES[key];
  };
  return {
    git: flag("git"),
    docker: flag("docker"),
    network: flag("network"),
    dangerousGitHubOps: flag("dangerousGitHubOps"),
  };
}

export interface SessionInfo {
  id: string;
  /** Agent's conversation ID (e.g. Claude CLI session_id for --resume). */
  agentSessionId?: string;
  title: string;
  /**
   * docs/128 / docs/211 — server-authoritative session kind. Undefined means an
   * ordinary repo/local session. The privileged kinds are:
   *   - `"ops"` — a host-debugging session created from the gated ops template:
   *     read-only journal mounts and a read-only Docker socket proxy.
   *   - `"sandbox"` (docs/211) — a repo-less session that starts from an empty
   *     `/workspace` with an explicit set of granted {@link capabilities}. The
   *     agent clones whatever repos it wants; ShipIt runs no clone, no preview,
   *     no auto-commit/push, and no PR card for it.
   * This field is set server-side at creation and is NOT writable from inside
   * the container, so an ordinary session can never forge its way into a
   * privileged path (the gate keys off `kind`, not any workspace marker file).
   */
  kind?: "ops" | "sandbox";
  /**
   * docs/211 — capabilities granted to a `kind === "sandbox"` session at
   * creation. Like {@link kind}, this is set server-authoritatively once and is
   * never inferred from workspace files, so an agent cannot self-elevate. Absent
   * on non-sandbox sessions. See {@link SessionCapabilities} for the defaults.
   */
  capabilities?: SessionCapabilities;
  createdAt: string;
  lastUsedAt: string;
  /** Per-session workspace directory, e.g. "/workspace/sessions/abc123". */
  workspaceDir?: string;
  /** Cached origin remote URL (e.g. "https://github.com/owner/repo.git"). */
  remoteUrl: string;
  /**
   * Back-compat alias for `userArchived` (docs/161): true when the user
   * explicitly hid the session from the sidebar. Derived, read-only — the
   * authoritative field is `userArchived`. Kept until all clients migrate.
   */
  archived?: boolean;
  /**
   * docs/161 — how much of the session is on disk right now. Orthogonal to
   * listing: a session can be listed in the sidebar while disk-evicted (it
   * restores on select) and fully on disk while not listed.
   *   - `hot`     — full checkout + node_modules + build artifacts.
   *   - `light`   — checkout (incl. uncommitted edits) kept; deps dropped.
   *   - `evicted` — workspace wiped; restore via clone-from-cache off fresh main.
   */
  diskTier?: "hot" | "light" | "evicted";
  /**
   * docs/161 — the explicit "hide this session" action. The only thing that
   * force-removes a session from the sidebar regardless of activity; reversible
   * from All Sessions. Distinct from `diskTier`: hiding never destroys disk and
   * disk reclamation never hides.
   */
  userArchived?: boolean;
  /**
   * docs/161 — bumped on viewer attach. Read ONLY by the disk-idle ladder
   * (`now - max(lastUsedAt, lastViewedAt)`); never by the listing predicate,
   * which keys off `lastUsedAt` so a merely-opened merged session isn't
   * promoted to Active forever.
   */
  lastViewedAt?: string;
  /**
   * docs/110 — pinned session. ISO timestamp set when the user pins the session;
   * presence is the pin flag, the value orders pins (most-recently-pinned first)
   * within a repo group. A pin makes the session **persistent**: it sticks to the
   * top of its repo group in the sidebar, is exempt from the merged top-N view cap
   * (`filterVisibleInSidebar`) so it never silently drops out of the list, and is
   * immune to automatic disk-tier descent (`canAutoDescend`) so its workspace is
   * never reclaimed. Cleared by an explicit user archive — a session can't be both
   * hidden and persistent.
   */
  pinnedAt?: string;
  /** Branch name for sessions cloned from a repo. */
  branch?: string;
  /** If true, this is a pre-created warm session not yet visible in the sidebar. */
  warm?: boolean;
  /** True once the branch has been renamed with a descriptive slug after graduation. */
  branchRenamed?: boolean;
  /** Conversation replay text injected as system prompt context after a rollback. */
  conversationReplay?: string;
  /** When the session's PR was merged. Sessions with mergedAt are kept alive until pruned. */
  mergedAt?: string;
  /**
   * When the session's PR was closed *without* being merged (abandoned/rejected).
   * The close analogue of `mergedAt`: like a merge, it's a terminal PR state that
   * sinks the session out of the active sidebar list into the "Recently resolved"
   * group. Kept distinct from `mergedAt` because closing is a different outcome
   * than merging (it does not delete the head branch or trigger merge-aware disk
   * reclaim, and the PR card badge stays red).
   */
  closedAt?: string;
  /** Model alias or ID selected for this session (e.g., "sonnet", "opus", "gpt-5.4"). */
  model?: string;
  /**
   * docs/217 — reasoning effort selected for this session's own turns (Control B),
   * an agent-specific token (e.g. "high"). Absent ⇒ the CLI's default.
   */
  reasoningEffort?: string;
  /** Agent (provider) selected for this session. Locked in on first WS connect. */
  agentId?: AgentId;
  /**
   * docs/138 — true once the session has taken its first turn. At that point
   * the agent is fixed for the session's life: its credentials have been
   * provisioned into the per-session credentials directory, the other agent's
   * credentials are deliberately absent, and `set_agent` is rejected.
   */
  agentPinned?: boolean;
  /**
   * docs/150 — route used for the pinned provider. Account routes refer to a
   * stored ProviderAccount id; reserved routes are env/API-key auth paths.
   */
  providerRouteKind?: ProviderRouteKind;
  providerRouteId?: string;
  /**
   * If this session was spawned by another session via `shipit session create`
   * (see docs/117-agent-spawned-sessions/), the parent's session ID. Used to
   * render the sidebar grouping ("spawned by parent") and to scope the
   * agent-facing `shipit session view/message/archive` operations so a parent
   * agent can only touch sessions it actually spawned.
   */
  parentSessionId?: string;
  /**
   * Optional identifier of the turn that spawned this session (the parent's
   * message group id at spawn time). Lets us scope `shipit session list` to
   * "this turn first" without walking chat history. Free-form string; the
   * orchestrator does not interpret it beyond persistence.
   */
  spawnedByTurn?: string;
  /**
   * docs/201 — the top-level ancestor of this session's spawn tree. A child can
   * itself spawn grandchildren; `parentSessionId` is single-step, so the sidebar
   * keys its grouping and merged-view-cap exemption off this ROOT instead — a
   * whole brood (children + grandchildren + deeper) groups under one top-level
   * session, and a descendant stays visible while its root is live regardless of
   * how deep it sits. Computed once at spawn (`parent.rootSessionId ?? parent.id`)
   * — no chain walking at read time. **Undefined on a top-level (user-created)
   * session**: it IS its own root, so `!!parentSessionId` stays the "am I
   * spawned?" test and only spawned descendants carry a root. `parentSessionId`
   * is retained alongside for true immediate lineage / provenance.
   */
  rootSessionId?: string;
  /**
   * docs/182 — true when the session's last completed turn ended in an error
   * (agent process error, or an `agent_result` carrying an error that wasn't a
   * deliberate interrupt). Persisted so it survives an orchestrator restart and
   * the child-session readiness check (`shipit session wait`) can report a
   * distinct `error` outcome instead of a false `idle`. Cleared (set false) on
   * the next clean turn completion.
   */
  lastTurnErrored?: boolean;
  /**
   * docs/186 — per-session pause for the auto-fix-CI loop. When true, the PR
   * poller's auto-fix loop is suppressed for THIS session even while the global
   * `autoFixCi` setting is on. Persisted on the session row so a pause survives
   * a restart. Undefined / false means the global setting governs. Toggled from
   * the PR card's overflow menu (only shown when the global setting is on).
   */
  autoFixCiPaused?: boolean;
  /**
   * docs/196 — async "notify parent when this child's PR merges" watch. Set on
   * the CHILD session row by `shipit session notify-on-merge`; the parent that
   * registered it is recorded in `parentSessionId` here. The PR poller fires the
   * watch when this session's PR reaches a terminal state (merged or
   * closed-without-merge), enqueuing a self-describing system turn into the
   * parent's message queue and surfacing a persisted merge card. Persisted so
   * the firing survives an orchestrator restart; the `state` machine
   * (`armed → merge-observed → delivered`, or terminal `closed-unmerged`) makes
   * delivery fire-once.
   */
  mergeWatch?: SessionMergeWatch;
  /**
   * docs/202 — display-only breadcrumb of the session's prior MERGED PR,
   * retained after a re-arm clears `merged_at`. Set by `clearMerged` when a
   * merged branch is rebased onto its base and gains genuinely new work, so the
   * session returns to Active/gray while still remembering it shipped once.
   *
   * Two non-display consumers piggyback on it, both deliberate:
   *   - `number` doubles as the PR poller's superseded-PR suppression key (so an
   *     immediate REST verify can't re-promote the OLD merged PR back to merged
   *     before the new PR opens), and
   *   - `baseBranch` targets the new PR's base + the "ready" diff, since re-arm
   *     is the one case where ShipIt knows the correct base (the prior PR's).
   *
   * It MUST NOT feed `resolvedAt()`, sidebar grouping, status color, or the
   * disk-eviction tier — clearing `merged_at` is what drives all of those, and
   * this breadcrumb is purely additive.
   */
  previousMergedPr?: PreviousMergedPr;
  /**
   * docs/218 — the branch-tip SHA the session's merged PR shipped from, captured
   * from the PR's `head.sha` when the poller promotes the session to merged.
   *
   * The safety anchor for auto-reset-merged-branch-on-continue: a later pre-turn
   * `reset --hard origin/<base>` fires only when the local HEAD still equals this
   * SHA, proving the branch carries no post-merge work the reset would discard.
   * It is deliberately the PR's head SHA, NOT local HEAD at merge-detection time —
   * a turn that ran between the GitHub merge and the poller noticing would have
   * advanced local HEAD onto unmerged work, and anchoring on that would later
   * reset the unmerged work away. Absent ⇒ no merged tip recorded ⇒ reset fails
   * closed. Cleared by `clearMerged` on a docs/202 re-arm.
   */
  mergedHeadSha?: string;
}

/**
 * docs/202 — lightweight reference to a session's prior merged PR, retained on
 * the session after re-arm. See `SessionInfo.previousMergedPr`.
 */
export interface PreviousMergedPr {
  number: number;
  url: string;
  title: string;
  /** The prior PR's base branch — the new PR targets the same base. */
  baseBranch: string;
}

/**
 * docs/196 — a single parent→child merge-watch, stored on the child session row.
 * The lifecycle is fire-once: a re-poll (or a restart-driven re-derivation) that
 * sees a terminal state but an already-`delivered`/`closed-unmerged` watch is a
 * no-op.
 */
export interface SessionMergeWatch {
  /** Session that registered the watch and receives the wake-turn + merge card. */
  parentSessionId: string;
  /**
   * - `armed` — registered, waiting for the child's PR to reach a terminal state
   *   (the PR need not exist yet).
   * - `merge-observed` — the poller saw the merge and surfaced the card, but the
   *   actionable wake-turn hasn't been enqueued into the parent yet (a transient
   *   step; re-tried on the next poll if enqueue couldn't complete).
   * - `delivered` — the merge wake-turn was enqueued. Terminal, fire-once.
   * - `closed-unmerged` — the PR closed without merging; a distinct wake-turn was
   *   enqueued so the parent doesn't proceed as if the work shipped. Terminal.
   */
  state: "armed" | "merge-observed" | "delivered" | "closed-unmerged";
  /** ISO instant the watch was armed. */
  registeredAt: string;
  /** ISO instant the terminal PR state was first observed. */
  observedAt?: string;
  /** ISO instant the wake-turn was enqueued into the parent. */
  deliveredAt?: string;
}

/**
 * docs/196 — payload for the inline "Child PR merged / closed" transcript card
 * surfaced into the PARENT session when a watched child's PR reaches a terminal
 * state. Static (no mutable lifecycle): persisted on the message row and
 * rendered directly, no client store. Carries everything needed to identify the
 * child and its PR so the card is self-explanatory after a reload.
 */
export interface ChildMergedCard {
  /** Server-generated stable id — used for live-append idempotency on reconnect. */
  cardId: string;
  /** The watched child session's id (the card's "Open" target). */
  childSessionId: string;
  /** Child session title, for display. */
  childTitle: string;
  /** Child's branch. */
  branch?: string;
  /** `"merged"` or `"closed-unmerged"` — drives the card's copy + tone. */
  outcome: "merged" | "closed-unmerged";
  prNumber: number;
  prUrl: string;
  prTitle?: string;
  /** Merge commit SHA, when known (merged outcome only). */
  mergeSha?: string;
  createdAt: string;
}

// ---- Repo types ----

export interface RepoInfo {
  /** Canonical remote URL, e.g. "https://github.com/owner/repo.git". */
  url: string;
  /** When the repo was added. */
  addedAt: string;
  /** Last time any session was created for this repo. */
  lastUsedAt: string;
  /** Clone status. "cloning" while initial clone is in progress. */
  status: "cloning" | "ready";
  /** Session ID of the current warm (pre-created) session, if any. */
  warmSessionId?: string;
  /**
   * docs/178 — per-remote trust-on-first-use gate. `false` (the default for a
   * freshly-added remote) defers all repo-declared auto-execution
   * (agent.install + compose command:/build:) until the user accepts once via
   * `POST /api/repos/trust`. Clone, file tree, diffs, and agent chat still work
   * while untrusted. ShipIt-template repos are trusted at creation. Always
   * populated from the store; only omitted on hand-built RepoInfo literals.
   */
  trusted?: boolean;
  /**
   * docs/222 — sidebar visibility flag. `true` hides the repo (and its sessions)
   * from the sidebar without removing anything: a pure declutter toggle, fully
   * reversible via the "Hidden" section or by re-adding the repo. Distinct from
   * Remove, which archives sessions and reclaims disk. Defaults to visible.
   */
  hidden?: boolean;
}
