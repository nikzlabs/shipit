import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TodoPanel, type TodoItem } from "./TodoPanel.js";

afterEach(cleanup);

describe("TodoPanel", () => {
  it("renders nothing when todos is empty", () => {
    const { container } = render(<TodoPanel todos={[]} />);
    expect(container.querySelector('[data-testid="todo-panel"]')).toBeInTheDocument();
    expect(screen.getByText("0/0 completed")).toBeInTheDocument();
  });

  it("renders items with correct status indicators", () => {
    const todos: TodoItem[] = [
      { content: "Fix bug", status: "completed", activeForm: "Fixing bug" },
      { content: "Add tests", status: "in_progress", activeForm: "Adding tests" },
      { content: "Deploy", status: "pending", activeForm: "Deploying" },
    ];
    const { container } = render(<TodoPanel todos={todos} />);
    expect(container.querySelector('[data-testid="status-completed"]')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="status-in-progress"]')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="status-pending"]')).toBeInTheDocument();
  });

  it("shows progress counter", () => {
    const todos: TodoItem[] = [
      { content: "Task 1", status: "completed", activeForm: "Doing 1" },
      { content: "Task 2", status: "completed", activeForm: "Doing 2" },
      { content: "Task 3", status: "in_progress", activeForm: "Doing 3" },
      { content: "Task 4", status: "pending", activeForm: "Doing 4" },
      { content: "Task 5", status: "pending", activeForm: "Doing 5" },
    ];
    render(<TodoPanel todos={todos} />);
    expect(screen.getByText("2/5 completed")).toBeInTheDocument();
  });

  it("uses activeForm for in_progress items and content for others", () => {
    const todos: TodoItem[] = [
      { content: "Write code", status: "completed", activeForm: "Writing code" },
      { content: "Run tests", status: "in_progress", activeForm: "Running tests" },
      { content: "Ship it", status: "pending", activeForm: "Shipping it" },
    ];
    render(<TodoPanel todos={todos} />);
    // completed shows content
    expect(screen.getByText("Write code")).toBeInTheDocument();
    // in_progress shows activeForm
    expect(screen.getByText("Running tests")).toBeInTheDocument();
    expect(screen.queryByText("Run tests")).not.toBeInTheDocument();
    // pending shows content
    expect(screen.getByText("Ship it")).toBeInTheDocument();
  });

  it("applies strikethrough to completed items", () => {
    const todos: TodoItem[] = [
      { content: "Done task", status: "completed", activeForm: "Done tasking" },
    ];
    render(<TodoPanel todos={todos} />);
    const el = screen.getByText("Done task");
    expect(el.className).toContain("line-through");
  });

  it("does not apply strikethrough to non-completed items", () => {
    const todos: TodoItem[] = [
      { content: "Active task", status: "in_progress", activeForm: "Activating" },
      { content: "Future task", status: "pending", activeForm: "Futuring" },
    ];
    render(<TodoPanel todos={todos} />);
    expect(screen.getByText("Activating").className).not.toContain("line-through");
    expect(screen.getByText("Future task").className).not.toContain("line-through");
  });

  it("shows Tasks header", () => {
    render(<TodoPanel todos={[]} />);
    expect(screen.getByText("Tasks")).toBeInTheDocument();
  });
});
