import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TodoPanel } from "./TodoPanel.js";
import type { TaskItem } from "./task-list.js";

afterEach(cleanup);

describe("TodoPanel", () => {
  it("renders nothing when the list is empty", () => {
    const { container } = render(<TodoPanel tasks={[]} />);
    expect(container.querySelector('[data-testid="todo-panel"]')).toBeInTheDocument();
    expect(screen.getByText("0/0 completed")).toBeInTheDocument();
  });

  it("renders items with correct status indicators", () => {
    const tasks: TaskItem[] = [
      { id: "1", subject: "Fix bug", status: "completed", activeForm: "Fixing bug" },
      { id: "2", subject: "Add tests", status: "in_progress", activeForm: "Adding tests" },
      { id: "3", subject: "Deploy", status: "pending", activeForm: "Deploying" },
    ];
    const { container } = render(<TodoPanel tasks={tasks} />);
    expect(container.querySelector('[data-testid="status-completed"]')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="status-in-progress"]')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="status-pending"]')).toBeInTheDocument();
  });

  it("shows progress counter", () => {
    const tasks: TaskItem[] = [
      { id: "1", subject: "Task 1", status: "completed", activeForm: "Doing 1" },
      { id: "2", subject: "Task 2", status: "completed", activeForm: "Doing 2" },
      { id: "3", subject: "Task 3", status: "in_progress", activeForm: "Doing 3" },
      { id: "4", subject: "Task 4", status: "pending", activeForm: "Doing 4" },
      { id: "5", subject: "Task 5", status: "pending", activeForm: "Doing 5" },
    ];
    render(<TodoPanel tasks={tasks} />);
    expect(screen.getByText("2/5 completed")).toBeInTheDocument();
  });

  it("uses activeForm for in_progress items and subject for others", () => {
    const tasks: TaskItem[] = [
      { id: "1", subject: "Write code", status: "completed", activeForm: "Writing code" },
      { id: "2", subject: "Run tests", status: "in_progress", activeForm: "Running tests" },
      { id: "3", subject: "Ship it", status: "pending", activeForm: "Shipping it" },
    ];
    render(<TodoPanel tasks={tasks} />);
    // completed shows subject
    expect(screen.getByText("Write code")).toBeInTheDocument();
    // in_progress shows activeForm
    expect(screen.getByText("Running tests")).toBeInTheDocument();
    expect(screen.queryByText("Run tests")).not.toBeInTheDocument();
    // pending shows subject
    expect(screen.getByText("Ship it")).toBeInTheDocument();
  });

  it("falls back to the subject when an in_progress task has no activeForm", () => {
    // `activeForm` is optional on TaskCreate/TaskUpdate — the CLI's own spinner
    // shows the subject when it is omitted, and so must the panel.
    render(<TodoPanel tasks={[{ id: "1", subject: "Run tests", status: "in_progress" }]} />);
    expect(screen.getByText("Run tests")).toBeInTheDocument();
  });

  it("applies strikethrough to completed items", () => {
    render(<TodoPanel tasks={[{ id: "1", subject: "Done task", status: "completed" }]} />);
    expect(screen.getByText("Done task").className).toContain("line-through");
  });

  it("does not apply strikethrough to non-completed items", () => {
    const tasks: TaskItem[] = [
      { id: "1", subject: "Active task", status: "in_progress", activeForm: "Activating" },
      { id: "2", subject: "Future task", status: "pending" },
    ];
    render(<TodoPanel tasks={tasks} />);
    expect(screen.getByText("Activating").className).not.toContain("line-through");
    expect(screen.getByText("Future task").className).not.toContain("line-through");
  });

  it("shows Tasks header", () => {
    render(<TodoPanel tasks={[]} />);
    expect(screen.getByText("Tasks")).toBeInTheDocument();
  });
});
