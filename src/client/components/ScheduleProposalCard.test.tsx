import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ScheduleProposalCard } from "./ScheduleProposalCard.js";
import type { ScheduleProposalCard as CardData } from "../../server/shared/types.js";

const NOW = new Date("2026-10-07T12:00:00.000Z");

const card = (over: Partial<CardData> = {}): CardData => ({
  cardId: "sch-1",
  kind: "create",
  name: "Security PRs",
  values: [
    { label: "When", after: "Weekdays at 09:00" },
    { label: "Target", after: "Repository https://github.com/o/r" },
    { label: "Permission mode", after: "Auto" },
  ],
  prompt: { after: "Check current security PRs.\n# Not a heading" },
  timing: { kind: "weekdays", hour: 9, minute: 0 },
  timeZone: null,
  enabled: true,
  phase: "pending",
  createdAt: "2026-10-07T00:00:00.000Z",
  ...over,
});

afterEach(cleanup);

describe("ScheduleProposalCard — pending", () => {
  it("shows every value, the prompt as plain text, and the browser's zone when the proposal names none", () => {
    render(<ScheduleProposalCard card={card()} browserTimeZone="Asia/Tokyo" now={NOW} />);

    expect(screen.getByText("Schedule proposed")).toBeInTheDocument();
    expect(screen.getByTestId("schedule-proposal-value-When")).toHaveTextContent("Weekdays at 09:00");
    expect(screen.getByTestId("schedule-proposal-value-Permission mode")).toHaveTextContent("Auto");
    expect(screen.getByTestId("schedule-proposal-value-Time zone")).toHaveTextContent("Asia/Tokyo (yours)");
    expect(screen.getByText(/# Not a heading/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Not a heading" })).not.toBeInTheDocument();
  });

  it("lists the next three runs, worked out in the browser's zone", () => {
    render(<ScheduleProposalCard card={card()} browserTimeZone="Asia/Tokyo" now={NOW} />);
    // Weekdays at 09:00 Tokyo, after 21:00 Tokyo on Wednesday 7 October: Thu 8, Fri 9, Mon 12.
    const runs = screen.getByTestId("schedule-proposal-next-runs").textContent ?? "";
    expect(runs.split(" · ")).toHaveLength(3);
    expect(runs).toMatch(/Thu.*Oct.*8.*09:00/);
    expect(runs).toMatch(/Mon.*Oct.*12.*09:00/);
  });

  it("shows the runs of a named zone in the browser's time", () => {
    render(<ScheduleProposalCard
      card={card({ timeZone: "Europe/Berlin", timing: { kind: "daily", hour: 9, minute: 0 } })}
      browserTimeZone="UTC"
      now={NOW}
    />);
    expect(screen.queryByTestId("schedule-proposal-value-Time zone")).not.toBeInTheDocument();
    // 09:00 in Berlin (summer time) is 07:00 UTC.
    expect(screen.getByTestId("schedule-proposal-next-runs")).toHaveTextContent(/Oct.*8.*07:00/);
  });

  it("shows no runs for a paused schedule", () => {
    render(<ScheduleProposalCard card={card({ enabled: false })} browserTimeZone="UTC" now={NOW} />);
    expect(screen.getByTestId("schedule-proposal-next-runs")).toHaveTextContent("None while paused");
  });

  it("shows a change before → after", () => {
    render(<ScheduleProposalCard
      card={card({
        kind: "update",
        scheduleId: "sched-1",
        timeZone: "Europe/Berlin",
        values: [{ label: "When", before: "Every day at 09:00", after: "Weekdays at 10:00" }],
        prompt: { before: "Old prompt.", after: "New prompt." },
      })}
      browserTimeZone="UTC"
      now={NOW}
    />);
    expect(screen.getByText("Schedule change proposed")).toBeInTheDocument();
    expect(screen.getByTestId("schedule-proposal-value-When")).toHaveTextContent("Every day at 09:00→Weekdays at 10:00");
    expect(screen.getByText("Prompt before")).toBeInTheDocument();
    expect(screen.getByText("Old prompt.")).toBeInTheDocument();
    expect(screen.getByText("New prompt.")).toBeInTheDocument();
  });

  it("sends the browser's zone on Confirm only when the proposal names none", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ScheduleProposalCard card={card()} onDecide={onDecide} browserTimeZone="Asia/Tokyo" now={NOW} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("sch-1", "confirm", "Asia/Tokyo"));

    rerender(<ScheduleProposalCard
      card={card({ timeZone: "Europe/Berlin" })}
      onDecide={onDecide}
      browserTimeZone="Asia/Tokyo"
      now={NOW}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onDecide).toHaveBeenLastCalledWith("sch-1", "confirm", undefined));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onDecide).toHaveBeenLastCalledWith("sch-1", "cancel", undefined));
  });

  it("says why a decision did not reach the server", async () => {
    const onDecide = vi.fn().mockRejectedValue(new Error("That schedule proposal is not in this session."));
    render(<ScheduleProposalCard card={card()} onDecide={onDecide} browserTimeZone="UTC" now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That schedule proposal is not in this session.");
  });
});

describe("ScheduleProposalCard — decided", () => {
  it("collapses to one line that says what happened", () => {
    const { rerender } = render(<ScheduleProposalCard card={card({ phase: "confirmed", scheduleId: "sched-1" })} />);
    expect(screen.getByTestId("schedule-proposal-card")).toHaveTextContent("Saved · schedule Security PRs created");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    rerender(<ScheduleProposalCard card={card({ phase: "stale", kind: "update" })} />);
    expect(screen.getByTestId("schedule-proposal-card"))
      .toHaveTextContent("Not saved · the schedule changed after this card was written");

    rerender(<ScheduleProposalCard card={card({ phase: "refused", outcome: 'There is no role named "triage".' })} />);
    expect(screen.getByTestId("schedule-proposal-card")).toHaveTextContent('Not saved · There is no role named "triage".');

    rerender(<ScheduleProposalCard card={card({ phase: "cancelled" })} />);
    expect(screen.getByTestId("schedule-proposal-card")).toHaveTextContent("Cancelled · schedule Security PRs was not created");
  });
});
