/**
 * docs/291-composer-before-claim req 5 — **what happens to a held first message
 * when the claim it is waiting for does not produce a session.**
 *
 * `/{repo}/new` accepts a message before the claim lands and stashes it with no
 * session id; `useConnectionSync` fills the id in from the store when a socket
 * opens. That makes the stash safe exactly as long as the claim it was typed for
 * is still the one we are waiting for. These pin the two ways it stops being that:
 * the claim fails, and the user moves to another repository's new-session view.
 *
 * The success case is here too, and is the one a careless fix breaks: a claim that
 * DID produce a session must leave the stash alone, or the message the feature
 * exists to deliver is discarded a moment before it would have been sent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, cleanup, waitFor } from "@testing-library/react";
import { useSessionActivation } from "./useSessionActivation.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useRepoStore } from "../stores/repo-store.js";

const REPO = "https://github.com/acme/app.git";
const HELD = { type: "send_message", text: "build me a thing", requestId: "req-1" };

function heldMessage() {
  useSessionStore.setState({
    messages: [{ role: "user", text: "build me a thing", clientRequestId: "req-1" }],
    isLoading: true,
    activity: { label: "Starting session..." },
    pendingWsMessage: HELD,
  } as never);
}

function renderActivation(over: Partial<Parameters<typeof useSessionActivation>[0]> = {}) {
  return renderHook(() =>
    useSessionActivation({
      urlSessionId: undefined,
      sessionId: undefined,
      isNewSessionRoute: true,
      newSessionRepoSlug: "acme/app",
      newSessionRepoUrl: REPO,
      bootstrapLoaded: true,
      reposLength: 1,
      disableAutoFix: () => {},
      navigate: vi.fn() as never,
      ...over,
    }),
  );
}

beforeEach(() => {
  useSessionStore.setState({
    sessionId: undefined,
    messages: [],
    isLoading: false,
    activity: undefined,
    pendingWsMessage: undefined,
  } as never);
  useUiStore.setState({ toast: null } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useSessionActivation — a first message held across the claim", () => {
  it("gives the message back when the claim fails", async () => {
    vi.spyOn(useRepoStore.getState(), "claimSession").mockResolvedValue(null);
    heldMessage();

    renderActivation();

    await waitFor(() => {
      expect(useSessionStore.getState().pendingWsMessage).toBeUndefined();
    });
    expect(useSessionStore.getState().messages).toEqual([]);
    expect(useSessionStore.getState().isLoading).toBe(false);
    expect(useUiStore.getState().toast?.message).toMatch(/couldn't be started/);
  });

  it("leaves the message stashed when the claim succeeds", async () => {
    vi.spyOn(useRepoStore.getState(), "claimSession").mockResolvedValue({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
    });
    heldMessage();

    renderActivation();

    await waitFor(() => {
      expect(useSessionStore.getState().sessionId).toBe("s1");
    });
    // Still held: the flush in `useConnectionSync` is what sends it, on the socket
    // this id is what opens.
    expect(useSessionStore.getState().pendingWsMessage).toEqual(HELD);
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("gives the message back when the user moves to another repository's /new", () => {
    // The claim never settles, so the failure path above cannot be what discards
    // the message — otherwise this test would pass with the route-change branch
    // deleted.
    vi.spyOn(useRepoStore.getState(), "claimSession").mockReturnValue(new Promise(() => {}));
    const { rerender } = renderHook(
      (props: { slug: string; url: string }) =>
        useSessionActivation({
          urlSessionId: undefined,
          sessionId: undefined,
          isNewSessionRoute: true,
          newSessionRepoSlug: props.slug,
          newSessionRepoUrl: props.url,
          bootstrapLoaded: true,
          reposLength: 1,
          disableAutoFix: () => {},
          navigate: vi.fn() as never,
        }),
      { initialProps: { slug: "acme/app", url: REPO } },
    );

    heldMessage();
    rerender({ slug: "acme/other", url: "https://github.com/acme/other.git" });

    expect(useSessionStore.getState().pendingWsMessage).toBeUndefined();
    expect(useUiStore.getState().toast?.message).toMatch(/left before/);
  });
});
