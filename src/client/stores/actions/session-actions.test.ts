import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHeadlessSession, handleSessionResume, resumeSessionInternal, startQuickSessionInBackground } from "./session-actions.js";
import { useSessionStore } from "../session-store.js";
import { useUiStore } from "../ui-store.js";
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
      status: 500,
      json: async () => ({ error: "Something went wrong starting the session." }),
    }));

    await expect(createHeadlessSession({
      repoUrl: "https://github.com/acme/app.git",
      initialPrompt: "one more",
    })).rejects.toThrow("Something went wrong starting the session.");
  });
});

describe("startQuickSessionInBackground (docs/205)", () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [] });
    useUiStore.setState({ toast: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useSessionStore.setState({ sessions: [], sessionId: undefined });
    useUiStore.setState({ toast: null });
  });

  it("creates the session, notifies onCreated, and shows no toast on success", async () => {
    const returned = session("quick-bg", "Background");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ session: returned }),
    }));
    const onCreated = vi.fn();

    startQuickSessionInBackground(
      { repoUrl: "https://github.com/acme/app.git", initialPrompt: "go" },
      onCreated,
    );

    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(returned));
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toContain("quick-bg");
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("surfaces a failure as an error toast and does not call onCreated", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "Boom." }),
    }));
    const onCreated = vi.fn();

    startQuickSessionInBackground(
      { repoUrl: "https://github.com/acme/app.git", initialPrompt: "go" },
      onCreated,
    );

    await vi.waitFor(() => {
      const toast = useUiStore.getState().toast;
      expect(toast?.message).toBe("Boom.");
      expect(toast?.variant).toBe("error");
    });
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe("resumeSessionInternal", () => {
  afterEach(() => {
    useSessionStore.getState().reset();
    useSessionStore.setState({ sessionId: undefined });
  });

  it("clears the transient compacting flag so it doesn't bleed into the switched-to session", () => {
    // Outgoing session has a compaction in flight.
    useSessionStore.setState({ sessionId: "session-a", compacting: true });

    resumeSessionInternal("session-b");

    expect(useSessionStore.getState().sessionId).toBe("session-b");
    expect(useSessionStore.getState().compacting).toBe(false);
  });

  it("resets the mobile panel to chat so a switch never lands on the previous session's workspace tab", () => {
    // Outgoing session was parked on the workspace/preview tab on mobile.
    useSessionStore.setState({ sessionId: "session-a" });
    useUiStore.getState().setMobilePanel("preview");

    resumeSessionInternal("session-b");

    expect(useUiStore.getState().mobilePanel).toBe("chat");
  });
});

describe("handleSessionResume", () => {
  afterEach(() => {
    useSessionStore.getState().reset();
    useSessionStore.setState({ sessionId: undefined });
  });

  it("updates the route before the session store so old URL chrome cannot flash", () => {
    useSessionStore.setState({ sessionId: "session-a" });
    const observedSessionIds: (string | undefined)[] = [];
    const navigate = vi.fn(() => {
      observedSessionIds.push(useSessionStore.getState().sessionId);
    });

    handleSessionResume("sandbox-b", navigate);

    expect(navigate).toHaveBeenCalledWith("/session/sandbox-b");
    expect(observedSessionIds).toEqual(["session-a"]);
    expect(useSessionStore.getState().sessionId).toBe("sandbox-b");
  });
});
