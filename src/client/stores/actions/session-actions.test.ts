import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHeadlessSession } from "./session-actions.js";
import { useSessionStore } from "../session-store.js";
import type { SessionInfo } from "../../../server/shared/types.js";

function session(id: string, title = id): SessionInfo {
  return {
    id,
    title,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    remoteUrl: "https://github.com/acme/app.git",
  };
}

describe("createHeadlessSession", () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [session("existing", "Existing")] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useSessionStore.setState({ sessions: [], sessionId: undefined });
  });

  it("posts to the headless session route and prepends the returned session without navigating", async () => {
    const returned = session("quick-1", "Fix CI");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ session: returned }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createHeadlessSession({
      repoUrl: "https://github.com/acme/app.git",
      initialPrompt: "fix CI",
      branch: "quick-ci",
      agent: "codex",
      model: "gpt-5.4",
    });

    expect(result).toEqual(returned);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/headless", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        repoUrl: "https://github.com/acme/app.git",
        initialPrompt: "fix CI",
        branch: "quick-ci",
        agent: "codex",
        model: "gpt-5.4",
      }),
    });
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(["quick-1", "existing"]);
    expect(useSessionStore.getState().sessionId).toBeUndefined();
  });

  it("replaces an existing copy of the returned session instead of duplicating it", async () => {
    useSessionStore.setState({ sessions: [session("quick-1", "Old"), session("existing", "Existing")] });
    const returned = session("quick-1", "Updated");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ session: returned }),
    }));

    await createHeadlessSession({
      repoUrl: "https://github.com/acme/app.git",
      initialPrompt: "try again",
    });

    expect(useSessionStore.getState().sessions).toEqual([returned, session("existing", "Existing")]);
  });

  it("throws the server-provided error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: "You already have 8 quick sessions running." }),
    }));

    await expect(createHeadlessSession({
      repoUrl: "https://github.com/acme/app.git",
      initialPrompt: "one more",
    })).rejects.toThrow("You already have 8 quick sessions running.");
  });
});
