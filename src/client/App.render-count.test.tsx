import { act, render } from "@testing-library/react";
// eslint-disable-next-line no-restricted-imports -- useEffect: counting the watcher's mounts is the assertion
import { useEffect } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListRow } from "../server/shared/types.js";
import type { PrStatusSummary } from "../server/shared/types/github-types.js";
import type * as AttentionModule from "./hooks/useAttentionNotifications.js";

const counts = vi.hoisted(() => ({ messageList: 0, attentionMounts: 0 }));

vi.mock("./components/MessageList.js", () => ({
  MessageList: () => {
    counts.messageList += 1;
    return null;
  },
}));

// The real watcher still runs, so its subscriptions stay part of what the tests measure.
vi.mock("./hooks/useAttentionNotifications.js", async (importOriginal) => {
  const real = await importOriginal<typeof AttentionModule>();
  return {
    useAttentionNotifications: (...args: Parameters<typeof real.useAttentionNotifications>) => {
      // eslint-disable-next-line no-restricted-syntax -- counting mounts is the assertion
      useEffect(() => {
        counts.attentionMounts += 1;
      }, []);
      real.useAttentionNotifications(...args);
    },
  };
});

vi.mock("./hooks/useServerEvents.js", () => ({ useServerEvents: () => {} }));

vi.mock("./hooks/useSessionWebSocket.js", () => {
  const ws = {
    send: () => {},
    lastMessage: null,
    drainMessages: () => [],
    status: "open" as const,
    reconnectAttempt: 0,
    reconnect: () => {},
  };
  return { useSessionWebSocket: () => ws };
});

import App from "./App.js";
import { usePrStore } from "./stores/pr-store.js";
import { useSessionStore } from "./stores/session-store.js";
import { useSettingsStore } from "./stores/settings-store.js";
import { useUiStore } from "./stores/ui-store.js";

const row = (id: string, over: Partial<SessionListRow> = {}): SessionListRow => ({
  id,
  title: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: "2026-01-01T00:00:00.000Z",
  remoteUrl: "https://github.com/o/r",
  ...over,
});

const prStatus = (sessionId: string): PrStatusSummary => ({
  sessionId,
  prNumber: 7,
  prUrl: "https://github.com/o/r/pull/7",
  prTitle: "Work",
  prBody: "Body",
  prState: "open",
  baseBranch: "main",
  headBranch: "shipit/work",
  insertions: 1,
  deletions: 0,
  checks: { state: "pending", total: 1, passed: 0, failed: 0, pending: 1 },
  mergeable: "unknown",
  reviewDecision: "none",
  autoMergeEnabled: false,
});

function renderApp(): number {
  render(
    <MemoryRouter initialEntries={["/session/s1"]}>
      <Routes>
        <Route path="/session/:sessionId" element={<App />} />
      </Routes>
    </MemoryRouter>,
  );
  return counts.messageList;
}

describe("App render count", () => {
  beforeEach(() => {
    counts.messageList = 0;
    counts.attentionMounts = 0;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    useUiStore.setState({ bootstrapLoaded: true });
    useSettingsStore.setState({
      githubStatus: { authenticated: true },
      harnessOnboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    useSessionStore.setState({ sessionId: "s1", sessions: [row("s1"), row("s2")], allSessions: [] });
    usePrStore.setState({ statusBySession: {}, cardBySession: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not re-render the chat panel when another session's row changes", () => {
    const settled = renderApp();
    expect(settled).toBeGreaterThan(0);

    act(() => {
      useSessionStore.getState().setSessions([row("s1"), row("s2", { lastUsedAt: "2026-01-02T00:00:00.000Z" })]);
    });
    expect(counts.messageList).toBe(settled);

    act(() => {
      useSessionStore.getState().setSessions([row("s1", { title: "renamed" }), row("s2", { lastUsedAt: "2026-01-02T00:00:00.000Z" })]);
    });
    expect(counts.messageList).toBeGreaterThan(settled);
  });

  it("does not re-render the chat panel when another session's PR status changes", () => {
    const settled = renderApp();

    act(() => {
      usePrStore.setState({ statusBySession: { s2: prStatus("s2") } });
    });
    expect(counts.messageList).toBe(settled);
  });

  it("does not re-render the chat panel when the all-sessions list changes", () => {
    const settled = renderApp();

    act(() => {
      useSessionStore.setState({ allSessions: [row("s1"), row("s2"), row("s3", { archived: true })] });
    });
    expect(counts.messageList).toBe(settled);
  });

  it("watches for attention before bootstrap ends and stays mounted after it", () => {
    useUiStore.setState({ bootstrapLoaded: false });
    renderApp();
    expect(counts.attentionMounts).toBe(1);

    act(() => {
      useUiStore.setState({ bootstrapLoaded: true });
    });
    expect(counts.messageList).toBeGreaterThan(0);
    expect(counts.attentionMounts).toBe(1);
  });
});
