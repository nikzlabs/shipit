import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GoalChip } from "./GoalChip.js";

const GOAL = { objective: "Make the suite green", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, updatedAt: 1 };

describe("GoalChip (docs/154 req 1)", () => {
  it("shows the status, the objective and how to remove it", () => {
    render(<GoalChip goal={GOAL} />);
    expect(screen.getByText("Goal · Active")).toBeInTheDocument();
    expect(screen.getByText("Make the suite green")).toBeInTheDocument();
    expect(screen.getByText("/goal clear to remove")).toBeInTheDocument();
  });

  // docs/298 — Grok leaves a goal paused whenever no turn drives it, so the chip is
  // where the user learns that `/goal resume` is what continues it.
  it("offers resume on a paused goal, in each harness's own word for it", () => {
    for (const status of ["paused", "user_paused", "back_off_paused"]) {
      const { unmount } = render(<GoalChip goal={{ ...GOAL, status }} />);
      expect(screen.getByText("/goal resume to continue · /goal clear to remove")).toBeInTheDocument();
      unmount();
    }
  });

  it("does not offer resume on a goal that is running", () => {
    render(<GoalChip goal={GOAL} />);
    expect(screen.getByText("/goal clear to remove")).toBeInTheDocument();
  });

  it("shows a status it has no label for as the CLI wrote it", () => {
    render(<GoalChip goal={{ ...GOAL, status: "someNewStatus" }} />);
    expect(screen.getByText("Goal · someNewStatus")).toBeInTheDocument();
  });
});
