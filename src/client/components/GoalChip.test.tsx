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

  it("shows a status it has no label for as the CLI wrote it", () => {
    render(<GoalChip goal={{ ...GOAL, status: "someNewStatus" }} />);
    expect(screen.getByText("Goal · someNewStatus")).toBeInTheDocument();
  });
});
