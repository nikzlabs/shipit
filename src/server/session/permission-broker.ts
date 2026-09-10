// Approval decisions have no deadline. The orchestrator persists cards from broker events.

import { randomUUID } from "node:crypto";
import type { AgentEvent, PermissionDecision, PermissionRequestInput } from "../shared/types.js";

interface PendingRequest {
  settle: (decision: PermissionDecision) => void;
  decision: Promise<PermissionDecision>;
  settled: boolean;
  result?: PermissionDecision;
  path?: string;
  toolUseId?: string;
}

export const DEFAULT_PERMISSION_POLL_MS = 25_000;

// These tools must reach tool_use so ShipIt's question/plan interrupt flow can run.
const HANDLED_INTERRUPT_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

const PATH_KEYS = ["file_path", "notebook_path", "path"];

export function extractPermissionPath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function describePermissionRequest(toolName: string, path: string | undefined, input: Record<string, unknown> | undefined): string {
  if (path) return `${toolName} ${path}`;
  const command = input?.command;
  if (typeof command === "string" && command.trim()) {
    const oneLine = command.trim().split("\n")[0];
    return `${toolName}: ${oneLine.length > 100 ? `${oneLine.slice(0, 97)}…` : oneLine}`;
  }
  return toolName;
}

export const PERMISSION_DETAILS_CHARS = 4_000;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

export function describePermissionDetails(
  input: Record<string, unknown> | undefined,
  shown: { summary?: string; path?: string } = {},
): string | undefined {
  if (!input) return undefined;
  const command = input.command;
  let body: string | undefined;
  if (typeof command === "string" && command.trim()) {
    body = command;
  } else {
    const rest = Object.entries(input).filter(
      ([key, value]) => !(PATH_KEYS.includes(key) && value === shown.path),
    );
    if (rest.length > 0) body = JSON.stringify(Object.fromEntries(rest), null, 2);
  }
  if (!body) return undefined;
  if (shown.summary && collapse(shown.summary).includes(collapse(body))) return undefined;
  return body.length > PERMISSION_DETAILS_CHARS
    ? `${body.slice(0, PERMISSION_DETAILS_CHARS)}…`
    : body;
}

export class PermissionBroker {
  private pending = new Map<string, PendingRequest>();
  private byToolUse = new Map<string, string>();
  private remembered = new Set<string>();
  private readonly broadcast: (event: AgentEvent) => void;

  constructor(opts: { broadcast: (event: AgentEvent) => void }) {
    this.broadcast = opts.broadcast;
  }

  request(input: PermissionRequestInput): Promise<PermissionDecision> {
    const opened = this.openRequest(input);
    if (opened.immediate) return Promise.resolve(opened.immediate);
    const requestId = opened.requestId!;
    const entry = this.pending.get(requestId);
    if (!entry) return Promise.resolve({ behavior: "deny" });
    return entry.decision.finally(() => this.drop(requestId));
  }

  openRequest(input: PermissionRequestInput): { requestId?: string; immediate?: PermissionDecision } {
    if (HANDLED_INTERRUPT_TOOLS.has(input.toolName)) {
      return { immediate: { behavior: "allow" } };
    }

    const path = input.path ?? extractPermissionPath(input.input);

    if (path && this.remembered.has(path)) {
      return { immediate: { behavior: "allow" } };
    }

    // Retried POSTs must reuse the pending card.
    if (input.toolUseId) {
      const existingId = this.byToolUse.get(input.toolUseId);
      const existing = existingId ? this.pending.get(existingId) : undefined;
      if (existingId && existing && !existing.settled) {
        return { requestId: existingId };
      }
    }

    const requestId = `perm_${randomUUID()}`;
    const summary = input.summary ?? describePermissionRequest(input.toolName, path, input.input);
    const details = describePermissionDetails(input.input, { summary, ...(path ? { path } : {}) });

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
      ...(details ? { details } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    });

    return { requestId };
  }

  // Bound each HTTP hold, not the user's decision time. Unknown IDs fail closed.
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

  private consume(requestId: string, entry: PendingRequest): PermissionDecision {
    const decision = entry.result ?? { behavior: "deny" };
    this.drop(requestId);
    return decision;
  }

  private drop(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    if (entry.toolUseId) this.byToolUse.delete(entry.toolUseId);
  }

  // Retain the decision until consumed so a poll after resolution still receives it.
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

  // Teardown denies held calls silently; unanswered transcript cards remain pending.
  clearPending(): void {
    for (const entry of this.pending.values()) {
      entry.settled = true;
      entry.settle({ behavior: "deny" });
    }
    this.pending.clear();
    this.byToolUse.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
