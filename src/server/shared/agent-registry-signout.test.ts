import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentRegistry } from "./agent-registry.js";

describe("AgentRegistry sign-out event", () => {
  let prevKey: string | undefined;
  beforeEach(() => {
    prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
  });

  it("emits sign-out when an agent's auth drops to not-configured", async () => {
    let codexAuthed = true;
    const registry = new AgentRegistry({
      checkBinary: async () => true,
      checkClaudeAuth: () => true,
      checkCodexAuth: () => codexAuthed,
    });
    await registry.detect();

    const onSignOut = vi.fn();
    registry.on("sign-out", onSignOut);

    registry.refreshAuth("codex");
    expect(onSignOut).not.toHaveBeenCalled();

    codexAuthed = false;
    registry.refreshAuth("codex");
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(onSignOut).toHaveBeenCalledWith("codex");

    registry.refreshAuth("codex");
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("does not emit on a not-configured → configured transition (a sign-in)", async () => {
    let codexAuthed = false;
    const registry = new AgentRegistry({
      checkBinary: async () => true,
      checkClaudeAuth: () => true,
      checkCodexAuth: () => codexAuthed,
    });
    await registry.detect();
    const onSignOut = vi.fn();
    registry.on("sign-out", onSignOut);

    codexAuthed = true;
    registry.refreshAuth("codex");
    expect(onSignOut).not.toHaveBeenCalled();
  });
});
