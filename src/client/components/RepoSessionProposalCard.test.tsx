import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { RepoSessionProposalCard } from "./RepoSessionProposalCard.js";
import { useSessionStore } from "../stores/session-store.js";
import type { RepoSessionProposalCard as CardData } from "../../server/shared/types.js";

function card(over: Partial<CardData> = {}): CardData {
  return {
    cardId: "rsp-1",
    repo: "acme/api",
    repoUrl: "https://github.com/acme/api.git",
    registered: true,
    title: "Add cursor pagination to /events",
    prompt: "Add cursor pagination to GET /events; acme/web depends on the contract.",
    createdAt: "2026-09-14T10:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  useSessionStore.setState({ sessions: [], sessionId: undefined });
});
afterEach(() => cleanup());

describe("RepoSessionProposalCard — proposed", () => {
  it("names the repository, the title and the prompt before the user acts", () => {
    render(<RepoSessionProposalCard card={card()} />);
    expect(screen.getByText("acme/api")).toBeInTheDocument();
    expect(screen.getByText("Add cursor pagination to /events")).toBeInTheDocument();
    expect(screen.getByTestId("repo-session-proposal-prompt")).toHaveTextContent(
      /cursor pagination to GET \/events/,
    );
  });

  it("starts on one click, passing the card id", async () => {
    const onStart = vi.fn<(cardId: string) => Promise<void>>(async () => {});
    render(<RepoSessionProposalCard card={card()} onStart={onStart} />);

    fireEvent.click(screen.getByRole("button", { name: /Start in acme\/api/ }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith("rsp-1"));
  });

  it("can show a long prompt in full, since the click approves that exact text", () => {
    const long = "Refactor the events endpoint. ".repeat(20);
    render(<RepoSessionProposalCard card={card({ prompt: long })} />);

    expect(screen.getByTestId("repo-session-proposal-prompt")).toHaveClass("line-clamp-6");
    fireEvent.click(screen.getByRole("button", { name: /Show the whole prompt/ }));
    expect(screen.getByTestId("repo-session-proposal-prompt")).not.toHaveClass("line-clamp-6");
  });

  it("offers no expander for a prompt that already fits", () => {
    render(<RepoSessionProposalCard card={card()} />);
    expect(screen.queryByRole("button", { name: /Show the whole prompt/ })).not.toBeInTheDocument();
  });

  it("warns that an unregistered repository will be added to the sidebar", () => {
    render(<RepoSessionProposalCard card={card({ registered: false })} />);
    expect(screen.getByText(/not in ShipIt yet/)).toBeInTheDocument();
  });

  it("says nothing about adding a repository ShipIt already has", () => {
    render(<RepoSessionProposalCard card={card({ registered: true })} />);
    expect(screen.queryByText(/not in ShipIt yet/)).not.toBeInTheDocument();
  });

  it("shows the reason when the start request itself fails, and stays clickable", async () => {
    const onStart = vi.fn(async () => {
      throw new Error("Repository is still cloning");
    });
    render(<RepoSessionProposalCard card={card()} onStart={onStart} />);

    fireEvent.click(screen.getByRole("button", { name: /Start in/ }));
    await waitFor(() =>
      expect(screen.getByTestId("repo-session-proposal-error")).toHaveTextContent(
        "Repository is still cloning",
      ),
    );
    expect(screen.getByRole("button", { name: /Start in/ })).not.toBeDisabled();
  });
});

describe("RepoSessionProposalCard — in flight and terminal states", () => {
  it("disables the button once the server reports the start is running", () => {
    const { rerender } = render(<RepoSessionProposalCard card={card()} />);
    rerender(<RepoSessionProposalCard card={card({ state: "starting" })} />);
    expect(screen.getByRole("button", { name: /Starting/ })).toBeDisabled();
  });

  it("stays clickable for a card loaded already starting, which no process is working on", () => {
    // Only reachable after a reload: the live `starting` arrives as an update,
    // so a card that is starting at mount was abandoned by a dead process.
    render(<RepoSessionProposalCard card={card({ state: "starting" })} />);
    expect(screen.getByRole("button", { name: /Start in acme\/api/ })).not.toBeDisabled();
  });

  it("offers a retry, with the server's reason, after a failure", () => {
    render(
      <RepoSessionProposalCard
        card={card({ state: "failed", errorMessage: "Parent session is archived" })}
      />,
    );
    expect(screen.getByRole("button", { name: /Try again/ })).not.toBeDisabled();
    expect(screen.getByTestId("repo-session-proposal-error")).toHaveTextContent(
      "Parent session is archived",
    );
  });

  it("opens the session it started, and never offers a second start", () => {
    useSessionStore.setState({
      sessions: [{ id: "ses_child", title: "Add cursor pagination" }] as never,
    });
    const onOpenSession = vi.fn();
    render(
      <RepoSessionProposalCard
        card={card({ state: "started", startedSessionId: "ses_child" })}
        onOpenSession={onOpenSession}
      />,
    );

    expect(screen.queryByRole("button", { name: /Start in/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open session/ }));
    expect(onOpenSession).toHaveBeenCalledWith("ses_child");
  });

  it("still opens a target missing from the sidebar, which only means archived", () => {
    const onOpenSession = vi.fn();
    render(
      <RepoSessionProposalCard
        card={card({ state: "started", startedSessionId: "ses_archived" })}
        onOpenSession={onOpenSession}
      />,
    );
    expect(screen.getByTestId("repo-session-proposal-status")).toHaveTextContent(
      "not in the sidebar",
    );
    fireEvent.click(screen.getByRole("button", { name: /Open session/ }));
    expect(onOpenSession).toHaveBeenCalledWith("ses_archived");
  });

  it("warns before the click when the account cannot push to the target", () => {
    render(<RepoSessionProposalCard card={card({ readOnly: true })} />);
    expect(screen.getByText(/not be able to open a pull request/)).toBeInTheDocument();
  });
});
