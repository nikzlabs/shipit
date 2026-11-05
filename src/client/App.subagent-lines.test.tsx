import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListRow } from "../server/shared/types.js";

vi.mock("./components/MessageList.js", () => ({ MessageList: () => null }));
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

const row = (id: string): SessionListRow => ({
  id,
  title: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: "2026-01-01T00:00:00.000Z",
  remoteUrl: "https://github.com/o/r",
});

describe("App — sub-agent lines (docs/339 req 1)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    useUiStore.setState({ bootstrapLoaded: true });
    useSettingsStore.setState({
      githubStatus: { authenticated: true },
      harnessOnboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    usePrStore.setState({ statusBySession: {}, cardBySession: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useSessionStore.getState().reset();
  });

  it("draws the session's sub-agents in the stack above the composer", () => {
    useSessionStore.setState({
      sessionId: "s1",
      sessions: [row("s1")],
      allSessions: [],
      messages: [
        { role: "user", text: "go" },
        {
          role: "assistant",
          text: "",
          streaming: true,
          toolUse: [{ type: "tool_use", id: "a1", name: "Agent", input: { description: "Find auth call sites" } }],
        },
      ],
      isLoading: true,
      activeRunnerSessions: new Set(["s1"]),
    });
    render(
      <MemoryRouter initialEntries={["/session/s1"]}>
        <Routes>
          <Route path="/session/:sessionId" element={<App />} />
        </Routes>
      </MemoryRouter>,
    );

    const lines = screen.getByTestId("subagent-lines");
    expect(lines).toHaveTextContent("Find auth call sites");
    const composer = screen.getByRole("textbox");
    expect(lines.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
