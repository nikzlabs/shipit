import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MessageList } from "./MessageList.js";
import type { ChatMessage } from "./types.js";
import { useBugReportStore } from "../../stores/bug-report-store.js";

/**
 * A card's click travels MessageList → row context → TranscriptRow → the card,
 * and a handler dropped anywhere on the way turns the button into a no-op. The
 * bug-report Cancel was one: it changed only local state, so the agent never
 * heard that the user declined.
 */

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => {
  cleanup();
  useBugReportStore.getState().reset();
});

describe("a card's click reaches the handler MessageList was given", () => {
  it("sends a bug report's Cancel", () => {
    const draft = {
      cardId: "bug-1",
      phase: "draft" as const,
      title: "Preview won't reload",
      body: "Details",
      stage2Ran: true,
      producer: "session" as const,
    };
    act(() => { useBugReportStore.getState().seedCards([draft]); });
    const onDismissBugReport = vi.fn();
    const messages = [
      { role: "user", text: "File it" },
      { role: "assistant", text: "", bugReport: draft },
    ] as ChatMessage[];

    render(<MessageList messages={messages} isLoading={false} onDismissBugReport={onDismissBugReport} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onDismissBugReport).toHaveBeenCalledWith("bug-1");
  });

  it("sends a repository proposal's Decline", async () => {
    const onDeclineRepoSession = vi.fn(async () => {});
    const messages = [
      { role: "user", text: "Fix the contract" },
      {
        role: "assistant",
        text: "",
        repoSessionProposal: {
          cardId: "rsp-1",
          repo: "acme/api",
          repoUrl: "https://github.com/acme/api.git",
          registered: true,
          title: "Add cursor pagination",
          prompt: "Add cursor pagination to GET /events.",
          createdAt: "2026-09-30T10:00:00.000Z",
        },
      },
    ] as ChatMessage[];

    render(<MessageList messages={messages} isLoading={false} onDeclineRepoSession={onDeclineRepoSession} />);
    fireEvent.click(screen.getByRole("button", { name: /Decline/ }));

    await waitFor(() => expect(onDeclineRepoSession).toHaveBeenCalledWith("rsp-1"));
  });

  it("sends a session-message proposal's Decline", async () => {
    const onDeclineSessionMessage = vi.fn(async () => {});
    const messages = [
      { role: "user", text: "Tell the orchestrator" },
      {
        role: "assistant",
        text: "",
        sessionMessageProposal: {
          cardId: "smp-1",
          targetSessionId: "ses_root",
          targetTitle: "Orchestrator",
          message: "The parser slice is done.",
          createdAt: "2026-09-30T10:00:00.000Z",
        },
      },
    ] as ChatMessage[];

    render(
      <MessageList messages={messages} isLoading={false} onDeclineSessionMessage={onDeclineSessionMessage} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    await waitFor(() => expect(onDeclineSessionMessage).toHaveBeenCalledWith("smp-1"));
  });
});
