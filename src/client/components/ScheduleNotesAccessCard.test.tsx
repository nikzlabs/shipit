import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ScheduleNotesAccessCard } from "./ScheduleNotesAccessCard.js";
import type { ScheduleNotesAccessCard as CardData } from "../../server/shared/types.js";

const card = (over: Partial<CardData> = {}): CardData => ({
  cardId: "na-1",
  scheduleId: "sched-1",
  scheduleName: "Nightly triage",
  phase: "pending",
  createdAt: "2026-10-07T00:00:00.000Z",
  ...over,
});

afterEach(cleanup);

describe("ScheduleNotesAccessCard — pending", () => {
  it("names the schedule and says what Allow covers", () => {
    render(<ScheduleNotesAccessCard card={card()} />);
    expect(screen.getByText("Read schedule notes?")).toBeInTheDocument();
    expect(screen.getByTestId("schedule-notes-access-card")).toHaveTextContent(
      "This session's agent asks to read the notes of schedule Nightly triage. Allow covers this schedule only, for this session.",
    );
  });

  it("sends allow and deny", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ScheduleNotesAccessCard card={card()} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Allow for this session" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("na-1", "allow"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(onDecide).toHaveBeenLastCalledWith("na-1", "deny"));
  });

  it("disables both buttons while a decision is in flight", async () => {
    let finish: () => void = () => {};
    const onDecide = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<ScheduleNotesAccessCard card={card()} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Allow for this session" }));
    expect(screen.getByRole("button", { name: "Allow for this session" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenCalledTimes(1);

    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled());
  });

  it("says why a decision did not reach the server", async () => {
    const onDecide = vi.fn().mockRejectedValue(new Error("That card is not in this session."));
    render(<ScheduleNotesAccessCard card={card()} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That card is not in this session.");
  });
});

describe("ScheduleNotesAccessCard — decided", () => {
  it("collapses to one line with no buttons", () => {
    const { rerender } = render(<ScheduleNotesAccessCard card={card({ phase: "allowed" })} />);
    expect(screen.getByTestId("schedule-notes-access-card")).toHaveTextContent("Allowed for this session · Nightly triage");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    rerender(<ScheduleNotesAccessCard card={card({ phase: "denied" })} />);
    expect(screen.getByTestId("schedule-notes-access-card")).toHaveTextContent("Denied · Nightly triage");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
