import type { ChildMergedCard } from "../domain-types.js";

/**
 * Server → Client: the parent agent successfully spawned a sibling session
 * via the `shipit session create` shim (docs/117 Phase 2).
 *
 * Emitted on the *parent's* runner via `runner.emitMessage(...)` so every
 * attached viewer sees it and it lands in the turn-event buffer for
 * reconnecting viewers. The client renders a `SpawnedSessionCard` inline in
 * the parent's chat — title, branch, status pill, and an "Open" button that
 * switches the active session to the child.
 *
 * The child session itself shows up in the user's sidebar via the existing
 * `session_list` SSE broadcast that the spawn route already emits; this
 * event is purely the chat-side affordance.
 */
export interface WsSessionSpawned {
  type: "session_spawned";
  /** Parent session id — the runner that this event is emitted on. */
  sessionId: string;
  /** The newly-created child session's id. */
  childSessionId: string;
  /** Child session title (matches the sidebar row). */
  title: string;
  /** Branch the child was cut on (matches the sidebar row's branch). */
  branch?: string;
  /** ISO8601 timestamp the child was created at. */
  spawnedAt: string;
  /**
   * docs/162 — present only for Ops `--shipit-source` fix-session spawns. When
   * set, the client renders the spawned-session card in its "ShipIt fix"
   * variant: the exact commit the child branched from, the target repo the fix
   * PR opens against, and a short diagnosis summary. Absent for ordinary
   * same-repo fan-out spawns (which render the plain card).
   */
  shipitFix?: {
    /** Commit the child was branched from (the inspected source ref). */
    sourceRef: string;
    /** True only when `sourceRef` is the exact deployed build commit. */
    sourceExact: boolean;
    /** Where `sourceRef` came from — exact build id vs. checkout HEAD. */
    refSource?: "build-id" | "checkout-head";
    /** `owner/repo` the fix PR will open against. */
    targetRepo?: string;
    /** First line of the Ops diagnosis, truncated, for the card. */
    diagnosis?: string;
  };
}

/**
 * Server → Client: the parent agent's `shipit session create` invocation
 * was rejected by the orchestrator (docs/117 cross-cutting follow-up).
 *
 * Counterpart to `WsSessionSpawned` for the failure path. Without this, a
 * spawn rejection (quota hit, archived parent, bad payload) only surfaces on
 * the shim's stderr — invisible in the parent's chat lane. Emitted on the
 * parent runner via `runner.emitMessage` so every attached viewer sees it
 * and it lands in the turn-event buffer for reconnecting viewers.
 *
 * The shim still receives the HTTP error (and exits non-zero) — the chat
 * event is purely the user-facing affordance so the user sees "the agent
 * tried to spawn a session, here's why it didn't work."
 */
export interface WsSessionSpawnFailed {
  type: "session_spawn_failed";
  /** Parent session id — the runner that this event is emitted on. */
  sessionId: string;
  /**
   * Server-generated stable id. A failed spawn has no natural key (no child
   * session was created), so this is what the client dedupes on when the
   * turn-event buffer replays the card on reconnect against the persisted copy.
   */
  id: string;
  /** Human-readable error message, taken from the orchestrator's response body. */
  message: string;
  /** HTTP status code the spawn route returned (400, 404, 409, 429, 500…). */
  statusCode: number;
  /**
   * Short outcome bucket (`quota_per_turn`, `quota_per_parent`, `invalid_request`,
   * `parent_missing`, `error`) for the UI to pick a tailored copy line.
   */
  reason:
    | "quota_per_turn"
    | "quota_per_parent"
    | "invalid_request"
    | "parent_missing"
    | "error";
  /** Title the agent requested (or the prompt's derived slug). */
  title?: string;
  /**
   * First line of the prompt the spawn was meant to kick off, truncated to
   * 200 chars so the chat card has enough context to tell the user *what*
   * failed without bloating the buffer.
   */
  promptPreview?: string;
  /**
   * docs/162 — true when the rejected spawn was an Ops `--shipit-source` fix
   * session. Lets the failure card tailor its copy (e.g. a 403 here means "no
   * write access to the ShipIt repo — produce an incident report instead",
   * not a generic quota/parent error).
   */
  shipitSource?: boolean;
  /** ISO8601 timestamp the failure was recorded at. */
  failedAt: string;
}

/**
 * Server → Client: a child session the parent registered a notify-on-merge
 * watch on had its PR reach a terminal state — merged, or closed without merging
 * (docs/196).
 *
 * Emitted on the *parent's* runner via `runner.emitMessage(...)` when a runner
 * is attached, AND appended to the parent's chat history (the card fires from a
 * PR-poller event, outside any turn, so it can't ride `emitChatCard`). The
 * client renders a `ChildMergedCard` inline in the parent's chat — the child's
 * title/branch, the PR ref, and an "Open" button that switches to the child.
 * The actionable wake-turn is enqueued separately into the parent's message
 * queue; this card is purely the user-facing affordance.
 */
export interface WsChildMergedCard {
  type: "child_merged_card";
  /** Parent session id — the runner this event is emitted on. */
  sessionId: string;
  card: ChildMergedCard;
}
