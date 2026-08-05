import { describe, it, expect, vi } from "vitest";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionInfo, SessionTitleSource } from "../../shared/types.js";
import { isTitleLockedAgainst, renameSessionByAgent, MAX_SESSION_TITLE_LENGTH } from "./session-title.js";
import { ServiceError } from "./types.js";

interface FakeState {
  id: string;
  title: string;
  titleSource?: SessionTitleSource;
  branch?: string;
}

function buildDeps(initial: FakeState, opts: { attached?: boolean; running?: boolean } = {}) {
  const state: FakeState = { ...initial };
  const emitMessage = vi.fn();
  const replaceInProgress = vi.fn();
  const append = vi.fn();
  const sseBroadcast = vi.fn();
  const setBranch = vi.fn();

  const sessionManager = {
    get: vi.fn((id: string): SessionInfo | undefined =>
      id === state.id ? ({ ...state } as unknown as SessionInfo) : undefined),
    rename: vi.fn((id: string, title: string, source?: SessionTitleSource) => {
      if (id !== state.id) return null;
      state.title = title;
      state.titleSource = source;
      return { ...state } as unknown as SessionInfo;
    }),
    setBranch,
  } as unknown as SessionManager;

  const runnerRegistry = {
    get: vi.fn(() => (opts.attached === false
      ? undefined
      : {
        emitMessage,
        running: opts.running ?? true,
        recordedCards: [],
        chatMessageGroups: [],
        steeredMessages: [],
      })),
  } as unknown as SessionRunnerRegistry;

  return {
    deps: {
      sessionManager,
      runnerRegistry,
      chatHistoryManager: { replaceInProgress, append },
      sseBroadcast,
    },
    spies: { emitMessage, replaceInProgress, append, sseBroadcast, setBranch },
    state,
  };
}

describe("isTitleLockedAgainst — the whole precedence rule (docs/250 reqs 4, 7, 8)", () => {
  it("never blocks the user: they override an agent title and their own", () => {
    expect(isTitleLockedAgainst({ titleSource: "agent" }, "user")).toBe(false);
    expect(isTitleLockedAgainst({ titleSource: "user" }, "user")).toBe(false);
    expect(isTitleLockedAgainst({}, "user")).toBe(false);
  });

  it("locks a user-set title against both the agent and automatic naming (req 4)", () => {
    expect(isTitleLockedAgainst({ titleSource: "user" }, "agent")).toBe(true);
    expect(isTitleLockedAgainst({ titleSource: "user" }, undefined)).toBe(true);
  });

  it("locks an agent-set title against automatic naming but not against the agent (req 8)", () => {
    expect(isTitleLockedAgainst({ titleSource: "agent" }, undefined)).toBe(true);
    expect(isTitleLockedAgainst({ titleSource: "agent" }, "agent")).toBe(false);
  });

  it("leaves an automatic or born-with title replaceable by everyone (req 7)", () => {
    // No source is what an `explicitTitle` from the seeding issue / a parent
    // agent records, so those must NOT lock — they describe the starting task.
    expect(isTitleLockedAgainst({}, "agent")).toBe(false);
    expect(isTitleLockedAgainst({}, undefined)).toBe(false);
  });
});

describe("renameSessionByAgent", () => {
  it("renames, records the agent as the source, and broadcasts the sidebar update", () => {
    const { deps, spies, state } = buildDeps({ id: "s1", title: "Fix the flaky test" });

    const result = renameSessionByAgent(deps, "s1", "Harden the CI pipeline");

    expect(result).toEqual({
      sessionId: "s1",
      previousTitle: "Fix the flaky test",
      title: "Harden the CI pipeline",
    });
    expect(state.title).toBe("Harden the CI pipeline");
    expect(state.titleSource).toBe("agent");
    expect(spies.sseBroadcast).toHaveBeenCalledWith(
      "session_renamed",
      expect.objectContaining({ session: expect.objectContaining({ title: "Harden the CI pipeline" }) }),
    );
  });

  it("emits AND persists the transcript card (req 9 — emit-only would vanish on reload)", () => {
    const { deps, spies } = buildDeps({ id: "s1", title: "Old" });

    renameSessionByAgent(deps, "s1", "New");

    const emitted = spies.emitMessage.mock.calls[0]?.[0] as { type: string; sessionId: string; card: { from: string; to: string } };
    expect(emitted.type).toBe("session_renamed_card");
    expect(emitted.sessionId).toBe("s1");
    expect(emitted.card).toMatchObject({ from: "Old", to: "New" });
    // emitChatCard persists in the same call — a card that only emitted would
    // render live and disappear on the next history load.
    expect(spies.replaceInProgress).toHaveBeenCalled();
  });

  it("refuses when the user renamed by hand, without changing anything (req 4)", () => {
    const { deps, spies, state } = buildDeps({ id: "s1", title: "My name for this", titleSource: "user" });

    expect(() => renameSessionByAgent(deps, "s1", "Agent's idea")).toThrow(ServiceError);
    try {
      renameSessionByAgent(deps, "s1", "Agent's idea");
    } catch (err) {
      expect((err as ServiceError).statusCode).toBe(409);
      // The message has to name the winning title so the agent stops trying.
      expect((err as ServiceError).message).toContain("My name for this");
    }
    expect(state.title).toBe("My name for this");
    expect(spies.emitMessage).not.toHaveBeenCalled();
    expect(spies.sseBroadcast).not.toHaveBeenCalled();
  });

  it("lets the agent rename over its own earlier title", () => {
    const { deps, state } = buildDeps({ id: "s1", title: "First agent name", titleSource: "agent" });

    renameSessionByAgent(deps, "s1", "Second agent name");

    expect(state.title).toBe("Second agent name");
  });

  it("never touches the git branch (req 10)", () => {
    const { deps, spies, state } = buildDeps({ id: "s1", title: "Old", branch: "shipit/keep-me-abc123" });

    renameSessionByAgent(deps, "s1", "Completely different work");

    // A PR is usually already open on this branch; moving it would strand the PR.
    expect(spies.setBranch).not.toHaveBeenCalled();
    expect(state.branch).toBe("shipit/keep-me-abc123");
  });

  it("rejects an over-length title instead of truncating it", () => {
    const { deps, state } = buildDeps({ id: "s1", title: "Old" });
    const tooLong = "x".repeat(MAX_SESSION_TITLE_LENGTH + 1);

    expect(() => renameSessionByAgent(deps, "s1", tooLong)).toThrow(/maximum is 60/);
    // Silent truncation would leave the agent believing it set the long title.
    expect(state.title).toBe("Old");
  });

  it("rejects an empty or whitespace-only title", () => {
    const { deps } = buildDeps({ id: "s1", title: "Old" });
    expect(() => renameSessionByAgent(deps, "s1", "   ")).toThrow(ServiceError);
    expect(() => renameSessionByAgent(deps, "s1", undefined)).toThrow(ServiceError);
  });

  it("trims surrounding whitespace", () => {
    const { deps, state } = buildDeps({ id: "s1", title: "Old" });
    renameSessionByAgent(deps, "s1", "  Padded title  ");
    expect(state.title).toBe("Padded title");
  });

  it("is a quiet success when the title already matches — no card, no broadcast", () => {
    const { deps, spies } = buildDeps({ id: "s1", title: "Same" });

    const result = renameSessionByAgent(deps, "s1", "Same");

    expect(result.title).toBe("Same");
    expect(spies.emitMessage).not.toHaveBeenCalled();
    expect(spies.sseBroadcast).not.toHaveBeenCalled();
  });

  // CLAUDE.md — a card firing after its turn finalized MUST NOT take the
  // in-progress path: `persistTurnInProgress` would revive the finished turn as a
  // duplicate in_progress set, which the next turn's first `replaceInProgress`
  // deletes wholesale, card included. `emitChatCard` branches on `runner.running`
  // to pick `append` instead; this pins that we hand it a real runner so that
  // branch can actually be taken.
  it("appends the card as a final row when no turn is running", () => {
    const { deps, spies } = buildDeps({ id: "s1", title: "Old" }, { running: false });

    renameSessionByAgent(deps, "s1", "New");

    expect(spies.append).toHaveBeenCalledTimes(1);
    expect(spies.replaceInProgress).not.toHaveBeenCalled();
  });

  it("still renames when no runner is attached — only the card is best-effort", () => {
    const { deps, spies, state } = buildDeps({ id: "s1", title: "Old" }, { attached: false });

    renameSessionByAgent(deps, "s1", "New");

    expect(state.title).toBe("New");
    expect(spies.sseBroadcast).toHaveBeenCalled();
    expect(spies.emitMessage).not.toHaveBeenCalled();
  });

  it("404s for an unknown session", () => {
    const { deps } = buildDeps({ id: "s1", title: "Old" });
    expect(() => renameSessionByAgent(deps, "nope", "New")).toThrow(/Session not found/);
  });
});
