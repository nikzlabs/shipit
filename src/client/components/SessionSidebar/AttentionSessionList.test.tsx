import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttentionSessionList } from "./AttentionSessionList.js";
import type { ScheduleView, SessionInfo } from "../../../server/shared/types.js";

afterEach(cleanup);

const session = (id: string, title: string, createdAt: string, remoteUrl = ""): SessionInfo => ({
  id,
  title,
  createdAt,
  lastUsedAt: createdAt,
  remoteUrl,
});

function renderedTitles(): string[] {
  return [...document.querySelectorAll('[data-testid="session-item"] p')].map(
    (el) => el.textContent ?? "",
  );
}

const props = (sessions: SessionInfo[], attention: string[]) => ({
  sessions,
  attentionIds: new Set(attention),
  schedules: [],
  onOpenSchedule: vi.fn(),
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

    expect(screen.getByText("repo")).toBeTruthy();
  });

  it("appends a late arrival instead of inserting it into the date order", () => {

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

    rerender(<AttentionSessionList {...props(sessions, ["b"])} />);
    expect(renderedTitles()).toEqual(["Settles", "Still waiting"]);

    expect(screen.getByText("Settles").closest(".opacity-60")).toBeTruthy();
    expect(screen.getByText("Still waiting").closest(".opacity-60")).toBeNull();

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

describe("AttentionSessionList schedule rows (docs/324-scheduled-sessions reqs 18, 31)", () => {
  const schedule = (id: string, name: string, createdAt: string, needsUserReason?: string): ScheduleView => ({
    id,
    name,
    enabled: true,
    timing: { kind: "daily", hour: 9, minute: 0 },
    timeZone: "UTC",
    spec: null,
    activeSince: createdAt,
    ...(needsUserReason ? { needsUserReason } : {}),
    createdAt,
    updatedAt: createdAt,
    nextRuns: [],
  });

  /** Every row's first line, sessions and schedules alike, in screen order. */
  function rowNames(): string[] {
    return [...document.querySelectorAll('[data-testid="session-item"] p, [data-testid="schedule-attention-item"] p')].map(
      (el) => el.textContent ?? "",
    );
  }

  it("lists a schedule that could not start, with its reason, in the one arrival order", () => {
    const sessions = [session("a", "Older session", "2024-01-01"), session("b", "Newer session", "2024-03-01")];
    const schedules = [
      schedule("s1", "Nightly audit", "2024-02-01", "The repository is no longer added."),
      schedule("s2", "Calm schedule", "2024-02-15"),
    ];
    render(<AttentionSessionList {...props(sessions, ["a", "b"])} schedules={schedules} />);

    expect(rowNames()).toEqual(["Newer session", "Nightly audit", "Older session"]);
    const row = screen.getByTestId("schedule-attention-item");
    expect(row.textContent).toContain("The repository is no longer added.");
    expect(row.getAttribute("title")).toBe("Could not start: The repository is no longer added.");
    expect(row.getAttribute("style")).toContain("--color-attention");
    expect(screen.queryByText("Calm schedule")).toBeNull();
  });

  it("opens the schedule from its row", async () => {
    const onOpenSchedule = vi.fn();
    render(
      <AttentionSessionList
        {...props([], [])}
        schedules={[schedule("s1", "Nightly audit", "2024-02-01", "Out of quota.")]}
        onOpenSchedule={onOpenSchedule}
      />,
    );
    await userEvent.click(screen.getByTestId("schedule-attention-item"));
    expect(onOpenSchedule).toHaveBeenCalledWith("s1");
  });

  it("appends a schedule that fails later, below the rows already there", () => {
    const sessions = [session("a", "Waiting session", "2024-01-01")];
    const { rerender } = render(
      <AttentionSessionList {...props(sessions, ["a"])} schedules={[schedule("s1", "Nightly audit", "2024-06-01")]} />,
    );
    expect(rowNames()).toEqual(["Waiting session"]);

    rerender(
      <AttentionSessionList
        {...props(sessions, ["a"])}
        schedules={[schedule("s1", "Nightly audit", "2024-06-01", "Out of quota.")]}
      />,
    );
    expect(rowNames()).toEqual(["Waiting session", "Nightly audit"]);
  });

  it("keeps a schedule whose reason cleared in place, dimmed and unmarked, until the view is entered again", () => {
    const failed = [schedule("s1", "Nightly audit", "2024-02-01", "Out of quota.")];
    const cleared = [schedule("s1", "Nightly audit", "2024-02-01")];
    const sessions = [session("a", "Waiting session", "2024-01-01")];
    const { rerender, unmount } = render(<AttentionSessionList {...props(sessions, ["a"])} schedules={failed} />);
    expect(rowNames()).toEqual(["Nightly audit", "Waiting session"]);

    rerender(<AttentionSessionList {...props(sessions, ["a"])} schedules={cleared} />);
    expect(rowNames()).toEqual(["Nightly audit", "Waiting session"]);
    const row = screen.getByTestId("schedule-attention-item");
    expect(row.closest(".opacity-60")).toBeTruthy();
    expect(row.getAttribute("style") ?? "").not.toContain("--color-attention");
    // The tag stays on the second line, so the row keeps its height.
    expect(row.textContent).toContain("schedule");

    unmount();
    render(<AttentionSessionList {...props(sessions, ["a"])} schedules={cleared} />);
    expect(rowNames()).toEqual(["Waiting session"]);
  });

  it("drops a deleted schedule at once", () => {
    const { rerender } = render(
      <AttentionSessionList {...props([], [])} schedules={[schedule("s1", "Nightly audit", "2024-02-01", "Out of quota.")]} />,
    );
    expect(rowNames()).toEqual(["Nightly audit"]);

    rerender(<AttentionSessionList {...props([], [])} schedules={[]} />);
    expect(rowNames()).toEqual([]);
    expect(screen.getByText("Nothing needs you.")).toBeTruthy();
  });
});
