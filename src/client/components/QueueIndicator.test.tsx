import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueueIndicator } from "./QueueIndicator.js";

afterEach(() => {
  cleanup();
});

describe("QueueIndicator", () => {
  it("renders nothing when queue is empty", () => {
    const { container } = render(
      <QueueIndicator queue={[]} onCancel={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows singular label for one queued message", () => {
    render(
      <QueueIndicator
        queue={[{ text: "Hello", position: 1 }]}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText("1 message queued")).toBeInTheDocument();
  });

  it("shows plural label for multiple queued messages", () => {
    render(
      <QueueIndicator
        queue={[
          { text: "First", position: 1 },
          { text: "Second", position: 2 },
        ]}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText("2 messages queued")).toBeInTheDocument();
  });

  it("displays truncated text for long messages", () => {
    const longText = "A".repeat(100);
    render(
      <QueueIndicator
        queue={[{ text: longText, position: 1 }]}
        onCancel={vi.fn()}
      />
    );
    // Should show first 80 chars + ellipsis
    expect(screen.getByText(`${"A".repeat(80)}…`)).toBeInTheDocument();
  });

  it("displays full text for short messages", () => {
    render(
      <QueueIndicator
        queue={[{ text: "Short message", position: 1 }]}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText("Short message")).toBeInTheDocument();
  });

  it("calls onCancel('all') when Clear all is clicked", () => {
    const onCancel = vi.fn();
    render(
      <QueueIndicator
        queue={[{ text: "Hello", position: 1 }]}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByText("Clear all"));
    expect(onCancel).toHaveBeenCalledWith("all");
  });

  it("calls onCancel with 0-indexed position when individual cancel is clicked", () => {
    const onCancel = vi.fn();
    render(
      <QueueIndicator
        queue={[
          { text: "First", position: 1 },
          { text: "Second", position: 2 },
        ]}
        onCancel={onCancel}
      />
    );
    const cancelButtons = screen.getAllByLabelText(/Cancel queued message/);
    fireEvent.click(cancelButtons[0]);
    // position 1 → 0-indexed position 0
    expect(onCancel).toHaveBeenCalledWith(0);
  });

  it("shows position badge for each item", () => {
    render(
      <QueueIndicator
        queue={[
          { text: "First", position: 1 },
          { text: "Second", position: 2 },
        ]}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  // docs/140 Phase 6 — the queue path is unchanged when live steering is off.
  // QueueIndicator is steering-agnostic: it renders whatever queued messages it
  // is handed. With steering disabled, mid-turn messages still flow to the
  // queue and this indicator still renders them exactly as before.
  it("still renders queued messages (queue path unchanged when steering is off)", () => {
    render(
      <QueueIndicator
        queue={[
          { text: "queued while running", position: 1 },
          { text: "another queued message", position: 2 },
        ]}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText("2 messages queued")).toBeInTheDocument();
    expect(screen.getByText("queued while running")).toBeInTheDocument();
    expect(screen.getByText("another queued message")).toBeInTheDocument();
  });
});
