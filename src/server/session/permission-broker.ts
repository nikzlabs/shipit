/**
 * PermissionBroker — the agent-agnostic core of ShipIt's sensitive-action
 * approval flow (SHI-112 / docs/193).
 *
 * ShipIt runs every agent CLI headless, where the backend's own permission gate
 * (Claude's "this is a sensitive file" prompt; Codex's escalated-command
 * approval) has no human to answer and so dead-ends the action. This broker is
 * the single locus that turns such a gate into a real, user-answerable
 * approve/deny card — regardless of which agent raised it:
 *
 * - **Claude** routes its built-in gate to ShipIt's `--permission-prompt-tool`
 *   MCP bridge (`mcp-permission-bridge.ts`), which POSTs the request to the
 *   worker; the worker calls {@link PermissionBroker.request}.
 * - **Codex** routes its app-server's blocking approval requests through the
 *   injected `requestPermission` callback (bound to {@link request}) instead of
 *   auto-accepting them.
 *
 * Both paths block on the returned promise. The broker broadcasts the canonical
 * `agent_permission_request` event (wrapped in an `agent_event` SSE frame, the
 * same channel the ask bridge uses) so the orchestrator renders + persists a
 * card; the user's answer arrives via {@link resolve} (driven by the
 * `resolve_permission` WS message → `/agent/permission/resolve`) and unblocks
 * the held promise, broadcasting `agent_permission_resolved` so the orchestrator
 * patches the card to its terminal state. There is no timeout — the request
 * stays pending until the user answers (or teardown drops it; see
 * {@link clearPending}).
 *
 * "Remember" is a per-session allow-set keyed by resource path: an approved
 * remember makes subsequent requests for the same path auto-resolve to `allow`
 * without surfacing a card again.
 *
 * The broker holds NO chat/persistence state — that lives orchestrator-side,
 * driven entirely by the two broadcast events. This keeps it pure transport +
 * policy and trivially unit-testable.
 */

import { randomUUID } from "node:crypto";
import type { AgentEvent, PermissionDecision, PermissionRequestInput } from "../shared/types.js";

interface PendingRequest {
  /** Settles {@link decision} — called once, by `resolve`/`clearPending`. */
  settle: (decision: PermissionDecision) => void;
  /** Resolves when the user (or teardown) settles this request. */
  decision: Promise<PermissionDecision>;
  /** True once settled; a second settle is a no-op (stale double-resolve). */
  settled: boolean;
  /** The settled decision, retained so a long-poll can consume it after the fact. */
  result?: PermissionDecision;
  path?: string;
  /** The gated tool call's id — the idempotency key (see {@link openRequest}). */
  toolUseId?: string;
}

/** Default bound on a single long-poll hold (worker clamps the client value). */
export const DEFAULT_PERMISSION_POLL_MS = 25_000;

/**
 * Tools ShipIt handles itself via its own interrupt/resume machinery, NOT the
 * sensitive-action gate — `AskUserQuestion` (renders the question card) and
 * `ExitPlanMode` (renders the PlanApproval card). They are allowlisted, but the
 * Claude CLI still routes these "control"-class tools through
 * `--permission-prompt-tool` (docs/193) before emitting their `tool_use`. If the
 * broker surfaced an approve/deny card for them, the user would get a dead-end
 * permission prompt instead of the real question/plan card (the orchestrator
 * interrupts on the `tool_use` regardless of the prompt's outcome). So we
 * auto-allow them here with no card — the CLI then emits the `tool_use` and the
 * normal interrupt flow takes over. See agent-listeners.ts's interrupt handling.
 */
const HANDLED_INTERRUPT_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * Best-effort resource path for a tool call. Covers the file-editing tools
 * whose sensitive-file gate is the whole point of SHI-112 (`file_path` for
 * Write/Edit, `notebook_path` for NotebookEdit) plus a generic `path`. Returns
 * undefined for path-less tools (e.g. Bash), where the card falls back to the
 * tool name + command summary.
 */
export function extractPermissionPath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** A short human summary for the card when the caller didn't supply one. */
export function describePermissionRequest(toolName: string, path: string | undefined, input: Record<string, unknown> | undefined): string {
  if (path) return `${toolName} ${path}`;
  const command = input?.command;
  if (typeof command === "string" && command.trim()) {
    const oneLine = command.trim().split("\n")[0];
    return `${toolName}: ${oneLine.length > 100 ? `${oneLine.slice(0, 97)}…` : oneLine}`;
  }
  return toolName;
}

export class PermissionBroker {
  private pending = new Map<string, PendingRequest>();
  /** toolUseId → requestId, so a retried open re-attaches to one card (idempotency). */
  private byToolUse = new Map<string, string>();
  /** Paths the user approved with "remember" — auto-allowed for the session. */
  private remembered = new Set<string>();
  private readonly broadcast: (event: AgentEvent) => void;

  constructor(opts: { broadcast: (event: AgentEvent) => void }) {
    this.broadcast = opts.broadcast;
  }

  /**
   * Open a permission request and block until the user answers it. Used by
   * adapters that hold the decision on a native blocking channel (Codex's
   * app-server approval RPC) — it directly awaits the returned promise. The
   * Claude `--permission-prompt-tool` bridge does NOT use this; it goes through
   * {@link openRequest} + {@link poll} so a long round-trip rides over a
   * transient worker blip instead of failing the held HTTP fetch (see those).
   *
   * There is deliberately NO timeout — a permission decision is the user's. The
   * request stays pending (and answerable) for as long as the backend holds the
   * call open; it is only settled by a user decision (`resolve`) or by teardown
   * (`clearPending`).
   */
  request(input: PermissionRequestInput): Promise<PermissionDecision> {
    const opened = this.openRequest(input);
    if (opened.immediate) return Promise.resolve(opened.immediate);
    const requestId = opened.requestId!;
    const entry = this.pending.get(requestId);
    if (!entry) return Promise.resolve({ behavior: "deny" });
    // Direct-await owner cleans up its own entry once settled (there is no poll
    // to consume it on this path).
    return entry.decision.finally(() => this.drop(requestId));
  }

  /**
   * Register a permission request and return its id WITHOUT blocking — the
   * non-blocking half of the long-poll protocol the Claude bridge uses.
   *
   * Returns `{ immediate }` (an `allow`, no card) when the action is
   * pre-approved: a ShipIt-handled interrupt tool (`AskUserQuestion` /
   * `ExitPlanMode`, resolved by ShipIt's own flow) or a path previously approved
   * with "remember". Otherwise registers the request, broadcasts the canonical
   * `agent_permission_request` card event, and returns `{ requestId }` for the
   * caller to {@link poll}.
   *
   * **Idempotent on `toolUseId`.** If a still-pending request already exists for
   * the same gated tool call, returns that same `requestId` and broadcasts NO
   * new card. This is what stops a retried/duplicated open (a transient blip
   * losing the response, the bridge re-POSTing) from STACKING a second identical
   * permission card — the exact symptom this fixes (Thread B). A fresh-modelled
   * retry carries a new `toolUseId` and correctly gets its own card.
   */
  openRequest(input: PermissionRequestInput): { requestId?: string; immediate?: PermissionDecision } {
    // ShipIt-handled interrupt tools (AskUserQuestion / ExitPlanMode) are never
    // a sensitive action — auto-allow with no card so the CLI proceeds to emit
    // the tool_use and ShipIt's own interrupt/resume flow renders the right
    // card. Without this, docs/193's permission-prompt-tool intercepts them and
    // surfaces a dead-end approve/deny card (the original bug).
    if (HANDLED_INTERRUPT_TOOLS.has(input.toolName)) {
      return { immediate: { behavior: "allow" } };
    }

    const path = input.path ?? extractPermissionPath(input.input);

    // Remembered → auto-allow, no card. (Path-less requests are never
    // remembered, so they always surface.)
    if (path && this.remembered.has(path)) {
      return { immediate: { behavior: "allow" } };
    }

    // Idempotency: a still-pending request for the same tool call re-attaches
    // to the existing card rather than opening a second one.
    if (input.toolUseId) {
      const existingId = this.byToolUse.get(input.toolUseId);
      const existing = existingId ? this.pending.get(existingId) : undefined;
      if (existingId && existing && !existing.settled) {
        return { requestId: existingId };
      }
    }

    const requestId = `perm_${randomUUID()}`;
    const summary = input.summary ?? describePermissionRequest(input.toolName, path, input.input);

    let settle!: (decision: PermissionDecision) => void;
    const decision = new Promise<PermissionDecision>((res) => {
      settle = res;
    });
    this.pending.set(requestId, {
      settle,
      decision,
      settled: false,
      ...(path ? { path } : {}),
      ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
    });
    if (input.toolUseId) this.byToolUse.set(input.toolUseId, requestId);

    this.broadcast({
      type: "agent_permission_request",
      requestId,
      toolName: input.toolName,
      ...(path ? { path } : {}),
      summary,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    });

    return { requestId };
  }

  /**
   * Long-poll for a request's decision, holding up to `timeoutMs` (a BOUND on
   * this hold, NOT a deadline on the request). Returns `{ settled: true,
   * decision }` once the user answers — consuming and dropping the entry — or
   * `{ settled: false }` when the hold elapses with the request still pending,
   * signalling the caller to poll again.
   *
   * The bound is the whole point: each hold is short, so the bridge's fetch
   * never trips an undici/client timeout while a user takes their time, and a
   * worker that briefly can't be reached surfaces as a quick failed poll the
   * bridge retries — rather than one indefinitely-held fetch that dies with
   * "fetch failed" and forces a fail-closed deny (Thread B). An unknown id
   * (worker restarted and lost the request, or it was already consumed) returns
   * settled `deny` so the caller stops polling and fails closed.
   */
  async poll(requestId: string, timeoutMs = DEFAULT_PERMISSION_POLL_MS): Promise<{ settled: boolean; decision?: PermissionDecision }> {
    const entry = this.pending.get(requestId);
    if (!entry) return { settled: true, decision: { behavior: "deny" } };
    if (entry.settled) return { settled: true, decision: this.consume(requestId, entry) };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((res) => {
      timer = setTimeout(() => res("timeout"), Math.max(0, timeoutMs));
    });
    try {
      // eslint-disable-next-line no-restricted-syntax -- Promise.race tag: map the decision settle to a discriminator
      const outcome = await Promise.race([entry.decision.then(() => "settled" as const), timedOut]);
      if (outcome === "settled") {
        return { settled: true, decision: this.consume(requestId, entry) };
      }
      return { settled: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Drop a settled entry and hand back its decision (default deny defensively). */
  private consume(requestId: string, entry: PendingRequest): PermissionDecision {
    const decision = entry.result ?? { behavior: "deny" };
    this.drop(requestId);
    return decision;
  }

  /** Remove an entry from both indexes. */
  private drop(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    if (entry.toolUseId) this.byToolUse.delete(entry.toolUseId);
  }

  /**
   * Deliver the user's decision for a pending request. Returns true when the
   * request existed and was still open (false → already resolved / unknown id,
   * e.g. a stale card after a worker restart). An `allow` with `remember` adds
   * the path to the session allow-set. Broadcasts `agent_permission_resolved` so
   * the orchestrator flips the card to its terminal state. The entry is retained
   * (settled) until a `request`/`poll` consumer reads the decision, so a poll
   * that arrives just after resolution still gets the answer.
   */
  resolve(requestId: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.settled) return false;

    const remembered = decision.behavior === "allow" && decision.remember === true && !!entry.path;
    if (remembered && entry.path) this.remembered.add(entry.path);

    entry.settled = true;
    entry.result = decision;
    entry.settle(decision);
    this.broadcast({
      type: "agent_permission_resolved",
      requestId,
      behavior: decision.behavior,
      ...(remembered ? { remembered: true } : {}),
    });
    return true;
  }

  /**
   * Internal teardown only — settle every held promise (as a silent deny) so
   * the worker doesn't leak a held bridge response / awaiting RPC when the agent
   * process goes away. Deliberately broadcasts NOTHING: the card stays `pending`
   * in the transcript rather than flipping to a synthetic terminal state. There
   * is no "expired" — an unanswered prompt is an honest record that it wasn't
   * answered, not a ShipIt-imposed cutoff.
   */
  clearPending(): void {
    for (const entry of this.pending.values()) {
      entry.settled = true;
      entry.settle({ behavior: "deny" });
    }
    this.pending.clear();
    this.byToolUse.clear();
  }

  /** Number of requests currently registered (diagnostics / tests). */
  get pendingCount(): number {
    return this.pending.size;
  }
}
