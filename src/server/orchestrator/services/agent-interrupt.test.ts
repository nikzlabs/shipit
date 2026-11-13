import { describe, it, expect, vi } from "vitest";
import { SessionRunner } from "../session-runner.js";
import { interruptAgentTurn } from "./agent-interrupt.js";
import type { AgentId } from "../../shared/types.js";

describe("Stop and a waiting automatic continuation (docs/342-transient-provider-retry req 4)", () => {
  const press = (runner: SessionRunner, cancelTransientRetry: (id: string) => boolean) =>
    interruptAgentTurn(
      {
        sessionManager: { dropPendingCompactionNote: vi.fn() },
        broadcastLog: vi.fn(),
        postInterruptCommitDeps: {} as never,
        cancelTransientRetry,
      },
      runner,
    );

  it("cancels it, and says Stop did something", () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/none", defaultAgentId: "claude" as AgentId });
    const cancel = vi.fn(() => true);

    expect(press(runner, cancel)).toBe("queue");
    expect(cancel).toHaveBeenCalledWith("s1");
    runner.dispose({ force: true });
  });

  it("reports nothing to stop when none waited either", () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/none", defaultAgentId: "claude" as AgentId });

    expect(press(runner, () => false)).toBe("nothing");
    runner.dispose({ force: true });
  });
});
