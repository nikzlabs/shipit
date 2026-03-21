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
  let onRefresh: () => void;

  beforeEach(() => {
    onRefresh = vi.fn();
  });

  afterEach(cleanup);

  describe("commit count", () => {
    it("shows commit count in the header", () => {
      const commits = [makeCommit(), makeCommit({ hash: "def456" })];
      render(<GitHistory commits={commits} onRefresh={onRefresh} />);
      expect(screen.getByText("2 commits")).toBeInTheDocument();
    });

    it("shows singular for one commit", () => {
      render(<GitHistory commits={[makeCommit()]} onRefresh={onRefresh} />);
      expect(screen.getByText("1 commit")).toBeInTheDocument();
    });

    it("shows empty state message when no commits", () => {
      render(<GitHistory commits={[]} onRefresh={onRefresh} />);
      expect(screen.getByText("No commits yet.")).toBeInTheDocument();
    });
  });

  describe("commit display", () => {
    it("shows commit details immediately", () => {
      render(
        <GitHistory
          commits={[makeCommit({ message: "visible commit" })]}
          onRefresh={onRefresh}
        />
      );
      expect(screen.getByText("visible commit")).toBeInTheDocument();
    });

    it("shows abbreviated hash", () => {
      render(
        <GitHistory
          commits={[makeCommit({ hash: "abcdef1234567890" })]}
          onRefresh={onRefresh}
        />
      );
      expect(screen.getByText(/abcdef1/)).toBeInTheDocument();
    });

    it("shows relative date for recent commits", () => {
      const recentDate = new Date(Date.now() - 5 * 60000).toISOString();
      render(
        <GitHistory
          commits={[makeCommit({ date: recentDate })]}
          onRefresh={onRefresh}
        />
      );
      expect(screen.getByText(/5m ago/)).toBeInTheDocument();
    });

    it("shows 'just now' for very recent commits", () => {
      const justNow = new Date().toISOString();
      render(
        <GitHistory
          commits={[makeCommit({ date: justNow })]}
          onRefresh={onRefresh}
        />
      );
      expect(screen.getByText(/just now/)).toBeInTheDocument();
    });
  });

  describe("refresh", () => {
    it("calls onRefresh when refresh button is clicked", () => {
      render(<GitHistory commits={[]} onRefresh={onRefresh} />);
      fireEvent.click(screen.getByLabelText("Refresh"));
      expect(onRefresh).toHaveBeenCalledOnce();
    });
  });

  describe("clicking a commit opens diff", () => {
    it("calls onViewDiff with commit hash and parent hash when clicked", () => {
      const onViewDiff = vi.fn();
      render(
        <GitHistory
          commits={[
            makeCommit({ hash: "commit2", message: "second" }),
            makeCommit({ hash: "commit1", message: "first" }),
          ]}
          onRefresh={onRefresh}
          onViewDiff={onViewDiff}
        />
      );

      fireEvent.click(screen.getByText("second"));
      expect(onViewDiff).toHaveBeenCalledWith("commit2", "commit1");
    });

    it("passes null as parent hash for the last commit", () => {
      const onViewDiff = vi.fn();
      render(
        <GitHistory
          commits={[makeCommit({ hash: "only-commit", message: "only" })]}
          onRefresh={onRefresh}
          onViewDiff={onViewDiff}
        />
      );

      fireEvent.click(screen.getByText("only"));
      expect(onViewDiff).toHaveBeenCalledWith("only-commit", null);
    });

    it("does not crash when onViewDiff is not provided", () => {
      render(
        <GitHistory
          commits={[makeCommit({ message: "click me" })]}
          onRefresh={onRefresh}
        />
      );

      // Should not throw
      fireEvent.click(screen.getByText("click me"));
    });
  });

  describe("ref badges", () => {
    it("renders HEAD badge", () => {
      render(
        <GitHistory
          commits={[makeCommit({ refs: ["HEAD"] })]}
          onRefresh={onRefresh}
        />
      );
      expect(screen.getByText("HEAD")).toBeInTheDocument();
    });

    it("renders tag badge without 'tag: ' prefix", () => {
      render(
        <GitHistory
          commits={[makeCommit({ refs: ["tag: v1.0.0"] })]}
          onRefresh={onRefresh}
        />
      );
      expect(screen.getByText("v1.0.0")).toBeInTheDocument();
    });

    it("renders branch ref badge", () => {
      render(
        <GitHistory
          commits={[makeCommit({ refs: ["HEAD -> main"] })]}
          onRefresh={onRefresh}
        />
      );
      expect(screen.getByText("HEAD -> main")).toBeInTheDocument();
    });

    it("renders multiple ref badges", () => {
      render(
        <GitHistory
          commits={[makeCommit({ refs: ["HEAD", "tag: v2.0"] })]}
          onRefresh={onRefresh}
        />
      );
      expect(screen.getByText("HEAD")).toBeInTheDocument();
      expect(screen.getByText("v2.0")).toBeInTheDocument();
    });

    it("renders no badges when refs is empty", () => {
      const { container } = render(
        <GitHistory
          commits={[makeCommit({ refs: [] })]}
          onRefresh={onRefresh}
        />
      );
      expect(container.querySelectorAll("[class*='rounded px-1']")).toHaveLength(0);
    });
  });
});
