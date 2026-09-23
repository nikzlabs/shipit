import { describe, it, expect } from "vitest";
import { countLiveChildren } from "./child-sessions.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionInfo } from "../../shared/types.js";

const LAST_USED = "2026-09-01T10:00:00.000Z";
const RESOLVED_AFTER = "2026-09-01T11:00:00.000Z";

function child(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    title: id,
    createdAt: LAST_USED,
    lastUsedAt: LAST_USED,
    remoteUrl: "https://github.com/owner/repo.git",
    parentSessionId: "parent",
    ...extra,
  } as SessionInfo;
}

interface RunnerState {
  agentBusy?: boolean;
  queueLength?: number;
}

function deps(opts: {
  broods?: Record<string, SessionInfo[]>;
  runners?: Record<string, RunnerState>;
} = {}) {
  const sessionManager = {
    findChildren: (id: string) => opts.broods?.[id] ?? [],
  } as unknown as SessionManager;
  const runnerRegistry = {
    get: (id: string) => {
      const state = opts.runners?.[id];
      if (!state) return undefined;
      return { agentBusy: state.agentBusy === true, queueLength: state.queueLength ?? 0 };
    },
  } as unknown as SessionRunnerRegistry;
  return { sessionManager, runnerRegistry };
}

describe("countLiveChildren", () => {
  it("counts a child that has neither merged nor closed", () => {
    const { sessionManager, runnerRegistry } = deps();
    expect(countLiveChildren(sessionManager, runnerRegistry, [child("a"), child("b")])).toBe(2);
  });

  it("does not count a merged or closed child", () => {
    const { sessionManager, runnerRegistry } = deps();
    const children = [
      child("merged", { mergedAt: RESOLVED_AFTER }),
      child("closed", { closedAt: RESOLVED_AFTER }),
      child("open"),
    ];
    expect(countLiveChildren(sessionManager, runnerRegistry, children)).toBe(1);
  });

  it("counts a merged child that the user has worked in since the merge", () => {
    const { sessionManager, runnerRegistry } = deps();
    const reopened = child("reopened", { mergedAt: LAST_USED, lastUsedAt: RESOLVED_AFTER });
    expect(countLiveChildren(sessionManager, runnerRegistry, [reopened])).toBe(1);
  });

  it("counts a merged child the user pinned", () => {
    const { sessionManager, runnerRegistry } = deps();
    const pinned = child("pinned", { mergedAt: RESOLVED_AFTER, pinnedAt: RESOLVED_AFTER });
    expect(countLiveChildren(sessionManager, runnerRegistry, [pinned])).toBe(1);
  });

  it("counts a merged child whose workspace ShipIt could not make durable", () => {
    const { sessionManager, runnerRegistry } = deps();
    const broken = child("broken", { mergedAt: RESOLVED_AFTER, workspaceBlock: "conflict" });
    expect(countLiveChildren(sessionManager, runnerRegistry, [broken])).toBe(1);
  });

  // The idle enforcer refuses to reclaim on `agentBusy`, not on `running`, so a child
  // that still costs a container must still cost a slot.
  it("counts a merged child still busy with background work", () => {
    const { sessionManager, runnerRegistry } = deps({ runners: { busy: { agentBusy: true } } });
    const busy = child("busy", { mergedAt: RESOLVED_AFTER });
    expect(countLiveChildren(sessionManager, runnerRegistry, [busy])).toBe(1);
  });

  it("counts a merged child with a queued turn it has not started", () => {
    const { sessionManager, runnerRegistry } = deps({
      runners: { queued: { agentBusy: false, queueLength: 1 } },
    });
    const queued = child("queued", { mergedAt: RESOLVED_AFTER });
    expect(countLiveChildren(sessionManager, runnerRegistry, [queued])).toBe(1);
  });

  it("counts a merged child that still has unfinished children of its own", () => {
    const { sessionManager, runnerRegistry } = deps({
      broods: { nester: [child("grandchild", { parentSessionId: "nester" })] },
    });
    const nester = child("nester", { mergedAt: RESOLVED_AFTER });
    expect(countLiveChildren(sessionManager, runnerRegistry, [nester])).toBe(1);
  });

  // The incident shape, one level down: a merged coordinator whose own children all
  // merged must release its slot, or nested orchestration hits the same wall.
  it("does not count a merged child whose children have all merged too", () => {
    const { sessionManager, runnerRegistry } = deps({
      broods: {
        nester: [child("grandchild", { parentSessionId: "nester", mergedAt: RESOLVED_AFTER })],
      },
    });
    const nester = child("nester", { mergedAt: RESOLVED_AFTER });
    expect(countLiveChildren(sessionManager, runnerRegistry, [nester])).toBe(0);
  });

  it("counts a merged child with an unfinished grandchild two levels down", () => {
    const { sessionManager, runnerRegistry } = deps({
      broods: {
        nester: [child("mid", { parentSessionId: "nester", mergedAt: RESOLVED_AFTER })],
        mid: [child("deep", { parentSessionId: "mid" })],
      },
    });
    const nester = child("nester", { mergedAt: RESOLVED_AFTER });
    expect(countLiveChildren(sessionManager, runnerRegistry, [nester])).toBe(1);
  });

  it("does not walk descendants of a child that is unfinished on its own terms", () => {
    const queried: string[] = [];
    const sessionManager = {
      findChildren: (id: string) => {
        queried.push(id);
        return [];
      },
    } as unknown as SessionManager;
    const runnerRegistry = { get: () => undefined } as unknown as SessionRunnerRegistry;
    expect(countLiveChildren(sessionManager, runnerRegistry, [child("open")])).toBe(1);
    expect(queried).toEqual([]);
  });

  it("terminates on a cyclic parent link", () => {
    const loop = child("loop", { mergedAt: RESOLVED_AFTER });
    const { sessionManager, runnerRegistry } = deps({ broods: { loop: [loop] } });
    expect(countLiveChildren(sessionManager, runnerRegistry, [loop])).toBe(0);
  });
});
