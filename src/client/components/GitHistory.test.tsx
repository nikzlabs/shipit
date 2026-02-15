import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { GitHistory, type GitCommit } from "./GitHistory.js";

function makeCommit(overrides?: Partial<GitCommit>): GitCommit {
  return {
    hash: "abc1234567890",
    message: "feat: add button",
    date: new Date().toISOString(),
    author: "test",
    ...overrides,
  };
}

describe("GitHistory", () => {
  let onRollback: (hash: string) => void;
  let onRefresh: () => void;

  beforeEach(() => {
    onRollback = vi.fn();
    onRefresh = vi.fn();
  });

  afterEach(cleanup);

  describe("collapsed state", () => {
    it("shows commit count in the toggle button", () => {
      const commits = [makeCommit(), makeCommit({ hash: "def456" })];
      render(
        <GitHistory commits={commits} onRollback={onRollback} onRefresh={onRefresh} />
      );
      expect(screen.getByText("Git History (2)")).toBeInTheDocument();
    });

    it("does not show commit details when collapsed", () => {
      render(
        <GitHistory
          commits={[makeCommit({ message: "hidden commit" })]}
          onRollback={onRollback}
          onRefresh={onRefresh}
        />
      );
      expect(screen.queryByText("hidden commit")).not.toBeInTheDocument();
    });

    it("shows zero count when no commits", () => {
      render(
        <GitHistory commits={[]} onRollback={onRollback} onRefresh={onRefresh} />
      );
      expect(screen.getByText("Git History (0)")).toBeInTheDocument();
    });
  });

  describe("expanding", () => {
    it("shows commit details when expanded", () => {
      render(
        <GitHistory
          commits={[makeCommit({ message: "visible commit" })]}
          onRollback={onRollback}
          onRefresh={onRefresh}
        />
      );
      fireEvent.click(screen.getByText(/Git History/));
      expect(screen.getByText("visible commit")).toBeInTheDocument();
    });

    it("calls onRefresh when expanding", () => {
      render(
        <GitHistory commits={[]} onRollback={onRollback} onRefresh={onRefresh} />
      );
      fireEvent.click(screen.getByText(/Git History/));
      expect(onRefresh).toHaveBeenCalledOnce();
    });

    it("shows empty state message when expanded with no commits", () => {
      render(
        <GitHistory commits={[]} onRollback={onRollback} onRefresh={onRefresh} />
      );
      fireEvent.click(screen.getByText(/Git History/));
      expect(screen.getByText("No commits yet.")).toBeInTheDocument();
    });

    it("collapses on second click", () => {
      render(
        <GitHistory
          commits={[makeCommit({ message: "toggled commit" })]}
          onRollback={onRollback}
          onRefresh={onRefresh}
        />
      );
      const toggle = screen.getByText(/Git History/);
      fireEvent.click(toggle);
      expect(screen.getByText("toggled commit")).toBeInTheDocument();

      fireEvent.click(toggle);
      expect(screen.queryByText("toggled commit")).not.toBeInTheDocument();
    });
  });

  describe("commit display", () => {
    it("shows abbreviated hash", () => {
      render(
        <GitHistory
          commits={[makeCommit({ hash: "abcdef1234567890" })]}
          onRollback={onRollback}
          onRefresh={onRefresh}
        />
      );
      fireEvent.click(screen.getByText(/Git History/));
      expect(screen.getByText(/abcdef1/)).toBeInTheDocument();
    });

    it("shows relative date for recent commits", () => {
      const recentDate = new Date(Date.now() - 5 * 60000).toISOString(); // 5 min ago
      render(
        <GitHistory
          commits={[makeCommit({ date: recentDate })]}
          onRollback={onRollback}
          onRefresh={onRefresh}
        />
      );
      fireEvent.click(screen.getByText(/Git History/));
      expect(screen.getByText(/5m ago/)).toBeInTheDocument();
    });

    it("shows 'just now' for very recent commits", () => {
      const justNow = new Date().toISOString();
      render(
        <GitHistory
          commits={[makeCommit({ date: justNow })]}
          onRollback={onRollback}
          onRefresh={onRefresh}
        />
      );
      fireEvent.click(screen.getByText(/Git History/));
      expect(screen.getByText(/just now/)).toBeInTheDocument();
    });
  });

  describe("rollback", () => {
    it("does not show rollback button on the first (latest) commit", () => {
      render(
        <GitHistory
          commits={[makeCommit()]}
          onRollback={onRollback}
          onRefresh={onRefresh}
        />
      );
      fireEvent.click(screen.getByText(/Git History/));
      expect(screen.queryByText("rollback")).not.toBeInTheDocument();
    });

    it("shows rollback button on older commits", () => {
      render(
        <GitHistory
          commits={[makeCommit({ hash: "latest" }), makeCommit({ hash: "older" })]}
          onRollback={onRollback}
          onRefresh={onRefresh}
        />
      );
      fireEvent.click(screen.getByText(/Git History/));
      expect(screen.getByText("rollback")).toBeInTheDocument();
    });

    it("requires confirmation before rollback", () => {
      render(
        <GitHistory
          commits={[
            makeCommit({ hash: "latest" }),
            makeCommit({ hash: "older123", message: "old commit" }),
          ]}
          onRollback={onRollback}
          onRefresh={onRefresh}
        />
      );
      fireEvent.click(screen.getByText(/Git History/));

      // First click shows "confirm?"
      fireEvent.click(screen.getByText("rollback"));
      expect(screen.getByText("confirm?")).toBeInTheDocument();
      expect(onRollback).not.toHaveBeenCalled();

      // Second click triggers actual rollback
      fireEvent.click(screen.getByText("confirm?"));
      expect(onRollback).toHaveBeenCalledWith("older123");
    });

    it("resets confirmation state on blur", () => {
      render(
        <GitHistory
          commits={[
            makeCommit({ hash: "latest" }),
            makeCommit({ hash: "older" }),
          ]}
          onRollback={onRollback}
          onRefresh={onRefresh}
        />
      );
      fireEvent.click(screen.getByText(/Git History/));

      fireEvent.click(screen.getByText("rollback"));
      expect(screen.getByText("confirm?")).toBeInTheDocument();

      fireEvent.blur(screen.getByText("confirm?"));
      expect(screen.getByText("rollback")).toBeInTheDocument();
    });
  });
});
