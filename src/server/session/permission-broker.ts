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
 * the held promise. Every resolution — user, timeout, or teardown — also
 * broadcasts `agent_permission_resolved` so the orchestrator patches the card
 * to its terminal state from one place.
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
  resolve: (decision: PermissionDecision) => void;
  path?: string;
}

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
  /** Paths the user approved with "remember" — auto-allowed for the session. */
  private remembered = new Set<string>();
  private readonly broadcast: (event: AgentEvent) => void;

  constructor(opts: { broadcast: (event: AgentEvent) => void }) {
    this.broadcast = opts.broadcast;
  }

  /**
   * Open a permission request and block until the user answers it. If the
   * resource path was previously approved with "remember", resolves immediately
   * to `allow` and surfaces no card. Otherwise registers the request, broadcasts
   * the canonical `agent_permission_request` event, and returns a promise that
   * settles when (and only when) the user decides.
   *
   * There is deliberately NO timeout — a permission decision is the user's, and
   * ShipIt does not impose its own deadline on it. The request stays pending
   * (and answerable) for as long as the backend holds the call open; it is only
   * settled by a user decision (`resolve`) or by teardown when the backend
   * process actually goes away (`clearPending`).
   */
  request(input: PermissionRequestInput): Promise<PermissionDecision> {
    const path = input.path ?? extractPermissionPath(input.input);

    // Remembered → auto-allow, no card. (Path-less requests are never
    // remembered, so they always surface.)
    if (path && this.remembered.has(path)) {
      return Promise.resolve({ behavior: "allow" });
    }

    const requestId = `perm_${randomUUID()}`;
    const summary = input.summary ?? describePermissionRequest(input.toolName, path, input.input);

    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(requestId, { resolve, path });

      this.broadcast({
        type: "agent_permission_request",
        requestId,
        toolName: input.toolName,
        ...(path ? { path } : {}),
        summary,
        ...(input.agentId ? { agentId: input.agentId } : {}),
      });
    });
  }

  /**
   * Deliver the user's decision for a pending request. Returns true when the
   * request existed (false → already resolved / unknown id, e.g. a stale card
   * after a worker restart). An `allow` with `remember` adds the path to the
   * session allow-set. Broadcasts `agent_permission_resolved` so the
   * orchestrator flips the card to its terminal state.
   */
  resolve(requestId: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);

    const remembered = decision.behavior === "allow" && decision.remember === true && !!entry.path;
    if (remembered && entry.path) this.remembered.add(entry.path);

    entry.resolve(decision);
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
      entry.resolve({ behavior: "deny" });
    }
    this.pending.clear();
  }

  /** Number of requests currently awaiting a decision (diagnostics / tests). */
  get pendingCount(): number {
    return this.pending.size;
  }
}
