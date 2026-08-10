import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AttentionSessionList } from "./AttentionSessionList.js";
import type { SessionInfo } from "../../../server/shared/types.js";

afterEach(cleanup);

const session = (id: string, title: string, createdAt: string, remoteUrl = ""): SessionInfo => ({
  id,
  title,
  createdAt,
  lastUsedAt: createdAt,
  remoteUrl,
});

/** Titles in rendered order — the thing every stability claim here is about. */
function renderedTitles(): string[] {
  return [...document.querySelectorAll('[data-testid="session-item"] p')].map(
    (el) => el.textContent ?? "",
  );
}

const props = (sessions: SessionInfo[], attention: string[]) => ({
  sessions,
  attentionIds: new Set(attention),
  currentSessionId: undefined,
  onResume: vi.fn(),
});

describe("AttentionSessionList", () => {
  it("lists only the sessions needing attention, newest first, with their repo", () => {
    const sessions = [
      session("a", "Oldest", "2024-01-01", "https://github.com/owner/repo.git"),
      session("b", "Newest", "2024-03-01"),
      session("c", "Calm", "2024-02-01"),
    ];
    render(<AttentionSessionList {...props(sessions, ["a", "b"])} />);

    expect(renderedTitles()).toEqual(["Newest", "Oldest"]);
    expect(screen.queryByText("Calm")).toBeNull();
    // req 12 — the repo name replaces the grouping the view drops.
    expect(screen.getByText("repo")).toBeTruthy();
  });

  it("appends a late arrival instead of inserting it into the date order", () => {
    // req 7 — no row already on screen may move. A plain createdAt sort would
    // put "Newer" on top the moment it qualifies, pushing "Older" down a slot
    // under the pointer; arrival order is what actually holds positions fixed.
    const sessions = [
      session("old", "Older", "2024-01-01"),
      session("new", "Newer", "2024-02-01"),
    ];
    const { rerender } = render(<AttentionSessionList {...props(sessions, ["old"])} />);
    expect(renderedTitles()).toEqual(["Older"]);

    rerender(<AttentionSessionList {...props(sessions, ["old", "new"])} />);
    expect(renderedTitles()).toEqual(["Older", "Newer"]);
  });

  it("keeps a settled session in place, and drops it only when the view is re-entered", () => {
    // req 8 — the row must not vanish from under the pointer.
    const sessions = [
      session("a", "Settles", "2024-03-01"),
      session("b", "Still waiting", "2024-02-01"),
    ];
    const { rerender, unmount } = render(<AttentionSessionList {...props(sessions, ["a", "b"])} />);
    expect(renderedTitles()).toEqual(["Settles", "Still waiting"]);

    // "a" stops needing attention while the view is open.
    rerender(<AttentionSessionList {...props(sessions, ["b"])} />);
    expect(renderedTitles()).toEqual(["Settles", "Still waiting"]);
    // Losing the marker is the signal; the row also dims, like an archived one.
    expect(screen.getByText("Settles").closest(".opacity-60")).toBeTruthy();
    expect(screen.getByText("Still waiting").closest(".opacity-60")).toBeNull();

    // Leaving and re-entering the view is what clears it.
    unmount();
    render(<AttentionSessionList {...props(sessions, ["b"])} />);
    expect(renderedTitles()).toEqual(["Still waiting"]);
  });

  it("drops a session that disappears from the sidebar entirely", () => {
    // Sticky membership must not outlive the session itself — an archived or
    // removed session is gone from `sessions` and must not linger as a ghost row.
    const sessions = [session("a", "Gone soon", "2024-01-01")];
    const { rerender } = render(<AttentionSessionList {...props(sessions, ["a"])} />);
    expect(renderedTitles()).toEqual(["Gone soon"]);

    rerender(<AttentionSessionList {...props([], [])} />);
    expect(renderedTitles()).toEqual([]);
  });

  it("shows an inbox-zero state when nothing needs attention", () => {
    render(<AttentionSessionList {...props([session("a", "Calm", "2024-01-01")], [])} />);
    expect(screen.getByText("Nothing needs you.")).toBeTruthy();
  });
});
