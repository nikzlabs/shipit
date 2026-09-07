import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHeadlessSession, discardHeldFirstMessage, handleSessionResume, resumeSessionInternal, startQuickSessionInBackground } from "./session-actions.js";
import { useSessionStore } from "../session-store.js";
import { useUiStore } from "../ui-store.js";
import { useIssuesStore } from "../issues-store.js";
import { usePluginReposStore } from "../plugin-repos-store.js";
import { useRepoStore } from "../repo-store.js";
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

  /**
   * `historyLoaded` says "the transcript on screen has its `GET /history`
   * baseline". This function clears the transcript, so it must clear that too:
   * `useMessageHandler` queues the attach-time `turn_snapshot` only while the
   * flag is false, which is what makes the snapshot land ON TOP of the baseline
   * instead of being overwritten by it. Carrying the outgoing session's `true`
   * into the incoming one erased the running turn's tail until a reload.
   */
  it("clears historyLoaded so the incoming session's attach snapshot is queued behind its history", () => {
    useSessionStore.setState({ sessionId: "session-a", historyLoaded: true });

    resumeSessionInternal("session-b");

    expect(useSessionStore.getState().historyLoaded).toBe(false);
  });

  it("resets the mobile panel to chat so a switch never lands on the previous session's workspace tab", () => {
    // Outgoing session was parked on the workspace/preview tab on mobile.
    useSessionStore.setState({ sessionId: "session-a" });
    useUiStore.getState().setMobilePanel("preview");

    resumeSessionInternal("session-b");

    expect(useUiStore.getState().mobilePanel).toBe("chat");
  });

  // docs/262 — the plugin snapshot IS session-scoped: it gates the Plugins tab
  // and its warn dot, so carrying it into another session would show that
  // session a tab its repository never declared.
  it("drops the plugin declarations on switch", () => {
    useSessionStore.setState({ sessionId: "session-a" });
    usePluginReposStore.setState({
      snapshot: { declared: true, pending: false, activating: false, consumerRepoUrl: null, repos: [], warnings: [] },
      forSessionId: "session-a",
    });

    resumeSessionInternal("session-b");

    expect(usePluginReposStore.getState().snapshot).toBeNull();
    expect(usePluginReposStore.getState().forSessionId).toBeNull();
  });

  /**
   * planning#327 — the issues store is repo-scoped, not session-scoped: it's dropped
   * when the incoming session belongs to another repository (whose `shipit.yaml`
   * declares a different tracker set), and left alone within one repository.
   */
  describe("issues-tab repo scope", () => {
    const openIssue: Partial<ReturnType<typeof useIssuesStore.getState>> = {
      repoScope: "https://github.com/acme/app.git",
      trackers: [{ id: "linear:SHI", kind: "linear", label: "roadmap", configured: true, name: "roadmap" }],
      selected: { tracker: "linear:SHI", id: "SHI-1", identifier: "SHI-1" },
    };

    afterEach(() => {
      useIssuesStore.setState({ repoScope: null, trackers: [] });
      useIssuesStore.getState().reset();
      useRepoStore.setState({ activeRepoUrl: undefined });
    });

    it("drops the open issue when the incoming session is on another repository", () => {
      useSessionStore.setState({
        sessionId: "session-a",
        sessions: [session("session-a"), { ...session("session-b"), remoteUrl: "https://github.com/acme/site.git" }],
      });
      useIssuesStore.setState(openIssue);

      resumeSessionInternal("session-b");

      expect(useIssuesStore.getState().selected).toBeNull();
      expect(useIssuesStore.getState().trackers).toEqual([]);
      expect(useIssuesStore.getState().repoScope).toBe("https://github.com/acme/site.git");
    });

    it("keeps the open issue when both sessions are on the same repository", () => {
      useSessionStore.setState({
        sessionId: "session-a",
        sessions: [session("session-a"), session("session-b")],
      });
      useIssuesStore.setState(openIssue);

      resumeSessionInternal("session-b");

      expect(useIssuesStore.getState().selected?.identifier).toBe("SHI-1");
      expect(useIssuesStore.getState().trackers).toHaveLength(1);
    });

    // The sidebar's active repo is only a guess for a session the list doesn't
    // know (it doesn't move on a URL-driven switch), so "unknown" fails closed
    // instead of borrowing it — otherwise the issue survives a repo change.
    it("drops the open issue when the incoming session isn't in the list yet", () => {
      useSessionStore.setState({ sessionId: "session-a", sessions: [session("session-a")] });
      useRepoStore.setState({ activeRepoUrl: "https://github.com/acme/app.git" });
      useIssuesStore.setState(openIssue);

      resumeSessionInternal("session-b");

      expect(useIssuesStore.getState().selected).toBeNull();
    });
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

/**
 * docs/291-composer-before-claim req 5 — a first message typed before the claim
 * landed is held with no session id, and the flush fills that id in from the store
 * at the moment a socket opens. That is right while the claim it was typed for is
 * still running, and wrong once it is not: a failed claim would leave the bubble
 * and the spinner up forever, and a switch to another repository's `/new` would
 * flush the message into a session in a repository the user never sent it to.
 */
describe("discardHeldFirstMessage", () => {
  beforeEach(() => {
    useSessionStore.setState({
      messages: [
        { role: "user", text: "an earlier message" },
        { role: "user", text: "held", clientRequestId: "req-1" },
      ],
      isLoading: true,
      activity: { label: "Starting session..." },
      pendingWsMessage: { type: "send_message", text: "held", requestId: "req-1" },
    } as never);
    useUiStore.setState({ toast: null } as never);
  });

  afterEach(() => {
    useSessionStore.setState({
      messages: [],
      isLoading: false,
      activity: undefined,
      pendingWsMessage: undefined,
    } as never);
  });

  it("takes back the bubble, the spinner and the stash, and says so", () => {
    discardHeldFirstMessage("Your message wasn't sent.");
    const state = useSessionStore.getState();
    expect(state.pendingWsMessage).toBeUndefined();
    expect(state.messages.map((m) => m.text)).toEqual(["an earlier message"]);
    expect(state.isLoading).toBe(false);
    expect(state.activity).toBeUndefined();
    expect(useUiStore.getState().toast?.message).toBe("Your message wasn't sent.");
  });

  it("leaves everything alone when nothing is held", () => {
    // Callers fire this on every claim failure and every new-session route change,
    // so the common case is that there is nothing to give back. It must not clear
    // a spinner belonging to a turn that is genuinely running.
    useSessionStore.setState({ pendingWsMessage: undefined } as never);
    discardHeldFirstMessage("Your message wasn't sent.");
    const state = useSessionStore.getState();
    expect(state.messages).toHaveLength(2);
    expect(state.isLoading).toBe(true);
    expect(useUiStore.getState().toast).toBeFalsy();
  });
});

/**
 * docs/291-composer-before-claim req 5 — switching sessions with a message still
 * held. The flush addresses a stashed frame from the STORE, so a stash left behind
 * here is not merely stranded: it is delivered into the session being resumed.
 */
describe("resumeSessionInternal — a first message still held for delivery", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessionId: undefined,
      messages: [{ role: "user", text: "held", clientRequestId: "req-1" }],
      isLoading: true,
      pendingWsMessage: { type: "send_message", text: "held", requestId: "req-1" },
    } as never);
    useUiStore.setState({ toast: null } as never);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ messages: [], commits: [], agentRunning: false }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useSessionStore.setState({
      sessionId: undefined,
      messages: [],
      isLoading: false,
      pendingWsMessage: undefined,
    } as never);
  });

  it("does not carry the message into the session being switched to", () => {
    resumeSessionInternal("some-other-session");
    expect(useSessionStore.getState().pendingWsMessage).toBeUndefined();
    expect(useUiStore.getState().toast?.message).toMatch(/switched sessions/);
  });

  it("keeps the message when the session resumes ITSELF", () => {
    // The URL graduation this feature performs (`/{repo}/new` → `/session/{id}`)
    // lands on exactly this case, and discarding there would drop the message a
    // moment before the flush sends it.
    useSessionStore.setState({ sessionId: "s1" } as never);
    resumeSessionInternal("s1");
    expect(useSessionStore.getState().pendingWsMessage).toBeDefined();
    expect(useUiStore.getState().toast).toBeFalsy();
  });
});
