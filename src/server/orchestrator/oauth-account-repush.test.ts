import { beforeEach, describe, expect, it, vi } from "vitest";

const { pushed, markers } = vi.hoisted(() => ({
  pushed: [] as { sessionId: string; via: "account" | "legacy"; repair: boolean | undefined }[],
  markers: new Map<string, string>(),
}));

vi.mock("./session-credentials.js", () => ({
  readSessionAccountMarker: (_root: string, sessionId: string) => {
    const account = markers.get(sessionId);
    return account === undefined ? {} : { claude: account };
  },
  repushProviderAccountToken: (
    _root: string, sessionId: string, _agent: string, _account: string, _a: unknown, _b: unknown,
    opts?: { repairLeakedSubtrees?: boolean },
  ) => {
    pushed.push({ sessionId, via: "account", repair: opts?.repairLeakedSubtrees });
    return true;
  },
  repushAgentToken: (
    _root: string, sessionId: string, _agent: string, _a: unknown, _b: unknown,
    opts?: { repairLeakedSubtrees?: boolean },
  ) => {
    pushed.push({ sessionId, via: "legacy", repair: opts?.repairLeakedSubtrees });
    return true;
  },
}));

import { TEST_CREDENTIALS_DIR } from "./credentials-test-helpers.js";
import { createOAuthAccountRepush } from "./oauth-account-repush.js";

const session = (id: string, agentId: "claude" | "codex" = "claude", agentPinned = true) => ({ id, agentId, agentPinned });

describe("createOAuthAccountRepush", () => {
  beforeEach(() => {
    pushed.length = 0;
    markers.clear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("pushes to the sessions with a live CLI first, and repairs only the idle ones", () => {
    const live = new Set(["live-1", "live-2"]);
    const repush = createOAuthAccountRepush({
      credentialsDir: TEST_CREDENTIALS_DIR,
      listSessions: () => [session("idle-1"), session("live-1"), session("idle-2"), session("live-2")],
      hasLiveAgent: (id) => live.has(id),
    }, "test");

    repush("claude", "acct-1");

    expect(pushed.map((p) => p.sessionId)).toEqual(["live-1", "live-2", "idle-1", "idle-2"]);
    expect(pushed.map((p) => p.repair)).toEqual([false, false, true, true]);
  });

  it("skips other agents, unpinned sessions and sessions marked for another account", () => {
    markers.set("other-account", "acct-2");
    markers.set("this-account", "acct-1");
    const repush = createOAuthAccountRepush({
      credentialsDir: TEST_CREDENTIALS_DIR,
      listSessions: () => [
        session("codex", "codex"),
        session("unpinned", "claude", false),
        session("other-account"),
        session("this-account"),
        session("unmarked"),
      ],
      hasLiveAgent: () => false,
    }, "test");

    repush("claude", "acct-1");

    expect(pushed).toEqual([
      { sessionId: "this-account", via: "account", repair: true },
      { sessionId: "unmarked", via: "legacy", repair: true },
    ]);
  });
});
